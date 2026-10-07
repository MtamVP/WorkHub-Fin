// Lưu lịch sử ảnh chụp thị trường vào MÁY NÀY (app Tauri), không ghi gì lên Supabase. Chạy ở trang gốc cùng local-backup.js; cần lib/market-history.js nạp trước.
// Mỗi lần mở app (và mỗi giờ khi đang mở): nếu máy chủ có ngày dữ liệu mới hơn tệp mới nhất đã lưu thì tải ảnh chụp (finance_market_snapshot + finance_sector_stats, chỉ ĐỌC),
// nén gzip và ghi thành market-history/snapshot-YYYY-MM-DD.json.gz trong thư mục dữ liệu của app (AppLocalData). Không xoá tệp cũ.
// Nếu quản lý đã chọn thư mục mạng ở mục Sao lưu (wh_backup_network_path) thì ghi thêm một bản vào <thư mục mạng>/market-history/ (cùng cách của local-backup.js).
// Ngày app không mở = không có tệp ngày đó (có thể có khoảng trống); người dùng không thuộc nhóm có quyền đọc ảnh chụp thì bỏ qua lặng lẽ.
(function () {
    var DIR = 'market-history';
    var CHECK_INTERVAL_MS = 60 * 60 * 1000;
    var busy = false;
    var status = { state: 'idle', summary: null, dir: null, error: null, lastSavedAt: null };

    function tauri() { return window.__TAURI__ && window.__TAURI__.fs && window.__TAURI__.core ? window.__TAURI__ : null; }

    async function fetchAll(build) {
        var out = [];
        for (var from = 0; ; from += 1000) {
            var res = await build().range(from, from + 999);
            if (res.error) throw res.error;
            var data = res.data || [];
            out = out.concat(data);
            if (data.length < 1000) break;
        }
        return out;
    }

    async function gzip(text) {
        var stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    function toBase64(bytes) {
        var bin = '', CH = 0x8000;
        for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        return btoa(bin);
    }

    async function listFiles(fs) {
        var base = fs.BaseDirectory.AppLocalData;
        if (!(await fs.exists(DIR, { baseDir: base }))) return [];
        var entries = await fs.readDir(DIR, { baseDir: base });
        return entries.map(function (e) { return e.name; }).filter(Boolean);
    }

    async function refreshStatus() {
        var T = tauri(); if (!T) return status;
        try {
            status.summary = MarketHistory.summarize(await listFiles(T.fs));
            if (T.path && T.path.appLocalDataDir) status.dir = (await T.path.appLocalDataDir()).replace(/[\\/]+$/, '') + '\\' + DIR;
        } catch (e) { status.error = String(e && e.message || e); }
        return status;
    }

    // force=true: lưu ngay cả khi đã có tệp cùng ngày (ghi đè)
    async function run(force) {
        var T = tauri(), sb = window.supabaseClient;
        if (!T || !sb || busy || typeof MarketHistory === 'undefined' || typeof CompressionStream === 'undefined') return status;
        busy = true; status.state = 'checking'; status.error = null;
        try {
            var sess = await sb.auth.getSession();
            if (!sess || !sess.data || !sess.data.session) { status.state = 'idle'; return status; }
            var files = await listFiles(T.fs);
            // hỏi ngày dữ liệu mới nhất trước (một dòng) để khỏi tải cả ảnh chụp khi chưa có gì mới
            var head = await sb.from('finance_sector_stats').select('as_of').order('as_of', { ascending: false }).limit(1);
            var serverDate = !head.error && head.data && head.data[0] ? head.data[0].as_of : null;
            if (!force && serverDate && !MarketHistory.shouldArchive(serverDate, files)) { status.state = 'ok'; await refreshStatus(); return status; }
            var snap = await fetchAll(function () { return sb.from('finance_market_snapshot').select('symbol, icb2_code, daily_date, quarter_date, metrics').order('symbol'); });
            var st = await sb.from('finance_sector_stats').select('icb2_code, n, as_of, stats');
            if (st.error) throw st.error;
            var stats = {}; (st.data || []).forEach(function (r) { stats[r.icb2_code] = { n: r.n, as_of: r.as_of, stats: r.stats || {} }; });
            var pack = MarketHistory.pack(snap, stats);
            if (!pack) { status.state = 'skipped'; status.error = 'Ảnh chụp trống hoặc quá ít mã: không lưu.'; return status; }
            if (!force && !MarketHistory.shouldArchive(pack.asOf, files)) { status.state = 'ok'; await refreshStatus(); return status; }
            var bytes = await gzip(JSON.stringify(pack));
            var base = T.fs.BaseDirectory.AppLocalData, name = MarketHistory.fileName(pack.asOf);
            if (!(await T.fs.exists(DIR, { baseDir: base }))) await T.fs.mkdir(DIR, { baseDir: base, recursive: true });
            await T.fs.writeFile(DIR + '/' + name, bytes, { baseDir: base });
            status.lastSavedAt = new Date().toISOString(); status.state = 'saved';
            writeNetworkCopy(name, bytes);                       // best-effort
            await refreshStatus();
            if (window.WorkHubFilterWatch) window.WorkHubFilterWatch.afterArchive(pack);   // bộ lọc đã lưu: so với ngày trước, báo mã mới lọt vào (best-effort)
        } catch (e) {
            status.state = 'error'; status.error = String(e && e.message || e);
            console.warn('[market-history]', e);
        } finally { busy = false; }
        return status;
    }

    async function writeNetworkCopy(name, bytes) {
        try {
            var root = localStorage.getItem('wh_backup_network_path');
            if (!root) return;
            await window.__TAURI__.core.invoke('sync_write_file', { root: root, relativePath: DIR + '/' + name, contentBase64: toBase64(bytes) });
        } catch (e) { console.warn('[market-history] network copy skipped/failed:', e); }
    }

    window.WorkHubMarketHistory = { runNow: function () { return run(false); }, runForce: function () { return run(true); }, status: function () { return status; }, refreshStatus: refreshStatus };

    function start() {
        setTimeout(function () { run(false); }, 20000);          // đợi app đăng nhập xong rồi mới kiểm
        setInterval(function () { run(false); }, CHECK_INTERVAL_MS);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
