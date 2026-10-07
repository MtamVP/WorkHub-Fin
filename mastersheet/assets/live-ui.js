/* --- FILE: /mastersheet/assets/live-ui.js ---
   Danh Mục: GIÁ TRỰC TIẾP trong phiên. Mỗi 20 giây (khi sàn mở, trang đang hiển thị) lấy giá khớp gần nhất của các mã đang nắm từ VNDirect (lib/live-quotes.js),
   rồi cập nhật tại chỗ bảng danh mục, NAV, lãi/lỗ chưa thực hiện và lãi/lỗ trong ngày. CHỈ HIỂN THỊ: không ghi gì vào sổ, NAV hay lịch sử (giá chính thức vẫn do cron 5 phút lưu).
   Mã đã khoá giá không bị ghi đè. Không cập nhật khi bạn đang gõ trong bảng. Dùng global của script.js / insights.js: loadHoldings, renderHoldingsRows, setKpi, updateHeroDelta, lastHoldings, escapeAssetHtml, formatVnd. */
const LiveUI = (function () {
    const KEY = 'wh.fin.live.v1', EVERY_MS = 20000, BREAK_EVERY_MS = 60000;
    const S = { on: true, base: null, kpi: null, timer: null, busy: false, lastFetchAt: 0, closedFetched: false, lastSig: '' };
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && v.on === false) S.on = false; } catch (e) { /* mặc định bật */ }

    const hasLib = () => typeof LiveQuotes !== 'undefined';
    const typing = () => { const a = document.activeElement; return !!(a && a.closest && a.closest('#holdings-body') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)); };

    function statusHtml() {
        const st = LiveQuotes.state, t = S.base ? LiveQuotes.totals(LiveQuotes.applyToHoldings(S.base, st.quotes)) : null, sess = LiveQuotes.session();
        const btn = `<button type="button" class="btn-tool live-toggle" aria-pressed="${S.on}" onclick="LiveUI.toggle()" title="Bật/tắt giá trực tiếp trong phiên (chỉ để xem, không ghi vào sổ)"><i class="fa-solid fa-bolt"></i> Giá trực tiếp: ${S.on ? 'Bật' : 'Tắt'}</button>`;
        if (!S.on) return `<span class="live-chip off">Đang dùng giá lưu (cập nhật mỗi 5 phút trong phiên)</span>${btn}`;
        if (st.error && !(t && t.liveCount)) return `<span class="live-chip bad" title="${escapeAssetHtml(st.error)}"><i class="fa-solid fa-triangle-exclamation"></i> Không lấy được giá trực tiếp, đang dùng giá lưu</span>${btn}`;
        if (!t || !t.liveCount) {
            const why = sess === 'closed' ? 'Ngoài giờ giao dịch: dùng giá lưu' : (sess === 'pre' ? 'Chưa mở cửa: dùng giá lưu' : 'Chưa có giá khớp hôm nay: dùng giá lưu');
            return `<span class="live-chip off">${why}</span>${btn}`;
        }
        const last = Object.values(st.quotes).reduce((m, q) => (q.ts && q.ts > m ? q.ts : m), 0), time = last ? LiveQuotes.hhmmss(last) : '';
        const label = sess === 'open' ? 'Trực tiếp' : (sess === 'break' ? 'Nghỉ trưa' : 'Hết phiên');
        const day = t.dayPnl === null ? '' : ` · hôm nay <b class="${t.dayPnl >= 0 ? 'pnl-up-text' : 'pnl-down-text'}">${t.dayPnl >= 0 ? '+' : '−'}${formatVnd(Math.abs(t.dayPnl))}</b> (${t.dayPct >= 0 ? '+' : '−'}${Math.abs(t.dayPct).toFixed(2)}%)`;
        return `<span class="live-chip ${sess === 'open' ? 'on' : 'idle'}" title="${escapeAssetHtml(st.source && st.source.indexOf('vci') === 0 ? 'Giá khớp từ bảng giá VCI, trễ vài giây.' : 'Giá khớp gần nhất của VNDirect, thường chậm khoảng 1 đến 2 phút (hàm giá VCI không dùng được' + (st.vciError ? ': ' + st.vciError : '') + ').')} Chỉ để xem: sổ và NAV lưu vẫn dùng giá cập nhật 5 phút/lần. Mã đã khoá giá không bị ghi đè."><span class="live-dot"></span> ${label} · giá lúc ${time} · ${t.liveCount}/${t.total} mã${day}</span>${btn}`;
    }
    function renderStatus() { const el = document.getElementById('live-status'); if (el && hasLib()) el.innerHTML = statusHtml(); }

    // Vẽ lại bảng, KPI và tiêu đề NAV theo giá trực tiếp (hoặc theo giá lưu khi tắt / chưa có giá)
    function apply(force) {
        if (!S.base || !hasLib()) return;
        const live = S.on ? LiveQuotes.applyToHoldings(S.base, LiveQuotes.state.quotes) : S.base;
        const t = LiveQuotes.totals(live);
        const sig = live.map(h => h.symbol + ':' + h.marketPrice).join('|') + '|' + S.on;
        renderStatus();
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
        const sess = LiveQuotes.session(), now = Date.now();
        if (!force) {
            if (sess === 'break' && now - S.lastFetchAt < BREAK_EVERY_MS) return;
            if ((sess === 'closed' || sess === 'pre') && S.closedFetched) return;     // ngoài giờ: lấy một lần để hiện giá đóng cửa hôm nay, không gọi lặp
        }
        S.busy = true;
        try {
            await LiveQuotes.refresh(S.base.map(h => h.symbol), { invoke: (typeof API !== 'undefined' && API.asset && API.asset.market && API.asset.market.liveQuotes) ? (syms) => API.asset.market.liveQuotes(syms) : undefined });
            S.lastFetchAt = now; if (sess === 'closed' || sess === 'pre') S.closedFetched = true;
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
        afterHoldings(holdings) { S.base = holdings || []; S.lastSig = ''; start(); renderStatus(); if (hasLib() && S.on) { if (Object.keys(LiveQuotes.state.quotes).length) apply(true); tick(true); } },
        afterKpis(k) { S.kpi = k || null; if (hasLib() && S.on && S.base && Object.keys(LiveQuotes.state.quotes).length) apply(true); },
        toggle() {
            S.on = !S.on; try { localStorage.setItem(KEY, JSON.stringify({ on: S.on })); } catch (e) { /* bỏ qua */ }
            S.lastSig = ''; if (S.on) { tick(true); } else apply(true);
            renderStatus();
        },
        active() { return !!(hasLib() && S.on); },
        renderStatus: renderStatus,
        state: S,
    };
})();
