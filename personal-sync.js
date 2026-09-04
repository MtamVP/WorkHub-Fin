// Personal Hub — local folder ↔ Supabase Storage bidirectional sync.
//
// The linked folder's absolute path lives only in this device's localStorage (never synced —
// each machine points at its own local copy, same as OneDrive/Dropbox). The cloud side is one
// private Storage bucket ('personal_files', path `${uid}/${relativePath}`) plus a bookkeeping
// table (personal_sync_files) that tracks each file's last-known content hash, used to detect
// whether a change came from "just me" or "someone else changed it too" (a real conflict).
//
// File I/O for the linked folder goes through Rust commands (sync_*), not the fs plugin's JS
// API, because the fs plugin's capability scope stays locked to $APPLOCALDATA for everything
// else in the app — see src-tauri/src/lib.rs.

window.PersonalSync = (function () {
    const ROOT_KEY = 'wh_personal_sync_root';
    const HASH_CACHE_KEY = 'wh_personal_sync_hashes'; // { relativePath: lastSyncedHash }
    const SUPPRESS_MS = 4000; // ignore a local-change event we caused ourselves via download/conflict-write

    let watching = false;
    let cachedUserId = null;
    let realtimeChannel = null;
    let statusListeners = [];
    let unlistenLocalChange = null; // trả về từ __TAURI__.event.listen(), gọi lúc stopWatching()
    const suppressUntil = {}; // relativePath -> timestamp

    function isTauri() {
        return !!(window.__TAURI__ && window.__TAURI__.core);
    }

    function invoke(cmd, args) {
        return window.__TAURI__.core.invoke(cmd, args || {});
    }

    function getRoot() {
        return localStorage.getItem(ROOT_KEY) || null;
    }

    function loadHashCache() {
        try { return JSON.parse(localStorage.getItem(HASH_CACHE_KEY) || '{}'); }
        catch (e) { return {}; }
    }

    function saveHashCache(cache) {
        localStorage.setItem(HASH_CACHE_KEY, JSON.stringify(cache));
    }

    function setLastSyncedHash(relPath, hash) {
        const cache = loadHashCache();
        if (hash) cache[relPath] = hash; else delete cache[relPath];
        saveHashCache(cache);
    }

    function emitStatus(status, detail) {
        statusListeners.forEach(fn => { try { fn(status, detail); } catch (e) {} });
    }

    function onStatus(fn) { statusListeners.push(fn); }

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
        localStorage.setItem(ROOT_KEY, path);
        saveHashCache({});
        await startWatching();
        await fullReconcile();
    }

    async function unlinkFolder() {
        await stopWatching();
        localStorage.removeItem(ROOT_KEY);
        saveHashCache({});
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
            handleLocalChanges(event.payload || []);
        });
        if (!realtimeChannel) {
            realtimeChannel = API.personalSync.subscribe(handleRemoteChange);
        }
    }

    async function stopWatching() {
        if (isTauri()) { try { await invoke('sync_stop_watch'); } catch (e) {} }
        if (unlistenLocalChange) { try { unlistenLocalChange(); } catch (e) {} unlistenLocalChange = null; }
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

    // ---- local change -> cloud ----

    async function handleLocalChanges(relativePaths) {
        const root = getRoot();
        if (!root) return;
        for (const relPath of relativePaths) {
            if (suppressUntil[relPath] && Date.now() < suppressUntil[relPath]) continue;
            await syncOneLocalPath(root, relPath);
        }
    }

    async function syncOneLocalPath(root, relPath) {
        try {
            const existsLocally = await invoke('sync_file_exists', { root, relativePath: relPath });
            const cache = loadHashCache();
            const lastSynced = cache[relPath] || null;

            if (!existsLocally) {
                if (lastSynced) {
                    const uid = await getUserId();
                    await API.personalSync.markDeleted(relPath);
                    await API.personalSync.deleteBytes(uid, relPath);
                    setLastSyncedHash(relPath, null);
                    emitStatus('deleted', relPath);
                }
                return;
            }

            const localHash = await invoke('sync_hash_file', { root, relativePath: relPath });
            if (localHash === lastSynced) return; // no real content change

            const remoteRow = await API.personalSync.getFile(relPath);
            const remoteHash = remoteRow && !remoteRow.deleted ? remoteRow.content_hash : null;

            if (remoteHash && remoteHash !== lastSynced && remoteHash !== localHash) {
                // Both sides changed since the last agreed state -> real conflict.
                // Preserve the remote version as a conflicted copy, then upload local as canonical.
                await pullFileTo(root, relPath, conflictCopyName(relPath), remoteRow);
                emitStatus('conflict', relPath);
            }

            await pushFile(root, relPath, localHash);
        } catch (err) {
            console.error('PersonalSync: lỗi đồng bộ (local->cloud)', relPath, err);
            emitStatus('error', { relPath, err });
        }
    }

    async function pushFile(root, relPath, knownHash) {
        const uid = await getUserId();
        const base64 = await invoke('sync_read_file', { root, relativePath: relPath });
        const blob = b64toBlob(base64);
        await API.personalSync.uploadBytes(uid, relPath, blob);
        await API.personalSync.upsertFile(relPath, knownHash, blob.size);
        setLastSyncedHash(relPath, knownHash);
        emitStatus('uploaded', relPath);
    }

    // ---- remote change -> local ----

    async function handleRemoteChange(payload) {
        const row = payload.new || payload.old;
        if (!row || !row.relative_path) return;
        const relPath = row.relative_path;
        const cache = loadHashCache();
        const lastSynced = cache[relPath] || null;

        if (row.deleted) {
            if (lastSynced) await removeLocalCopy(relPath);
            return;
        }
        if (row.content_hash && row.content_hash !== lastSynced) {
            await pullFileTo(getRoot(), relPath, relPath, row);
        }
    }

    async function pullFileTo(root, sourceRelPath, destRelPath, remoteRow) {
        if (!root) return;
        const uid = await getUserId();
        const blob = await API.personalSync.downloadBytes(uid, sourceRelPath);
        const base64 = await blobToBase64(blob);
        suppressUntil[destRelPath] = Date.now() + SUPPRESS_MS;
        await invoke('sync_write_file', { root, relativePath: destRelPath, contentBase64: base64 });
        if (destRelPath === sourceRelPath) {
            setLastSyncedHash(destRelPath, remoteRow ? remoteRow.content_hash : null);
        }
        emitStatus('downloaded', destRelPath);
    }

    async function removeLocalCopy(relPath) {
        const root = getRoot();
        if (!root) return;
        suppressUntil[relPath] = Date.now() + SUPPRESS_MS;
        try { await invoke('sync_delete_file', { root, relativePath: relPath }); } catch (e) {}
        setLastSyncedHash(relPath, null);
        emitStatus('deleted-remote', relPath);
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

    async function fullReconcile() {
        const root = getRoot();
        if (!root || !isTauri()) return;
        emitStatus('reconciling');
        const [localFiles, remoteFiles] = await Promise.all([
            invoke('sync_list_folder', { root }),
            API.personalSync.listFiles()
        ]);
        const localByPath = {};
        localFiles.forEach(f => { localByPath[f.relativePath] = f; });
        const remoteByPath = {};
        remoteFiles.forEach(f => { remoteByPath[f.relative_path] = f; });

        for (const relPath of Object.keys(localByPath)) {
            if (!remoteByPath[relPath]) {
                const hash = await invoke('sync_hash_file', { root, relativePath: relPath });
                await pushFile(root, relPath, hash);
            }
        }
        for (const relPath of Object.keys(remoteByPath)) {
            if (!localByPath[relPath]) {
                await pullFileTo(root, relPath, relPath, remoteByPath[relPath]);
            } else {
                const hash = await invoke('sync_hash_file', { root, relativePath: relPath });
                const remoteHash = remoteByPath[relPath].content_hash;
                if (hash === remoteHash) {
                    setLastSyncedHash(relPath, hash);
                    continue;
                }
                // So với lastSynced (không chỉ so local<->remote trực tiếp như bản cũ) để phân
                // biệt đúng 3 trường hợp, cùng logic 3 nhánh đã dùng ở syncOneLocalPath() phía
                // trên -- bản cũ coi MỌI lần khác nhau là xung đột "cả 2 bên đều đổi", kể cả khi
                // chỉ 1 bên (thường là remote, do máy khác đồng bộ trong lúc máy này không mở)
                // thực sự đổi -- ghi đè oan bản mới ở máy kia bằng nội dung cũ ở máy này.
                const cache = loadHashCache();
                const lastSynced = cache[relPath] || null;
                if (hash === lastSynced) {
                    // Máy này không đổi gì kể từ lần đồng bộ trước -- chỉ remote đổi, kéo về thôi.
                    await pullFileTo(root, relPath, relPath, remoteByPath[relPath]);
                } else if (remoteHash === lastSynced) {
                    // Remote không đổi kể từ lần đồng bộ trước -- chỉ máy này đổi, đẩy lên thôi.
                    await pushFile(root, relPath, hash);
                } else {
                    // Cả 2 bên đều đổi kể từ lần đồng bộ trước -- xung đột thật.
                    await pullFileTo(root, relPath, conflictCopyName(relPath), remoteByPath[relPath]);
                    await pushFile(root, relPath, hash);
                }
            }
        }
        emitStatus('reconciled');
    }

    return {
        isTauri,
        getRoot,
        pickFolder,
        linkFolder,
        unlinkFolder,
        startWatching,
        fullReconcile,
        onStatus,
        isWatching: () => watching
    };
})();
