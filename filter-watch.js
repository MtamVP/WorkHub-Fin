// Theo dõi bộ lọc đã lưu (cả trang gốc và Valuation Bench): đọc lịch sử ảnh chụp thị trường lưu trong máy (market-history.js ghi), so bộ lọc đã lưu giữa hai ngày gần nhất rồi báo mã mới lọt vào / vừa rớt ra.
// - Trang gốc: sau khi market-history.js lưu tệp của ngày mới, gọi afterArchive(pack): so với ngày trước đó, cất kết quả vào localStorage (wh.fin.filterwatch.v1) và gửi MỘT thông báo hệ điều hành cho mỗi ngày dữ liệu nếu có mã mới lọt vào.
// - Valuation Bench (Thị trường): compute({ currentRows, currentAsOf }) tính theo yêu cầu để hiện thẻ "Thay đổi so với lần lưu trước".
// Chỉ ĐỌC tệp trong thư mục dữ liệu của app (cần quyền fs:allow-read-file từ bản 0.1.13), không ghi gì lên Supabase. Bản web (không có Tauri) trả state 'web'.
// Cần lib/market-history.js, lib/peer-valuation.js, lib/market-screener.js, lib/filter-watch.js nạp trước.
(function () {
    var DIR = 'market-history', SAVED_KEY = 'wh.fin.marketscreener.saved.v1', RESULT_KEY = 'wh.fin.filterwatch.v1', VALID_KEY = 'wh.fin.filtervalid.v1';

    function tauri() { return window.__TAURI__ && window.__TAURI__.fs ? window.__TAURI__ : null; }
    function savedFilters() {
        try { var v = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); return Array.isArray(v) ? v.filter(function (x) { return x && typeof x.name === 'string' && x.filters; }) : []; }
        catch (e) { return []; }
    }
    async function listDates(T) {
        var base = T.fs.BaseDirectory.AppLocalData;
        if (!(await T.fs.exists(DIR, { baseDir: base }))) return [];
        var entries = await T.fs.readDir(DIR, { baseDir: base });
        return entries.map(function (e) { return MarketHistory.dateOfFile(e.name); }).filter(Boolean).sort();
    }
    async function gunzipText(bytes) {
        var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).text();
    }
    // Đọc một ngày -> { asOf, rows (MarketScreener.buildRows), stats }; null nếu tệp hỏng
    async function loadDay(T, date) {
        var bytes = await T.fs.readFile(DIR + '/' + MarketHistory.fileName(date), { baseDir: T.fs.BaseDirectory.AppLocalData });
        var u = MarketHistory.unpack(JSON.parse(await gunzipText(bytes)));
        return u ? { asOf: u.asOf, rows: MarketScreener.buildRows(u.snapshot, u.stats, {}), stats: u.stats } : null;
    }

    // opts: { currentRows, currentAsOf } (dữ liệu mới nhất đang có trên màn hình) hoặc bỏ trống = dùng tệp mới nhất trong máy.
    // Trả { state: 'ok'|'web'|'nosaved'|'nodata'|'error', asOf, prevAsOf, items, message }.
    async function compute(opts) {
        var o = opts || {}, T = tauri();
        if (!T || typeof DecompressionStream === 'undefined') return { state: 'web', message: 'Theo dõi thay đổi chỉ có trên bản desktop (cần lịch sử ảnh chụp lưu trong máy).' };
        var saved = savedFilters();
        if (!saved.length) return { state: 'nosaved', message: 'Chưa có bộ lọc đã lưu. Lưu một bộ lọc ở trên để app theo dõi mã mới lọt vào hoặc rớt ra.' };
        try {
            var dates = await listDates(T), cur = null, curDate;
            if (o.currentRows && o.currentAsOf) { cur = { asOf: String(o.currentAsOf).slice(0, 10), rows: o.currentRows }; curDate = cur.asOf; }
            else if (dates.length) { curDate = dates[dates.length - 1]; cur = await loadDay(T, curDate); }
            if (!cur) return { state: 'nodata', message: 'Chưa có lịch sử ảnh chụp trong máy. App tự lưu mỗi ngày có dữ liệu mới; cần ít nhất 2 ngày để so sánh.' };
            var older = dates.filter(function (d) { return d < curDate; });
            if (!older.length) return { state: 'nodata', message: 'Mới có dữ liệu của một ngày. Ngày làm việc kế tiếp app sẽ so sánh và báo thay đổi.' };
            var prevDate = older[older.length - 1], prev = await loadDay(T, prevDate);
            if (!prev) return { state: 'error', message: 'Không đọc được tệp ngày ' + prevDate + '.' };
            return { state: 'ok', asOf: cur.asOf, prevAsOf: prev.asOf, items: FilterWatch.compare(saved, prev.rows, cur.rows) };
        } catch (e) {
            return { state: 'error', message: String(e && e.message || e) };
        }
    }

    // KIỂM CHỨNG: đọc mọi ngày lịch sử trong máy, tính mã lọt vào từng bộ lọc đã lưu và lợi suất 1/3/6 tháng sau so với trung vị thị trường (lib/filter-validate.js). Nặng (đọc cả thư mục) nên chỉ chạy khi bấm;
    // kết quả gọn cất ở localStorage (wh.fin.filtervalid.v1). onProgress({ done, total }) để vẽ tiến trình. Trả { state: 'ok'|'web'|'nosaved'|'nodata'|'error', ... }.
    async function validate(onProgress) {
        var T = tauri();
        if (!T || typeof DecompressionStream === 'undefined' || typeof FilterValidate === 'undefined') return { state: 'web', message: 'Kiểm chứng chỉ có trên bản desktop (cần lịch sử ảnh chụp lưu trong máy).' };
        var saved = savedFilters();
        if (!saved.length) return { state: 'nosaved', message: 'Chưa có bộ lọc đã lưu để kiểm chứng.' };
        try {
            var dates = await listDates(T);
            if (dates.length < 2) return { state: 'nodata', message: 'Mới có ' + dates.length + ' ngày lịch sử trong máy. Kiểm chứng cần ít nhất vài tuần, tốt nhất từ 3 tháng trở lên.' };
            var days = [], skipped = 0;
            for (var i = 0; i < dates.length; i++) {
                if (onProgress) onProgress({ done: i, total: dates.length });
                var d = null;
                try { d = await loadDay(T, dates[i]); } catch (e) { d = null; }
                if (d) { var ex = FilterValidate.extractDay(d.rows, saved); ex.date = d.asOf || dates[i]; days.push(ex); } else skipped++;
                await new Promise(function (r) { setTimeout(r, 0); });                 // nhường giao diện giữa các tệp
            }
            var res = FilterValidate.analyze(days, saved);
            var out = { state: 'ok', at: new Date().toISOString(), days: days.length, skipped: skipped, first: res.dates[0] || null, last: res.latest, filters: res.filters };
            try { localStorage.setItem(VALID_KEY, JSON.stringify(out)); } catch (e) { /* quá dung lượng: vẫn trả kết quả */ }
            return out;
        } catch (e) {
            return { state: 'error', message: String(e && e.message || e) };
        }
    }
    function lastValidation() { try { return JSON.parse(localStorage.getItem(VALID_KEY) || 'null'); } catch (e) { return null; } }

    function fire(title, body) {
        try {
            if (window.__TAURI__ && window.__TAURI__.notification) window.__TAURI__.notification.sendNotification({ title: title, body: body });
            else if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body: body });
        } catch (e) { /* không có quyền thông báo: kết quả vẫn được cất để hiện trong app */ }
    }
    function lastResult() { try { return JSON.parse(localStorage.getItem(RESULT_KEY) || 'null'); } catch (e) { return null; } }

    // Gọi sau khi lưu tệp của ngày mới (market-history.js). pack: kết quả MarketHistory.pack. Không ném lỗi.
    async function afterArchive(pack) {
        try {
            if (!pack || !pack.asOf || !savedFilters().length) return null;
            var u = MarketHistory.unpack(pack);
            if (!u) return null;
            var res = await compute({ currentRows: MarketScreener.buildRows(u.snapshot, u.stats, {}), currentAsOf: pack.asOf });
            if (res.state !== 'ok') return res;
            var before = lastResult(), t = FilterWatch.totals(res.items);
            var rec = { asOf: res.asOf, prevAsOf: res.prevAsOf, items: res.items.map(function (i) { return i.comparable ? { name: i.name, comparable: true, entered: i.entered.map(function (x) { return x.symbol; }), left: i.left.map(function (x) { return x.symbol; }) } : { name: i.name, comparable: false, why: i.why }; }), notified: before && before.asOf === res.asOf ? !!before.notified : false };
            if (t.entered > 0 && !rec.notified) {
                var lines = res.items.map(function (i) { return FilterWatch.summaryLine(i, 4); }).filter(Boolean);
                fire('Bộ lọc đã lưu có mã mới lọt vào', lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n…và ' + (lines.length - 3) + ' bộ lọc khác' : ''));
                rec.notified = true;
            }
            try { localStorage.setItem(RESULT_KEY, JSON.stringify(rec)); } catch (e) { /* bỏ qua */ }
            return res;
        } catch (e) { return null; }
    }

    window.WorkHubFilterWatch = { compute: compute, afterArchive: afterArchive, lastResult: lastResult, savedFilters: savedFilters, validate: validate, lastValidation: lastValidation };
})();
