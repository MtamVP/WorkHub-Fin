/* --- FILE: /stocksheet/script.js ---
   Tổng Hợp Cổ Phiếu: (1) Bảng so sánh mọi mã đã định giá — kết luận Rẻ / Hợp lý / Đắt theo giá hiện tại;
   (2) Chi tiết một mã — khoảng giá theo từng phương pháp, 3 kịch bản, chỉ số chất lượng & tăng trưởng, dải P/E lịch sử,
   luận điểm + nhật ký đổi mục tiêu, áp dụng giá mục tiêu / giá muốn mua vào danh mục.
   Mọi phép tính nằm ở /lib/valuation-calc.js (có kiểm thử); file này chỉ lấy dữ liệu và vẽ. */

const VC = ValuationCalc;
const VU = ValuationUI;

const state = {
    view: 'overview',
    items: [],              // mỗi mã 1 dòng đã phân tích (xem analyzeItem)
    overviewLoaded: false,
    filter: 'all',
    query: '',
    sort: { key: 'upside', dir: -1 },
    detail: null,           // { symbol, year, rows, quarters, live, series, a, hist }
    portfolio: { held: [], watched: [] }, // mã đang nắm / theo dõi (kể cả chưa định giá)
    fin: { updates: [], status: null },   // máy chủ tự làm mới số liệu mỗi ngày: mã nào có báo cáo mới + trạng thái lần chạy
    charts: []
};

document.addEventListener('DOMContentLoaded', function () {
    applyThemeIcon();
    bindOverviewEvents();
    loadOverview().then(function () {
        const m = /^#([A-Za-z0-9]{1,12})(?:\/(\d{4}))?$/.exec(location.hash || '');
        if (m) openDetail(m[1].toUpperCase(), m[2] ? Number(m[2]) : null);
    });
});

// ---------- tiện ích ----------
async function call(action, params) {
    const r = await callGAS(action, params || {});
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}
function cssVar(name) {
    // Đọc trên .asset-container (không phải <html>) vì bảng màu sáng cố định được khai báo trên body/.asset-container.
    const scope = document.querySelector('.asset-container') || document.documentElement;
    return getComputedStyle(scope).getPropertyValue(name).trim();
}
function fmtDate(iso) {
    if (!iso) return '';
    const p = String(iso).slice(0, 10).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] : '';
}
function showToast(message, type = 'success') {
    const existing = document.querySelector('.toast-notification');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    const icon = type === 'success' ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-circle-exclamation"></i>';
    toast.innerHTML = `${icon} <span>${VU.esc(message)}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}

// --- Giao diện sáng / tối (Bàn Tài Sản) ---
function applyThemeIcon() {
    const ic = document.getElementById('theme-ic');
    if (!ic) return;
    ic.className = document.documentElement.getAttribute('data-theme') === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}
function toggleDeskTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('user-theme', next); } catch (e) {}
    applyThemeIcon();
    if (state.view === 'detail' && state.detail) renderDetail(); // biểu đồ đọc màu theo theme nên vẽ lại
}

// ---------- chuyển chế độ xem ----------
function showView(view) {
    state.view = view;
    document.getElementById('view-overview').style.display = view === 'overview' ? '' : 'none';
    document.getElementById('view-detail').style.display = view === 'detail' ? '' : 'none';
    document.getElementById('view-screener').style.display = view === 'screener' ? '' : 'none';
    document.getElementById('view-ideas').style.display = view === 'ideas' ? '' : 'none';
    document.getElementById('seg-ideas').setAttribute('aria-pressed', String(view === 'ideas'));
    document.getElementById('seg-overview').setAttribute('aria-pressed', String(view === 'overview'));
    document.getElementById('seg-detail').setAttribute('aria-pressed', String(view === 'detail'));
    document.getElementById('seg-screener').setAttribute('aria-pressed', String(view === 'screener'));
    if (view === 'screener') renderScreener();
    if (view === 'ideas' && typeof loadIdeas === 'function') loadIdeas();
    if (view === 'overview') {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    } else if (state.detail) {
        renderDetail(); // canvas vừa hiện ra: vẽ lại để biểu đồ lấy đúng kích thước
    }
}
async function refreshAll() {
    await loadOverview();
    if (state.view === 'detail' && document.getElementById('stock-select').value) await loadStockDetail({ force: true });
}

// =====================================================================
// 1. BẢNG SO SÁNH
// =====================================================================
function analyzeItem(item) {
    const data = Object.assign({}, item.data, { year: item.year, symbol: item.symbol });
    const prev = item.prev ? VC.normalize(Object.assign({}, item.prev, { year: item.year - 1 })) : null;
    const a = VC.analyze(data, { prev: prev, quarters: item.quarters, price: item.price });
    return {
        symbol: item.symbol, year: item.year, held: item.held, watched: item.watched, data: item.data,
        priceSource: item.priceSource, priceDate: item.priceDate, updatedAt: item.updatedAt, a: a
    };
}

async function loadOverview(opts) {
    const wrap = document.getElementById('ov-table-wrap');
    wrap.innerHTML = '<div class="vl-empty"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải bảng định giá…</div>';
    try {
        const raw = await call('getStockOverview');
        state.items = raw.map(analyzeItem);
        try { state.portfolio = await call('getStockPortfolioSymbols'); } catch (e) { state.portfolio = { held: [], watched: [] }; }
        try { state.fin = await call('getFinancialsUpdates'); } catch (e) { state.fin = { updates: [], status: null }; }
        state.overviewLoaded = true;
        fillSymbolSelect();
        renderOverview();
        if (state.view === 'screener' && typeof renderScreener === 'function') renderScreener();
        // Bật "tự cập nhật": có số liệu mới thì áp dụng ngay, mỗi lần mở trang đúng 1 lượt (không lặp khi vừa đồng bộ xong)
        if (!(opts && opts.skipAutoSync) && !state.autoSyncTried && autoSyncOn() && (state.fin.updates || []).length) { state.autoSyncTried = true; applyFinUpdates(true); }
    } catch (e) {
        console.error(e);
        wrap.innerHTML = `<div class="vl-empty">Không tải được dữ liệu: ${VU.esc(e.message)}</div>`;
    }
}

function fillSymbolSelect() {
    const select = document.getElementById('stock-select');
    const current = select.value;
    const symbols = state.items.map(i => i.symbol).sort();
    select.innerHTML = '<option value="">-- Chọn mã cổ phiếu --</option>' + symbols.map(s => `<option value="${VU.esc(s)}">${VU.esc(s)}</option>`).join('');
    if (current && symbols.includes(current)) select.value = current;
}

const VERDICT_RANK = { cheap: 0, fair: 1, expensive: 2, none: 3 };
function rowOf(it) {
    const a = it.a, m = a.m;
    return {
        it: it, symbol: it.symbol, year: it.year, price: a.price, fair: a.v.fair, upside: a.verdict.upsidePct,
        verdict: VERDICT_RANK[a.verdict.key], pe: m.pe, pb: m.pb, roe: m.roe, divYield: m.divYield, sector: a.n.sector
    };
}
const COLUMNS = [
    { key: 'symbol', label: 'Mã', left: true }, { key: 'year', label: 'Năm' }, { key: 'price', label: 'Giá hiện tại' },
    { key: 'fair', label: 'Giá hợp lý' }, { key: 'upside', label: 'Tiềm năng' }, { key: 'verdict', label: 'Kết luận', left: true },
    { key: 'pe', label: 'P/E' }, { key: 'pb', label: 'P/B' }, { key: 'roe', label: 'ROE' }, { key: 'divYield', label: 'Cổ tức' },
    { key: 'sector', label: 'Ngành', left: true }
];

function filteredRows() {
    const q = state.query.trim().toUpperCase();
    let rows = state.items.map(rowOf);
    rows = rows.filter(r => {
        if (q && r.symbol.indexOf(q) === -1) return false;
        switch (state.filter) {
            case 'held': return r.it.held;
            case 'watched': return r.it.watched;
            case 'cheap': return r.it.a.verdict.key === 'cheap';
            case 'fair': return r.it.a.verdict.key === 'fair';
            case 'expensive': return r.it.a.verdict.key === 'expensive';
            default: return true;
        }
    });
    const { key, dir } = state.sort;
    rows.sort((x, y) => {
        const a = x[key], b = y[key];
        const an = a === null || a === undefined || (typeof a === 'number' && !isFinite(a));
        const bn = b === null || b === undefined || (typeof b === 'number' && !isFinite(b));
        if (an && bn) return x.symbol < y.symbol ? -1 : 1;
        if (an) return 1;   // thiếu dữ liệu luôn xuống cuối, bất kể chiều sắp xếp
        if (bn) return -1;
        const c = typeof a === 'string' ? a.localeCompare(b, 'vi') : a - b;
        return c * dir || (x.symbol < y.symbol ? -1 : 1);
    });
    return rows;
}

function renderOverview() {
    renderSyncBar();
    const items = state.items;
    const count = k => items.filter(i => i.a.verdict.key === k).length;
    const tile = (label, value, sub) => `<div class="vl-sum"><span class="vl-sum-label">${label}</span><span class="vl-sum-value">${value}${sub ? `<small>${sub}</small>` : ''}</span></div>`;
    document.getElementById('ov-summary').innerHTML =
        tile('Mã đã định giá', items.length, items.filter(i => i.held).length ? `${items.filter(i => i.held).length} đang nắm` : '') +
        tile('Đang rẻ', count('cheap'), 'giá ≤ 80% giá hợp lý') +
        tile('Hợp lý', count('fair'), '80% – 110%') +
        tile('Đang đắt', count('expensive'), '> 110%');

    const chips = [['all', 'Tất cả'], ['held', 'Đang nắm'], ['watched', 'Theo dõi'], ['cheap', 'Rẻ'], ['fair', 'Hợp lý'], ['expensive', 'Đắt']];
    document.getElementById('ov-filters').innerHTML = chips.map(c =>
        `<button type="button" class="vl-chip" data-filter="${c[0]}" aria-pressed="${state.filter === c[0]}">${c[1]}</button>`).join('') +
        `<input type="search" class="vl-search" id="ov-search" placeholder="Tìm mã…" aria-label="Tìm mã cổ phiếu" value="${VU.esc(state.query)}">`;
    const search = document.getElementById('ov-search');
    search.addEventListener('input', function () {
        state.query = this.value;
        renderOverviewTable();
    });
    renderOverviewTable();

    const live = items.filter(i => i.priceSource).length;
    document.getElementById('ov-hint').textContent = items.length
        ? `Giá hiện tại: ${live}/${items.length} mã lấy từ giá thị trường (Danh Mục hoặc đóng cửa gần nhất), còn lại dùng giá lưu trong hồ sơ. Kết luận chỉ là công cụ tham khảo dựa trên giả định bạn nhập, không phải khuyến nghị đầu tư.`
        : '';
}

function renderOverviewTable() {
    const wrap = document.getElementById('ov-table-wrap');
    if (!state.items.length) {
        wrap.innerHTML = `<div class="stock-empty-state"><i class="fa-solid fa-calculator"></i><p>Chưa có mã nào được định giá.<br><a class="vl-link" href="/stocksheet/autosheet/">Mở Định Giá CP để thêm mã đầu tiên →</a></p></div>`;
        return;
    }
    const rows = filteredRows();
    const head = COLUMNS.map(c => {
        const active = state.sort.key === c.key;
        const aria = active ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none';
        const arrow = active ? (state.sort.dir > 0 ? '▲' : '▼') : '';
        return `<th scope="col" class="${c.left ? 'left' : ''}" aria-sort="${aria}"><button type="button" class="vl-sort" data-sort="${c.key}">${c.label} <span aria-hidden="true">${arrow}</span></button></th>`;
    }).join('');
    const body = rows.map(r => {
        const a = r.it.a, m = a.m;
        const tags = (r.it.held ? '<span class="vl-tag"><i class="fa-solid fa-wallet"></i> Đang nắm</span>' : '') +
            (r.it.watched ? ' <span class="vl-tag vl-tag-watch"><i class="fa-solid fa-eye"></i> Theo dõi</span>' : '');
        const src = r.it.priceSource ? `Thị trường ${fmtDate(r.it.priceDate)}` : 'Giá lưu trong hồ sơ';
        const up = a.verdict.upsidePct;
        return `<tr class="vl-row" tabindex="0" role="link" data-symbol="${VU.esc(r.symbol)}" aria-label="Xem chi tiết ${VU.esc(r.symbol)}">
            <td><span class="vl-sym">${VU.esc(r.symbol)}</span>${tags}</td>
            <td>${r.year}</td>
            <td>${VU.vnd(r.price)}<span class="vl-px-src">${VU.esc(src)}</span></td>
            <td>${VU.vnd(r.fair)}</td>
            <td>${VU.isNum(up) ? `<span class="pnl-pill ${VU.signedClass(up)}">${VU.esc(VU.pct(up, 0, true))}</span>` : VU.NA}</td>
            <td class="left">${VU.verdictPill(a.verdict)}</td>
            <td>${VU.mult(m.pe)}</td><td>${VU.mult(m.pb, 2)}</td><td>${VU.pct(m.roe)}</td><td>${VU.pct(m.divYield)}</td>
            <td class="left vl-sec">${VU.esc(VC.SECTORS[a.n.sector].label)}</td>
        </tr>`;
    }).join('');
    wrap.innerHTML = `<table class="vl-ov"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${COLUMNS.length}" class="left" style="padding:22px;color:var(--text-muted)">Không có mã nào khớp bộ lọc.</td></tr>`}</tbody></table>`;
}

function bindOverviewEvents() {
    document.getElementById('ov-filters').addEventListener('click', function (e) {
        const btn = e.target.closest('[data-filter]');
        if (!btn) return;
        state.filter = btn.getAttribute('data-filter');
        this.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
        renderOverviewTable();
    });
    const wrap = document.getElementById('ov-table-wrap');
    wrap.addEventListener('click', function (e) {
        const sort = e.target.closest('[data-sort]');
        if (sort) {
            const key = sort.getAttribute('data-sort');
            state.sort = state.sort.key === key ? { key: key, dir: -state.sort.dir } : { key: key, dir: (key === 'symbol' || key === 'sector' || key === 'verdict') ? 1 : -1 };
            renderOverviewTable();
            const again = wrap.querySelector(`[data-sort="${key}"]`);
            if (again) again.focus();
            return;
        }
        const row = e.target.closest('[data-symbol]');
        if (row) openDetail(row.getAttribute('data-symbol'));
    });
    wrap.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('tr[data-symbol]');
        if (row) { e.preventDefault(); openDetail(row.getAttribute('data-symbol')); }
    });
}

// =====================================================================
// 2. CHI TIẾT MỘT MÃ
// =====================================================================
function onSymbolChange() {
    const yearSelect = document.getElementById('stock-year-select');
    yearSelect.dataset.symbol = '';
    loadStockDetail({ force: true });
}

async function openDetail(symbol, year) {
    state.detail = null; // tránh vẽ lại mã cũ trong lúc chờ tải mã mới
    showView('detail');
    const select = document.getElementById('stock-select');
    select.value = symbol;
    if (select.value !== symbol) { showToast('Mã ' + symbol + ' chưa có hồ sơ định giá', 'error'); return; }
    document.getElementById('stock-year-select').dataset.symbol = '';
    await loadStockDetail({ force: true, year: year });
    try { history.replaceState(null, '', '#' + symbol + (year ? '/' + year : '')); } catch (e) {}
}

function peersFor(symbol, sector) {
    return VC.peerStats(state.items.map(i => ({
        symbol: i.symbol, sector: i.a.n.sector, pe: i.a.m.pe, pb: i.a.m.pb, roe: i.a.m.roe, divYield: i.a.m.divYield
    })), sector, symbol);
}

function analyzeDetail(d) {
    const row = d.rows.find(r => r.year === d.year);
    const prevRow = d.rows.find(r => r.year === d.year - 1);
    const prev = prevRow ? VC.normalize(Object.assign({}, prevRow.data, { year: prevRow.year })) : null;
    d.a = VC.analyze(Object.assign({}, row.data, { year: d.year, symbol: d.symbol }), {
        prev: prev, quarters: d.quarters, price: d.live ? d.live.price : 0
    });
    d.hist = VC.historicalMultiples(d.rows, d.series || []);
    d.peers = peersFor(d.symbol, d.a.n.sector);
}

async function loadStockDetail(opts) {
    opts = opts || {};
    const symbol = document.getElementById('stock-select').value;
    const displayDiv = document.getElementById('sheet-display');
    const spinner = document.getElementById('loading-spinner');
    const yearLabel = document.getElementById('stock-year-label');
    const yearSelect = document.getElementById('stock-year-select');
    const emptyState = document.getElementById('stock-empty-state');

    if (!symbol) {
        displayDiv.style.display = 'none';
        yearLabel.style.display = 'none';
        yearSelect.style.display = 'none';
        emptyState.style.display = 'flex';
        state.detail = null;
        return;
    }
    emptyState.style.display = 'none';

    const reuse = state.detail && state.detail.symbol === symbol && !opts.force;
    if (reuse) {
        state.detail.year = Number(yearSelect.value);
        analyzeDetail(state.detail);
        renderDetail();
        return;
    }

    displayDiv.style.display = 'none';
    spinner.style.display = 'block';
    try {
        const [rows, quarters, live] = await Promise.all([
            call('getStockHistory', { symbol: symbol }),
            call('getStockQuarters', { symbol: symbol }),
            call('getStockLivePrices', { symbols: [symbol] })
        ]);
        const sorted = (rows || []).slice().sort((a, b) => a.year - b.year);
        if (!sorted.length) throw new Error('Chưa có dữ liệu định giá cho mã này.');
        const years = sorted.map(r => r.year).sort((a, b) => b - a);
        yearSelect.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
        yearSelect.dataset.symbol = symbol;
        const want = opts.year && years.includes(opts.year) ? opts.year : years[0];
        yearSelect.value = String(want);
        yearLabel.style.display = 'inline-flex';
        yearSelect.style.display = 'inline-block';

        state.detail = { symbol: symbol, year: want, rows: sorted, quarters: quarters || [], live: (live || {})[symbol] || null, series: null };
        analyzeDetail(state.detail);
        spinner.style.display = 'none';
        renderDetail();
        loadPriceHistory(state.detail); // chạy nền: có giá lịch sử thì vẽ lại thêm dải P/E
    } catch (e) {
        spinner.style.display = 'none';
        displayDiv.style.display = 'block';
        displayDiv.innerHTML = `<div class="vl-empty">${VU.esc(e.message)}</div>`;
        state.detail = null;
    }
}

async function loadPriceHistory(d) {
    try {
        const today = new Date();
        const iso = (t) => t.toISOString().slice(0, 10);
        const minYear = d.rows[0].year;
        const earliest = new Date(today.getTime() - 2590 * 86400000);   // Edge Function giới hạn ~2.600 ngày
        let from = new Date(Date.UTC(minYear - 1, 11, 1));
        if (from < earliest) from = earliest;
        const series = await call('getAssetPriceHistory', { symbols: [d.symbol], from: iso(from), to: iso(today) });
        if (!state.detail || state.detail !== d) return; // người dùng đã chuyển sang mã khác
        d.series = series[d.symbol] || [];
        analyzeDetail(d);
        if (state.view === 'detail') renderDetail();
    } catch (e) {
        console.warn('Không lấy được giá lịch sử:', e.message);
        if (state.detail === d) { d.historyError = e.message; if (state.view === 'detail') renderDetail(); }
    }
}

// ---------- vẽ chi tiết ----------
function destroyCharts() { state.charts.forEach(c => { try { c.destroy(); } catch (e) {} }); state.charts = []; }

function compareSub(kind, d) {
    const m = d.a.m;
    const parts = [];
    const pos = VC.bandPosition(d.hist, kind, m[kind]);
    if (pos) parts.push(`${pos.label} · phân vị ${VU.dec(pos.percentile, 0)}% · TB ${VU.mult(pos.mean, kind === 'pb' ? 2 : 1)} (${pos.n} năm)`);
    if (d.peers && VU.isNum(d.peers[kind])) parts.push(`Cùng ngành (${d.peers.n} mã): trung vị ${VU.mult(d.peers[kind], kind === 'pb' ? 2 : 1)}`);
    return parts.map(VU.esc).join('<br>');
}

function renderDetail() {
    destroyCharts();
    const d = state.detail;
    const display = document.getElementById('sheet-display');
    if (!d) return;
    const a = d.a, n = a.n, m = a.m, v = a.v, verdict = a.verdict;
    const item = state.items.find(i => i.symbol === d.symbol);
    const unitLabel = VC.UNIT_LABELS[n.unit];

    const priceNote = d.live
        ? `Giá ${d.live.source === 'portfolio' ? 'trong Danh Mục' : 'đóng cửa'} ${fmtDate(d.live.date)}`
        : 'Giá lưu trong hồ sơ (chưa lấy được giá thị trường)';
    const status = (item && item.held ? '<span class="vl-tag"><i class="fa-solid fa-wallet"></i> Đang nắm</span>' : '') +
        (item && item.watched ? '<span class="vl-tag vl-tag-watch"><i class="fa-solid fa-eye"></i> Đang theo dõi</span>' : '');

    // --- Hero + kết luận ---
    const hero = VU.heroHtml({
        symbol: d.symbol, meta: [`Số liệu năm ${d.year}`, VC.SECTORS[n.sector].label,
            n.meta.financialsAt ? `Số liệu tự động ${fmtDate(n.meta.financialsAt)}` : 'Số liệu nhập tay',
            n.meta.carriedFrom ? `Giả định kế thừa từ ${n.meta.carriedFrom} — soát lại` : ''],
        statusHtml: status, priceNote: priceNote, a: a
    });

    // --- Khoảng giá (football field) ---
    const ffRows = v.methods.map(x => ({ label: x.label, low: x.bear, base: x.base, high: x.bull, kind: 'method', note: x.note }));
    const impPe = VC.impliedFromBand(d.hist.pe, m.eps), impPb = VC.impliedFromBand(d.hist.pb, m.bvps);
    if (impPe) ffRows.push({ label: 'Dải P/E lịch sử', low: impPe.low, base: impPe.base, high: impPe.high, kind: 'history', note: `TB ${VU.mult(d.hist.pe.mean)} ± 1σ × EPS` });
    if (impPb) ffRows.push({ label: 'Dải P/B lịch sử', low: impPb.low, base: impPb.base, high: impPb.high, kind: 'history', note: `TB ${VU.mult(d.hist.pb.mean, 2)} ± 1σ × BVPS` });
    const last252 = (d.series || []).slice(-252).map(r => Number(r[1])).filter(x => x > 0);
    if (last252.length > 20) ffRows.push({ label: 'Biên độ giá 52 tuần', low: Math.min.apply(null, last252), base: null, high: Math.max.apply(null, last252), kind: 'range', note: 'thấp nhất – cao nhất' });
    const football = `<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-ruler-horizontal"></i> Khoảng giá theo từng phương pháp<span class="vl-muted">đơn vị: VND/cổ phiếu</span></h3>
        ${VU.footballHtml(VC.football(ffRows, a.price), a.price)}</div>`;

    // --- Kịch bản ---
    const notes = VU.dataNotes(n, m).concat(d.historyError ? ['Chưa lấy được giá lịch sử nên chưa có dải P/E, P/B (' + d.historyError + ').'] : []);
    const scen = `<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-layer-group"></i> Ba kịch bản<span class="vl-muted">% so với giá hiện tại</span></h3>
        ${VU.scenarioTableHtml(v, a.price)}
        ${!v.methods.length ? `<div class="vl-note"><i class="fa-solid fa-circle-info"></i><span>Chưa có P/E, P/B mục tiêu nên chưa có giá hợp lý. <a class="vl-link" href="/stocksheet/autosheet/#${VU.esc(d.symbol)}/${d.year}">Mở Định Giá CP</a> và bấm “Gợi ý P/E, P/B theo lịch sử”, rồi Lưu.</span></div>` : ''}
        ${v.scenarios.bear.auto.pe || v.scenarios.bear.auto.pb ? '<p class="vl-hint">Kịch bản xấu/tốt bạn chưa nhập nên mặc định bội số cơ sở −/+20%. Chỉnh trong Định Giá CP › Kịch bản & nâng cao.</p>' : ''}
        ${notes.map(t => `<div class="vl-note"><i class="fa-solid fa-circle-info"></i><span>${VU.esc(t)}</span></div>`).join('')}</div>`;

    // --- Nhóm chỉ số ---
    const R = VU.metricRow, tag = VU.growthTag;
    const groupA = [
        R('Vốn điều lệ', VU.dec(n.charter, 0)),
        R('Vốn chủ sở hữu', VU.dec(n.equity, 0), m.bvpsGrowth !== null ? tag(m.bvpsGrowth, 'BVPS so năm trước') : ''),
        R('Lợi nhuận sau thuế', VU.dec(n.lnst, 0), tag(m.lnstGrowth, 'so năm trước')),
        n.revenue !== null ? R('Doanh thu', VU.dec(n.revenue, 0), m.netMargin !== null ? `Biên lợi nhuận ròng ${VU.pct(m.netMargin)}` : '') : '',
        n.assets !== null ? R('Tổng tài sản', VU.dec(n.assets, 0), m.equityMultiplier !== null ? `Đòn bẩy (TS/VCSH) ${VU.dec(m.equityMultiplier, 1)}x` : '') : ''
    ].join('');
    const basisText = m.basis === 'shares' ? 'Số nhập tay' : 'Ước tính từ vốn điều lệ ÷ 10.000';
    const groupB = [
        R('EPS', VU.vnd(m.eps), tag(m.epsGrowth, 'so năm trước'), 'Lợi nhuận sau thuế / số cổ phiếu'),
        m.ttm ? R('EPS 4 quý gần nhất (TTM)', VU.vnd(m.ttm.eps), `${m.ttm.from} → ${m.ttm.to}`) : '',
        R('Giá trị sổ sách (BVPS)', VU.vnd(m.bvps), tag(m.bvpsGrowth, 'so năm trước')),
        n.dps !== null ? R('Cổ tức tiền / cổ phiếu', VU.vnd(n.dps), m.payout !== null ? `Tỷ lệ chi trả ${VU.pct(m.payout, 0)}` : '') : '',
        m.shares ? R('Số cổ phiếu', VU.dec(m.shares, 0), basisText) : ''
    ].join('');
    const roeSub = (m.roeBasis === 'avg' ? 'Trên vốn chủ bình quân' : 'Trên vốn chủ cuối kỳ') + (d.peers && VU.isNum(d.peers.roe) ? `<br>Cùng ngành: trung vị ${VU.pct(d.peers.roe)}` : '');
    const groupC = [
        R('ROE', VU.pct(m.roe), roeSub),
        m.roa !== null ? R('ROA', VU.pct(m.roa)) : '',
        R('P/E', VU.mult(m.pe), compareSub('pe', d)),
        m.ttm && m.ttm.pe ? R('P/E TTM', VU.mult(m.ttm.pe), 'trên EPS 4 quý gần nhất') : '',
        R('P/B', VU.mult(m.pb, 2), compareSub('pb', d)),
        m.ps !== null ? R('P/S', VU.mult(m.ps, 2)) : '',
        m.peg !== null ? R('PEG', VU.dec(m.peg, 2), 'P/E ÷ tăng trưởng EPS (< 1 thường được coi là rẻ so với tăng trưởng)') : '',
        m.divYield !== null ? R('Tỷ suất cổ tức', VU.pct(m.divYield)) : ''
    ].join('');
    const groups = `<div class="vl-groups">
        <div class="vl-group"><h4>Quy mô & lợi nhuận · ${VU.esc(unitLabel)}</h4>${groupA}</div>
        <div class="vl-group"><h4>Trên mỗi cổ phiếu · VND</h4>${groupB}</div>
        <div class="vl-group"><h4>Chất lượng & định giá</h4>${groupC}</div>
    </div>`;

    // --- Biểu đồ ---
    const hasBand = d.hist.pe && d.hist.pe.n >= 3 && (d.series || []).length > 30 && m.eps > 0;
    const bandHeader = d.hist.pe && d.hist.pe.n >= 3
        ? `<div class="vl-stats"><span>P/E trung bình <b>${VU.mult(d.hist.pe.mean)}</b></span><span>Độ lệch chuẩn <b>${VU.dec(d.hist.pe.sd, 1)}</b></span><span>Thấp nhất – cao nhất <b>${VU.mult(d.hist.pe.min)} – ${VU.mult(d.hist.pe.max)}</b></span><span>Số năm <b>${d.hist.pe.n}</b></span></div>` : '';
    const bandBody = hasBand
        ? `<div class="vl-chartbox"><canvas id="chart-band" aria-label="Giá cổ phiếu so với dải P/E lịch sử"></canvas></div><p class="vl-hint">Ba đường ngang = EPS hiện tại × (P/E trung bình − 1σ, trung bình, + 1σ) của chính mã này. Giá nằm trên đường trên nghĩa là đang đắt hơn thông lệ lịch sử của nó.</p>`
        : `<div class="vl-empty">${(d.series === null && !d.historyError) ? '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải giá lịch sử…' : 'Cần ít nhất 3 năm hồ sơ (EPS dương) cùng giá lịch sử để vẽ dải P/E. Hiện có ' + (d.hist.pe ? d.hist.pe.n : 0) + ' năm. Thêm các năm trước ở Định Giá CP.'}</div>`;
    const charts = `<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-chart-line"></i> Giá so với dải P/E lịch sử</h3>${bandHeader}${bandBody}</div>
        <div class="vl-two">
            <div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-divide"></i> P/E và P/B cuối mỗi năm</h3><div class="vl-chartbox"><canvas id="chart-multiples" aria-label="P/E và P/B theo năm"></canvas></div></div>
            <div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-seedling"></i> EPS và BVPS theo năm</h3><div class="vl-chartbox"><canvas id="chart-fundamentals" aria-label="EPS và BVPS theo năm"></canvas></div></div>
        </div>`;

    // --- Luận điểm + nhật ký mục tiêu ---
    const log = n.targetLog.slice().reverse();
    const logHtml = log.length ? `<div class="vl-table-wrap"><table class="vl-log"><thead><tr><th>Ngày</th><th>Người đổi</th><th>Giá hợp lý</th><th>Giá lúc đó</th><th>P/E mục tiêu</th><th>P/B mục tiêu</th></tr></thead><tbody>${log.map(e => `<tr>
        <td class="left">${VU.esc(String(e.at || '').slice(0, 10).split('-').reverse().join('/'))}</td><td class="left">${VU.esc(String(e.by || '').split('@')[0] || VU.NA)}</td>
        <td>${VU.vnd(e.fair)}</td><td>${VU.vnd(e.price)}</td><td>${VU.mult(e.pe)}</td><td>${VU.mult(e.pb, 2)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="vl-hint">Chưa có lịch sử — nhật ký sẽ ghi lại mỗi lần giá hợp lý đổi trên 0,5% khi bạn lưu ở Định Giá CP.</p>';
    const thesis = `<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-lightbulb"></i> Luận điểm đầu tư & lịch sử đổi mục tiêu</h3>
        ${n.thesis ? `<p class="vl-thesis">${VU.esc(n.thesis)}</p>` : '<p class="vl-hint" style="margin-top:0">Chưa có luận điểm — ghi lý do mua/không mua ở Định Giá CP để sau này đối chiếu.</p>'}
        ${logHtml}</div>`;

    // --- Áp dụng vào danh mục ---
    const fairR = v.fair > 0 ? Math.round(v.fair) : '';
    const buyR = v.fair > 0 ? Math.round(v.fair * 0.8) : '';
    const apply = `<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-paper-plane"></i> Áp dụng vào danh mục của tôi</h3>
        <div class="vl-apply">
            <div class="input-field"><label for="ap-target"><input type="checkbox" id="ap-do-target" checked> Giá mục tiêu (bán/chốt)</label><input type="text" inputmode="numeric" class="input-val" id="ap-target" value="${fairR}"></div>
            <div class="input-field"><label for="ap-mos">Biên an toàn muốn có (%)</label><input type="text" inputmode="decimal" class="input-val" id="ap-mos" value="20" oninput="syncBuyBelow()"></div>
            <div class="input-field"><label for="ap-buy"><input type="checkbox" id="ap-do-buy" checked> Giá muốn mua (cảnh báo khi giá ≤)</label><input type="text" inputmode="numeric" class="input-val" id="ap-buy" value="${buyR}"></div>
        </div>
        <div class="vl-apply-actions"><button type="button" class="btn-save" onclick="applyToPortfolio()"><i class="fa-solid fa-check"></i> Áp dụng</button>
            <span class="vl-muted">Mã đang nắm: ghi vào giá mục tiêu của mã. Giá muốn mua: thêm/cập nhật mục Theo Dõi (cảnh báo email và desktop chạy như cũ).</span></div>
        <div class="vl-apply-actions" style="margin-top:18px;border-top:1px solid var(--border-color);padding-top:14px">
            <a class="btn-refresh" href="/stocksheet/autosheet/#${VU.esc(d.symbol)}/${d.year}"><i class="fa-solid fa-pen"></i> Sửa định giá ${d.year}</a>
            <button type="button" class="btn-refresh" onclick="refreshFinancials()"><i class="fa-solid fa-cloud-arrow-down"></i> Làm mới số liệu tự động</button>
            <button type="button" class="btn-refresh" onclick="deleteCurrentValuation()" style="color:var(--danger-color)"><i class="fa-solid fa-trash"></i> Xoá hồ sơ năm ${d.year}</button></div>
    </div>`;

    display.style.display = 'block';
    display.innerHTML = hero + football + scen + groups + charts + thesis + apply +
        '<p class="vl-hint">Kết quả là công cụ tham khảo dựa trên số liệu và giả định bạn nhập; không phải khuyến nghị đầu tư.</p>';

    drawCharts(d, hasBand);
}

function chartBase() {
    return {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: cssVar('--text-primary'), boxWidth: 12, font: { size: 11 } } } },
    };
}
function axis(extra) {
    return Object.assign({ ticks: { color: cssVar('--text-secondary'), font: { size: 10 } }, grid: { color: cssVar('--border-color') } }, extra || {});
}

function drawCharts(d, hasBand) {
    if (typeof Chart === 'undefined') return;
    const m = d.a.m;
    const accent = cssVar('--finance-accent'), gold = cssVar('--gold'), info = cssVar('--info-color'), danger = cssVar('--danger-color'), muted = cssVar('--text-muted');

    // 1) Giá so với dải P/E lịch sử
    const bandCanvas = document.getElementById('chart-band');
    if (bandCanvas && hasBand) {
        const series = d.series.filter((r, i) => i % 2 === 0 || i === d.series.length - 1);
        const labels = series.map(r => r[0]);
        const st = d.hist.pe;
        const line = (mult) => labels.map(() => Math.round(mult * m.eps));
        const datasets = [
            { label: 'Giá đóng cửa', data: series.map(r => r[1]), borderColor: accent, borderWidth: 1.6, pointRadius: 0, tension: 0 },
            { label: 'P/E TB + 1σ', data: line(st.mean + st.sd), borderColor: danger, borderDash: [5, 4], borderWidth: 1.2, pointRadius: 0 },
            { label: 'P/E TB', data: line(st.mean), borderColor: gold, borderDash: [5, 4], borderWidth: 1.4, pointRadius: 0 }
        ];
        if (st.mean - st.sd > 0) datasets.push({ label: 'P/E TB − 1σ', data: line(st.mean - st.sd), borderColor: info, borderDash: [5, 4], borderWidth: 1.2, pointRadius: 0 });
        state.charts.push(new Chart(bandCanvas.getContext('2d'), {
            type: 'line', data: { labels: labels, datasets: datasets },
            options: Object.assign(chartBase(), { scales: { x: axis({ ticks: { color: cssVar('--text-secondary'), font: { size: 10 }, maxTicksLimit: 8 } }), y: axis() } })
        }));
    }

    // 2) P/E và P/B cuối mỗi năm — ưu tiên số tính lại bằng giá đóng cửa thật, thiếu thì dùng giá lưu trong hồ sơ
    const stored = d.rows.map(r => {
        const a = VC.analyze(Object.assign({}, r.data, { year: r.year }));
        return { year: r.year, pe: a.m.pe, pb: a.m.pb, eps: a.m.eps, bvps: a.m.bvps };
    });
    const byYearHist = {};
    d.hist.byYear.forEach(x => { byYearHist[x.year] = x; });
    const mult = stored.map(s => {
        const h = byYearHist[s.year];
        return { year: s.year, pe: h && h.pe !== null ? h.pe : s.pe, pb: h && h.pb !== null ? h.pb : s.pb };
    });
    const mc = document.getElementById('chart-multiples');
    if (mc) {
        if (mult.length < 2) emptyChart(mc, 'Cần ít nhất 2 năm hồ sơ');
        else state.charts.push(new Chart(mc.getContext('2d'), {
            type: 'line',
            data: { labels: mult.map(x => x.year), datasets: [
                { label: 'P/E', data: mult.map(x => x.pe), borderColor: accent, backgroundColor: accent, yAxisID: 'y', tension: 0.25, spanGaps: true },
                { label: 'P/B', data: mult.map(x => x.pb), borderColor: gold, backgroundColor: gold, yAxisID: 'y1', tension: 0.25, spanGaps: true }
            ] },
            options: Object.assign(chartBase(), { scales: {
                x: axis(), y: axis({ position: 'left', title: { display: true, text: 'P/E (lần)', color: muted, font: { size: 10 } } }),
                y1: axis({ position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'P/B (lần)', color: muted, font: { size: 10 } } })
            } })
        }));
    }

    // 3) EPS và BVPS theo năm
    const fc = document.getElementById('chart-fundamentals');
    if (fc) {
        if (stored.length < 2) emptyChart(fc, 'Cần ít nhất 2 năm hồ sơ');
        else state.charts.push(new Chart(fc.getContext('2d'), {
            type: 'bar',
            data: { labels: stored.map(x => x.year), datasets: [
                { type: 'bar', label: 'EPS (VND)', data: stored.map(x => x.eps === null ? null : Math.round(x.eps)), backgroundColor: accent, borderRadius: 4, yAxisID: 'y' },
                { type: 'line', label: 'BVPS (VND)', data: stored.map(x => x.bvps === null ? null : Math.round(x.bvps)), borderColor: gold, backgroundColor: gold, yAxisID: 'y1', tension: 0.25 }
            ] },
            options: Object.assign(chartBase(), { scales: {
                x: axis(), y: axis({ position: 'left' }), y1: axis({ position: 'right', grid: { drawOnChartArea: false } })
            } })
        }));
    }
}
function emptyChart(canvas, text) {
    const box = canvas.parentElement;
    box.innerHTML = `<div class="vl-empty" style="height:100%;display:flex;align-items:center;justify-content:center">${VU.esc(text)}</div>`;
}

// ---------- hành động ----------
function numberFrom(id) {
    const el = document.getElementById(id);
    return el ? (parseFloat(String(el.value).replace(/[^0-9.]/g, '')) || 0) : 0;
}
function syncBuyBelow() {
    const d = state.detail;
    if (!d || !(d.a.v.fair > 0)) return;
    const mos = Math.min(Math.max(numberFrom('ap-mos'), 0), 90);
    document.getElementById('ap-buy').value = Math.round(d.a.v.fair * (1 - mos / 100));
}

async function applyToPortfolio() {
    const d = state.detail;
    if (!d) return;
    const target = document.getElementById('ap-do-target').checked ? numberFrom('ap-target') : 0;
    const buy = document.getElementById('ap-do-buy').checked ? numberFrom('ap-buy') : 0;
    if (!(target > 0) && !(buy > 0)) { showToast('Hãy tick và nhập ít nhất một mức giá', 'error'); return; }
    const item = state.items.find(i => i.symbol === d.symbol);
    const lines = [];
    if (target > 0) lines.push(`• Giá mục tiêu: ${VU.vnd(target)}${item && item.held ? ' (ghi vào mã đang nắm)' : ' (ghi vào mục Theo Dõi)'}`);
    if (buy > 0) lines.push(`• Giá muốn mua: ${VU.vnd(buy)} (mục Theo Dõi${item && item.watched ? ', cập nhật mục có sẵn' : ', thêm mới'})`);
    if (!window.confirm(`Áp dụng cho ${d.symbol} trong Danh Mục của bạn?\n\n${lines.join('\n')}`)) return;
    try {
        const msg = await call('pushStockToPortfolio', { symbol: d.symbol, targetPrice: target, buyBelow: buy });
        showToast(msg, 'success');
        loadOverview(); // cập nhật nhãn Đang nắm / Theo dõi
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function deleteCurrentValuation() {
    const d = state.detail;
    if (!d) return;
    if (!window.confirm(`Xoá hồ sơ định giá ${d.symbol} năm ${d.year}? Thao tác này không hoàn tác được.`)) return;
    try {
        await call('deleteStockValuation', { symbol: d.symbol, year: d.year });
        showToast(`Đã xoá ${d.symbol} (${d.year})`, 'success');
        const remaining = d.rows.filter(r => r.year !== d.year);
        await loadOverview();
        if (!remaining.length) {
            state.detail = null;
            document.getElementById('stock-select').value = '';
            document.getElementById('sheet-display').style.display = 'none';
            document.getElementById('stock-empty-state').style.display = 'flex';
            document.getElementById('stock-year-label').style.display = 'none';
            document.getElementById('stock-year-select').style.display = 'none';
            showView('overview');
        } else {
            await loadStockDetail({ force: true });
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ---------- đồng bộ số liệu tài chính tự động ----------
function fmtDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderSyncBar() {
    const el = document.getElementById('ov-syncbar');
    if (!el) return;
    const last = FinancialsSync.lastSyncOf(state.items.map(i => i.data));
    const stale = last && last.ageDays > 45;
    const status = last
        ? `Số liệu tự động cập nhật lần cuối <b>${VU.esc(fmtDateTime(last.at))}</b> (${last.ageDays === 0 ? 'hôm nay' : last.ageDays + ' ngày trước'})${stale ? ' <span class="vl-pill vl-pill-expensive"><i class="fa-solid fa-clock" aria-hidden="true"></i> Nên cập nhật</span>' : ''}`
        : (state.items.length ? 'Chưa đồng bộ số liệu tự động lần nào — các mã đang dùng số liệu nhập tay.' : 'Thêm mã để lấy số liệu tài chính tự động.');
    const have = new Set(state.items.map(i => i.symbol));
    const missing = [...new Set([...(state.portfolio.held || []), ...(state.portfolio.watched || [])])].filter(s => !have.has(s));
    const ups = (state.fin.updates || []).filter(u => have.has(u.symbol));
    const auto = autoSyncOn();
    const qLabel = (u) => u.quarterKey ? `Q${u.quarterKey.slice(5)}/${u.quarterKey.slice(0, 4)}` : (u.annualYear ? `năm ${u.annualYear}` : '');
    const st = state.fin.status;
    const autoRan = st && st.ranAt ? `Máy chủ tự kiểm tra báo cáo mới mỗi ngày — lần gần nhất ${VU.esc(fmtDateTime(st.ranAt))}.` : 'Máy chủ tự kiểm tra báo cáo mới mỗi ngày (chưa có lần chạy nào được ghi nhận).';
    el.innerHTML = `<div class="vl-syncrow">
            <span class="vl-sync-status"><i class="fa-solid fa-cloud-arrow-down" aria-hidden="true"></i> ${status}</span>
            <span class="vl-sync-actions">
                <input type="text" class="vl-search" id="qa-symbol" placeholder="Thêm mã (VD: MWG)" maxlength="12" aria-label="Thêm mã cổ phiếu" autocomplete="off" style="margin-left:0;min-width:150px;text-transform:uppercase">
                <button type="button" class="btn-refresh" id="btn-quick-add" onclick="quickAdd()"><i class="fa-solid fa-plus"></i> Thêm</button>
                <button type="button" class="btn-save" id="btn-sync-all" onclick="syncAll()"${state.items.length ? '' : ' disabled'}><i class="fa-solid fa-rotate"></i> Đồng bộ số liệu</button>
            </span>
        </div>
        ${ups.length ? `<div class="vl-note vl-note-new"><i class="fa-solid fa-bell"></i><span>Có số liệu mới từ nguồn thị trường: <b>${ups.map(u => `${VU.esc(u.symbol)}${qLabel(u) ? ' (' + VU.esc(qLabel(u)) + ')' : ''}`).join(', ')}</b>. <button type="button" class="vl-link" onclick="applyFinUpdates()">Cập nhật ${ups.length} mã</button></span></div>` : ''}
        <div class="vl-autosync"><label><input type="checkbox" id="autosync-box" ${auto ? 'checked' : ''} onchange="setAutoSync(this.checked)"> Tự cập nhật khi mở trang</label><span>${autoRan} Cập nhật chỉ ghi đè số liệu tài chính, giữ nguyên P/E, P/B mục tiêu và luận điểm của bạn.</span></div>
        ${missing.length ? `<div class="vl-note"><i class="fa-solid fa-circle-info"></i><span>Trong danh mục của bạn có ${missing.length} mã chưa định giá: <b>${missing.map(VU.esc).join(', ')}</b>. <button type="button" class="vl-link" onclick="addMissing()">Thêm tất cả tự động</button></span></div>` : ''}`;
    const input = document.getElementById('qa-symbol');
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') quickAdd(); });
}

function renderSyncResult(results) {
    const box = document.getElementById('ov-syncresult');
    if (!box) return;
    const ok = results.filter(r => r.ok), bad = results.filter(r => !r.ok);
    const line = (r) => r.ok
        ? `<li><i class="fa-solid fa-circle-check" style="color:var(--success-color)" aria-hidden="true"></i> <b>${VU.esc(r.symbol)}</b>: ${r.summary.updated} năm cập nhật${r.summary.created ? `, ${r.summary.created} năm mới` : ''}${r.summary.carried ? ' — <span style="color:var(--warning-color)">năm mới nhất kế thừa P/E, P/B mục tiêu từ năm trước, hãy soát lại</span>' : ''}</li>`
        : `<li><i class="fa-solid fa-circle-exclamation" style="color:var(--danger-color)" aria-hidden="true"></i> <b>${VU.esc(r.symbol)}</b>: ${VU.esc(r.error)}</li>`;
    box.style.display = 'block';
    box.innerHTML = `<h3 class="vl-card-title"><i class="fa-solid fa-list-check"></i> Kết quả đồng bộ: ${ok.length}/${results.length} mã thành công
            <button type="button" class="vl-link" style="margin-left:auto" onclick="document.getElementById('ov-syncresult').style.display='none'">Đóng</button></h3>
        <ul style="margin:0;padding-left:18px;font-size:0.82rem;line-height:1.9">${results.map(line).join('')}</ul>
        ${bad.length ? '<p class="vl-hint">Mã lỗi thường do sai mã, mã chưa niêm yết hoặc nguồn tạm thời không phản hồi — thử lại sau.</p>' : ''}`;
}

const AUTOSYNC_KEY = 'wh.fin.autosync';
function autoSyncOn() { try { return localStorage.getItem(AUTOSYNC_KEY) === '1'; } catch (e) { return false; } }
function setAutoSync(on) {
    try { localStorage.setItem(AUTOSYNC_KEY, on ? '1' : '0'); } catch (e) { /* bỏ qua */ }
    showToast(on ? 'Đã bật: số liệu mới sẽ tự được cập nhật mỗi lần mở trang.' : 'Đã tắt tự cập nhật.', 'success');
    if (on) applyFinUpdates(true);
}

// Áp dụng số liệu máy chủ đã làm mới sẵn cho các mã có báo cáo mới (không cần gọi nguồn từ máy bạn)
async function applyFinUpdates(silent) {
    const have = new Set(state.items.map(i => i.symbol));
    const symbols = (state.fin.updates || []).map(u => u.symbol).filter(s => have.has(s));
    if (!symbols.length) { if (!silent) showToast('Không có số liệu mới cần cập nhật.', 'success'); return; }
    const results = await runSync(symbols, { useCache: true, silent: !!silent });
    if (silent) {
        const ok = results.filter(r => r.ok).length;
        showToast(`Đã tự cập nhật số liệu mới của ${ok}/${results.length} mã.`, ok ? 'success' : 'error');
    }
}

async function runSync(symbols, opts) {
    const o = opts || {};
    const btn = document.getElementById('btn-sync-all');
    const quick = document.getElementById('btn-quick-add');
    if (btn) btn.disabled = true;
    if (quick) quick.disabled = true;
    try {
        const results = await FinancialsSync.syncMany(symbols, function (done, total, sym) {
            if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${done}/${total} · ${VU.esc(sym)}`;
        }, { useCache: !!o.useCache });
        await loadOverview({ skipAutoSync: true });
        if (!o.silent) renderSyncResult(results);
        return results;
    } finally {
        const b = document.getElementById('btn-sync-all'), q = document.getElementById('btn-quick-add');
        if (b) b.disabled = !state.items.length;
        if (q) q.disabled = false;
    }
}

async function syncAll() {
    const symbols = state.items.map(i => i.symbol);
    if (!symbols.length) { showToast('Chưa có mã nào để đồng bộ', 'error'); return; }
    const msg = `Cập nhật số liệu tài chính của ${symbols.length} mã từ nguồn thị trường?\n\n` +
        '• Ghi đè: vốn điều lệ, vốn chủ, lợi nhuận, doanh thu, tổng tài sản (và cổ tức khi nguồn có)\n' +
        '• Giữ nguyên: P/E-P/B mục tiêu, luận điểm, giá của bạn\n' +
        '• Tự thêm năm mới / năm lịch sử và dữ liệu quý nếu còn thiếu';
    if (!window.confirm(msg)) return;
    await runSync(symbols);
}

async function addMissing() {
    const have = new Set(state.items.map(i => i.symbol));
    const missing = [...new Set([...(state.portfolio.held || []), ...(state.portfolio.watched || [])])].filter(s => !have.has(s));
    if (!missing.length) return;
    await runSync(missing);
}

// Thêm 1 mã mới: lấy số liệu từ nguồn, tạo hồ sơ các năm + dữ liệu quý, rồi mở trang chi tiết.
async function quickAdd() {
    const input = document.getElementById('qa-symbol');
    const sym = String((input && input.value) || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(sym)) { showToast('Nhập mã cổ phiếu hợp lệ (VD: MWG)', 'error'); if (input) input.focus(); return; }
    if (state.items.find(i => i.symbol === sym)) { showToast(sym + ' đã có trong bảng', 'success'); openDetail(sym); return; }
    const btn = document.getElementById('btn-quick-add');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lấy…'; }
    try {
        const p = await FinancialsSync.preview(sym);
        const summary = await FinancialsSync.apply(p);
        await loadOverview();
        showToast(`Đã thêm ${sym}: ${summary.years.length} năm số liệu + ${p.plan.quarters.length} quý. Đặt P/E, P/B mục tiêu ở Định Giá CP (nút “Gợi ý theo lịch sử”).`, 'success');
        openDetail(sym);
    } catch (e) {
        showToast(e.message, 'error');
        const b = document.getElementById('btn-quick-add');
        if (b) { b.disabled = false; b.innerHTML = '<i class="fa-solid fa-plus"></i> Thêm'; }
    }
}

// Làm mới số liệu của mã đang xem (trang chi tiết)
async function refreshFinancials() {
    const d = state.detail;
    if (!d) return;
    if (!window.confirm(`Làm mới số liệu tài chính của ${d.symbol} từ nguồn thị trường?\nSố liệu tài chính các năm sẽ theo nguồn; P/E-P/B mục tiêu, luận điểm, giá của bạn giữ nguyên.`)) return;
    try {
        const results = await FinancialsSync.syncMany([d.symbol]);
        if (!results[0].ok) throw new Error(results[0].error);
        showToast(`Đã làm mới số liệu ${d.symbol}`, 'success');
        await loadOverview();
        await loadStockDetail({ force: true, year: d.year });
    } catch (e) {
        showToast(e.message, 'error');
    }
}
