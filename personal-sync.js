// Personal Hub — local folder ↔ Supabase Storage bidirectional sync.
//
// The linked folder's absolute path lives only in this device's localStorage (never synced —
// each machine points at its own local copy, same as OneDrive/Dropbox). The cloud side is one
// private Storage bucket ('personal_files', path `${uid}/${encodedRelativePath}`) plus a bookkeeping
// table (personal_sync_files) that tracks each file's last-known content hash, used to detect
// whether a change came from "just me" or "someone else changed it too" (a real conflict).
//
// File I/O for the linked folder goes through Rust commands (sync_*), not the fs plugin's JS
// API, because the fs plugin's capability scope stays locked to $APPLOCALDATA for everything
// else in the app — see src-tauri/src/lib.rs.
//
// Mọi quyết định (đẩy/kéo/xoá/xung đột) nằm ở lib/sync-decision.js (logic thuần, có test). File này CHỈ làm
// I/O và điều phối. File này GIỐNG HỆT ở cả 3 app; cần lib/sync-decision.js nạp TRƯỚC nó.
//
// Các lỗi của bản cũ đã sửa ở đây (xem lịch sử git):
//  1. Chỉ bắt đầu theo dõi khi MỞ Không Gian Riêng, và không bao giờ đối chiếu lúc khởi động => đổi file lúc
//     app tắt, hoặc không vào Không Gian Riêng, thì không bao giờ được đồng bộ. Giờ tự chạy ngay khi mở app +
//     định kỳ (INTERVAL).
//  2. Tên file tiếng Việt bị Storage từ chối ("Invalid key") và làm cả lượt dừng ở file đó. Giờ mã hoá khoá
//     lưu trữ (api.js dùng encodeSyncStorageKey) và mỗi file lỗi chỉ bỏ qua file đó.
//  3. File đã xoá cứ hồi sinh (thiếu so khớp với "last"). Giờ xoá được lan truyền đúng chiều.
//  4. Xoá/di chuyển CẢ THƯ MỤC không được nhận ra (sự kiện chỉ nêu đường dẫn thư mục).
//  5. File tạm (.wh-tmp-*, ~$*.docx) bị đẩy lên như file thật.
//  6. Sự kiện đổi từ đám mây ghi đè bản đang sửa dở ở máy (không kiểm tra xung đột).

window.PersonalSync = (function () {
    const ROOT_KEY = 'wh_personal_sync_root';
    const OWNER_KEY = 'wh_personal_sync_owner'; // uid của tài khoản đã liên kết thư mục này trên máy
    const HASH_CACHE_KEY = 'wh_personal_sync_hashes'; // { relativePath: lastSyncedHash }
    const SIZE_CACHE_KEY = 'wh_personal_sync_sizes';  // { relativePath: sizeAtLastSync } -- chỉ để bỏ qua băm ở lượt định kỳ
    const SUPPRESS_MS = 4000; // ignore a local-change event we caused ourselves via download/conflict-write
    const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
    const SESSION_POLL_MS = 3000;
    const SESSION_POLL_MAX_MS = 10 * 60 * 1000;

    let watching = false;
    let cachedUserId = null;
    let realtimeChannel = null;
    let statusListeners = [];
    let unlistenLocalChange = null; // trả về từ __TAURI__.event.listen(), gọi lúc stopWatching()
    let queue = Promise.resolve();  // hàng đợi tuần tự: không bao giờ có 2 thao tác file chạy chồng nhau
    let reconcileTimer = null;
    let started = false;
    const suppressUntil = {}; // relativePath -> timestamp

    // Trạng thái công khai cho giao diện (getState()).
    const state = {
        phase: 'idle',       // idle | reconciling | error | disabled
        lastRunAt: null,     // ms epoch của lượt đối chiếu đầy đủ gần nhất kết thúc
        lastError: null,     // chuỗi mô tả lỗi cấp thư mục (vd thư mục biến mất)
        failures: [],        // [{ path, message }] -- file lỗi ở lượt gần nhất
        counts: { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0 }, // của lượt gần nhất
        progress: null       // { done, total } khi đang đối chiếu
    };

    function isTauri() {
        return !!(window.__TAURI__ && window.__TAURI__.core);
    }

    function invoke(cmd, args) {
        return window.__TAURI__.core.invoke(cmd, args || {});
    }

    function getRoot() {
        return localStorage.getItem(ROOT_KEY) || null;
    }

    function loadJson(key) {
        try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
        catch (e) { return {}; }
    }

    function loadHashCache() { return loadJson(HASH_CACHE_KEY); }

    function saveHashCache(cache) {
        localStorage.setItem(HASH_CACHE_KEY, JSON.stringify(cache));
    }

    function setLastSyncedHash(relPath, hash, size) {
        const cache = loadHashCache();
        const sizes = loadJson(SIZE_CACHE_KEY);
        if (hash) { cache[relPath] = hash; if (size != null) sizes[relPath] = size; }
        else { delete cache[relPath]; delete sizes[relPath]; }
        saveHashCache(cache);
        localStorage.setItem(SIZE_CACHE_KEY, JSON.stringify(sizes));
    }

    function emitStatus(status, detail) {
        statusListeners.forEach(fn => { try { fn(status, detail); } catch (e) {} });
    }

    function onStatus(fn) { statusListeners.push(fn); }

    function getState() {
        return {
            root: getRoot(),
            watching,
            phase: state.phase,
            lastRunAt: state.lastRunAt,
            lastError: state.lastError,
            failures: state.failures.slice(),
            counts: Object.assign({}, state.counts),
            progress: state.progress ? Object.assign({}, state.progress) : null,
            trackedCount: Object.keys(loadHashCache()).length
        };
    }

    // Chạy fn sau mọi thao tác đã xếp hàng; lỗi của 1 việc không chặn các việc sau.
    function enqueue(fn) {
        const run = queue.then(fn, fn);
        queue = run.catch(() => {});
        return run;
    }

    async function getUserId() {
        if (!cachedUserId) cachedUserId = await API.personalSync.getUserId();
        return cachedUserId;
    }

    async function pickFolder() {
        if (!isTauri() || !window.__TAURI__.dialog) return null;
        const selected = await window.__TAURI__.dialog.open({ directory: true, multiple: false, title: 'Chọn thư mục để đồng bộ' });
        if (!selected) return null;
        return Array.isArray(selected) ? selected[0] : selected;
    }

    async function linkFolder(path) {
        const uid = await getUserId();
        localStorage.setItem(ROOT_KEY, path);
        if (uid) localStorage.setItem(OWNER_KEY, uid);
        saveHashCache({});
        localStorage.setItem(SIZE_CACHE_KEY, '{}');
        state.lastError = null;
        state.failures = [];
        started = true;
        await startWatching();
        startTimer();
        await fullReconcile({ deep: true });
    }

    async function unlinkFolder() {
        await stopWatching();
        stopTimer();
        localStorage.removeItem(ROOT_KEY);
        localStorage.removeItem(OWNER_KEY);
        saveHashCache({});
        localStorage.setItem(SIZE_CACHE_KEY, '{}');
        state.phase = 'idle';
        state.lastError = null;
        state.failures = [];
        state.progress = null;
    }

    async function startWatching() {
        const root = getRoot();
        if (!root || !isTauri() || watching) return;
        await invoke('sync_start_watch', { root });
        watching = true;
        // __TAURI__.event.listen() trả về 1 hàm "unlisten" -- trước đây không lưu lại nên
        // không gỡ được lúc stopWatching(). Chu kỳ unlink -> relink (watching reset về false
        // ở stopWatching(), cho phép gọi startWatching() lần nữa) từng cộng dồn thêm 1 listener
        // mỗi lần relink, khiến 1 lần đổi file cục bộ kích hoạt xử lý N lần sau N lần relink.
        unlistenLocalChange = await window.__TAURI__.event.listen('personal-sync-local-change', (event) => {
            const p = handleLocalChanges(event.payload || []);
            if (p && p.catch) p.catch(err => console.warn('PersonalSync: xử lý thay đổi cục bộ lỗi', err));
        });
        if (!realtimeChannel) {
            realtimeChannel = API.personalSync.subscribe(handleRemoteChange);
        }
    }

    async function stopWatching() {
        if (isTauri()) { try { await invoke('sync_stop_watch'); } catch (e) {} }
        if (unlistenLocalChange) { try { unlistenLocalChange(); } catch (e) {} unlistenLocalChange = null; }
        if (realtimeChannel && typeof sbClient !== 'undefined' && sbClient) {
            try { sbClient.removeChannel(realtimeChannel); } catch (e) {}
        }
        realtimeChannel = null;
        watching = false;
    }

    function conflictCopyName(relPath) {
        const stamp = new Date().toISOString().slice(0, 10);
        const slash = relPath.lastIndexOf('/');
        const dir = slash >= 0 ? relPath.slice(0, slash + 1) : '';
        const base = slash >= 0 ? relPath.slice(slash + 1) : relPath;
        const dot = base.lastIndexOf('.');
        const name = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : '';
        return dir + name + ' (conflicted copy ' + stamp + ')' + ext;
    }

    // ---- áp dụng 1 quyết định lên 1 file ----

    async function pushFile(root, relPath, knownHash) {
        const uid = await getUserId();
        const base64 = await invoke('sync_read_file', { root, relativePath: relPath });
        const blob = b64toBlob(base64);
        await API.personalSync.uploadBytes(uid, relPath, blob);
        await API.personalSync.upsertFile(relPath, knownHash, blob.size);
        setLastSyncedHash(relPath, knownHash, blob.size);
        emitStatus('uploaded', relPath);
    }

    async function pullFileTo(root, sourceRelPath, destRelPath, remoteRow) {
        if (!root) return;
        const uid = await getUserId();
        const blob = await API.personalSync.downloadBytes(uid, sourceRelPath);
        const base64 = await blobToBase64(blob);
        suppressUntil[destRelPath] = Date.now() + SUPPRESS_MS;
        await invoke('sync_write_file', { root, relativePath: destRelPath, contentBase64: base64 });
        if (destRelPath === sourceRelPath) {
            setLastSyncedHash(destRelPath, remoteRow ? remoteRow.content_hash : null, remoteRow ? remoteRow.size : null);
        }
        emitStatus('downloaded', destRelPath);
    }

    async function removeLocalCopy(root, relPath) {
        suppressUntil[relPath] = Date.now() + SUPPRESS_MS;
        await invoke('sync_delete_file', { root, relativePath: relPath });
        setLastSyncedHash(relPath, null);
        emitStatus('deleted-remote', relPath);
    }

    async function removeRemoteCopy(relPath) {
        const uid = await getUserId();
        await API.personalSync.markDeleted(relPath);
        await API.personalSync.deleteBytes(uid, relPath);
        setLastSyncedHash(relPath, null);
        emitStatus('deleted', relPath);
    }

    // Thực hiện 'action' đã quyết định. local/remote là {hash,size}|null.
    async function applyAction(action, root, relPath, local, remoteRow) {
        switch (action) {
            case 'record': setLastSyncedHash(relPath, local.hash, local.size); return 'noop';
            case 'forget': setLastSyncedHash(relPath, null); return 'noop';
            case 'push': await pushFile(root, relPath, local.hash); return 'uploaded';
            case 'pull': await pullFileTo(root, relPath, relPath, remoteRow); return 'downloaded';
            case 'delete-local': await removeLocalCopy(root, relPath); return 'deleted';
            case 'delete-remote': await removeRemoteCopy(relPath); return 'deleted';
            case 'conflict':
                // Cả 2 bên đều đổi: giữ bản đám mây thành "conflicted copy", bản ở máy là bản chính.
                await pullFileTo(root, relPath, conflictCopyName(relPath), remoteRow);
                emitStatus('conflict', relPath);
                await pushFile(root, relPath, local.hash);
                return 'conflict';
            default: return 'noop';
        }
    }

    function bumpCount(kind) {
        if (kind === 'uploaded') state.counts.uploaded++;
        else if (kind === 'downloaded') state.counts.downloaded++;
        else if (kind === 'deleted') state.counts.deleted++;
        else if (kind === 'conflict') state.counts.conflicts++;
    }

    // Đối chiếu ĐÚNG 1 file (dùng cho sự kiện thay đổi theo thời gian thực). remoteRow: undefined => tự tra.
    async function reconcilePath(root, relPath, remoteRowOverride) {
        if (isTempSyncPath(relPath)) return 'skip';
        const exists = await invoke('sync_file_exists', { root, relativePath: relPath });
        const local = exists
            ? { hash: await invoke('sync_hash_file', { root, relativePath: relPath }), size: null }
            : null;
        const last = loadHashCache()[relPath] || null;
        const remoteRow = remoteRowOverride !== undefined ? remoteRowOverride : await API.personalSync.getFile(relPath);
        const remoteHash = remoteRow && !remoteRow.deleted ? remoteRow.content_hash : null;
        const action = decideSyncAction({ local: local && local.hash, last, remote: remoteHash });
        return applyAction(action, root, relPath, local, remoteRow);
    }

    async function guarded(relPath, fn) {
        try { return await fn(); }
        catch (err) {
            console.error('PersonalSync: lỗi đồng bộ', relPath, err);
            const message = describeSyncError(err);
            state.failures = state.failures.filter(f => f.path !== relPath).concat([{ path: relPath, message }]);
            emitStatus('error', { relPath, message, err });
            return 'error';
        }
    }

    // ---- local change -> cloud ----

    function handleLocalChanges(relativePaths) {
        const root = getRoot();
        if (!root) return;
        const paths = relativePaths.filter(p => !isTempSyncPath(p) && !(suppressUntil[p] && Date.now() < suppressUntil[p]));
        if (!paths.length) return;
        return enqueue(async () => { try {
            const cache = loadHashCache();
            let localListing = null; // chỉ liệt kê thư mục khi thật sự có đường dẫn không phải file
            const targets = new Set();
            for (const relPath of paths) {
                const isFile = await invoke('sync_file_exists', { root, relativePath: relPath });
                if (isFile) { targets.add(relPath); continue; }
                // Không phải file: có thể là file vừa bị xoá, hoặc 1 THƯ MỤC vừa bị xoá/di chuyển/tạo. Sự kiện chỉ nêu
                // đường dẫn thư mục, nên phải tự mở rộng ra các file bên trong (đang theo dõi + đang có trên đĩa).
                targets.add(relPath);
                const prefix = relPath + '/';
                Object.keys(cache).forEach(p => { if (p.startsWith(prefix)) targets.add(p); });
                if (localListing === null) {
                    try { localListing = await invoke('sync_list_folder', { root }); } catch (e) { localListing = []; }
                }
                localListing.forEach(f => { if (f.relativePath.startsWith(prefix)) targets.add(f.relativePath); });
            }
            for (const relPath of targets) {
                if (isTempSyncPath(relPath)) continue;
                const kind = await guarded(relPath, () => reconcilePath(root, relPath));
                if (kind && kind !== 'error' && kind !== 'noop' && kind !== 'skip') {
                    // một file tự lành sau lần lỗi trước
                    state.failures = state.failures.filter(f => f.path !== relPath);
                }
            }
        } catch (err) { console.warn('PersonalSync: lỗi khi mở rộng sự kiện thư mục', err); } });
    }

    // ---- remote change -> local ----

    function handleRemoteChange(payload) {
        const root = getRoot();
        if (!root) return;
        const row = payload.new || payload.old;
        if (!row || !row.relative_path) return;
        const relPath = row.relative_path;
        if (isTempSyncPath(relPath)) return;
        const remoteRow = payload.eventType === 'DELETE' ? null : payload.new;
        return enqueue(() => guarded(relPath, () => reconcilePath(root, relPath, remoteRow)));
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // ---- initial link / periodic full reconcile ----

    // deep=true: băm MỌI file (lúc khởi động / bấm "Đồng bộ lại"). deep=false (lượt định kỳ): bỏ qua băm với file
    // có kích thước không đổi và đã khớp đám mây -- sự thay đổi ngay lúc app đang mở đã có trình theo dõi bắt.
    function fullReconcile(opts) {
        return enqueue(() => fullReconcileInner(opts || {}));
    }

    async function fullReconcileInner(opts) {
        const root = getRoot();
        if (!root || !isTauri()) return;
        if (!watching) {
            try { await startWatching(); }
            catch (err) {
                const message = 'Không mở được thư mục đã liên kết (' + describeSyncError(err) + '). Thư mục còn tồn tại không?';
                state.phase = 'error'; state.lastError = message;
                emitStatus('error', { relPath: root, message, err });
                throw new Error(message);
            }
        }
        state.phase = 'reconciling';
        state.lastError = null;
        state.counts = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0 };
        state.failures = []; // guarded() cộng dồn lỗi từng file vào đây suốt lượt
        state.progress = { done: 0, total: 0 };
        emitStatus('reconciling');

        try {
            const [rawLocal, remoteFiles] = await Promise.all([
                invoke('sync_list_folder', { root }),
                API.personalSync.listFiles()
            ]);
            const localFiles = rawLocal.filter(f => !isTempSyncPath(f.relativePath));
            const remoteByPath = {};
            remoteFiles.forEach(f => { if (!isTempSyncPath(f.relative_path)) remoteByPath[f.relative_path] = f; });
            const cache = loadHashCache();
            const sizes = loadJson(SIZE_CACHE_KEY);
            const localByPath = {};
            localFiles.forEach(f => { localByPath[f.relativePath] = f; });

            // 1) Lập kế hoạch cho mọi đường dẫn đã biết (máy ∪ đám mây ∪ đang theo dõi) -- chưa động vào gì.
            const allPaths = new Set([...Object.keys(localByPath), ...Object.keys(remoteByPath), ...Object.keys(cache)]);
            const plan = [];
            let deleteCount = 0;
            for (const relPath of allPaths) {
                const entry = localByPath[relPath];
                let localHash = null;
                if (entry) {
                    const known = remoteByPath[relPath];
                    const unchangedSize = !opts.deep && cache[relPath] && known && known.content_hash === cache[relPath]
                        && sizes[relPath] === entry.size && Number(known.size) === entry.size;
                    localHash = unchangedSize
                        ? cache[relPath]
                        : await guarded(relPath, () => invoke('sync_hash_file', { root, relativePath: relPath }));
                    if (localHash === 'error') continue; // băm lỗi (file đang bị khoá): bỏ qua, lần sau thử lại
                }
                const remoteRow = remoteByPath[relPath] || null;
                const action = decideSyncAction({ local: localHash, last: cache[relPath] || null, remote: remoteRow ? remoteRow.content_hash : null });
                if (action === 'delete-local' || action === 'delete-remote') deleteCount++;
                if (action !== 'noop') plan.push({ relPath, action, local: entry ? { hash: localHash, size: entry.size } : null, remoteRow });
            }

            // 2) Chốt chặn an toàn trước khi xoá bất cứ thứ gì.
            if (!opts.force && isSuspiciousMassDelete(deleteCount, Object.keys(cache).length, localFiles.length)) {
                const message = 'Phát hiện bất thường: ' + deleteCount + ' file sắp bị xoá (thư mục trống hoặc không truy cập được?). Đã dừng để bảo vệ dữ liệu — kiểm tra thư mục "' + root + '" rồi bấm Đồng bộ lại.';
                state.phase = 'error'; state.lastError = message; state.progress = null;
                emitStatus('error', { relPath: root, message });
                return;
            }

            // 3) Thực hiện, mỗi file độc lập: file lỗi không chặn các file còn lại.
            state.progress = { done: 0, total: plan.length };
            for (const item of plan) {
                const kind = await guarded(item.relPath, () => applyAction(item.action, root, item.relPath, item.local, item.remoteRow));
                if (kind !== 'error') bumpCount(kind);
                state.progress.done++;
            }

            const failures = state.failures.slice();
            state.lastRunAt = Date.now();
            state.progress = null;
            state.phase = failures.length ? 'error' : 'idle';
            state.lastError = failures.length ? (failures.length + ' file chưa đồng bộ được') : null;
            emitStatus('reconciled', { failures }); // giữ tên trạng thái cũ để giao diện cũ (Sci/Org) vẫn hiển thị đúng
        } catch (err) {
            const message = describeSyncError(err);
            state.phase = 'error'; state.lastError = message; state.progress = null;
            emitStatus('error', { relPath: root, message, err });
            throw err;
        }
    }

    // ---- tự khởi động khi mở app ----

    function startTimer() {
        if (reconcileTimer) return;
        reconcileTimer = setInterval(() => {
            if (watching && getRoot()) fullReconcile({ deep: false }).catch(() => {});
        }, RECONCILE_INTERVAL_MS);
    }

    function stopTimer() {
        if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
    }

    async function hasSession() {
        try {
            if (typeof sbClient === 'undefined' || !sbClient) return false;
            const { data } = await sbClient.auth.getSession();
            return !!(data && data.session);
        } catch (e) { return false; }
    }

    // Khởi động đồng bộ nền: gọi được nhiều lần. Chỉ chạy khi: bản desktop + đã liên kết thư mục + đã đăng nhập.
    async function init() {
        if (!isTauri() || !getRoot() || started) return false;
        if (!(await hasSession())) return false;
        started = true;
        cachedUserId = null;
        try {
            const uid = await getUserId();
            const owner = localStorage.getItem(OWNER_KEY);
            if (owner && uid && owner !== uid) {
                // Máy này đang liên kết thư mục cho TÀI KHOẢN KHÁC: tuyệt đối không đẩy file đó vào kho của người này.
                await unlinkFolder();
                started = false;
                emitStatus('error', { relPath: '', message: 'Thư mục này đã liên kết cho tài khoản khác nên được gỡ khỏi máy này.' });
                return false;
            }
            if (!owner && uid) localStorage.setItem(OWNER_KEY, uid); // liên kết cũ chưa ghi chủ: nhận người đăng nhập hiện tại
            await startWatching();
            startTimer();
            fullReconcile({ deep: true }).catch(err => console.warn('PersonalSync: đối chiếu khi khởi động lỗi', err));
            return true;
        } catch (err) {
            started = false;
            const message = 'Không bật được đồng bộ thư mục: ' + describeSyncError(err);
            state.phase = 'error'; state.lastError = message;
            emitStatus('error', { relPath: getRoot(), message, err });
            return false;
        }
    }

    async function shutdown() {
        started = false;
        stopTimer();
        await stopWatching();
        cachedUserId = null;
    }

    // Tự gọi init() ngay khi mở app, không cần mở Không Gian Riêng. Đăng nhập có thể xong sau khi trang tải
    // (hoặc người dùng đăng xuất rồi vào bằng tài khoản khác) nên vừa hỏi phiên định kỳ vừa nghe onAuthStateChange.
    function autoStart() {
        if (!isTauri()) return;
        let waited = 0;
        const poll = setInterval(async () => {
            waited += SESSION_POLL_MS;
            if (started || !getRoot() || waited > SESSION_POLL_MAX_MS) { clearInterval(poll); return; }
            if (await init()) clearInterval(poll);
        }, SESSION_POLL_MS);
        try {
            if (typeof sbClient !== 'undefined' && sbClient && sbClient.auth && sbClient.auth.onAuthStateChange) {
                sbClient.auth.onAuthStateChange((event) => {
                    if (event === 'SIGNED_OUT') shutdown().catch(() => {});
                    else if (event === 'SIGNED_IN') setTimeout(() => init().catch(() => {}), 500);
                });
            }
        } catch (e) { /* không chặn */ }
    }

    if (document.readyState === 'complete') setTimeout(autoStart, 1500);
    else window.addEventListener('load', () => setTimeout(autoStart, 1500));

    return {
        isTauri,
        getRoot,
        pickFolder,
        linkFolder,
        unlinkFolder,
        startWatching,
        fullReconcile,
        init,
        onStatus,
        getState,
        isWatching: () => watching
    };
})();
