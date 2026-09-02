(function () {
    var RETENTION = 14;
    var CHECK_INTERVAL_MS = 60 * 60 * 1000;
    var DAY_MS = 24 * 60 * 60 * 1000;
    var LAST_KEY = 'wh_last_local_backup_at';

    function due() {
        var last = parseInt(localStorage.getItem(LAST_KEY) || '0', 10);
        return Date.now() - last >= DAY_MS;
    }

    function utf8ToBase64(str) {
        var bytes = new TextEncoder().encode(str);
        var binary = '';
        bytes.forEach(function (b) { binary += String.fromCharCode(b); });
        return btoa(binary);
    }

    // Best-effort secondary copy to a TrueNAS/mapped-network-drive path, if the admin
    // has configured one (Backup & Restore panel -> "Chọn thư mục mạng"). Goes through
    // the sync_write_file/sync_list_folder/sync_delete_file Rust commands (already
    // registered for Personal Hub's local-folder-sync) rather than the fs plugin's JS
    // API, since the fs plugin's capability scope is locked to $APPLOCALDATA/** -- a
    // network path would be rejected by that scope regardless. Wrapped in try/catch so
    // an unreachable/unmounted NAS never breaks the primary local backup.
    async function writeNetworkCopy(baseFileName, jsonText) {
        try {
            var networkRoot = localStorage.getItem('wh_backup_network_path');
            if (!networkRoot || !window.__TAURI__ || !window.__TAURI__.core) return;
            var base64 = utf8ToBase64(jsonText);
            await window.__TAURI__.core.invoke('sync_write_file', {
                root: networkRoot, relativePath: baseFileName, contentBase64: base64
            });
            var entries = await window.__TAURI__.core.invoke('sync_list_folder', { root: networkRoot });
            var backups = entries.filter(function (e) { return e.relativePath && e.relativePath.indexOf('backup-') === 0; });
            backups.sort(function (a, b) { return a.relativePath < b.relativePath ? 1 : -1; });
            for (var j = RETENTION; j < backups.length; j++) {
                await window.__TAURI__.core.invoke('sync_delete_file', { root: networkRoot, relativePath: backups[j].relativePath });
            }
        } catch (e) {
            console.warn('[local-backup] network copy skipped/failed:', e);
        }
    }

    async function runBackup() {
        if (!window.__TAURI__ || !window.__TAURI__.fs || !window.supabaseClient) return;
        var tables = window.WORKHUB_BACKUP_TABLES || [];
        if (!tables.length) return;

        var fs = window.__TAURI__.fs;
        var BaseDirectory = fs.BaseDirectory;
        var dir = 'backups';

        var dirExists = await fs.exists(dir, { baseDir: BaseDirectory.AppLocalData });
        if (!dirExists) {
            await fs.mkdir(dir, { baseDir: BaseDirectory.AppLocalData, recursive: true });
        }

        var snapshot = {};
        for (var i = 0; i < tables.length; i++) {
            var t = tables[i];
            try {
                var res = await window.supabaseClient.from(t).select('*').limit(5000);
                // Backup files can end up on a shared/mapped drive -- never persist live
                // OAuth tokens in them. A stale token is useless on restore anyway; the
                // user just reconnects via the existing Calendar-connect flow.
                if (t === 'calendar_connections' && Array.isArray(res.data)) {
                    res.data = res.data.map(function (row) {
                        var copy = Object.assign({}, row);
                        delete copy.access_token;
                        delete copy.refresh_token;
                        return copy;
                    });
                }
                snapshot[t] = res.error ? { error: res.error.message } : res.data;
            } catch (e) {
                snapshot[t] = { error: String(e) };
            }
        }

        var stamp = new Date().toISOString().replace(/[:.]/g, '-');
        var baseFileName = 'backup-' + stamp + '.json';
        var fileName = dir + '/' + baseFileName;
        var jsonText = JSON.stringify(snapshot, null, 2);
        await fs.writeTextFile(fileName, jsonText, { baseDir: BaseDirectory.AppLocalData });
        localStorage.setItem(LAST_KEY, Date.now().toString());

        writeNetworkCopy(baseFileName, jsonText); // fire-and-forget, best-effort

        var entries = await fs.readDir(dir, { baseDir: BaseDirectory.AppLocalData });
        var backups = entries.filter(function (e) { return e.name && e.name.indexOf('backup-') === 0; });
        backups.sort(function (a, b) { return a.name < b.name ? 1 : -1; });
        for (var j = RETENTION; j < backups.length; j++) {
            await fs.remove(dir + '/' + backups[j].name, { baseDir: BaseDirectory.AppLocalData });
        }

        return fileName;
    }

    window.WorkHubBackup = { runNow: runBackup };

    function start() {
        if (due()) runBackup().catch(function (e) { console.warn('[local-backup]', e); });
        setInterval(function () {
            if (due()) runBackup().catch(function (e) { console.warn('[local-backup]', e); });
        }, CHECK_INTERVAL_MS);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
