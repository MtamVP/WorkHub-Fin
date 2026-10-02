/* --- FILE: /stocksheet/autosheet/script.js ---
   Máy tính Định Giá Cổ Phiếu: nhập số liệu năm (+ tuỳ chọn: số cổ phiếu, doanh thu, tổng tài sản, cổ tức, dữ liệu quý),
   chọn mẫu ngành, nhập mục tiêu 3 kịch bản -> thấy NGAY chỉ số, giá hợp lý, kết luận Rẻ/Hợp lý/Đắt và khoảng giá.
   Mọi phép tính nằm ở /lib/valuation-calc.js (có kiểm thử); file này chỉ đọc ô nhập, gọi API và vẽ. */

const VC = ValuationCalc;
const VU = ValuationUI;

// Bối cảnh lấy từ DB cho (mã, năm) đang nhập: năm trước (tăng trưởng, ROE bình quân), dữ liệu quý (TTM), nhật ký mục tiêu cũ.
const ctx = { prev: null, quarters: [], existing: null, existingLog: [], loadedKey: '' };

const $ = (id) => document.getElementById(id);

// --- Giao diện sáng / tối (Bàn Tài Sản) ---
function applyThemeIcon() {
    const ic = $('theme-ic');
    if (!ic) return;
    ic.className = document.documentElement.getAttribute('data-theme') === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}
function toggleDeskTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('user-theme', next); } catch (e) {}
    applyThemeIcon();
}

async function call(action, params) {
    const r = await callGAS(action, params || {});
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}

document.addEventListener('DOMContentLoaded', function () {
    applyThemeIcon();
    $('stock-sector').innerHTML = VU.SECTOR_OPTIONS().map(o => `<option value="${o.value}">${VU.esc(o.label)}</option>`).join('');
    $('stock-unit').innerHTML = Object.keys(VC.UNIT_LABELS).map(k => `<option value="${k}">${VU.esc(VC.UNIT_LABELS[k])}</option>`).join('');
    $('stock-unit').value = 'billion';

    // Mọi ô nhập số: định dạng dấu phân cách ngàn khi gõ, rồi tính lại ngay
    document.querySelectorAll('.input-val').forEach(function (input) {
        input.addEventListener('input', function (e) {
            formatCurrencyInput(e.target);
            if (!e.target.id.startsWith('q-')) calculate();
        });
    });
    ['stock-sector', 'stock-unit'].forEach(id => $(id).addEventListener('change', calculate));
    $('val-thesis').addEventListener('input', function () { /* chỉ đọc lúc lưu */ });

    // Gõ xong mã + năm thì tải bối cảnh (năm trước, quý) và nạp hồ sơ có sẵn để sửa thay vì lưu đè mù
    ['stock-symbol', 'stock-year'].forEach(id => $(id).addEventListener('blur', function () { loadContext(); }));
    $('stock-symbol').addEventListener('keydown', function (e) { if (e.key === 'Enter') this.blur(); });

    updateUnitText();
    const m = /^#([A-Za-z0-9]{1,12})(?:\/(\d{4}))?$/.exec(location.hash || '');
    if (m) {
        $('stock-symbol').value = m[1].toUpperCase();
        if (m[2]) $('stock-year').value = m[2];
        loadContext();
    }
    calculate();
});

// --- 1. ĐỊNH DẠNG SỐ ---
// Kết quả hiển thị: kiểu Việt Nam (chấm ngàn, phẩy thập phân). Ô nhập: kiểu quốc tế (phẩy ngàn, chấm thập phân) để dễ đọc ngược.
function formatOnly(num) {
    if (num === undefined || num === null || num === '') return '';
    return Number(num).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function formatCurrencyInput(input) {
    let cursor = input.selectionStart;
    const oldLength = input.value.length;
    const signed = input.dataset.signed === '1';

    let raw = input.value.replace(/[^0-9.-]/g, '');
    const neg = signed && raw.charAt(0) === '-';
    raw = raw.replace(/-/g, '');
    const firstDot = raw.indexOf('.');
    if (firstDot !== -1) raw = raw.slice(0, firstDot + 1) + raw.slice(firstDot + 1).replace(/\./g, ''); // chỉ 1 dấu chấm thập phân
    if (raw === '') { input.value = neg ? '-' : ''; return; }

    const parts = raw.split('.');
    const intFmt = parts[0] === '' ? '0' : parseInt(parts[0], 10).toLocaleString('en-US');
    const next = (neg ? '-' : '') + intFmt + (parts.length > 1 ? '.' + parts[1] : '');
    input.value = next;
    cursor = Math.max(0, cursor + (next.length - oldLength));
    try { input.setSelectionRange(cursor, cursor); } catch (e) { /* input type=number không hỗ trợ */ }
}

// Giá trị thật của ô nhập: '' nếu trống / chưa là số, ngược lại là số (cho phép âm ở ô signed)
function readNum(id) {
    const el = $(id);
    if (!el) return '';
    const s = String(el.value).replace(/,/g, '').trim();
    if (s === '' || s === '-' || s === '.') return '';
    const n = parseFloat(s);
    return isFinite(n) ? n : '';
}
function setNum(id, value) {
    const el = $(id);
    if (el) el.value = (value === null || value === undefined || value === '') ? '' : formatOnly(value);
}

function updateUnitText() {
    const label = ' · ' + VC.UNIT_LABELS[$('stock-unit').value];
    document.querySelectorAll('.unit-text').forEach(el => { el.textContent = label; });
}

// --- 2. GOM Ô NHẬP -> DỮ LIỆU HỒ SƠ ---
function gatherInputs() {
    return {
        symbol: $('stock-symbol').value.trim().toUpperCase(),
        year: parseInt($('stock-year').value, 10) || null,
        sector: $('stock-sector').value, unit: $('stock-unit').value,
        v1: readNum('val-1'), v2: readNum('val-2'), v3: readNum('val-3'), v6: readNum('val-6'),
        shares: readNum('val-shares'), revenue: readNum('val-rev'), assets: readNum('val-assets'), dps: readNum('val-dps'),
        ke: readNum('val-ke'), gDiv: readNum('val-gdiv'),
        targetPE: readNum('target-pe'), targetPB: readNum('target-pb'), growthBase: readNum('growth-base'),
        targetPEBear: readNum('pe-bear'), targetPEBull: readNum('pe-bull'),
        targetPBBear: readNum('pb-bear'), targetPBBull: readNum('pb-bull'),
        growthBear: readNum('growth-bear'), growthBull: readNum('growth-bull'),
        thesis: $('val-thesis').value.trim(), targetLog: ctx.existingLog
    };
}

function fillForm(data) {
    const n = VC.normalize(data);
    $('stock-sector').value = n.sector;
    $('stock-unit').value = n.unit;
    setNum('val-1', n.charter); setNum('val-2', n.equity); setNum('val-3', n.lnst); setNum('val-6', n.price);
    setNum('val-shares', n.shares); setNum('val-rev', n.revenue); setNum('val-assets', n.assets); setNum('val-dps', n.dps);
    setNum('val-ke', n.ke); setNum('val-gdiv', n.gDiv);
    setNum('target-pe', n.scenarios.base.pe); setNum('target-pb', n.scenarios.base.pb); setNum('growth-base', n.scenarios.base.growth);
    setNum('pe-bear', n.scenarios.bear.pe); setNum('pe-bull', n.scenarios.bull.pe);
    setNum('pb-bear', n.scenarios.bear.pb); setNum('pb-bull', n.scenarios.bull.pb);
    setNum('growth-bear', n.scenarios.bear.growth); setNum('growth-bull', n.scenarios.bull.growth);
    $('val-thesis').value = n.thesis;
    ctx.existingLog = n.targetLog;
    // mở sẵn các khung nâng cao nếu hồ sơ có dùng
    if (n.shares !== null || n.revenue !== null || n.assets !== null || n.dps !== null) $('adv-extra').open = true;
    if (n.scenarios.bear.pe !== null || n.scenarios.bull.pe !== null || n.scenarios.bear.growth !== null || n.ke !== null) $('adv-scen').open = true;
    updateUnitText();
}

// --- 3. BỐI CẢNH TỪ DB (năm trước, quý, hồ sơ có sẵn) ---
async function loadContext() {
    const symbol = $('stock-symbol').value.trim().toUpperCase();
    const year = parseInt($('stock-year').value, 10);
    const key = symbol + '/' + year;
    ctx.prev = null; ctx.quarters = []; ctx.existing = null;
    if (!symbol || !year) { ctx.loadedKey = ''; ctx.existingLog = []; renderQuarters(); updateCtxLine(); calculate(); return; }
    try {
        const [rows, quarters] = await Promise.all([call('getStockHistory', { symbol: symbol }), call('getStockQuarters', { symbol: symbol })]);
        if ($('stock-symbol').value.trim().toUpperCase() !== symbol || parseInt($('stock-year').value, 10) !== year) return; // người dùng đã đổi tiếp
        const prevRow = rows.find(r => r.year === year - 1);
        ctx.prev = prevRow ? VC.normalize(Object.assign({}, prevRow.data, { year: prevRow.year })) : null;
        ctx.quarters = quarters || [];
        ctx.existing = rows.find(r => r.year === year) || null;
        $('q-year').value = year;
        const isNewKey = ctx.loadedKey !== key;
        ctx.loadedKey = key;
        if (ctx.existing && isNewKey) {
            fillForm(ctx.existing.data);
            showToast(`Đã tải định giá có sẵn của ${symbol} (${year}) để sửa`, 'success');
        } else if (!ctx.existing) {
            ctx.existingLog = [];
            if (isNewKey && !readNum('val-6')) fetchLivePrice(true);
        }
    } catch (e) {
        console.error('Lỗi loadContext:', e);
    }
    $('link-summary').href = '/stocksheet/#' + symbol + '/' + year;
    renderQuarters(); updateCtxLine(); calculate();
}

function updateCtxLine() {
    const parts = [];
    const symbol = $('stock-symbol').value.trim();
    if (symbol && ctx.existing) parts.push(`Đang sửa hồ sơ ${symbol} năm ${$('stock-year').value}.`);
    else if (symbol && ctx.loadedKey) parts.push(`Hồ sơ mới cho ${symbol} năm ${$('stock-year').value}.`);
    if (ctx.prev) parts.push(`Dùng số liệu năm ${ctx.prev.year} để tính tăng trưởng và ROE bình quân.`);
    else if (ctx.loadedKey) parts.push('Chưa có hồ sơ năm trước — chưa tính được tăng trưởng, PEG (nhập năm trước để có).');
    if (ctx.quarters.length) parts.push(`${ctx.quarters.length} quý đã nhập.`);
    parts.push(VC.SECTORS[$('stock-sector').value].hint);
    $('ctx-line').textContent = parts.join(' ');
}

async function fetchLivePrice(silent) {
    const symbol = $('stock-symbol').value.trim().toUpperCase();
    if (!symbol) { if (!silent) showToast('Nhập mã cổ phiếu trước', 'error'); return; }
    const btn = $('btn-live');
    if (!silent) btn.disabled = true;
    try {
        const live = await call('getStockLivePrices', { symbols: [symbol] });
        const p = live[symbol];
        if (!p) { if (!silent) showToast('Chưa lấy được giá thị trường của ' + symbol, 'error'); return; }
        setNum('val-6', p.price);
        const d = String(p.date || '').split('-');
        showToast(`Giá ${symbol}: ${VU.vnd(p.price)} (${d.length === 3 ? d[2] + '/' + d[1] : 'gần nhất'})`, 'success');
        calculate();
    } catch (e) {
        if (!silent) showToast(e.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

// --- 4. TÍNH TOÁN + VẼ KẾT QUẢ ---
function calculate() {
    updateUnitText();
    const inputs = gatherInputs();
    const a = VC.analyze(inputs, { prev: ctx.prev, quarters: ctx.quarters });
    const n = a.n, m = a.m, v = a.v;
    const pending = '—';

    $('val-4').innerText = m.bvps === null ? pending : VU.dec(m.bvps);
    $('val-5').innerText = m.eps === null ? pending : VU.dec(m.eps);
    $('val-7').innerText = m.pe === null ? pending : VU.dec(m.pe);
    $('val-8').innerText = m.pb === null ? pending : VU.dec(m.pb);

    // chỉ số bổ sung: chỉ hiện những ô tính được
    const tiles = [
        ['fa-bullseye', 'ROE', m.roe !== null ? VU.pct(m.roe) : null],
        ['fa-building', 'ROA', m.roa !== null ? VU.pct(m.roa) : null],
        ['fa-percent', 'Biên lợi nhuận ròng', m.netMargin !== null ? VU.pct(m.netMargin) : null],
        ['fa-arrow-trend-up', 'Tăng trưởng LNST', m.lnstGrowth !== null ? VU.pct(m.lnstGrowth, 1, true) : null],
        ['fa-arrow-trend-up', 'Tăng trưởng EPS', m.epsGrowth !== null ? VU.pct(m.epsGrowth, 1, true) : null],
        ['fa-scale-unbalanced', 'PEG', m.peg !== null ? VU.dec(m.peg) : null],
        ['fa-coins', 'Tỷ suất cổ tức', m.divYield !== null ? VU.pct(m.divYield) : null],
        ['fa-receipt', 'Tỷ lệ chi trả', m.payout !== null ? VU.pct(m.payout, 0) : null],
        ['fa-calendar-check', m.ttm ? `EPS TTM (${m.ttm.from}→${m.ttm.to})` : 'EPS TTM', m.ttm ? VU.dec(m.ttm.eps, 0) : null],
        ['fa-divide', 'P/E TTM', m.ttm && m.ttm.pe ? VU.dec(m.ttm.pe) : null],
        ['fa-chart-pie', 'P/S', m.ps !== null ? VU.dec(m.ps) : null],
        ['fa-layer-group', 'Đòn bẩy (TS/VCSH)', m.equityMultiplier !== null ? VU.dec(m.equityMultiplier, 1) + 'x' : null]
    ].filter(t => t[2] !== null);
    $('calc-extra').style.gridTemplateColumns = 'repeat(auto-fit, minmax(150px, 1fr))';
    $('calc-extra').innerHTML = tiles.length ? tiles.map(t => `<div class="stat-tile">
        <span class="stat-tile-icon"><i class="fa-solid ${t[0]}"></i></span>
        <span class="stat-tile-label">${VU.esc(t[1])}</span>
        <span class="stat-tile-value">${VU.esc(t[2])}</span></div>`).join('')
        : '<p class="vl-hint" style="grid-column:1/-1;margin:0">Nhập thêm số liệu năm trước, doanh thu, tổng tài sản hoặc cổ tức (mục “Bổ sung”) để có ROE, tăng trưởng, PEG, tỷ suất cổ tức…</p>';

    // bản phản chiếu cột "Cơ sở" trong khung kịch bản
    $('base-pe').textContent = n.scenarios.base.pe !== null ? VU.dec(n.scenarios.base.pe) : '—';
    $('base-pb').textContent = n.scenarios.base.pb !== null ? VU.dec(n.scenarios.base.pb) : '—';
    $('base-growth').textContent = n.scenarios.base.growth !== null ? VU.dec(n.scenarios.base.growth) + '%' : 'EPS hiện tại';
    // gợi ý giá trị tự động ngay trong ô trống của kịch bản xấu / tốt
    const sc = v.scenarios;
    const hint = (id, val, digits) => { const el = $(id); if (el) el.placeholder = val !== null && val !== undefined ? VU.dec(val, digits) : 'tự động'; };
    hint('pe-bear', sc.bear.pe, 1); hint('pe-bull', sc.bull.pe, 1);
    hint('pb-bear', sc.bear.pb, 2); hint('pb-bull', sc.bull.pb, 2);
    hint('growth-bear', sc.bear.growth, 0); hint('growth-bull', sc.bull.growth, 0);

    // kết quả
    const hasAnything = n.charter > 0 || n.shares > 0;
    $('res-hero').innerHTML = hasAnything ? VU.heroHtml({
        symbol: n.symbol || 'Mã chưa nhập', meta: [n.year ? 'Năm ' + n.year : '', VC.SECTORS[n.sector].label],
        priceNote: 'Giá bạn nhập ở trên', a: a
    }) : '<div class="vl-empty">Nhập vốn điều lệ (hoặc số cổ phiếu), vốn chủ sở hữu, lợi nhuận sau thuế và giá để xem kết quả.</div>';
    $('res-scen').innerHTML = VU.scenarioTableHtml(v, a.price);
    const ffRows = v.methods.map(x => ({ label: x.label, low: x.bear, base: x.base, high: x.bull, kind: 'method', note: x.note }));
    $('res-ff').innerHTML = VU.footballHtml(VC.football(ffRows, a.price), a.price);
    const notes = hasAnything ? VU.dataNotes(n, m) : [];
    $('res-notes').innerHTML = notes.map(t => `<div class="vl-note"><i class="fa-solid fa-circle-info"></i><span>${VU.esc(t)}</span></div>`).join('') +
        (hasAnything ? '<p class="vl-hint">Dải P/E, P/B lịch sử và so sánh cùng ngành xem ở trang Tổng hợp CP sau khi lưu.</p>' : '');
    updateCtxLine();
}

// Hàm phụ trợ cũ (giữ tên để các nơi khác không vỡ nếu còn gọi)
function formatNumber(num) {
    if (num === null || num === undefined || isNaN(num) || !isFinite(num)) return '0';
    return num.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
}

// Hàm Reset form nhập liệu (giữ mã, năm, ngành, đơn vị)
function resetData() {
    document.querySelectorAll('.input-val').forEach(input => { if (!input.id.startsWith('q-')) input.value = ''; });
    $('val-thesis').value = '';
    ctx.existingLog = [];
    ctx.existing = null;
    ctx.loadedKey = '';
    calculate();
    showToast('Đã xoá dữ liệu nhập', 'success');
}

// --- 5. DỮ LIỆU QUÝ ---
function renderQuarters() {
    const list = $('q-list');
    const qs = ctx.quarters.slice().sort((a, b) => (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter));
    list.innerHTML = qs.map(q => `<span class="vl-qitem">Q${q.quarter}/${q.year} · LNST ${VU.esc(VU.dec(q.lnst, 2))}${q.revenue !== null && q.revenue !== undefined ? ' · DT ' + VU.esc(VU.dec(q.revenue, 2)) : ''}
        <button type="button" aria-label="Xoá Q${q.quarter}/${q.year}" onclick="removeQuarter(${q.year}, ${q.quarter})"><i class="fa-solid fa-xmark"></i></button></span>`).join('');
    const ttm = VC.ttmFrom(ctx.quarters, VC.normalize(gatherInputs()));
    $('q-ttm').textContent = ttm
        ? `TTM (${ttm.from} → ${ttm.to}): LNST ${VU.dec(ttm.lnst, 2)}${ttm.eps !== null ? ' · EPS ' + VU.dec(ttm.eps, 0) : ''}${ttm.pe ? ' · P/E ' + VU.dec(ttm.pe) : ''}`
        : (qs.length ? 'Chưa đủ 4 quý liền nhau gần nhất để tính TTM (quý nhập cùng đơn vị với số liệu năm).' : 'Chưa có dữ liệu quý. Nhập đủ 4 quý liền nhau để có EPS và P/E 4 quý gần nhất.');
}

async function addQuarter() {
    const symbol = $('stock-symbol').value.trim().toUpperCase();
    if (!symbol) { showToast('Nhập mã cổ phiếu trước', 'error'); $('stock-symbol').focus(); return; }
    const lnst = readNum('q-lnst');
    if (lnst === '') { showToast('Nhập lợi nhuận sau thuế của quý', 'error'); $('q-lnst').focus(); return; }
    try {
        await call('saveStockQuarter', { symbol: symbol, year: parseInt($('q-year').value, 10), quarter: parseInt($('q-quarter').value, 10), lnst: lnst, revenue: readNum('q-rev') });
        ctx.quarters = await call('getStockQuarters', { symbol: symbol });
        $('q-lnst').value = ''; $('q-rev').value = '';
        renderQuarters(); updateCtxLine(); calculate();
        showToast('Đã lưu dữ liệu quý', 'success');
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function removeQuarter(year, quarter) {
    const symbol = $('stock-symbol').value.trim().toUpperCase();
    try {
        await call('deleteStockQuarter', { symbol: symbol, year: year, quarter: quarter });
        ctx.quarters = await call('getStockQuarters', { symbol: symbol });
        renderQuarters(); updateCtxLine(); calculate();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// --- 6. LƯU HỒ SƠ ---
async function saveToSheet() {
    const symbol = $('stock-symbol').value.trim().toUpperCase();
    const year = parseInt($('stock-year').value, 10);
    if (!symbol) { showToast('Vui lòng nhập Mã cổ phiếu!', 'error'); $('stock-symbol').focus(); return; }
    if (!(year >= 2000 && year <= 2100)) { showToast('Năm không hợp lệ', 'error'); $('stock-year').focus(); return; }
    const inputs = gatherInputs();
    if (!(inputs.v1 > 0) && !(inputs.shares > 0)) { showToast('Cần vốn điều lệ hoặc số cổ phiếu lưu hành để tính EPS và BVPS', 'error'); $('val-1').focus(); return; }

    const btn = $('btn-save-sheet');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...';
    btn.disabled = true;
    try {
        // Nhật ký đổi mục tiêu: chỉ ghi thêm khi giá hợp lý đổi > 0,5% so với dòng gần nhất
        const a = VC.analyze(inputs, { prev: ctx.prev, quarters: ctx.quarters });
        const email = localStorage.getItem('userEmail') || localStorage.getItem('currentUser') || null;
        const log = VC.appendTargetLog(ctx.existingLog, {
            at: new Date().toISOString(), by: email, fair: a.v.fair, price: a.price,
            pe: a.n.scenarios.base.pe, pb: a.n.scenarios.base.pb
        });
        inputs.targetLog = log;
        const record = VC.buildRecord(inputs, { prev: ctx.prev, quarters: ctx.quarters });
        await call('saveStockValuation', record);
        ctx.existingLog = log;
        ctx.loadedKey = symbol + '/' + year;
        $('link-summary').href = '/stocksheet/#' + symbol + '/' + year;
        showToast(`Thành công! Đã lưu mã ${symbol} (${year})${a.v.fair > 0 ? ' — giá hợp lý ' + VU.vnd(a.v.fair) : ''}`, 'success');
        loadContext();
    } catch (e) {
        console.error(e);
        showToast('Lỗi lưu: ' + e.message, 'error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// --- 7. THÔNG BÁO (TOAST) ---
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


// --- 8. SỐ LIỆU TÀI CHÍNH TỰ ĐỘNG (nguồn thị trường) ---
const finState = { plan: null };

function billions(v, digits) {
    return v === null || v === undefined ? '—' : VU.dec(v / 1e9, digits === undefined ? 0 : digits);
}

async function openFinPanel() {
    const symbol = $('stock-symbol').value.trim().toUpperCase();
    if (!symbol) { showToast('Nhập mã cổ phiếu trước', 'error'); $('stock-symbol').focus(); return; }
    const panel = $('fin-panel');
    panel.style.display = 'block';
    panel.innerHTML = `<h3 class="vl-card-title"><i class="fa-solid fa-cloud-arrow-down"></i> Số liệu tài chính tự động</h3><div class="vl-empty"><i class="fa-solid fa-spinner fa-spin"></i> Đang lấy báo cáo tài chính của ${VU.esc(symbol)}…</div>`;
    const btn = $('btn-fin');
    btn.disabled = true;
    try {
        const price = readNum('val-6');
        finState.plan = await FinancialsSync.preview(symbol, price > 0 ? { livePrice: price } : {});
        renderFinPanel();
    } catch (e) {
        finState.plan = null;
        panel.innerHTML = `<h3 class="vl-card-title"><i class="fa-solid fa-cloud-arrow-down"></i> Số liệu tài chính tự động</h3>
            <div class="vl-empty">${VU.esc(e.message)}</div>
            <div class="vl-apply-actions"><button type="button" class="btn-refresh" onclick="openFinPanel()"><i class="fa-solid fa-rotate-right"></i> Thử lại</button><button type="button" class="btn-refresh" onclick="closeFinPanel()">Đóng</button></div>`;
    } finally {
        btn.disabled = false;
    }
}

function closeFinPanel() { $('fin-panel').style.display = 'none'; finState.plan = null; }

function renderFinPanel() {
    const p = finState.plan;
    if (!p) return;
    const fin = p.fin, plan = p.plan, symbol = p.symbol;
    const year = parseInt($('stock-year').value, 10);
    const formLabel = { NON_FINANCE: 'Doanh nghiệp thường', BANK: 'Ngân hàng', SECURITIES: 'Chứng khoán', INSURANCE: 'Bảo hiểm' }[fin.form] || 'Chưa nhận diện';
    const rows = fin.annual.slice(0, 6).map(a => `<tr${a.year === year ? ' style="background:var(--finance-accent-subtle)"' : ''}>
        <td class="left">${a.year}</td><td>${billions(a.charter)}</td><td>${billions(a.equityParent !== null ? a.equityParent : a.equity)}</td>
        <td>${billions(a.lnst)}</td><td>${billions(a.revenue)}</td><td>${billions(a.assets)}</td><td>${fin.dividends[a.year] ? VU.vnd(fin.dividends[a.year]) : '—'}</td>
        <td><button type="button" class="vl-link" onclick="fillFromSource(${a.year})">Điền vào form</button></td></tr>`).join('');
    const quarters = fin.quarters.slice(0, 8).map(q => `<span class="vl-qitem" style="padding:4px 12px">Q${q.quarter}/${q.year} · ${billions(q.lnst, 0)}</span>`).join('');
    const s = plan.summary;
    const bits = [];
    if (s.created) bits.push(`${s.created} năm chưa có hồ sơ sẽ được tạo mới`);
    if (s.updated) bits.push(`${s.updated} năm đã có hồ sơ sẽ cập nhật số liệu`);
    if (s.carried) bits.push('năm mới nhất kế thừa P/E, P/B mục tiêu từ năm trước (nhớ soát lại)');
    if (plan.quarters.length) bits.push(`${plan.quarters.length} quý`);
    $('fin-panel').innerHTML = `<h3 class="vl-card-title"><i class="fa-solid fa-cloud-arrow-down"></i> Số liệu tài chính tự động · ${VU.esc(symbol)}
            <span class="vl-muted">${VU.esc(formLabel)} · nguồn VNDirect · tỷ đồng (cổ tức: đồng/cổ phiếu)</span></h3>
        <div class="vl-table-wrap"><table class="vl-log">
            <thead><tr><th>Năm</th><th>Vốn điều lệ</th><th>Vốn chủ (cổ đông mẹ)</th><th>LNST (cổ đông mẹ)</th><th>Doanh thu</th><th>Tổng tài sản</th><th>Cổ tức/cp</th><th></th></tr></thead>
            <tbody>${rows || '<tr><td class="left" colspan="8">Chưa có báo cáo năm.</td></tr>'}</tbody></table></div>
        ${quarters ? `<div class="vl-qlist" style="margin-top:12px">${quarters}</div><p class="vl-hint" style="margin-top:6px">LNST quý riêng lẻ (tỷ đồng). 4 quý liền nhau gần nhất dùng để tính EPS và P/E TTM.</p>` : ''}
        <div class="vl-apply-actions">
            <button type="button" class="btn-save" onclick="saveFinHistory()"><i class="fa-solid fa-floppy-disk"></i> Lưu lịch sử vào hệ thống</button>
            <button type="button" class="btn-refresh" onclick="closeFinPanel()">Đóng</button>
            <span class="vl-muted">${VU.esc(bits.join(' · '))}. Giả định, luận điểm và giá của bạn giữ nguyên.</span>
        </div>`;
}

// Điền số liệu 1 năm của nguồn vào form (chưa lưu). Đổi sang năm đó, nạp bối cảnh (năm trước, quý) rồi ghi đè các ô số liệu tài chính.
async function fillFromSource(year) {
    const p = finState.plan;
    if (!p) return;
    const a = p.fin.annual.find(x => x.year === year);
    if (!a) return;
    $('stock-year').value = year;
    await loadContext();
    const unit = $('stock-unit').value;
    const put = (id, v) => { if (v !== null && v !== undefined) setNum(id, VC.roundForUnit(v, unit)); };
    put('val-1', a.charter);
    put('val-2', a.equityParent !== null ? a.equityParent : a.equity);
    put('val-3', a.lnst);
    put('val-rev', a.revenue);
    put('val-assets', a.assets);
    if (p.fin.dividends[year] > 0) setNum('val-dps', p.fin.dividends[year]);
    if (p.fin.form && VC.FORM_SECTOR[p.fin.form] && !ctx.existing) $('stock-sector').value = VC.FORM_SECTOR[p.fin.form];
    $('adv-extra').open = true;
    calculate();
    renderFinPanel();
    showToast(`Đã điền số liệu năm ${year} từ nguồn — kiểm tra rồi bấm Lưu`, 'success');
}

async function saveFinHistory() {
    const p = finState.plan;
    if (!p) return;
    const s = p.plan.summary;
    const lines = [`Lưu số liệu tài chính của ${p.symbol} vào hệ thống?`, '',
        `• ${s.created} hồ sơ năm mới, ${s.updated} hồ sơ năm cập nhật số liệu`, `• ${p.plan.quarters.length} quý`, '',
        'Số liệu tài chính (vốn điều lệ, vốn chủ, lợi nhuận, doanh thu, tổng tài sản, cổ tức) sẽ theo nguồn; P/E-P/B mục tiêu, luận điểm, giá của bạn giữ nguyên.'];
    if (!window.confirm(lines.join('\n'))) return;
    try {
        await FinancialsSync.apply(p);
        showToast(`Đã lưu ${s.years.length} năm + ${p.plan.quarters.length} quý của ${p.symbol}`, 'success');
        closeFinPanel();
        ctx.loadedKey = '';
        await loadContext();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// Gợi ý P/E, P/B mục tiêu = trung bình lịch sử của chính mã (chỉ điền ô đang trống; ô đã có giá trị thì chỉ hiện số tham khảo).
async function suggestTargets() {
    const symbol = $('stock-symbol').value.trim().toUpperCase();
    const note = $('suggest-note');
    if (!symbol) { showToast('Nhập mã cổ phiếu trước', 'error'); $('stock-symbol').focus(); return; }
    note.textContent = 'Đang tính từ lịch sử…';
    try {
        const rows = await call('getStockHistory', { symbol: symbol });
        if (rows.length < 3) { note.textContent = `Mới có ${rows.length} năm hồ sơ — cần ít nhất 3. Bấm “Lấy số liệu tự động” rồi “Lưu lịch sử” để có đủ.`; return; }
        const minYear = Math.min.apply(null, rows.map(r => r.year));
        const today = new Date();
        const earliest = new Date(today.getTime() - 2590 * 86400000);
        let from = new Date(Date.UTC(minYear - 1, 11, 1));
        if (from < earliest) from = earliest;
        const series = await call('getAssetPriceHistory', { symbols: [symbol], from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) });
        const hist = VC.historicalMultiples(rows, series[symbol] || []);
        const pe = hist.pe && hist.pe.n >= 3 ? hist.pe : null, pb = hist.pb && hist.pb.n >= 3 ? hist.pb : null;
        if (!pe && !pb) { note.textContent = 'Chưa đủ 3 năm có cả số liệu dương và giá lịch sử để tính trung bình.'; return; }
        const parts = [];
        if (pe) {
            parts.push(`P/E trung bình ${VU.mult(pe.mean)} (${VU.mult(pe.min)}–${VU.mult(pe.max)}, ${pe.n} năm)`);
            if (readNum('target-pe') === '') setNum('target-pe', Math.round(pe.mean * 10) / 10);
        }
        if (pb) {
            parts.push(`P/B trung bình ${VU.mult(pb.mean, 2)} (${VU.mult(pb.min, 2)}–${VU.mult(pb.max, 2)}, ${pb.n} năm)`);
            if (readNum('target-pb') === '') setNum('target-pb', Math.round(pb.mean * 100) / 100);
        }
        note.textContent = parts.join(' · ') + '. Ô trống đã được điền bằng mức trung bình — đây chỉ là điểm xuất phát, hãy điều chỉnh theo triển vọng.';
        calculate();
    } catch (e) {
        note.textContent = 'Không tính được: ' + e.message;
    }
}
