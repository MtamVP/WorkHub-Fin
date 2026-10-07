/* --- FILE: /mastersheet/assets/live-ui.js ---
   Danh Mục: GIÁ TRỰC TIẾP trong phiên. Mỗi 20 giây (khi sàn mở, trang đang hiển thị) lấy giá khớp gần nhất của các mã đang nắm (lib/live-quotes.js: bảng giá VCI qua Edge Function, dự phòng VNDirect),
   rồi cập nhật tại chỗ bảng danh mục, NAV, lãi/lỗ chưa thực hiện và lãi/lỗ trong ngày. CHỈ HIỂN THỊ: không ghi gì vào sổ, NAV hay lịch sử (giá chính thức vẫn do cron 5 phút lưu).
   Thêm: (1) CẢNH BÁO theo giá trực tiếp (lib/live-alerts.js): chạm giá mục tiêu / cắt lỗ / biến động mạnh trong ngày, báo bằng thông báo hệ điều hành + dải cảnh báo trong trang, mỗi mức 1 lần/ngày;
   (2) ĐƯỜNG LÃI/LỖ TRONG NGÀY (lib/live-series.js): mỗi phút ghi một điểm vào bộ nhớ của MÁY NÀY (localStorage, không lên máy chủ) rồi vẽ.
   Mã đã khoá giá không bị ghi đè. Không cập nhật khi bạn đang gõ trong bảng. Dùng global của script.js / insights.js: loadHoldings, renderHoldingsRows, setKpi, updateHeroDelta, lastHoldings, escapeAssetHtml, formatVnd. */
const LiveUI = (function () {
    const KEY = 'wh.fin.live.v1', SERIES_KEY = 'wh.fin.liveseries.v1', ALERTS_KEY = 'wh.fin.livealerts.v1', NOTIFIED_PREFIX = 'wh_notified_price_alerts_', EVERY_MS = 20000, BREAK_EVERY_MS = 60000;
    const S = { on: true, movePct: (typeof LiveAlerts !== 'undefined' ? LiveAlerts.DEFAULT_MOVE : 5), showSeries: true, base: null, watch: null, lastWatchSig: '', kpi: null, timer: null, busy: false, lastFetchAt: 0, closedFetched: false, lastSig: '', series: {}, alertLog: [] };
    const hasLib = () => typeof LiveQuotes !== 'undefined';
    const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* bỏ qua: không có bộ nhớ thì chỉ mất lịch sử */ } };
    const saveCfg = () => lsSet(KEY, { on: S.on, movePct: S.movePct, showSeries: S.showSeries });
    const localDate = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    (function init() {
        const v = lsGet(KEY);
        if (v) { if (v.on === false) S.on = false; if (v.showSeries === false) S.showSeries = false; if (typeof LiveAlerts !== 'undefined' && v.movePct !== undefined) S.movePct = LiveAlerts.normalizeMove(v.movePct); }
        const sr = lsGet(SERIES_KEY); if (sr && typeof sr === 'object' && !Array.isArray(sr)) S.series = sr;
        const al = lsGet(ALERTS_KEY); if (al && al.date === localDate() && Array.isArray(al.items)) S.alertLog = al.items.slice(-20);
    })();

    const typing = () => { const a = document.activeElement; return !!(a && a.closest && a.closest('#holdings-body') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)); };
    const esc = (s) => (typeof escapeAssetHtml === 'function' ? escapeAssetHtml(s) : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

    function statusHtml() {
        const st = LiveQuotes.state, t = S.base ? LiveQuotes.totals(LiveQuotes.applyToHoldings(S.base, st.quotes)) : null, sess = LiveQuotes.session();
        const btn = `<button type="button" class="btn-tool live-toggle" aria-pressed="${S.on}" onclick="LiveUI.toggle()" title="Bật/tắt giá trực tiếp trong phiên (chỉ để xem, không ghi vào sổ)"><i class="fa-solid fa-bolt"></i> Giá trực tiếp: ${S.on ? 'Bật' : 'Tắt'}</button>`;
        if (!S.on) return `<span class="live-chip off">Đang dùng giá lưu (cập nhật mỗi 5 phút trong phiên)</span>${btn}`;
        const opts = (typeof LiveAlerts !== 'undefined' ? LiveAlerts.MOVE_CHOICES : []).map((m) => `<option value="${m}"${m === S.movePct ? ' selected' : ''}>${m ? '±' + m + '%' : 'Tắt'}</option>`).join('');
        const moveSel = opts ? `<label class="live-opt" title="Báo khi một mã trong danh mục tăng hoặc giảm vượt mức này so với giá tham chiếu. Giá mục tiêu và ngưỡng cắt lỗ luôn được báo."><i class="fa-solid fa-bell"></i> Báo biến động <select onchange="LiveUI.setMove(this.value)" aria-label="Ngưỡng báo biến động trong ngày">${opts}</select></label>` : '';
        const serSel = typeof LiveSeries !== 'undefined' ? `<button type="button" class="btn-tool" aria-pressed="${S.showSeries}" onclick="LiveUI.toggleSeries()" title="Hiện hoặc ẩn đường lãi/lỗ trong ngày (lưu trong máy này)"><i class="fa-solid fa-chart-line"></i> Diễn biến hôm nay</button>` : '';
        const alertChip = S.alertLog.length ? `<span class="live-chip warn" title="${esc(S.alertLog.map((a) => a.time + ' ' + a.title + ': ' + a.body).join('\n'))}"><i class="fa-solid fa-bell"></i> ${S.alertLog.length} cảnh báo hôm nay</span>` : '';
        const tail = btn + moveSel + serSel;
        const ix = st.index && st.index.date === LiveQuotes.vnParts().date ? st.index : null;
        if (st.error && !(t && t.liveCount)) return `<span class="live-chip bad" title="${esc(st.error)}"><i class="fa-solid fa-triangle-exclamation"></i> Không lấy được giá trực tiếp, đang dùng giá lưu</span>${tail}`;
        if (!t || !t.liveCount) {
            const hol = sess === 'holiday' && typeof VnHolidays !== 'undefined' ? VnHolidays.name(LiveQuotes.vnParts().date) : null;
            const why = sess === 'holiday' ? 'Hôm nay thị trường nghỉ lễ' + (hol ? ' (' + hol + ')' : '') + ': dùng giá lưu' : (sess === 'closed' ? 'Ngoài giờ giao dịch: dùng giá lưu' : (sess === 'pre' ? 'Chưa mở cửa: dùng giá lưu' : 'Chưa có giá khớp hôm nay: dùng giá lưu'));
            return `<span class="live-chip off">${why}</span>${alertChip}${tail}`;
        }
        const last = Object.values(st.quotes).reduce((m, q) => (q.ts && q.ts > m ? q.ts : m), 0), time = last ? LiveQuotes.hhmmss(last) : '';
        const label = sess === 'open' ? 'Trực tiếp' : (sess === 'break' ? 'Nghỉ trưa' : 'Hết phiên');
        const rel = ix && t.dayPct !== null ? t.dayPct - ix.pct : null;
        const idx = ix ? ` · VN-Index <b>${ix.value.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> <span class="${ix.pct >= 0 ? 'pnl-up-text' : 'pnl-down-text'}">(${ix.pct >= 0 ? '+' : '−'}${Math.abs(ix.pct).toFixed(2)}%)</span>${rel === null ? '' : ` · danh mục ${rel >= 0 ? 'hơn' : 'kém'} chỉ số <b class="${rel >= 0 ? 'pnl-up-text' : 'pnl-down-text'}">${Math.abs(rel).toFixed(2)} điểm %</b>`}` : '';
        const day = t.dayPnl === null ? '' : ` · hôm nay <b class="${t.dayPnl >= 0 ? 'pnl-up-text' : 'pnl-down-text'}">${t.dayPnl >= 0 ? '+' : '−'}${formatVnd(Math.abs(t.dayPnl))}</b> (${t.dayPct >= 0 ? '+' : '−'}${Math.abs(t.dayPct).toFixed(2)}%)`;
        return `<span class="live-chip ${sess === 'open' ? 'on' : 'idle'}" title="${esc(st.source && st.source.indexOf('vci') === 0 ? 'Giá khớp từ bảng giá VCI, trễ vài giây.' : 'Giá khớp gần nhất của VNDirect, thường chậm khoảng 1 đến 2 phút (hàm giá VCI không dùng được' + (st.vciError ? ': ' + st.vciError : '') + ').')} Chỉ để xem: sổ và NAV lưu vẫn dùng giá cập nhật 5 phút/lần. Mã đã khoá giá không bị ghi đè."><span class="live-dot"></span> ${label} · giá lúc ${time} · ${t.liveCount}/${t.total} mã${day}${idx}</span>${alertChip}${tail}`;
    }
    function renderStatus() { const el = document.getElementById('live-status'); if (el && hasLib()) el.innerHTML = statusHtml(); }

    // ---- Đường lãi/lỗ trong ngày ----
    function renderSeries() {
        const el = document.getElementById('live-series');
        if (!el) return;
        if (typeof LiveSeries === 'undefined') { el.hidden = true; return; }
        const date = LiveSeries.vnParts(Date.now()).date, pts = LiveSeries.points(S.series, date), st = LiveSeries.stats(pts);
        if (!S.on || !S.showSeries || !st || pts.length < 2) { el.hidden = true; el.innerHTML = ''; return; }
        const M = LiveSeries.money, hh = (r) => String(Math.floor(r[0] / 60)).padStart(2, '0') + ':' + String(r[0] % 60).padStart(2, '0');
        const cls = st.last[1] >= 0 ? 'pnl-up-text' : 'pnl-down-text';
        el.hidden = false;
        el.innerHTML = `<div class="ls-head"><b>Lãi/lỗ hôm nay</b> <span class="${cls}">${M(st.last[1])} (${st.last[2] >= 0 ? '+' : '−'}${Math.abs(st.last[2]).toFixed(2).replace('.', ',')}%)</span>` +
            `<span class="ls-meta">cao nhất ${M(st.high[1])} lúc ${hh(st.high)} · thấp nhất ${M(st.low[1])} lúc ${hh(st.low)}</span>` +
            `<span class="ls-meta">${st.n} điểm, lưu trong máy này (không gửi lên máy chủ)</span></div>${LiveSeries.svg(pts, { width: Math.max(320, Math.round((el.clientWidth || 640) - 24)), height: 140 })}`;
    }
    function recordSeries(t) {
        if (typeof LiveSeries === 'undefined' || !S.on || !t || !t.liveCount || t.dayPnl === null) return;
        const at = LiveQuotes.state.fetchedAt; if (!at) return;            // ghi theo thời điểm lấy giá, không theo lúc vẽ lại
        const next = LiveSeries.record(S.series, at, { pnl: t.dayPnl, pct: t.dayPct, mv: t.marketValue });
        if (next !== S.series) { S.series = next; lsSet(SERIES_KEY, S.series); }
    }

    // ---- Cảnh báo theo giá trực tiếp ----
    async function fireOs(title, body) {
        try {
            const T = window.__TAURI__ && window.__TAURI__.notification;
            if (T) { let ok = await T.isPermissionGranted(); if (!ok) ok = (await T.requestPermission()) === 'granted'; if (ok) T.sendNotification({ title: title, body: body }); return; }
            if ('Notification' in window) { if (Notification.permission === 'default') await Notification.requestPermission(); if (Notification.permission === 'granted') new Notification(title, { body: body }); }
        } catch (e) { /* không có quyền thông báo: dải cảnh báo trong trang vẫn hiện */ }
    }
    function renderAlerts() {
        const el = document.getElementById('live-alerts');
        if (!el) return;
        if (!S.alertLog.length) { el.hidden = true; el.innerHTML = ''; return; }
        el.hidden = false;
        el.innerHTML = S.alertLog.slice(-5).reverse().map((a) => `<div class="la-item la-${a.level}"><i class="fa-solid ${a.level === 'bad' ? 'fa-triangle-exclamation' : 'fa-circle-check'}" aria-hidden="true"></i><span><b>${esc(a.title)}</b> ${esc(a.body)}</span><time>${esc(a.time)}</time></div>`).join('') +
            `<button type="button" class="btn-tool la-clear" onclick="LiveUI.clearAlerts()">Ẩn cảnh báo</button>`;
    }
    function checkAlerts(live, t, watch) {
        if (typeof LiveAlerts === 'undefined' || !S.on || !t) return;
        const found = LiveAlerts.evaluate(live, { movePct: S.movePct }).concat(watch ? LiveAlerts.evaluateWatch(watch) : []);
        if (!found.length) return;
        const nk = NOTIFIED_PREFIX + localDate(), set = new Set(lsGet(nk) || []), fresh = LiveAlerts.fresh(found, set);
        if (!fresh.length) return;
        const hh = LiveQuotes.hhmmss(Math.floor(Date.now() / 1000));
        fresh.forEach((a) => {
            const m = LiveAlerts.message(a);
            fireOs(m.title, m.body);
            S.alertLog.push({ time: hh, title: m.title, body: m.body, level: LiveAlerts.levelOf(a), key: a.key });
            set.add(a.key);
        });
        lsSet(nk, Array.from(set)); lsSet(ALERTS_KEY, { date: localDate(), items: S.alertLog.slice(-20) });
        renderAlerts();
    }

    // Vẽ lại bảng, KPI và tiêu đề NAV theo giá trực tiếp (hoặc theo giá lưu khi tắt / chưa có giá)
    function apply(force) {
        if (!S.base || !hasLib()) return;
        const live = S.on ? LiveQuotes.applyToHoldings(S.base, LiveQuotes.state.quotes) : S.base;
        const t = LiveQuotes.totals(live);
        const sig = live.map(h => h.symbol + ':' + h.marketPrice).join('|') + '|' + S.on;
        const liveWatch = S.watch ? (S.on ? LiveQuotes.applyToWatchlist(S.watch, LiveQuotes.state.quotes) : S.watch) : null;
        recordSeries(t); checkAlerts(live, t, liveWatch);
        renderStatus(); renderSeries();
        if (liveWatch && typeof renderWatchlist === 'function') {         // tab Theo Dõi: vẽ lại khi có giá đổi (không khi đang gõ trong bảng)
            const wsig = liveWatch.map(w => w.symbol + ':' + w.price).join('|') + '|' + S.on, a = document.activeElement;
            const wtyping = !!(a && a.closest && a.closest('#watch-body') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
            if ((force || wsig !== S.lastWatchSig) && !wtyping) { S.lastWatchSig = wsig; renderWatchlist(); }
        }
        if (!force && sig === S.lastSig) return;                       // không có giá nào đổi: khỏi vẽ lại
        if (typing()) return;                                          // đang gõ trong bảng: để lần sau
        S.lastSig = sig;
        renderHoldingsRows(live);
        if (typeof lastHoldings !== 'undefined') lastHoldings = live;
        const k0 = S.kpi;
        if (k0) {
            const live_ = S.on && t.liveCount > 0;
            const k = Object.assign({}, k0, live_ ? { marketValue: t.marketValue, unrealizedPnl: t.unrealizedPnl, nav: (Number(k0.nav) || 0) + (t.marketValue - (Number(k0.marketValue) || 0)), dayPnl: t.dayPnl, dayPct: t.dayPct } : {});
            setKpi('kpi-nav', k.nav, true); setKpi('kpi-unrealized', k.unrealizedPnl, true, true); setKpi('kpi-market-value', k.marketValue, true);
            updateHeroDelta(k);
        }
    }

    async function tick(force) {
        if (!hasLib() || !S.on || S.busy || !S.base) return;
        if (document.hidden && !force) return;
        const sess = LiveQuotes.session(), now = Date.now(), offHours = sess === 'closed' || sess === 'pre' || sess === 'holiday';
        if (sess === 'open') S.closedFetched = false;
        if (!force) {
            if (sess === 'break' && now - S.lastFetchAt < BREAK_EVERY_MS) return;
            if (offHours && S.closedFetched) return;                    // ngoài giờ / ngày lễ: lấy một lần để hiện giá đóng cửa hôm nay, không gọi lặp
        }
        S.busy = true;
        try {
            const syms = [...new Set(S.base.map(h => h.symbol).concat((S.watch || []).map(w => w.symbol)))].slice(0, 80);
            await LiveQuotes.refresh(syms, { index: true, invoke: (typeof API !== 'undefined' && API.asset && API.asset.market && API.asset.market.liveQuotes) ? (syms) => API.asset.market.liveQuotes(syms) : undefined });
            S.lastFetchAt = now; if (offHours) S.closedFetched = true;
        } catch (e) { /* trạng thái lỗi nằm trong LiveQuotes.state */ }
        S.busy = false;
        apply(force);
    }

    function start() {
        if (S.timer) return;
        S.timer = setInterval(() => tick(false), EVERY_MS);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(true); });
    }

    return {
        // script.js gọi sau khi tải danh mục / KPI từ máy chủ (giá lưu): ghi nhớ làm cơ sở rồi áp giá trực tiếp ngay nếu đã có
        afterHoldings(holdings) { S.base = holdings || []; S.lastSig = ''; start(); renderStatus(); renderAlerts(); renderSeries(); if (hasLib() && S.on) { if (Object.keys(LiveQuotes.state.quotes).length) apply(true); tick(true); } },
        // watchlist.js gọi sau khi tải danh sách Theo Dõi: mã chờ mua cũng được cập nhật giá trực tiếp và báo "tới giá mua"
        afterWatchlist(list) { S.watch = list || []; S.lastWatchSig = ''; if (hasLib() && S.on && S.base) { if (Object.keys(LiveQuotes.state.quotes).length) apply(true); tick(true); } },
        // Danh sách Theo Dõi để vẽ: áp giá trực tiếp nếu đang bật
        watchView(list) { return hasLib() && S.on ? LiveQuotes.applyToWatchlist(list, LiveQuotes.state.quotes) : list; },
        afterKpis(k) { S.kpi = k || null; if (hasLib() && S.on && S.base && Object.keys(LiveQuotes.state.quotes).length) apply(true); },
        toggle() {
            S.on = !S.on; saveCfg();
            S.lastSig = ''; if (S.on) { tick(true); } else apply(true);
            renderStatus(); renderSeries();
        },
        setMove(v) { if (typeof LiveAlerts === 'undefined') return; S.movePct = LiveAlerts.normalizeMove(v); saveCfg(); renderStatus(); if (S.base) apply(false); },
        toggleSeries() { S.showSeries = !S.showSeries; saveCfg(); renderStatus(); renderSeries(); },
        clearAlerts() { S.alertLog = []; lsSet(ALERTS_KEY, { date: localDate(), items: [] }); renderAlerts(); renderStatus(); },
        active() { return !!(hasLib() && S.on); },
        renderStatus: renderStatus,
        state: S,
    };
})();
