/* --- FILE: /valuation/vb-stock.js ---
   Valuation Bench > Hồ sơ cổ phiếu: khung trang, tab Tổng hợp, Cơ bản, Thị trường, Đã lưu. (Tab Định giá và Kỹ thuật ở vb-stock2.js.)
   Chỉ dựng HTML và vẽ biểu đồ từ kết quả của VBEngine.analyze (VB.result); không tính toán tài chính tại đây. Mọi chuỗi chèn vào HTML đều qua vbE() (VU.esc). */

const VB_TABS = [
    ['summary', 'fa-gauge-high', 'Tổng hợp'], ['process', 'fa-list-check', 'Quy trình'], ['fundamental', 'fa-building-columns', 'Cơ bản'], ['valuation', 'fa-scale-balanced', 'Định giá'],
    ['technical', 'fa-chart-line', 'Kỹ thuật'], ['market', 'fa-earth-asia', 'Thị trường'], ['saved', 'fa-bookmark', 'Đã lưu'],
];

function renderStock() {
    const root = document.getElementById('vb-root'); if (!root) return;
    if (VB.loading) { root.innerHTML = '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải dữ liệu ' + vbE(VB.symbol) + '…<span class="vl-muted">báo cáo tài chính, nến giá, bội số lịch sử, thống kê ngành</span></h3><div class="vb-skeleton"><div></div><div></div><div></div></div></div>'; return; }
    if (VB.error) { root.innerHTML = '<div class="vl-card"><div class="vl-empty"><i class="fa-solid fa-triangle-exclamation"></i> Không tải được ' + vbE(VB.symbol) + ': ' + vbE(VB.error) + '<br><button type="button" class="vb-btn" style="margin-top:12px" onclick="reloadStock()"><i class="fa-solid fa-rotate-right"></i> Thử lại</button> <button type="button" class="vb-btn ghost" style="margin-top:12px" onclick="setHash(\'stock\')">Chọn mã khác</button></div></div>'; return; }
    const r = VB.result;
    if (!r || !r.ok) { root.innerHTML = '<div class="vl-card"><div class="vl-empty"><i class="fa-solid fa-circle-question"></i> ' + vbE((r && r.reason) || 'Không dựng được định giá cho mã này.') + '<br><button type="button" class="vb-btn ghost" style="margin-top:12px" onclick="setHash(\'stock\')">Chọn mã khác</button></div></div>'; return; }
    root.innerHTML = '<div id="vb-head"></div><div class="vb-tabs" role="tablist" aria-label="Các phần của hồ sơ" id="vb-tabs"></div><div id="vb-body"></div>' +
        '<p class="vb-disclaimer">Công cụ phân tích, không phải khuyến nghị đầu tư. Giá trị ước tính rất nhạy với giả định (chênh 1 điểm % trong WACC hoặc tăng trưởng dài hạn có thể đổi giá trị hàng chục %). Số liệu miễn phí từ VNDirect có thể trễ hoặc khác báo cáo gốc: hãy đối chiếu báo cáo tài chính trước khi ra quyết định.</p>';
    renderStockBody();
}

function renderStockBody() {
    const r = VB.result; if (!r || !r.ok) return;
    const y = window.scrollY;
    const head = document.getElementById('vb-head'), tabs = document.getElementById('vb-tabs'), body = document.getElementById('vb-body'); if (!body) return;
    head.innerHTML = headHtml(r);
    tabs.innerHTML = VB_TABS.map(function (t) {
        const cnt = t[0] === 'saved' ? VB.history.length : (t[0] === 'technical' && r.technical && r.technical.ok ? r.technical.signals.length : 0);
        return '<button type="button" role="tab" aria-selected="' + (VB.tab === t[0]) + '" onclick="setHash(\'stock\',\'' + vbE(VB.symbol) + '\',\'' + t[0] + '\')"><i class="fa-solid ' + t[1] + '"></i> ' + t[2] + (cnt ? ' <span class="vb-count">' + cnt + '</span>' : '') + '</button>';
    }).join('');
    const fn = { summary: tabSummary, process: tabProcess, fundamental: tabFundamental, valuation: tabValuation, technical: tabTechnical, market: tabMarket, saved: tabSaved }[VB.tab] || tabSummary;
    body.innerHTML = (VB.tab === 'summary' && typeof procBannerHtml === 'function' ? procBannerHtml(r) : '') + fn(r);
    const after = { summary: afterSummary, fundamental: afterFundamental, valuation: afterValuation, technical: afterTechnical, market: afterMarket, saved: afterSaved }[VB.tab];
    if (after) after(r);
    window.scrollTo(0, y);
}

function headHtml(r) {
    const s = r.synthesis, c = r.candles || (VB.bundle && VB.bundle.vb && VB.bundle.vb.candles), px = r.price;
    const closes = c && c.c ? c.c : null, prev = closes && closes.length > 1 ? closes[closes.length - 2] : null, chg = prev ? px / prev - 1 : null;
    const sector = VB.bundle && VB.bundle.peers ? VB.bundle.peers.sectorName : null;
    const pills = [];
    if (s && s.ok) { pills.push(vbPill(s.grade.tone, s.grade.label, 'fa-scale-balanced')); if (r.technical && r.technical.ok && r.technical.timing) pills.push(vbPill(r.technical.timing.tone, r.technical.timing.label, 'fa-chart-line')); if (r.market && r.market.regime) pills.push(vbPill(r.market.regime.tone, 'Thị trường: ' + r.market.regime.label, 'fa-earth-asia')); pills.push(vbPill(s.confidence.tone, 'Tin cậy ' + s.confidence.label.toLowerCase(), 'fa-shield-halved', (s.confidenceWhy || []).join('; '))); }
    const left = '<div class="vl-card" style="margin:0"><div class="vb-sym"><h2>' + vbE(r.symbol) + '</h2><span class="vb-name">' + vbE(r.formLabel) + (sector ? ' · ' + vbE(sector) : '') + '</span></div>' +
        '<div class="vb-price"><b>' + vbN(px) + '</b> <span class="vb-muted">đ</span>' + (chg !== null ? '<span class="' + (chg >= 0 ? 'vb-up' : 'vb-down') + '">' + vbPct(chg, 2, true) + ' phiên cuối</span>' : '') + (closes ? '<span class="vb-muted">' + vbDate(c.t[c.t.length - 1]) + '</span>' : '') + '</div>' +
        '<div class="vb-meta">' + pills.join('') + '</div>' +
        '<div class="vb-actions" style="margin-top:12px"><button type="button" class="vb-btn ghost sm" onclick="reloadStock()"><i class="fa-solid fa-rotate-right"></i> Tải lại dữ liệu</button><a class="vb-btn ghost sm" href="/stocksheet/#' + vbE(r.symbol) + '" title="Mở chi tiết mã ở Investment Workbench"><i class="fa-solid fa-chart-column"></i> Chi tiết ở Investment</a>' +
        '<button type="button" class="vb-btn ghost sm" onclick="setHash(\'stock\')"><i class="fa-solid fa-magnifying-glass"></i> Mã khác</button></div></div>';
    const right = s && s.ok ? '<div class="vl-card" style="margin:0"><h3 class="vl-card-title"><i class="fa-solid fa-bullseye"></i> Kết luận kết hợp<span class="vl-muted">điểm ' + vbN(s.composite, 0) + '</span></h3><p style="margin:0 0 6px;font-weight:700">' + vbE(s.stance.label) + '</p><p class="vb-note" style="margin:0">' + vbE(s.stance.text) + '</p>' + meterHtml(s.composite) + '</div>' : '';
    return '<div class="vb-head">' + left + right + '</div>';
}
function meterHtml(score) {
    if (score === null || score === undefined) return '';
    const w = Math.min(50, Math.abs(score) / 2);
    return '<div class="vb-meter" title="Thang −100 đến +100"><i class="mid"></i><i class="fill ' + (score >= 0 ? 'pos' : 'neg') + '" style="width:' + w + '%"></i></div>';
}

// ---------- tab Tổng hợp ----------
function tabSummary(r) {
    const s = r.synthesis;
    if (!s || !s.ok) return '<div class="vl-card"><div class="vl-empty">' + vbE((s && s.reason) || 'Chưa có giá trị hợp lý.') + '</div></div>';
    const kpi = function (l, v, sub, cls) { return '<div class="vb-kpi"><span class="l">' + vbE(l) + '</span><span class="v ' + (cls || '') + '">' + v + '</span><span class="s">' + sub + '</span></div>'; };
    const mos = s.marginOfSafety;
    const kpis = '<div class="vb-kpis">' +
        kpi('Giá trị hợp lý (đồng thuận)', vbN(s.fair.base) + ' đ', 'dải ' + vbN(s.fair.low) + ' – ' + vbN(s.fair.high) + ' đ') +
        kpi('Giá hiện tại', vbN(s.price) + ' đ', 'P/E ' + (r.multiples && r.multiples.pe ? vbN(r.multiples.pe, 1) + 'x' : '—') + ' · P/B ' + (r.multiples && r.multiples.pb ? vbN(r.multiples.pb, 2) + 'x' : '—')) +
        kpi('Biên an toàn', vbPct(mos, 0, true), mos >= 0 ? 'giá thấp hơn giá trị ước tính' : 'giá cao hơn giá trị ước tính', mos >= 0.1 ? 'vb-up' : (mos <= -0.1 ? 'vb-down' : '')) +
        kpi('Độ tin cậy', vbE(s.confidence.label), 'điểm ' + vbN(s.confidenceScore, 0) + '/100 · ' + s.active + ' phương pháp') +
        kpi('Điểm kỹ thuật', s.technicalScore === null ? '—' : vbN(s.technicalScore, 0), r.technical && r.technical.ok ? vbE(r.technical.rating.label) : 'chưa đủ nến') +
        kpi('Bối cảnh thị trường', s.marketScore === null ? '—' : vbN(s.marketScore, 0), r.market && r.market.regime ? vbE(r.market.regime.label) : 'thiếu dữ liệu') + '</div>';
    const ff = '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-ruler-horizontal"></i> Khoảng giá của từng phương pháp<span class="vl-muted">thanh = thấp–cao · vạch đậm = cơ sở · ô số = trọng số (0 = chỉ hiển thị)</span></h3>' + footballHtml(s) +
        '<div class="vb-legend"><span><i style="background:var(--finance-accent)"></i>Giá trị nội tại</span><span><i style="background:var(--info-color)"></i>Bội số</span><span><i style="background:var(--warning-color)"></i>Tài sản / thu nhập</span><span><i style="background:var(--vb-ma200)"></i>Cổ tức</span></div>' +
        '<p class="vb-note"><b>Giá trị đồng thuận</b> là trung vị có trọng số của các giá trị cơ sở (bền với phương pháp lệch xa). Đổi trọng số ở cột bên phải để thấy tác động; trọng số mặc định theo loại doanh nghiệp. <a href="#methods" style="color:var(--finance-accent)">Xem giải thích từng phương pháp</a>.</p>' +
        '<div class="vb-actions"><button type="button" class="vb-btn ghost sm" onclick="resetParams(\'weights\')"><i class="fa-solid fa-rotate-left"></i> Trọng số mặc định</button>' +
        '<label class="vb-field" style="flex-direction:row;align-items:center;gap:8px">Biên an toàn đặt trước <input class="vb-in w" type="number" step="1" min="0" max="60" value="' + Math.round(VB.params.mos * 100) + '" onchange="setParam(\'top\',\'mos\',Math.min(0.6,Math.max(0,Number(this.value)/100)))"> %</label></div></div>';
    const zones = '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-layer-group"></i> Vùng giá tham khảo<span class="vl-muted">để lập kế hoạch, không phải lệnh</span></h3>' + zonesHtml(s) + '</div>';
    const lists = '<div class="vb-grid2"><div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-list-check"></i> Lý do chính</h3><ul class="vb-list">' +
        s.reasons.pos.map(function (t) { return '<li class="pos"><i class="fa-solid fa-circle-plus"></i><span>' + vbE(t) + '</span></li>'; }).join('') + s.reasons.neg.map(function (t) { return '<li class="neg"><i class="fa-solid fa-circle-minus"></i><span>' + vbE(t) + '</span></li>'; }).join('') +
        (!s.reasons.pos.length && !s.reasons.neg.length ? '<li class="mute"><i class="fa-solid fa-circle"></i><span>Không có yếu tố nào nổi bật: giá quanh giá trị ước tính, kỹ thuật và bối cảnh chưa rõ.</span></li>' : '') + '</ul>' +
        (s.mustBeTrue.length ? '<h4 style="margin:16px 0 6px;font-size:0.82rem">Điều gì phải đúng để giá hiện tại hợp lý</h4><ul class="vb-list">' + s.mustBeTrue.map(function (t) { return '<li class="mute"><i class="fa-solid fa-question"></i><span>' + vbE(t) + '</span></li>'; }).join('') + '</ul>' : '') + '</div>' +
        '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-flag"></i> Cờ cần soát<span class="vl-muted">' + s.flags.length + '</span></h3>' +
        (s.flags.length || r.warnings.length ? '<ul class="vb-list">' + s.flags.map(function (f) { return '<li class="flag"><i class="fa-solid fa-triangle-exclamation"></i><span>' + vbE(f.text) + '</span></li>'; }).join('') + r.warnings.map(function (t) { return '<li class="flag"><i class="fa-solid fa-circle-info"></i><span>' + vbE(t) + '</span></li>'; }).join('') + '</ul>' : '<div class="vl-empty">Không có cờ nào từ điểm chất lượng và độ lệch giữa các phương pháp.</div>') +
        (s.confidenceWhy.length ? '<p class="vb-note"><b>Vì sao độ tin cậy là ' + vbE(s.confidence.label.toLowerCase()) + ':</b> ' + vbE(s.confidenceWhy.join('; ')) + '.</p>' : '') + '</div></div>';
    const save = '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-floppy-disk"></i> Lưu và liên kết với Investment Workbench</h3>' +
        '<p class="vb-note" style="margin-top:0">Mỗi lần lưu tạo một bản mới (lịch sử bất biến). Bản mới nhất hiển thị ở <b>Chi tiết mã</b> và <b>Danh Mục</b> của Investment Workbench để cả nhóm thấy giá trị hợp lý, vùng giá và kết luận. Đã lưu <b>' + VB.history.length + '</b> bản của mã này.</p>' +
        '<div class="vb-actions"><input class="vb-in" id="vb-save-note" maxlength="300" placeholder="Ghi chú ngắn (lý do chỉnh giả định, nguồn tin…)" style="flex:1 1 280px;max-width:520px;font-family:var(--font-body)">' +
        '<button type="button" class="vb-btn" id="vb-save-btn" onclick="saveValuation()"><i class="fa-solid fa-floppy-disk"></i> Lưu bản định giá</button>' +
        '<button type="button" class="vb-btn ghost" onclick="applyToPortfolio()" title="Ghi giá trị hợp lý làm giá mục tiêu và đầu vùng tích lũy làm giá muốn mua trong Danh Mục của bạn"><i class="fa-solid fa-bullseye"></i> Áp dụng vào Danh Mục</button></div></div>';
    return kpis + ff + zones + lists + save;
}

const FF_GROUP_ORDER = { intrinsic: 0, relative: 1, asset: 2, income: 3 };
function footballHtml(s) {
    const R = s.range, span = Math.max(1, R.max - R.min), pos = function (v) { return Math.max(0, Math.min(100, (v - R.min) / span * 100)); };
    const rows = s.methods.slice().sort(function (a, b) { return (FF_GROUP_ORDER[a.group] || 9) - (FF_GROUP_ORDER[b.group] || 9) || b.weight - a.weight; });
    const lines = function () { return '<i class="vb-ff-v price" style="left:' + pos(s.price).toFixed(2) + '%"></i><i class="vb-ff-v fair" style="left:' + pos(s.fair.base).toFixed(2) + '%"></i>'; };
    let html = '<div class="vb-ff"><div></div><div class="vb-ff-top"><span class="vb-ff-tag price" style="left:' + pos(s.price).toFixed(2) + '%">Giá ' + vbN(s.price) + '</span><span class="vb-ff-tag fair" style="left:' + pos(s.fair.base).toFixed(2) + '%">Hợp lý ' + vbN(s.fair.base) + '</span></div><div></div>';
    rows.forEach(function (m) {
        const off = m.weight === 0;
        html += '<div class="vb-ff-label"><b>' + vbE(m.label) + '</b><small>' + vbN(m.low) + ' – ' + vbN(m.base) + ' – ' + vbN(m.high) + ' đ' + (m.outlier ? ' · lệch xa' : '') + '</small></div>' +
            '<div class="vb-ff-track" title="' + vbE(m.note || '') + '">' + lines() + '<i class="vb-ff-bar ' + vbE(m.group === 'relative' ? 'rel' : (m.group === 'asset' ? 'asset' : (m.group === 'income' ? 'income' : ''))) + (off ? ' off' : '') + '" style="left:' + pos(m.low).toFixed(2) + '%;width:' + Math.max(0.6, pos(m.high) - pos(m.low)).toFixed(2) + '%"></i><i class="vb-ff-base" style="left:' + pos(m.base).toFixed(2) + '%"></i></div>' +
            '<input class="vb-in w' + (VB.params.weights[m.key] !== undefined ? ' changed' : '') + '" type="number" min="0" step="0.1" value="' + (Math.round(m.weight * 100) / 100) + '" title="Trọng số trong giá trị đồng thuận (mặc định ' + vbN(m.defaultWeight, 2) + ')" aria-label="Trọng số ' + vbE(m.label) + '" onchange="onWeightInput(\'' + vbE(m.key) + '\',this)">';
    });
    // trục giá
    html += '<div></div><div class="vb-ff-axis">';
    for (let i = 0; i <= 5; i++) { const v = R.min + span * i / 5; html += '<span style="left:' + (i * 20) + '%">' + vbN(v / 1000, 0) + 'k</span>'; }
    html += '</div><div></div></div>';
    return html;
}
function zonesHtml(s) {
    const z = s.zones, price = s.price;
    const lo = Math.min(z.accumulate.low * 0.92, z.invalidation.price ? z.invalidation.price * 0.97 : Infinity, price * 0.9), hi = Math.max(z.fair.high * 1.12, price * 1.1), span = hi - lo, pos = function (v) { return Math.max(0, Math.min(100, (v - lo) / span * 100)); };
    const row = function (name, a, b, cls, txt) { return '<div class="vb-zrow"><span class="n">' + vbE(name) + '</span><div class="t"><i class="z ' + cls + '" style="left:' + pos(a).toFixed(2) + '%;width:' + Math.max(1, pos(b) - pos(a)).toFixed(2) + '%">' + vbE(txt) + '</i>' +
        '<i class="pl" style="left:' + pos(price).toFixed(2) + '%"></i>' + (z.invalidation.price && cls === 'acc' ? '<i class="stop" style="left:' + pos(z.invalidation.price).toFixed(2) + '%" title="Mức vô hiệu kỹ thuật"></i>' : '') + '</div></div>'; };
    const where = { below: 'Giá đang THẤP hơn vùng tích lũy: rẻ hơn mức tham khảo (kiểm tra vì sao).', accumulate: 'Giá đang NẰM TRONG vùng tích lũy tham khảo.', fair: 'Giá đang nằm trong vùng giá trị hợp lý, trên vùng tích lũy.', trim: 'Giá đang CAO hơn dải giá trị hợp lý: vùng cân nhắc giảm tỷ trọng.' }[z.position];
    return '<div class="vb-zoneset">' + row('Tích lũy', z.accumulate.low, z.accumulate.high, 'acc', vbN(z.accumulate.low) + ' – ' + vbN(z.accumulate.high)) + row('Hợp lý', z.fair.low, z.fair.high, 'fair', vbN(z.fair.low) + ' – ' + vbN(z.fair.high)) + row('Cân nhắc giảm', z.trim.low, hi, 'trim', '≥ ' + vbN(z.trim.low)) + '</div>' +
        '<div class="vb-actions" style="margin-top:10px">' + vbPill(z.position === 'accumulate' || z.position === 'below' ? 'ok' : (z.position === 'trim' ? 'warn' : 'mute'), where) + '</div>' +
        '<ul class="vb-list" style="margin-top:12px">' + [z.accumulate.note, z.fair.note, z.trim.note, z.invalidation.note].filter(Boolean).map(function (t) { return '<li class="mute"><i class="fa-solid fa-circle"></i><span>' + vbE(t) + '</span></li>'; }).join('') + '</ul>';
}
function afterSummary() { /* football và vùng giá là HTML thuần */ }

// ---------- tab Cơ bản ----------
function finTable(rows, periods, ratios) {
    const cols = periods.slice(-8);
    const head = '<thead><tr><th class="l">Chỉ tiêu</th>' + cols.map(function (p) { return '<th>' + vbE(String(p.year)) + '</th>'; }).join('') + '</tr></thead>';
    const off = periods.length - cols.length;
    const body = rows.map(function (rw) {
        if (rw.sect) return '<tr class="vb-sect"><td colspan="' + (cols.length + 1) + '">' + vbE(rw.sect) + '</td></tr>';
        return '<tr' + (rw.strong ? ' class="vb-strong"' : (rw.sub ? ' class="vb-sub"' : '')) + '><td>' + vbE(rw.label) + '</td>' + cols.map(function (p, i) { const v = rw.get(p, ratios ? ratios[off + i] : null, off + i); return '<td>' + rw.fmt(v) + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<div class="vb-table-wrap"><table class="vb-table">' + head + '<tbody>' + body + '</tbody></table></div>';
}
const fTy = (v) => vbTy(v), fPc = (v) => vbPct(v, 1), fX = (v) => (v === null || v === undefined ? '—' : vbN(v, 2) + 'x'), fD = (v) => (v === null || v === undefined ? '—' : vbN(v, 0)), fDays = (v) => (v === null || v === undefined ? '—' : vbN(v, 0));
function tabFundamental(r) {
    const P = r.periods, form = r.form;
    let html = '';
    if (form === 'NON_FINANCE') {
        const R = r.fundamental.ratios, Q = r.quality;
        const rows1 = [
            { sect: 'Kết quả kinh doanh (tỷ đồng)' },
            { label: 'Doanh thu thuần', get: (p) => p.revenue, fmt: fTy, strong: true }, { label: 'Tăng trưởng', get: (p, q) => q && q.revenueGrowth, fmt: fPc, sub: true },
            { label: 'Lợi nhuận gộp', get: (p) => p.grossProfit, fmt: fTy }, { label: 'Biên gộp', get: (p, q) => q && q.grossMargin, fmt: fPc, sub: true },
            { label: 'EBIT hoạt động', get: (p) => p.ebit, fmt: fTy }, { label: 'Biên EBIT', get: (p, q) => q && q.ebitMargin, fmt: fPc, sub: true },
            { label: 'EBITDA', get: (p) => p.ebitda, fmt: fTy }, { label: 'LNST công ty mẹ', get: (p) => p.netIncome, fmt: fTy, strong: true }, { label: 'Biên ròng', get: (p, q) => q && q.netMargin, fmt: fPc, sub: true },
            { label: 'EPS (đồng)', get: (p) => p.eps, fmt: fD },
            { sect: 'Bảng cân đối (tỷ đồng)' },
            { label: 'Tiền và đầu tư tài chính ngắn hạn', get: (p) => (p.cash === null && p.stInvest === null ? null : (p.cash || 0) + (p.stInvest || 0)), fmt: fTy }, { label: 'Hàng tồn kho', get: (p) => p.inventory, fmt: fTy }, { label: 'Phải thu', get: (p) => p.receivables, fmt: fTy },
            { label: 'Tài sản cố định', get: (p) => p.fixedAssets, fmt: fTy }, { label: 'Tổng tài sản', get: (p) => p.totalAssets, fmt: fTy, strong: true }, { label: 'Nợ vay', get: (p) => p.debt, fmt: fTy }, { label: 'Nợ ròng (âm = tiền ròng)', get: (p) => (p.debt === null ? null : p.debt - (p.cash || 0) - (p.stInvest || 0)), fmt: fTy },
            { label: 'Vốn chủ công ty mẹ', get: (p) => p.equity, fmt: fTy, strong: true },
            { sect: 'Lưu chuyển tiền (tỷ đồng)' },
            { label: 'Dòng tiền kinh doanh (CFO)', get: (p) => p.cfo, fmt: fTy }, { label: 'Đầu tư tài sản cố định (capex)', get: (p) => p.capex, fmt: fTy }, { label: 'Dòng tiền tự do (FCF)', get: (p) => p.fcf, fmt: fTy, strong: true }, { label: 'Cổ tức đã trả', get: (p) => p.divPaid, fmt: fTy },
        ];
        const rows2 = [
            { sect: 'Sinh lời' }, { label: 'ROE (công ty mẹ)', get: (p, q) => q && q.roe, fmt: fPc, strong: true }, { label: 'ROA', get: (p, q) => q && q.roa, fmt: fPc }, { label: 'ROIC (sau thuế)', get: (p, q) => q && q.roic, fmt: fPc },
            { sect: 'Vốn lưu động (ngày)' }, { label: 'Số ngày thu tiền (DSO)', get: (p, q) => q && q.dso, fmt: fDays }, { label: 'Số ngày tồn kho (DIO)', get: (p, q) => q && q.dio, fmt: fDays }, { label: 'Số ngày trả tiền (DPO)', get: (p, q) => q && q.dpo, fmt: fDays }, { label: 'Chu kỳ chuyển hoá tiền (CCC)', get: (p, q) => q && q.ccc, fmt: fDays, strong: true },
            { sect: 'An toàn tài chính' }, { label: 'Thanh toán hiện hành', get: (p, q) => q && q.currentRatio, fmt: fX }, { label: 'Nợ vay / vốn chủ', get: (p, q) => q && q.debtToEquity, fmt: fX }, { label: 'Nợ ròng / EBITDA', get: (p, q) => q && q.netDebtToEbitda, fmt: fX }, { label: 'Khả năng trả lãi (EBIT / lãi vay)', get: (p, q) => q && q.interestCover, fmt: fX },
            { sect: 'Chất lượng dòng tiền và cổ tức' }, { label: 'CFO / lợi nhuận ròng', get: (p, q) => q && q.cfoToNetIncome, fmt: fX }, { label: 'Biên FCF', get: (p, q) => q && q.fcfMargin, fmt: fPc }, { label: 'Capex / doanh thu', get: (p, q) => q && q.capexToRevenue, fmt: fPc }, { label: 'Tỷ lệ chi trả cổ tức', get: (p, q) => q && q.payout, fmt: fPc }, { label: 'Tăng trưởng bền vững (ROE × giữ lại)', get: (p, q) => q && q.sustainableGrowth, fmt: fPc },
        ];
        const g = r.fundamental.growth;
        html += '<div class="vb-kpis">' + [['Doanh thu 3 năm', g.revenue3y], ['EBIT 3 năm', g.ebit3y], ['Lợi nhuận 3 năm', g.netIncome3y], ['EPS 3 năm', g.eps3y], ['CFO 3 năm', g.cfo3y], ['Vốn chủ 3 năm', g.equity3y]].map(function (k) { return '<div class="vb-kpi"><span class="l">CAGR ' + vbE(k[0]) + '</span><span class="v ' + (k[1] !== null && k[1] < 0 ? 'vb-down' : '') + '">' + vbPct(k[1], 1) + '</span></div>'; }).join('') + '</div>';
        html += '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-table"></i> Báo cáo tài chính ' + vbE(String(Math.min(8, P.length))) + ' năm<span class="vl-muted">' + (r.ttm ? 'TTM đến ' + vbDate(r.ttm.date) + ': doanh thu ' + vbTy(r.ttm.revenue) + ' tỷ, lợi nhuận công ty mẹ ' + vbTy(r.ttm.netIncome) + ' tỷ' : '') + '</span></h3>' + finTable(rows1, P, R) + '</div>';
        html += '<div class="vb-grid2"><div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-chart-line"></i> Doanh thu và lợi nhuận (tỷ đồng)</h3><div class="vb-chart"><canvas id="vb-ch-rev" aria-label="Doanh thu và lợi nhuận theo năm"></canvas></div><div class="vb-legend"><span><i style="background:var(--finance-accent)"></i>Doanh thu</span><span><i style="background:var(--vb-up)"></i>LNST công ty mẹ</span><span><i style="background:var(--vb-ma20)"></i>EBITDA</span></div></div>' +
            '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-percent"></i> Biên lợi nhuận và ROE (%)</h3><div class="vb-chart"><canvas id="vb-ch-margin" aria-label="Biên lợi nhuận theo năm"></canvas></div><div class="vb-legend"><span><i style="background:var(--finance-accent)"></i>Biên gộp</span><span><i style="background:var(--vb-ma20)"></i>Biên EBIT</span><span><i style="background:var(--vb-up)"></i>Biên ròng</span><span><i style="background:var(--vb-ma200)"></i>ROE</span></div></div></div>';
        html += '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-gauge"></i> Tỷ số tài chính</h3>' + finTable(rows2, P, R) + '</div>';
        html += '<div class="vb-grid2">' + piotroskiCard(Q.piotroski) + '<div>' + altmanCard(Q.altman) + beneishCard(Q.beneish, Q.accruals) + '</div></div>' + dupontCard(r.dupont);
    } else if (form === 'BANK') {
        const rows = [
            { sect: 'Kết quả kinh doanh (tỷ đồng)' }, { label: 'Thu nhập lãi thuần (NII)', get: (p) => p.nii, fmt: fTy, strong: true }, { label: 'Thu nhập ngoài lãi', get: (p) => p.nonInterestIncome, fmt: fTy }, { label: 'Tổng thu nhập hoạt động (TOI)', get: (p) => p.toi, fmt: fTy, strong: true }, { label: 'Chi phí hoạt động', get: (p) => p.opex, fmt: fTy },
            { label: 'Lợi nhuận trước dự phòng (PPOP)', get: (p) => p.ppop, fmt: fTy }, { label: 'Chi phí dự phòng rủi ro tín dụng', get: (p) => p.provision, fmt: fTy }, { label: 'Lợi nhuận trước thuế', get: (p) => p.pretax, fmt: fTy }, { label: 'LNST công ty mẹ', get: (p) => p.netIncome, fmt: fTy, strong: true }, { label: 'EPS (đồng)', get: (p) => p.eps, fmt: fD },
            { sect: 'Bảng cân đối (tỷ đồng)' }, { label: 'Dư nợ cho vay khách hàng', get: (p) => p.loansGross, fmt: fTy }, { label: 'Dự phòng rủi ro cho vay (âm)', get: (p) => p.loanProvision, fmt: fTy }, { label: 'Tiền gửi khách hàng', get: (p) => p.deposits, fmt: fTy }, { label: 'Tổng tài sản', get: (p) => p.totalAssets, fmt: fTy, strong: true }, { label: 'Vốn chủ sở hữu', get: (p) => p.equity, fmt: fTy, strong: true },
            { sect: 'Chỉ số ngân hàng' }, { label: 'ROE', get: (p, q, i) => bankAt(r, i, 'roe'), fmt: fPc, strong: true }, { label: 'ROA', get: (p, q, i) => bankAt(r, i, 'roa'), fmt: (v) => vbPct(v, 2) }, { label: 'NIM xấp xỉ (NII / tài sản bình quân)', get: (p, q, i) => bankAt(r, i, 'nimApprox'), fmt: (v) => vbPct(v, 2) },
            { label: 'Chi phí / thu nhập (CIR)', get: (p) => p.costIncome, fmt: fPc }, { label: 'Chi phí tín dụng (dự phòng / dư nợ bình quân)', get: (p, q, i) => bankAt(r, i, 'creditCost'), fmt: (v) => vbPct(v, 2) }, { label: 'Cho vay / tiền gửi (LDR)', get: (p) => p.ldr, fmt: fPc },
            { label: 'Tỷ trọng thu nhập ngoài lãi', get: (p, q, i) => bankAt(r, i, 'nonInterestShare'), fmt: fPc }, { label: 'Tăng trưởng tín dụng', get: (p, q, i) => bankAt(r, i, 'loanGrowth'), fmt: fPc }, { label: 'Tăng trưởng huy động', get: (p, q, i) => bankAt(r, i, 'depositGrowth'), fmt: fPc }, { label: 'Tăng trưởng lợi nhuận', get: (p, q, i) => bankAt(r, i, 'profitGrowth'), fmt: fPc }, { label: 'Vốn chủ / tổng tài sản', get: (p, q, i) => bankAt(r, i, 'equityToAssets'), fmt: fPc },
        ];
        html += '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-building-columns"></i> Báo cáo và chỉ số ngân hàng<span class="vl-muted">' + (r.ttm ? 'TTM đến ' + vbDate(r.ttm.date) + ': lợi nhuận công ty mẹ ' + vbTy(r.ttm.netIncome) + ' tỷ' : '') + '</span></h3>' + finTable(rows, P, null) + '<p class="vb-note"><b>Lưu ý:</b> nguồn miễn phí không có tỷ lệ nợ xấu (NPL), hệ số an toàn vốn (CAR), CASA: hãy đối chiếu báo cáo thường niên của ngân hàng trước khi tin ROE và P/B. Điểm Piotroski, Altman, Beneish không áp dụng cho ngân hàng.</p></div>';
        html += dupontCard(r.dupont);
    } else {
        const rows = [{ label: 'Doanh thu', get: (p) => p.revenue, fmt: fTy }, { label: 'Lợi nhuận trước thuế', get: (p) => p.pretax, fmt: fTy }, { label: 'LNST công ty mẹ', get: (p) => p.netIncome, fmt: fTy, strong: true }, { label: 'EPS (đồng)', get: (p) => p.eps, fmt: fD },
            { label: 'Tổng tài sản', get: (p) => p.totalAssets, fmt: fTy }, { label: 'Nợ phải trả', get: (p) => p.liabilities, fmt: fTy }, { label: 'Vốn chủ công ty mẹ', get: (p) => p.equity, fmt: fTy, strong: true }];
        html += '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-table"></i> Báo cáo ' + vbE(r.formLabel.toLowerCase()) + ' (tỷ đồng)</h3>' + finTable(rows, P, null) + '<p class="vb-note">Doanh nghiệp ' + vbE(r.formLabel.toLowerCase()) + ' có cấu trúc báo cáo riêng: phân tích chi tiết hơn cần đọc báo cáo gốc. Định giá dùng P/B hợp lý, thu nhập thặng dư và bội số ngang hàng.</p></div>' + dupontCard(r.dupont);
    }
    return html;
}
function bankAt(r, i, key) { const s = r.bank && r.bank.series ? r.bank.series[i] : null; return s ? s[key] : null; }
function piotroskiCard(p) {
    if (!p || p.score === null) return '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-clipboard-check"></i> Piotroski F-score</h3><div class="vl-empty">' + vbE((p && p.note) || 'Chưa đủ dữ liệu.') + '</div></div>';
    return '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-clipboard-check"></i> Piotroski F-score<span class="vl-muted">' + vbPill(p.grade.tone, p.score + '/' + p.available + ' · ' + p.grade.label) + '</span></h3><div>' + p.tests.map(function (t) {
        return '<div class="vb-sig"><span class="ic ' + (t.pass === null ? 'neutral' : (t.pass ? 'bull' : 'bear')) + '"><i class="fa-solid ' + (t.pass === null ? 'fa-minus' : (t.pass ? 'fa-check' : 'fa-xmark')) + '"></i></span><span><b>' + vbE(t.label) + '</b><small>' + vbE(t.detail) + '</small></span><span class="sc">' + (t.pass === null ? 'thiếu' : (t.pass ? '1' : '0')) + '</span></div>'; }).join('') + '</div></div>';
}
function altmanCard(a) {
    if (!a || a.z2 === null || a.z2 === undefined) return '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-life-ring"></i> Altman Z</h3><div class="vl-empty">' + vbE((a && a.note) || 'Chưa đủ dữ liệu.') + '</div></div>';
    const x = a.x;
    return '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-life-ring"></i> Altman Z<span class="vl-muted">' + vbPill(a.zone2.tone, a.zone2.label) + '</span></h3><div class="vb-kpis" style="margin-bottom:6px"><div class="vb-kpi"><span class="l">Z" (không sản xuất)</span><span class="v">' + vbN(a.z2, 2) + '</span><span class="s">an toàn > 2,6 · nguy cơ < 1,1</span></div><div class="vb-kpi"><span class="l">Z gốc</span><span class="v">' + (a.z === null ? '—' : vbN(a.z, 2)) + '</span><span class="s">' + (a.zone ? vbE(a.zone.label) : '—') + ' (an toàn > 2,99 · nguy cơ < 1,81)</span></div></div><p class="vb-note" style="margin:0">X1 vốn lưu động/TS ' + vbN(x.x1, 2) + ' · X2 LN giữ lại/TS ' + vbN(x.x2, 2) + ' · X3 EBIT/TS ' + vbN(x.x3, 2) + ' · X4 vốn chủ/nợ ' + vbN(x.x4book, 2) + '. ' + vbE(a.note) + '</p></div>';
}
function beneishCard(b, acc) {
    let html = '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-magnifying-glass-dollar"></i> Chất lượng lợi nhuận';
    if (b && b.m !== null && b.m !== undefined) html += '<span class="vl-muted">' + vbPill(b.flag.tone, b.flag.label) + '</span></h3><div class="vb-kpis" style="margin-bottom:6px"><div class="vb-kpi"><span class="l">Beneish M-score</span><span class="v">' + vbN(b.m, 2) + '</span><span class="s">ngưỡng ' + vbN(b.threshold, 2).replace('-', '−') + ' (cao hơn là cần soát)</span></div>' +
        (acc ? '<div class="vb-kpi"><span class="l">Dồn tích Sloan</span><span class="v">' + vbPct(acc.value, 1) + '</span><span class="s">' + vbE(acc.flag.label) + '</span></div>' : '') + '</div>' +
        '<p class="vb-note" style="margin:0">DSRI ' + vbN(b.vars.dsri, 2) + ' · GMI ' + vbN(b.vars.gmi, 2) + ' · AQI ' + vbN(b.vars.aqi, 2) + ' · SGI ' + vbN(b.vars.sgi, 2) + ' · DEPI ' + vbN(b.vars.depi, 2) + ' · SGAI ' + vbN(b.vars.sgai, 2) + ' · TATA ' + vbN(b.vars.tata, 3) + ' · LVGI ' + vbN(b.vars.lvgi, 2) + '. Cờ chỉ có nghĩa "đọc kỹ thuyết minh", không phải kết luận gian lận.</p></div>';
    else html += '</h3><div class="vl-empty">' + vbE((b && b.note) || 'Chưa đủ dữ liệu.') + '</div>' + (acc ? '<p class="vb-note">Dồn tích Sloan ' + vbPct(acc.value, 1) + ': ' + vbE(acc.flag.label) + '.</p>' : '') + '</div>';
    return html;
}
function dupontCard(d) {
    if (!d || d.roe === null || d.roe === undefined) return '';
    const f = d.five;
    return '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-diagram-project"></i> Phân rã DuPont (năm gần nhất)<span class="vl-muted">ROE ' + vbPct(d.roe, 1) + '</span></h3><div class="vb-kpis" style="margin-bottom:0">' +
        '<div class="vb-kpi"><span class="l">Biên lợi nhuận ròng</span><span class="v">' + vbPct(d.margin, 1) + '</span><span class="s">lợi nhuận / doanh thu</span></div><div class="vb-kpi"><span class="l">Vòng quay tài sản</span><span class="v">' + (d.turnover === null ? '—' : vbN(d.turnover, 2) + 'x') + '</span><span class="s">doanh thu / tài sản bình quân</span></div>' +
        '<div class="vb-kpi"><span class="l">Đòn bẩy tài chính</span><span class="v">' + (d.leverage === null ? '—' : vbN(d.leverage, 2) + 'x') + '</span><span class="s">tài sản / vốn chủ bình quân</span></div>' +
        (f ? '<div class="vb-kpi"><span class="l">Gánh nặng thuế · lãi</span><span class="v">' + vbN(f.taxBurden, 2) + ' · ' + vbN(f.interestBurden, 2) + '</span><span class="s">LNST/LNTT · LNTT/EBIT</span></div>' : '') + '</div>' +
        '<p class="vb-note">ROE cao nhờ <b>biên</b> (lợi thế cạnh tranh) hoặc <b>vòng quay</b> (hiệu quả) bền hơn ROE cao nhờ <b>đòn bẩy</b> (rủi ro).' + (f ? ' ' + vbE(f.note) : '') + '</p></div>';
}
function afterFundamental(r) {
    if (r.form !== 'NON_FINANCE' || !r.fundamental) return;
    const P = r.fundamental.periods, R = r.fundamental.ratios, t = P.map(function (p) { return p.year + '-12-31'; });
    const rev = document.getElementById('vb-ch-rev'), mg = document.getElementById('vb-ch-margin'), B = 1e9;
    if (rev) VBCharts.lines(rev, { t: t, window: t.length, height: 190, digits: 0, series: [{ data: P.map((p) => p.revenue === null ? null : p.revenue / B), color: VBCharts.palette().accent, label: 'Doanh thu' }, { data: P.map((p) => p.netIncome === null ? null : p.netIncome / B), color: VBCharts.palette().up, label: 'LNST' }, { data: P.map((p) => p.ebitda === null ? null : p.ebitda / B), color: VBCharts.palette().ma20, label: 'EBITDA' }] });
    if (mg) VBCharts.lines(mg, { t: t, window: t.length, height: 190, digits: 1, zeroLine: true, series: [{ data: R.map((x) => x.grossMargin === null ? null : x.grossMargin * 100), color: VBCharts.palette().accent, label: 'Biên gộp' }, { data: R.map((x) => x.ebitMargin === null ? null : x.ebitMargin * 100), color: VBCharts.palette().ma20, label: 'Biên EBIT' }, { data: R.map((x) => x.netMargin === null ? null : x.netMargin * 100), color: VBCharts.palette().up, label: 'Biên ròng' }, { data: R.map((x) => x.roe === null ? null : x.roe * 100), color: VBCharts.palette().ma200, label: 'ROE' }] });
}

// ---------- tab Thị trường ----------
function tabMarket(r) {
    const m = r.market, it = r.indexTech, b = VB.bundle;
    let html = '<div class="vb-kpis"><div class="vb-kpi"><span class="l">Điểm bối cảnh</span><span class="v">' + (m.score === null ? '—' : vbN(m.score, 0)) + '</span><span class="s">' + (m.regime ? vbPill(m.regime.tone, m.regime.label) : 'thiếu dữ liệu') + '</span></div>' +
        '<div class="vb-kpi"><span class="l">Xu hướng VN-Index</span><span class="v">' + (it && it.ok ? vbN(it.score, 0) : '—') + '</span><span class="s">' + (it && it.ok ? vbE(it.rating.label) + ' · RSI ' + vbN(it.latest.rsi, 0) : 'chưa có nến chỉ số') + '</span></div>' +
        '<div class="vb-kpi"><span class="l">P/E thị trường (tổng hợp)</span><span class="v">' + (m.marketValuation && m.marketValuation.enough ? vbN(m.marketValuation.now, 1) + 'x' : '—') + '</span><span class="s">' + (m.marketValuation && m.marketValuation.enough ? 'phân vị ' + vbN(m.marketValuation.pct, 0) + ' trong 5 năm' : 'chưa đủ lịch sử') + '</span></div>' +
        '<div class="vb-kpi"><span class="l">Ngành ' + vbE(b && b.peers ? b.peers.sectorName : '') + '</span><span class="v">' + (m.sectorValuation && m.sectorValuation.enough ? vbN(m.sectorValuation.now, 1) + 'x' : '—') + '</span><span class="s">' + (m.sectorValuation && m.sectorValuation.enough ? 'phân vị ' + vbN(m.sectorValuation.pct, 0) + ' · ' + (m.rotation ? vbE(m.rotation.label) : '') : 'chưa đủ lịch sử') + '</span></div></div>';
    html += '<div class="vb-grid2"><div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-sliders"></i> Các yếu tố của bối cảnh</h3>' + (m.factors.length ? m.factors.map(function (f) {
        return '<div class="vb-sig"><span class="ic ' + f.state + '"><i class="fa-solid ' + (f.state === 'bull' ? 'fa-arrow-up' : (f.state === 'bear' ? 'fa-arrow-down' : 'fa-minus')) + '"></i></span><span><b>' + vbE(f.label) + '</b><small>' + vbE(f.detail) + '</small></span><span class="sc">' + vbN(f.score * 100, 0) + '</span></div>'; }).join('') : '<div class="vl-empty">Chưa có dữ liệu nào để đánh giá bối cảnh.</div>') +
        (m.flags.length ? '<ul class="vb-list" style="margin-top:12px">' + m.flags.map(function (f) { return '<li class="flag"><i class="fa-solid fa-triangle-exclamation"></i><span>' + vbE(f.text) + '</span></li>'; }).join('') + '</ul>' : '') + '</div>' +
        '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-chart-area"></i> P/E tổng hợp: thị trường và ngành<span class="vl-muted">đường đậm = thị trường</span></h3><div class="vb-chart"><canvas id="vb-ch-mkt" aria-label="P/E tổng hợp theo thời gian"></canvas></div><div class="vb-legend"><span><i style="background:var(--finance-accent)"></i>Thị trường</span><span><i style="background:var(--vb-ma20)"></i>Ngành</span></div>' +
        '<p class="vb-note">Phân vị cho biết thị trường/ngành đang rẻ hay đắt so với CHÍNH LỊCH SỬ của nó (0 = rẻ nhất 5 năm). P/E tổng hợp chỉ tính mã có lãi nên thấp hơn P/E thật của chỉ số khi nhiều doanh nghiệp lỗ.</p></div></div>';
    const peers = b && b.peers && b.peers.rows ? b.peers.rows.map(function (x) { return { s: x.symbol, m: x.metrics || {} }; }).filter(function (x) { return x.m.marketcap > 0; }).sort(function (a, c) { return c.m.marketcap - a.m.marketcap; }).slice(0, 12) : [];
    if (peers.length) html += '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-people-group"></i> Cổ phiếu cùng ngành (vốn hoá lớn nhất)<span class="vl-muted">' + b.peers.rows.length + ' mã trong ngành</span></h3><div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Mã</th><th>Vốn hoá (tỷ)</th><th>P/E</th><th>P/B</th><th>ROE</th><th>Cổ tức</th><th>1 năm</th><th>RS-Ratio</th></tr></thead><tbody>' +
        peers.map(function (p) { const me = p.s === r.symbol; return '<tr class="vb-clickable' + (me ? ' vb-strong' : '') + '" onclick="setHash(\'stock\',\'' + vbE(p.s) + '\')"><td class="l"><b>' + vbE(p.s) + '</b></td><td>' + vbN(p.m.marketcap / 1e9, 0) + '</td><td>' + (p.m.pe > 0 ? vbN(p.m.pe, 1) + 'x' : '—') + '</td><td>' + (p.m.pb > 0 ? vbN(p.m.pb, 2) + 'x' : '—') + '</td><td>' + vbPct(p.m.roae, 1) + '</td><td>' + vbPct(p.m.divYield, 1) + '</td><td class="' + (p.m.chg1y >= 0 ? 'vb-up' : 'vb-down') + '">' + vbPct(p.m.chg1y, 0, true) + '</td><td>' + (p.m.jdkRs ? vbN(p.m.jdkRs, 1) : '—') + '</td></tr>'; }).join('') + '</tbody></table></div></div>';
    if (it && it.ok) html += '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-chart-line"></i> Kỹ thuật VN-Index<span class="vl-muted">' + vbDate(it.asOf) + '</span></h3><ul class="vb-list">' + it.signals.filter(function (x) { return x.group === 'trend' }).slice(0, 5).map(function (x) { return '<li class="' + (x.state === 'bull' ? 'pos' : (x.state === 'bear' ? 'neg' : 'mute')) + '"><i class="fa-solid fa-circle"></i><span><b>' + vbE(x.label) + ':</b> ' + vbE(x.detail) + '</span></li>'; }).join('') + '</ul></div>';
    return html;
}
function afterMarket(r) {
    const cv = document.getElementById('vb-ch-mkt'); if (!cv || !VB.bundle || !VB.bundle.history) return;
    const VH = ValuationHistory, rows = VB.bundle.history.rows, mk = VH.seriesOf(rows, 'ALL', 'pe_agg'), sc = VB.bundle.peers && VB.bundle.peers.icb2_code ? VH.seriesOf(rows, VB.bundle.peers.icb2_code, 'pe_agg') : [];
    if (!mk.length) { cv.parentElement.innerHTML = '<div class="vl-empty">Chưa có lịch sử định giá thị trường.</div>'; return; }
    const dates = mk.map(function (x) { return x.d; }), byS = {}; sc.forEach(function (x) { byS[x.d] = x.v; });
    const sum = VH.summarize(mk, { years: 5 });
    VBCharts.lines(cv, { t: dates, window: dates.length, height: 230, digits: 1, series: [{ data: mk.map((x) => x.v), color: VBCharts.palette().accent, width: 2, label: 'Thị trường' }, { data: dates.map((d) => (byS[d] === undefined ? null : byS[d])), color: VBCharts.palette().ma20, width: 1.4, label: 'Ngành' }], refs: sum && sum.enough ? [{ y: sum.mean, color: VBCharts.palette().muted }] : [] });
}

// ---------- tab Đã lưu ----------
function tabSaved(r) {
    const H = VB.history;
    let html = '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-bookmark"></i> Các bản định giá đã lưu của ' + vbE(VB.symbol) + '<span class="vl-muted">' + H.length + ' bản · mới trước</span></h3>';
    if (!H.length) return html + '<div class="vl-empty"><i class="fa-solid fa-floppy-disk"></i> Chưa có bản nào. Vào tab Tổng hợp và bấm "Lưu bản định giá" để lưu giả định và kết quả hiện tại.</div></div>';
    html += '<div class="vb-chart"><canvas id="vb-ch-saved" aria-label="Giá trị hợp lý đã lưu theo thời gian"></canvas></div><div class="vb-legend"><span><i style="background:var(--finance-accent)"></i>Giá trị hợp lý</span><span><i style="background:var(--vb-up)"></i>Đầu vùng tích lũy</span><span><i style="background:var(--text-primary)"></i>Giá lúc lưu</span></div>';
    html += '<div class="vb-table-wrap" style="margin-top:14px"><table class="vb-table"><thead><tr><th class="l">Ngày lưu</th><th>Giá trị hợp lý (thấp – cơ sở – cao)</th><th>Giá lúc lưu</th><th>Biên an toàn</th><th class="l">Kết luận</th><th>Tin cậy</th><th class="l">Người lưu</th><th class="l">Ghi chú</th><th></th></tr></thead><tbody>' + H.map(function (h) {
        return '<tr><td class="l">' + vbDate(h.created_at) + '</td><td>' + vbN(h.fair_low) + ' – <b>' + vbN(h.fair_base) + '</b> – ' + vbN(h.fair_high) + '</td><td>' + vbN(h.price) + '</td><td class="' + (h.margin_of_safety >= 0.1 ? 'vb-up' : (h.margin_of_safety <= -0.1 ? 'vb-down' : '')) + '">' + vbPct(h.margin_of_safety, 0, true) + '</td><td class="l">' + vbE(h.stance || h.grade || '') + '</td><td>' + vbE(h.confidence || '—') + '</td><td class="l">' + vbE(h.author || '') + '</td><td class="l">' + vbE(h.note || '') + '</td>' +
            '<td style="white-space:nowrap"><button type="button" class="vb-btn ghost sm" onclick="restoreSaved(\'' + vbE(h.id) + '\')" title="Nạp lại giả định của bản này"><i class="fa-solid fa-clock-rotate-left"></i></button> <button type="button" class="vb-btn ghost sm" onclick="deleteSaved(\'' + vbE(h.id) + '\')" title="Xoá bản này"><i class="fa-solid fa-trash"></i></button></td></tr>'; }).join('') + '</tbody></table></div></div>';
    return html;
}
function afterSaved() {
    const cv = document.getElementById('vb-ch-saved'); if (!cv || !VB.history.length) return;
    const H = VB.history.slice().reverse(), t = H.map(function (h) { return String(h.created_at).slice(0, 10); });
    VBCharts.lines(cv, { t: t, window: t.length, height: 200, digits: 0, series: [{ data: H.map((h) => h.fair_base), color: VBCharts.palette().accent, width: 2, label: 'Hợp lý' }, { data: H.map((h) => h.accumulate_high), color: VBCharts.palette().up, width: 1.3, label: 'Tích lũy' }, { data: H.map((h) => h.price), color: VBCharts.palette().primary, width: 1.3, dash: [4, 3], label: 'Giá' }] });
}
