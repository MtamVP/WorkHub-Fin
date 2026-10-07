/* --- FILE: /mastersheet/assets/today.js ---
   Danh Mục: thẻ "Hôm nay" đầu trang, bản tóm tắt buổi sáng (lib/today-brief.js): danh mục qua phiên trước, sự kiện doanh nghiệp sắp tới, giới hạn đầu tư đang vượt, mã Theo Dõi gần giá muốn mua,
   bộ lọc đã lưu có mã mới, ngành mạnh/yếu 1 tháng, cảnh báo phiên trước. Chỉ ĐỌC dữ liệu có sẵn (không ghi gì); mỗi phần tải riêng, phần nào lỗi hoặc thiếu số liệu thì tự bỏ qua.
   Tải một lần khi mở trang (và khi sự kiện doanh nghiệp tải xong); nút "Làm mới" tải lại. Có thể thu gọn; trạng thái thu gọn nhớ theo ngày (localStorage, chỉ trong máy này).
   Dùng global của script.js / events.js: callGAS, targetEmail, escapeAssetHtml, CE. */
const TodayUI = (function () {
    const KEY = 'wh.fin.today.v1', ALERTS_PREV_KEY = 'wh.fin.livealerts.prev.v1', FILTERWATCH_KEY = 'wh.fin.filterwatch.v1';
    const S = { holdings: null, kpi: null, timer: null, busy: false, result: null, loadedAt: 0, collapsed: false, error: '' };
    const localDate = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const esc = (s) => (typeof escapeAssetHtml === 'function' ? escapeAssetHtml(s) : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
    const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* bỏ qua */ } };
    (function init() { const v = lsGet(KEY); if (v && v.date === localDate() && v.collapsed) S.collapsed = true; })();

    const call = async (action, params) => {
        const r = await callGAS(action, Object.assign({ email: targetEmail }, params || {}));
        if (!r || r.status !== 'success') throw new Error((r && r.message) || action);
        return r.data;
    };

    async function limitsPart() {
        if (typeof LimitsCalc === 'undefined' || typeof LiveAlerts === 'undefined' || !S.holdings || !S.holdings.length) return null;
        const [rows, actor, cd] = await Promise.all([call('listLimits'), call('getLimitActor').catch(() => ({})), call('getCashDebt').catch(() => ({}))]);
        const ev = LimitsCalc.evaluate(LimitsCalc.applicable(rows || [], actor && actor.targetId || null, 'member'), { holdings: S.holdings.map(h => ({ symbol: h.symbol, value: h.marketValue })), cash: Number(cd && cd.cash) || 0, debt: Number(cd && cd.debt) || 0 });
        return { breaches: LiveAlerts.evaluateLimits(ev.items, LimitsCalc.KINDS), warns: ev.warns.length };
    }
    async function sectorsPart() {
        if (typeof SectorHeatmap === 'undefined' || typeof MarketScreener === 'undefined') return null;
        const u = await call('getMarketUniverse', {});
        const rows = MarketScreener.buildRows(u.snapshot || [], u.stats || {}, u.meta || {}), names = {};
        rows.forEach(r => { if (r.icb2_code && typeof SectorMap !== 'undefined') names[r.icb2_code] = SectorMap.icbName(r.icb2_code) || ('ICB ' + r.icb2_code); });
        return SectorHeatmap.build(rows, 'chg1m', { names });
    }

    async function load() {
        if (S.busy || typeof TodayBrief === 'undefined') return;
        S.busy = true; render();
        const ok = (r) => (r.status === 'fulfilled' ? r.value : null);
        try {
            const [nav, watch, limits, sectors] = (await Promise.allSettled([call('getNavHistory', { days: 10 }), call('getWatchlist'), limitsPart(), sectorsPart()])).map(ok);
            const input = {
                nav: nav || [], kpi: S.kpi, holdingsCount: S.holdings ? S.holdings.length : 0, watch: watch || [], limits: limits, sectors: sectors,
                events: typeof CE !== 'undefined' && CE.state === 'ok' ? (CE.items || []) : [],
                filterwatch: lsGet(FILTERWATCH_KEY), alertsPrev: lsGet(ALERTS_PREV_KEY),
            };
            S.result = TodayBrief.build(input, localDate()); S.loadedAt = Date.now(); S.error = '';
        } catch (e) { S.error = e && e.message || String(e); }
        S.busy = false; render();
    }
    function schedule() { if (S.timer) clearTimeout(S.timer); S.timer = setTimeout(() => { S.timer = null; load(); }, 600); }

    function render() {
        const el = document.getElementById('today-brief');
        if (!el) return;
        if (typeof TodayBrief === 'undefined' || !S.kpi) { el.hidden = true; return; }
        el.hidden = false;
        const r = S.result;
        const toggle = `<button type="button" class="btn-tool" aria-expanded="${!S.collapsed}" onclick="TodayUI.toggle()">${S.collapsed ? 'Mở' : 'Thu gọn'}</button><button type="button" class="btn-tool" onclick="TodayUI.refresh()"${S.busy ? ' disabled' : ''} title="Tải lại các phần của bản tóm tắt"><i class="fa-solid fa-rotate${S.busy ? ' fa-spin' : ''}"></i> Làm mới</button>`;
        if (!r) { el.innerHTML = `<div class="tb-head"><b><i class="fa-solid fa-sun"></i> Hôm nay</b><span class="tb-muted">${S.busy ? 'Đang tổng hợp…' : esc(S.error || '')}</span><span class="tb-actions">${toggle}</span></div>`; return; }
        const head = `<div class="tb-head"><b><i class="fa-solid fa-sun"></i> Hôm nay</b><span class="tb-headline ${r.attention ? 'attn' : ''}">${esc(r.headline)}</span><span class="tb-actions">${toggle}</span></div>`;
        if (S.collapsed) { el.innerHTML = head; return; }
        const body = r.sections.length ? `<div class="tb-grid">${r.sections.map(s => `<section class="tb-sec"><h4>${esc(s.title)}</h4><ul>${s.items.map(i => `<li class="tb-${i.tone}">${esc(i.text)}</li>`).join('')}</ul></section>`).join('')}</div>` : '<p class="tb-muted">Chưa có gì để tóm tắt.</p>';
        el.innerHTML = head + body + '<p class="tb-foot">Tóm tắt từ số liệu đã lưu lúc mở trang; giá trực tiếp trong phiên xem ở dòng trạng thái bên dưới. Không phải khuyến nghị đầu tư.</p>';
    }

    return {
        afterHoldings(h) { S.holdings = h || []; schedule(); },
        afterKpis(k) { S.kpi = k || null; if (S.result === null) schedule(); else render(); },
        onEvents() { schedule(); },
        refresh() { load(); },
        toggle() { S.collapsed = !S.collapsed; lsSet(KEY, { date: localDate(), collapsed: S.collapsed }); render(); },
        state: S,
    };
})();
