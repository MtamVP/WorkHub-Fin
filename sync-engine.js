window.WorkHubSync = (function () {
    var cfg = window.WORKHUB_SYNC_CONFIG || {};
    var db = null;
    var dbFailed = false;
    // Trước đây luôn khởi tạo true -- nếu mở app khi ĐANG offline sẵn (vd. bật chế độ máy
    // bay trước khi mở app), sự kiện 'offline' của trình duyệt chỉ bắn lúc CHUYỂN trạng
    // thái, không bắn cho trạng thái đã offline sẵn từ đầu, và callback Realtime cũng có
    // thể chưa kịp chạy -- online bị kẹt ở true sai, khiến ghi dữ liệu đi thẳng qua
    // dispatch() thay vì queueWrite(), làm hỏng đúng cam kết "ghi được cả lúc offline" mà
    // module này tồn tại để đảm bảo. navigator.onLine là phỏng đoán tốt nhất có sẵn ngay
    // lúc script chạy, dù không hoàn hảo 100% (không phát hiện được kiểu "có mạng LAN
    // nhưng không ra được Internet") vẫn đúng hơn hẳn so với luôn giả định true.
    var online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    var statusListeners = [];

    function tauriSql() {
        return window.__TAURI__ && window.__TAURI__.sql ? window.__TAURI__.sql : null;
    }

    async function getDb() {
        if (db) return db;
        if (dbFailed) return null;
        var sql = tauriSql();
        if (!sql || !sql.Database) { dbFailed = true; return null; }
        try {
            db = await sql.Database.load(cfg.dbFile);
            return db;
        } catch (e) {
            console.warn('[sync-engine] Không mở được SQLite cache:', e);
            dbFailed = true;
            return null;
        }
    }

    // Khoá bộ nhớ đệm của 1 lệnh đọc = băm TOÀN BỘ tham số. Bản cũ lấy base64 của JSON rồi cắt còn 64 ký tự => tham số chỉ khác
    // nhau sau khoảng 48 byte đầu (vd email dài rồi mới tới mã cổ phiếu) ra CÙNG khoá, và lúc mất mạng app trả dữ liệu của lệnh khác.
    // cyrb53 (băm 53 bit, hai làn 32 bit) trên cả chuỗi JSON, kèm độ dài: trùng khoá gần như không thể với số lệnh của một người.
    function hash(params) {
        var str;
        try { str = JSON.stringify(params || {}); } catch (e) { str = String(params && params.id || params && params.projectId || 'x'); }
        var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (var i = 0; i < str.length; i++) {
            var ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 'v2_' + str.length + '_' + (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
    }

    function genTrace() {
        return 'TRC_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    function isReadAction(action) {
        return action.indexOf('get') === 0 || action.indexOf('list') === 0;
    }
    function isWriteAction(action) {
        return !!(window.MUTATING_ACTIONS && window.MUTATING_ACTIONS.has(action));
    }

    // Every call from callGAS funnels through here. Online: dispatch for real, and for reads,
    // write the result through to the local cache so it's available next time we're offline.
    // Offline: reads are served from that cache, writes are queued for replay on reconnect.
    async function handle(action, params, dispatch) {
        if (!window.__TAURI__) return dispatch(action, params);

        if (online) {
            var result = await dispatch(action, params);
            if (isReadAction(action) && result && result.status === 'success') {
                cacheRead(action, params, result);
            }
            return result;
        }
        if (isReadAction(action)) return readFromCache(action, params);
        if (isWriteAction(action)) return queueWrite(action, params);
        return dispatch(action, params);
    }

    async function cacheRead(action, params, result) {
        var d = await getDb();
        if (!d) return;
        try {
            await d.execute(
                'INSERT OR REPLACE INTO cache_responses (action, params_hash, response_json, cached_at) VALUES (?,?,?,?)',
                [action, hash(params), JSON.stringify(result), Date.now()]
            );
        } catch (e) { console.warn('[sync-engine] cacheRead failed:', e); }
    }

    async function readFromCache(action, params) {
        var d = await getDb();
        if (!d) return { status: 'error', data: null, message: 'Không có kết nối và chưa có dữ liệu ngoại tuyến.' };
        try {
            var rows = await d.select(
                'SELECT response_json FROM cache_responses WHERE action = ? AND params_hash = ?',
                [action, hash(params)]
            );
            if (!rows || !rows.length) {
                return { status: 'error', data: null, message: 'Không có dữ liệu ngoại tuyến cho thao tác này.' };
            }
            var parsed = JSON.parse(rows[0].response_json);
            return Object.assign({}, parsed, { message: '(dữ liệu ngoại tuyến) ' + (parsed.message || '') });
        } catch (e) {
            return { status: 'error', data: null, message: 'Lỗi đọc cache ngoại tuyến: ' + e };
        }
    }

    async function queueWrite(action, params) {
        var d = await getDb();
        if (!d) return { status: 'error', data: null, message: 'Đang mất mạng và không dùng được lưu tạm ngoại tuyến.' };
        var id = 'Q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        try {
            await d.execute(
                'INSERT INTO sync_queue (id, action, params_json, created_at, status) VALUES (?,?,?,?,?)',
                [id, action, JSON.stringify(params), Date.now(), 'pending']
            );
        } catch (e) {
            return { status: 'error', data: null, message: 'Lỗi lưu thao tác ngoại tuyến: ' + e };
        }
        return { status: 'success', data: params, message: 'Đã lưu ngoại tuyến — sẽ đồng bộ khi có mạng.' };
    }

    // Lỗi do MẠNG (chưa ra được Internet dù trình duyệt báo 'online'): giữ thao tác trong hàng đợi để thử lại, KHÔNG coi là xung đột.
    function isNetworkError(msg) {
        return /failed to fetch|networkerror|network request failed|load failed|err_internet|err_network|timed? ?out|timeout|fetch.*abort|econn|enotfound|mất mạng/i.test(String(msg || ''));
    }

    // Khoá: sự kiện 'online' của trình duyệt và kênh Realtime báo SUBSCRIBED thường đến gần như cùng lúc. Bản cũ chạy 2 lượt song song,
    // cả hai đọc cùng danh sách 'pending' => MỖI thao tác ghi ngoại tuyến bị gửi 2 lần (vd 1 lệnh mua thành 2 lệnh).
    var flushing = null;
    function flushQueue() {
        if (flushing) return flushing;
        flushing = flushQueueInner().finally(function () { flushing = null; });
        return flushing;
    }

    async function flushQueueInner() {
        var d = await getDb();
        if (!d || !window._dispatchAction) return;
        var rows;
        try {
            rows = await d.select("SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at ASC");
        } catch (e) { console.warn('[sync-engine] flushQueue read failed:', e); return; }

        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var params = JSON.parse(row.params_json);
            try {
                var result = await window._dispatchAction(row.action, params);
                if (result && result.status === 'error') throw new Error(result.message || 'Lỗi không rõ');
                await d.execute('DELETE FROM sync_queue WHERE id = ?', [row.id]);
            } catch (err) {
                if (isNetworkError(err && err.message || err)) {
                    // Mạng chưa thông: dừng lượt này, giữ nguyên thao tác này và các thao tác sau (đúng thứ tự) cho lần có mạng kế tiếp.
                    console.warn('[sync-engine] flushQueue: mạng chưa sẵn sàng, thử lại sau', err);
                    return;
                }
                await d.execute('DELETE FROM sync_queue WHERE id = ?', [row.id]);
                await d.execute(
                    'INSERT INTO sync_conflicts (id, original_queue_id, action, params_json, error_message, occurred_at) VALUES (?,?,?,?,?,?)',
                    ['C_' + row.id, row.id, row.action, row.params_json, (err && err.message) || String(err), Date.now()]
                );
                window.dispatchEvent(new CustomEvent('workhub-sync-conflict'));
            }
        }
    }

    // Mỗi lần xác nhận CÓ MẠNG đều thử đẩy hàng đợi (có khoá nên không chạy chồng; hàng đợi trống thì chỉ tốn 1 câu SELECT). Bản cũ chỉ
    // đẩy khi CHUYỂN từ mất mạng sang có mạng => thao tác ghi lúc ngoại tuyến ở phiên trước KHÔNG BAO GIỜ được gửi nếu lần mở app sau đã
    // có mạng sẵn (không có lần "chuyển" nào), và thao tác dừng lại vì mạng chưa thông cũng không được thử lại.
    function setOnline(next) {
        online = next;
        if (online) flushQueue();
        statusListeners.forEach(function (cb) { cb(online); });
    }

    // Primary connectivity signal: the app's existing Supabase Realtime status callback
    // (see script.js's realtime subscription, which already drives the UI's realtime dot).
    function onRealtimeStatus(status) {
        setOnline(status === 'SUBSCRIBED');
    }

    window.addEventListener('online', function () { setOnline(true); });
    window.addEventListener('offline', function () { setOnline(false); });
    // Lúc mở app khi đang có mạng: đẩy những gì còn trong hàng đợi từ phiên trước (chờ đăng nhập xong)
    if (window.__TAURI__ && online) setTimeout(function () { if (online) flushQueue(); }, 8000);

    async function discardConflict(conflictId) {
        var d = await getDb();
        if (!d) return;
        await d.execute('DELETE FROM sync_conflicts WHERE id = ?', [conflictId]);
    }

    return {
        handle: handle,
        onRealtimeStatus: onRealtimeStatus,
        flushQueue: flushQueue,
        _hash: hash,
        discardConflict: discardConflict,
        onStatusChange: function (cb) { statusListeners.push(cb); },
        get isOnline() { return online; },
        debugDumpQueue: async function () {
            var d = await getDb();
            if (!d) return [];
            return d.select('SELECT * FROM sync_queue');
        },
        debugDumpConflicts: async function () {
            var d = await getDb();
            if (!d) return [];
            return d.select('SELECT * FROM sync_conflicts');
        },
        debugDumpCache: async function () {
            var d = await getDb();
            if (!d) return [];
            return d.select('SELECT action, params_hash, cached_at FROM cache_responses');
        }
    };
})();
