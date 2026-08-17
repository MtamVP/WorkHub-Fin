window.WorkHubSync = (function () {
    var cfg = window.WORKHUB_SYNC_CONFIG || {};
    var db = null;
    var dbFailed = false;
    var online = true;
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

    function hash(params) {
        try {
            return btoa(unescape(encodeURIComponent(JSON.stringify(params || {})))).slice(0, 64);
        } catch (e) {
            return String(params && params.id || params && params.projectId || 'x');
        }
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

    async function flushQueue() {
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
                await d.execute('DELETE FROM sync_queue WHERE id = ?', [row.id]);
                await d.execute(
                    'INSERT INTO sync_conflicts (id, original_queue_id, action, params_json, error_message, occurred_at) VALUES (?,?,?,?,?,?)',
                    ['C_' + row.id, row.id, row.action, row.params_json, (err && err.message) || String(err), Date.now()]
                );
                window.dispatchEvent(new CustomEvent('workhub-sync-conflict'));
            }
        }
    }

    function setOnline(next) {
        var was = online;
        online = next;
        if (!was && online) flushQueue();
        statusListeners.forEach(function (cb) { cb(online); });
    }

    // Primary connectivity signal: the app's existing Supabase Realtime status callback
    // (see script.js's realtime subscription, which already drives the UI's realtime dot).
    function onRealtimeStatus(status) {
        setOnline(status === 'SUBSCRIBED');
    }

    window.addEventListener('online', function () { setOnline(true); });
    window.addEventListener('offline', function () { setOnline(false); });

    async function discardConflict(conflictId) {
        var d = await getDb();
        if (!d) return;
        await d.execute('DELETE FROM sync_conflicts WHERE id = ?', [conflictId]);
    }

    return {
        handle: handle,
        onRealtimeStatus: onRealtimeStatus,
        flushQueue: flushQueue,
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
