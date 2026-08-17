(function () {
    var RETENTION = 14;
    var CHECK_INTERVAL_MS = 60 * 60 * 1000;
    var DAY_MS = 24 * 60 * 60 * 1000;
    var LAST_KEY = 'wh_last_local_backup_at';

    function due() {
        var last = parseInt(localStorage.getItem(LAST_KEY) || '0', 10);
        return Date.now() - last >= DAY_MS;
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
                snapshot[t] = res.error ? { error: res.error.message } : res.data;
            } catch (e) {
                snapshot[t] = { error: String(e) };
            }
        }

        var stamp = new Date().toISOString().replace(/[:.]/g, '-');
        var fileName = dir + '/backup-' + stamp + '.json';
        await fs.writeTextFile(fileName, JSON.stringify(snapshot, null, 2), { baseDir: BaseDirectory.AppLocalData });
        localStorage.setItem(LAST_KEY, Date.now().toString());

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
