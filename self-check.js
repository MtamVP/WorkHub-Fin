// Kiểm tra hệ thống (trang gốc, menu tài khoản > "Kiểm tra hệ thống"): bấm một lần để thử từng thứ mà app cài trên máy cần để chạy đủ tính năng, rồi báo đạt/chú ý/lỗi kèm lý do.
// Mỗi phép kiểm chỉ ĐỌC hoặc ghi một tệp tạm tên _selfcheck.tmp trong thư mục dữ liệu của app (rồi xoá); không ghi lên Supabase, không đụng sổ/NAV. Báo cáo không chứa khoá, token hay email.
// Phép chạy thật: phiên đăng nhập, hàm giá VCI (live-quotes), giá VNDirect, quyền ghi tệp (lịch sử ảnh chụp trong máy), thông báo hệ điều hành, ảnh chụp thị trường (số liệu mới đã nạp chưa),
// dữ liệu báo cáo (vb-data), và cả đường định giá hàng loạt cho 1 mã (nạp bộ máy định giá khi bấm). Cần lib/self-check.js, lib/vn-holidays.js, lib/live-quotes.js nạp trước.
(function () {
    var running = false, last = null;
    var VB_SCRIPTS = ['lib/quant-calc.js', 'lib/vb-statements.js', 'lib/vb-fundamental.js', 'lib/vb-dcf.js', 'lib/vb-asset.js', 'lib/vb-multiples.js', 'lib/vb-technical.js', 'lib/vb-market.js', 'lib/vb-synthesis.js', 'lib/vb-normalize.js',
        'lib/vb-process.js', 'lib/vb-engine.js', 'lib/market-batch.js', 'valuation/vb-scorecard.js'];   // peer-valuation và market-screener đã nạp sẵn ở trang gốc (theo dõi bộ lọc): nạp lại sẽ lỗi khai báo trùng

    function T() { return window.__TAURI__ || null; }
    function today() { return LiveQuotes.vnParts().date; }
    var fmtVnd = function (n) { return Math.round(Number(n) || 0).toLocaleString('vi-VN'); };
    var fmtDate = function (d) { return d ? String(d).split('-').reverse().join('/') : ''; };

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src + '?v=1792000000000'; s.async = false;
            s.onload = function () { resolve(); }; s.onerror = function () { reject(new Error('Không nạp được ' + src)); };
            document.head.appendChild(s);
        });
    }
    async function ensureEngine() {
        if (typeof VBEngine !== 'undefined' && typeof MarketBatch !== 'undefined' && typeof MarketScreener !== 'undefined') return;
        for (var i = 0; i < VB_SCRIPTS.length; i++) {
            await loadScript(VB_SCRIPTS[i]);
        }
        if (typeof VBEngine === 'undefined' || typeof MarketBatch === 'undefined') throw new Error('Nạp xong nhưng thiếu bộ máy định giá');
    }

    var DEFS = [
        { id: 'version', label: 'Phiên bản ứng dụng', run: async function () {
            var t = T();
            if (!t || !t.app || !t.app.getVersion) return { status: 'skip', detail: 'Bản web: không có thông tin phiên bản cài đặt.' };
            return { status: 'ok', detail: await t.app.getVersion() };
        } },
        { id: 'session', label: 'Phiên đăng nhập Supabase', run: async function () {
            var sb = window.supabaseClient;
            if (!sb) throw new Error('Chưa khởi tạo kết nối máy chủ');
            var s = await sb.auth.getSession(), ses = s && s.data && s.data.session;
            if (!ses) return { status: 'fail', detail: 'Chưa đăng nhập: các phép kiểm cần đăng nhập bên dưới sẽ lỗi.' };
            var left = ses.expires_at ? Math.round((ses.expires_at * 1000 - Date.now()) / 60000) : null;
            return { status: left !== null && left < 0 ? 'warn' : 'ok', detail: 'Đã đăng nhập' + (left !== null ? (left >= 0 ? ', phiên còn khoảng ' + left + ' phút (tự gia hạn).' : ', phiên đã hết hạn: thử đăng nhập lại.') : '.') };
        } },
        { id: 'live-fn', label: 'Giá trực tiếp: hàm VCI (Supabase live-quotes)', timeoutMs: 20000, run: async function () {
            var t0 = Date.now(), r = await API.asset.market.liveQuotes(['FPT', 'VNM']), ms = Date.now() - t0, qs = (r && r.quotes) || {}, got = Object.keys(qs);
            if (!got.length) return { status: 'fail', detail: 'Hàm phản hồi nhưng không có báo giá nào' + (r && r.missing && r.missing.length ? ' (không thấy: ' + r.missing.join(', ') + ')' : '') + '.' };
            var sess = LiveQuotes.session(), liveNow = sess === 'open' || sess === 'break';
            var asOf = r.asOf ? LiveQuotes.hhmmss(Math.floor(Date.parse(r.asOf) / 1000)) : '?';
            var fpt = qs.FPT ? 'FPT ' + fmtVnd(qs.FPT.price) : got[0] + ' ' + fmtVnd(qs[got[0]].price);
            return { status: ms > 9000 ? 'warn' : 'ok', detail: 'Nhận ' + got.length + '/2 mã trong ' + (ms / 1000).toFixed(1) + ' giây; ' + fpt + (liveNow ? ' (giá trực tiếp)' : ' (ngoài giờ: giá phiên gần nhất)') + ', bảng giá lúc ' + asOf + (ms > 9000 ? '. Chậm: app vẫn dùng được nhưng giá sẽ trễ hơn.' : '.') };
        } },
        { id: 'vnd', label: 'Giá trực tiếp: nguồn dự phòng VNDirect', run: async function () {
            var from = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
            var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 9000);
            var res;
            try { res = await fetch(LiveQuotes.FINFO + '?q=code:FPT~date:gte:' + from + '&size=15&sort=date', { signal: ctl.signal }); } finally { clearTimeout(timer); }
            if (!res.ok) throw new Error('VNDirect trả HTTP ' + res.status);
            var j = await res.json(), rows = (j && j.data) || [];
            if (!rows.length) return { status: 'warn', detail: 'VNDirect không trả dòng giá nào trong 10 ngày gần đây.' };
            var latest = rows.map(function (r) { return String(r.date).slice(0, 10); }).sort().pop(), row = rows.filter(function (r) { return String(r.date).slice(0, 10) === latest; })[0];
            var sess = LiveQuotes.session(), isToday = latest === today();
            if ((sess === 'open' || sess === 'break') && !isToday) return { status: 'warn', detail: 'Đang trong phiên nhưng VNDirect chưa có giá hôm nay (mới nhất ' + fmtDate(latest) + '): app sẽ dùng giá VCI nếu có.' };
            return { status: 'ok', detail: 'FPT ' + fmtVnd(Number(row.close) * 1000) + ' ngày ' + fmtDate(latest) + (row.time ? ' lúc ' + String(row.time).slice(0, 8) : '') + '.' };
        } },
        { id: 'holidays', label: 'Lịch nghỉ lễ của sàn', run: async function () {
            var d = today(), cov = VnHolidays.coverage(d), name = VnHolidays.name(d), yr = d.slice(0, 4);
            var next = VnHolidays.nextTradingDay(d);
            if (cov === 'complete') return { status: 'ok', detail: 'Có đủ lịch năm ' + yr + (name ? '. Hôm nay nghỉ lễ: ' + name + '.' : '.') };
            return { status: 'warn', detail: 'Lịch nghỉ lễ năm ' + yr + ' chưa đầy đủ (mới có Tết Dương lịch). Nếu gặp ngày nghỉ chưa có trong lịch, app vẫn tự nhận biết nhờ VNDirect không có giá hôm nay; nên cập nhật khi có thông báo mới. Ngày giao dịch kế tiếp: ' + fmtDate(next) + '.' };
        } },
        { id: 'fs-write', label: 'Ghi tệp trong máy (lịch sử ảnh chụp)', run: async function () {
            var t = T();
            if (!t || !t.fs) return { status: 'skip', detail: 'Bản web: không ghi được tệp.' };
            var base = t.fs.BaseDirectory.AppLocalData, dir = 'market-history', name = dir + '/_selfcheck.tmp', text = 'workhub-selfcheck-' + Date.now();
            try {
                if (!(await t.fs.exists(dir, { baseDir: base }))) await t.fs.mkdir(dir, { baseDir: base, recursive: true });
                await t.fs.writeFile(name, new TextEncoder().encode(text), { baseDir: base });
                var back = new TextDecoder().decode(await t.fs.readFile(name, { baseDir: base }));          // quyền đọc tệp nhị phân: cần cho theo dõi bộ lọc đã lưu (đọc ảnh chụp nén)
                await t.fs.remove(name, { baseDir: base });
                if (back !== text) return { status: 'fail', detail: 'Ghi được nhưng đọc lại không khớp.' };
                return { status: 'ok', detail: 'Ghi, đọc lại và xoá tệp thử trong thư mục dữ liệu của app đều đạt (lịch sử ảnh chụp và theo dõi bộ lọc dùng được).' };
            } catch (e) {
                var m = String(e && e.message || e);
                throw new Error(/not allowed|permission|scope|forbidden/i.test(m) ? 'Chưa có quyền ghi hoặc đọc tệp trong bản cài này: lịch sử ảnh chụp và theo dõi bộ lọc sẽ chưa chạy (cần bản cài mới). Chi tiết: ' + m : m);
            }
        } },
        { id: 'history', label: 'Lịch sử ảnh chụp thị trường lưu trong máy', run: async function () {
            if (!window.WorkHubMarketHistory) return { status: 'skip', detail: 'Chỉ có trên bản desktop.' };
            var st = await window.WorkHubMarketHistory.refreshStatus(), s = st.summary;
            if (st.error) return { status: 'warn', detail: 'Không đọc được thư mục: ' + st.error };
            if (!s || !s.count) return { status: 'warn', detail: 'Chưa có tệp nào. App tự lưu sau khi mở khoảng 20 giây (hoặc bấm "Lưu ảnh chụp hôm nay" ở Sao lưu & Phục hồi).' };
            var age = SelfCheck.daysBetween(s.last, today());
            return { status: age > 5 ? 'warn' : 'ok', detail: s.count + ' ngày (từ ' + fmtDate(s.first) + ' đến ' + fmtDate(s.last) + (s.gaps ? ', thiếu ' + s.gaps + ' ngày làm việc' : '') + ')' + (age > 5 ? '. Tệp mới nhất đã ' + age + ' ngày: mở app thường xuyên hơn để lưu đủ.' : '.') };
        } },
        { id: 'notify', label: 'Thông báo của hệ điều hành', run: async function () {
            var t = T();
            if (t && t.notification) {
                var ok = await t.notification.isPermissionGranted();
                return ok ? { status: 'ok', detail: 'Đã cấp quyền. Bấm "Gửi thông báo thử" để xem thông báo hiện ra.' } : { status: 'warn', detail: 'Chưa cấp quyền thông báo: cảnh báo giá chỉ hiện trong trang, không hiện ngoài màn hình. Bấm "Gửi thông báo thử" để cấp.' };
            }
            if ('Notification' in window) return Notification.permission === 'granted' ? { status: 'ok', detail: 'Trình duyệt đã cấp quyền thông báo.' } : { status: 'warn', detail: 'Trình duyệt chưa cấp quyền thông báo (' + Notification.permission + ').' };
            return { status: 'skip', detail: 'Môi trường này không hỗ trợ thông báo.' };
        } },
        { id: 'snapshot', label: 'Ảnh chụp thị trường và số liệu bộ lọc mới', timeoutMs: 30000, run: async function () {
            var u = await API.asset.market.marketUniverse(true), snap = u.snapshot || [], n = snap.length;
            if (!n) return { status: 'warn', detail: 'Chưa có ảnh chụp thị trường (hoặc tài khoản này không có quyền đọc).' };
            var cnt = function (k) { return snap.filter(function (r) { return r.metrics && r.metrics[k] !== undefined && r.metrics[k] !== null; }).length; };
            var pct = function (k) { return Math.round(cnt(k) / n * 100); };
            var newPct = Math.min(pct('chgYtd'), pct('netProfitGrowthYoY')), age = u.asOf ? SelfCheck.daysBetween(u.asOf, today()) : null;
            var base = n + ' mã, ngày số liệu ' + fmtDate(u.asOf) + '; có giá từ 1/1 ở ' + pct('chgYtd') + '% mã, tăng trưởng lợi nhuận ở ' + pct('netProfitGrowthYoY') + '% mã';
            if (newPct < 30) return { status: 'warn', detail: base + '. Số liệu mới chưa nạp đủ: bộ lọc báo "thiếu số liệu" cho tới lần cập nhật 18:20 kế tiếp.' };
            if (age !== null && age > 4) return { status: 'warn', detail: base + '. Số liệu đã cũ ' + age + ' ngày: kiểm tra lịch cập nhật hằng ngày.' };
            if (n < 800) return { status: 'warn', detail: base + '. Số mã ít hơn dự kiến.' };
            return { status: 'ok', detail: base + '.' };
        } },
        { id: 'vb-data', label: 'Dữ liệu báo cáo và giá cho định giá (vb-data)', timeoutMs: 30000, run: async function () {
            var t0 = Date.now(), d = await API.asset.vb.data('FPT', { lite: true }), ms = Date.now() - t0, v = d && d.vb || {};
            var years = (v.annualRows || []).length, qs = (v.quarterRows || []).length, candles = v.candles && v.candles.c ? v.candles.c.length : (Array.isArray(v.candles) ? v.candles.length : 0);
            if (!years) return { status: 'fail', detail: 'Có phản hồi nhưng không có báo cáo năm nào.' };
            return { status: years >= 3 && (candles >= 200 || !candles) ? 'ok' : 'warn', detail: 'FPT: ' + years + ' năm báo cáo, ' + qs + ' quý, ' + candles + ' phiên giá, ' + (ms / 1000).toFixed(1) + ' giây.' };
        } },
        { id: 'batch', label: 'Định giá hàng loạt: chạy thử 1 mã (FPT)', timeoutMs: 60000, run: async function () {
            await ensureEngine();
            var u = await API.asset.market.marketUniverse(false), rows = MarketScreener.buildRows(u.snapshot || [], u.stats || {}, u.meta || {});
            var row = rows.filter(function (r) { return r.symbol === 'FPT'; })[0];
            if (!row) return { status: 'warn', detail: 'FPT không có trong ảnh chụp thị trường nên không dựng được ngữ cảnh.' };
            var d = await API.asset.vb.data('FPT', { lite: true }), hist = null;
            try { hist = await API.asset.market.valuationHistory(6); } catch (e) { /* không có lịch sử định giá: engine vẫn chạy */ }
            var t0 = Date.now(), res = VBEngine.analyze(MarketBatch.buildCtx(d.vb, row, { stats: u.stats }, hist, { scorecard: typeof VB_SCORECARD !== 'undefined' ? VB_SCORECARD : null })), s = MarketBatch.summarize(res, VBEngine);
            if (!s.ok) return { status: 'warn', detail: 'Bộ máy chạy nhưng không định giá được FPT: ' + s.reason };
            return { status: 'ok', detail: 'FPT: giá trị hợp lý ' + fmtVnd(s.fairBase) + ' (khoảng ' + fmtVnd(s.fairLow) + ' đến ' + fmtVnd(s.fairHigh) + '), giá ' + fmtVnd(s.price) + ', tính trong ' + (Date.now() - t0) + ' ms. Đường định giá hàng loạt hoạt động.' };
        } },
        { id: 'local-store', label: 'Bộ nhớ trình duyệt của app (lưu diễn biến trong ngày)', run: async function () {
            var k = 'wh.fin.selfcheck.tmp';
            localStorage.setItem(k, 'x'); var ok = localStorage.getItem(k) === 'x'; localStorage.removeItem(k);
            if (!ok) return { status: 'fail', detail: 'Không ghi/đọc lại được.' };
            var sz = 0; ['wh.fin.liveseries.v1', 'wh.fin.livealerts.v1', 'wh.fin.live.v1', 'wh.fin.marketscreener.saved.v1'].forEach(function (key) { var v = localStorage.getItem(key); if (v) sz += v.length; });
            return { status: 'ok', detail: 'Ghi và đọc lại đạt; dữ liệu của Danh Mục/bộ lọc đang chiếm khoảng ' + Math.max(1, Math.round(sz / 1024)) + ' KB.' };
        } },
    ];

    async function run(onProgress) {
        if (running) return last;
        running = true;
        try {
            last = await SelfCheck.runAll(DEFS, {}, { onProgress: onProgress });
            return last;
        } finally { running = false; }
    }
    async function version() { try { var t = T(); return t && t.app && t.app.getVersion ? await t.app.getVersion() : null; } catch (e) { return null; } }
    async function report() {
        var d = new Date(), when = d.toLocaleString('vi-VN');
        return SelfCheck.toText(last || [], { version: await version(), when: when, platform: T() ? 'Desktop' : 'Web' });
    }
    // Gửi một thông báo hệ điều hành thử (người dùng bấm nút). Trả { ok, detail }.
    async function testNotification() {
        try {
            var t = T();
            if (t && t.notification) {
                var ok = await t.notification.isPermissionGranted();
                if (!ok) ok = (await t.notification.requestPermission()) === 'granted';
                if (!ok) return { ok: false, detail: 'Bạn chưa cho phép thông báo. Bật quyền thông báo cho WorkHub trong Cài đặt Windows.' };
                t.notification.sendNotification({ title: 'WorkHub: thông báo thử', body: 'Cảnh báo giá của bạn sẽ hiện như thế này.' });
                return { ok: true, detail: 'Đã gửi. Nếu không thấy thông báo, kiểm tra chế độ Không làm phiền / Hỗ trợ tập trung của Windows.' };
            }
            if ('Notification' in window) {
                if (Notification.permission === 'default') await Notification.requestPermission();
                if (Notification.permission !== 'granted') return { ok: false, detail: 'Trình duyệt chưa cho phép thông báo.' };
                new Notification('WorkHub: thông báo thử', { body: 'Cảnh báo giá của bạn sẽ hiện như thế này.' });
                return { ok: true, detail: 'Đã gửi.' };
            }
            return { ok: false, detail: 'Môi trường này không hỗ trợ thông báo.' };
        } catch (e) { return { ok: false, detail: String(e && e.message || e) }; }
    }

    window.WorkHubSelfCheck = { run: run, report: report, testNotification: testNotification, defs: DEFS, last: function () { return last; } };
})();
