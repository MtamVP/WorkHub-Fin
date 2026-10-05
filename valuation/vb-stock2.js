/* --- FILE: /valuation/vb-stock2.js ---
   Valuation Bench > Hồ sơ cổ phiếu: tab Định giá (DCF, bội số, tài sản/thu nhập, ngân hàng) và tab Kỹ thuật (biểu đồ nến, chỉ báo, tín hiệu, mức giá, mẫu nến, sức mạnh tương đối).
   Chỉ dựng HTML và vẽ từ VB.result; người dùng chỉnh giả định qua ô nhập (onParamInput) -> VBEngine tính lại. */

// ---------- ô nhập giả định ----------
function fmtIn(v, mode) { if (v === null || v === undefined || !isFinite(v)) return ''; return mode === 'pct' ? String(Math.round(v * 10000) / 100) : String(Math.round(v * 1000) / 1000); }
function vbField(group, key, label, cur, base, mode, hint, step) {
    const ov = group === 'top' ? VB.params[key] !== null && VB.params[key] !== undefined : VB.params[group][key] !== undefined;
    if (mode === 'bool') return '<label class="vb-field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" data-group="' + group + '" data-key="' + key + '" data-mode="bool"' + (cur ? ' checked' : '') + ' onchange="onParamInput(this)"> ' + vbE(label) + '</label>';
    return '<label class="vb-field">' + vbE(label) + '<input class="vb-in' + (ov ? ' changed' : '') + '" type="number" step="' + (step || (mode === 'pct' ? '0.1' : '0.01')) + '" data-group="' + group + '" data-key="' + key + '" data-mode="' + mode + '" value="' + fmtIn(cur, mode) + '" placeholder="' + fmtIn(base, mode) + '" onchange="onParamInput(this)">' + (hint ? '<small>' + vbE(hint) + '</small>' : '') + '</label>';
}

// ---------- ô lưới nhạy cảm ----------
function sensGrid(rowLabels, colLabels, values, price, rowFmt, colFmt, cr, cc) {
    let h = '<div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l"></th>' + colLabels.map(function (c) { return '<th>' + colFmt(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
    values.forEach(function (row, i) {
        h += '<tr><td class="l"><b>' + rowFmt(rowLabels[i]) + '</b></td>' + row.map(function (v, j) {
            const base = i === cr && j === cc, cls = v === null ? '' : (price > 0 && v >= price * 1.1 ? 'vb-up' : (price > 0 && v <= price * 0.9 ? 'vb-down' : ''));
            return '<td class="' + cls + '"' + (base ? ' style="font-weight:800;background:var(--finance-accent-subtle)"' : '') + '>' + (v === null ? '—' : vbN(v)) + '</td>'; }).join('') + '</tr>';
    });
    return h + '</tbody></table></div>';
}

// ---------- tab Định giá ----------
function tabValuation(r) {
    let html = '';
    if (r.form === 'NON_FINANCE') html += dcfSection(r); else html += bankSection(r);
    html += multiplesSection(r) + assetSection(r);
    return html;
}

function dcfSection(r) {
    const a = r.dcfAssumptions, base = r.dcfBase, d = r.dcf;
    if (!a || !d) return '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-diagram-next"></i> DCF dòng tiền doanh nghiệp (FCFF)</h3><div class="vl-empty">Chưa đủ số liệu để dựng DCF: cần giá, số cổ phiếu và báo cáo tài chính của doanh nghiệp phi tài chính.</div></div>';
    const wd = r.waccDetail, price = r.price;
    const inputs = '<div class="vb-inputs">' +
        vbField('dcf', 'wacc', 'WACC (%)', a.wacc, base.wacc, 'pct', 'Ghi đè trực tiếp; để trống = tính từ CAPM bên dưới') +
        vbField('top', 'beta', 'Beta', (VB.params.beta !== null && VB.params.beta !== undefined) ? VB.params.beta : (wd ? wd.beta : null), wd ? wd.beta : null, 'num', 'Beta VNDirect, điều chỉnh Blume ×0,67 + 0,33') +
        vbField('top', 'erp', 'Phần bù rủi ro cổ phiếu ERP (%)', (VB.params.erp !== null && VB.params.erp !== undefined) ? VB.params.erp : (wd ? wd.erp : null), 0.08, 'pct', 'Mặc định 8% (thị trường mới nổi)') +
        vbField('top', 'sizePremium', 'Phần bù quy mô / riêng (%)', (VB.params.sizePremium !== null && VB.params.sizePremium !== undefined) ? VB.params.sizePremium : 0, 0, 'pct', 'Cộng thêm cho vốn hoá nhỏ, thanh khoản thấp') +
        vbField('dcf', 'g1', 'Tăng trưởng doanh thu giai đoạn đầu (%/năm)', a.g1, base.g1, 'pct', '60% CAGR 3 năm + 40% tăng trưởng bền vững') +
        vbField('dcf', 'highYears', 'Số năm giai đoạn cao', a.highYears, base.highYears, 'num', 'Sau đó giảm tuyến tính về tăng trưởng dài hạn', '1') +
        vbField('dcf', 'years', 'Số năm dự phóng', a.years, base.years, 'num', '5-15 năm', '1') +
        vbField('dcf', 'gTerminal', 'Tăng trưởng dài hạn g (%)', a.gTerminal, base.gTerminal, 'pct', 'Không vượt lãi suất phi rủi ro') +
        vbField('dcf', 'ebitMargin', 'Biên EBIT cơ sở (%)', a.ebitMargin, base.ebitMargin, 'pct', 'Bình quân 3 năm gần nhất') +
        vbField('dcf', 'marginTarget', 'Biên EBIT mục tiêu (%)', a.marginTarget, base.marginTarget, 'pct', 'Đạt được sau số năm bên dưới') +
        vbField('dcf', 'marginYears', 'Số năm đạt biên mục tiêu', a.marginYears, base.marginYears, 'num', '', '1') +
        vbField('dcf', 'taxRate', 'Thuế suất hiện tại (%)', a.taxRate, base.taxRate, 'pct', 'Thuế thực tế bình quân 3 năm') +
        vbField('dcf', 'taxTarget', 'Thuế suất dài hạn (%)', a.taxTarget, base.taxTarget, 'pct', 'Hội tụ tuyến tính (thuế TNDN phổ thông 20%)') +
        vbField('dcf', 'salesToCapital', 'Doanh thu / vốn đầu tư (x)', a.salesToCapital, base.salesToCapital, 'num', 'Càng cao càng ít tái đầu tư') +
        vbField('dcf', 'terminalRoic', 'ROIC cuối kỳ (%)', a.terminalRoic, base.terminalRoic, 'pct', 'Bằng WACC = tăng trưởng cuối kỳ không tạo giá trị') +
        vbField('dcf', 'minorityShare', 'Tỷ lệ lợi nhuận của cổ đông thiểu số (%)', a.minorityShare, base.minorityShare, 'pct', 'Trừ cùng tỷ lệ khỏi vốn chủ hợp nhất') +
        vbField('dcf', 'exitMultiple', 'Bội số thoát EV/EBITDA (x)', a.exitMultiple, null, 'num', 'Để trống = chỉ dùng Gordon') +
        vbField('dcf', 'exitWeight', 'Tỷ trọng bội số thoát (%)', a.exitWeight, 0, 'pct', '0-100%: trộn Gordon và bội số thoát') +
        vbField('dcf', 'midYear', 'Chiết khấu giữa năm', !!a.midYear, false, 'bool') + '</div>';
    const res = d.ok ? dcfResults(r) : '<div class="vb-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>' + vbE(d.reason) + '</span></div>';
    return '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-diagram-next"></i> DCF dòng tiền doanh nghiệp (FCFF)<span class="vl-muted">số liệu cơ sở ' + (base.baseIsTtm ? 'TTM đến ' : 'năm ') + vbDate(base.baseDate) + '</span></h3>' +
        '<details open><summary style="cursor:pointer;font-weight:700;font-size:0.84rem;margin-bottom:10px">Giả định (ô tô màu = bạn đã chỉnh; chữ mờ = giá trị gốc từ lịch sử)</summary>' + inputs +
        '<div class="vb-actions"><button type="button" class="vb-btn ghost sm" onclick="resetParams(\'dcf\')"><i class="fa-solid fa-rotate-left"></i> Đặt lại giả định DCF</button></div>' +
        '<ul class="vb-list" style="margin-top:12px">' + base.notes.map(function (t) { return '<li class="mute"><i class="fa-solid fa-circle-info"></i><span>' + vbE(t) + '</span></li>'; }).join('') + '</ul></details></div>' + res;
}

function dcfResults(r) {
    const d = r.dcf, a = r.dcfAssumptions, price = r.price, B = 1e9;
    const impliedPe = r.multiples && r.multiples.eps > 0 ? d.perShare / r.multiples.eps : null;
    const kpi = function (l, v, s, cls) { return '<div class="vb-kpi"><span class="l">' + vbE(l) + '</span><span class="v ' + (cls || '') + '">' + v + '</span><span class="s">' + s + '</span></div>'; };
    let h = '<div class="vb-kpis">' + kpi('Giá trị DCF / cổ phiếu', vbN(d.perShare) + ' đ', 'so với giá ' + vbN(price) + ' đ') + kpi('Chênh lệch so với giá', vbPct(d.upsidePct === null ? null : d.upsidePct / 100, 0, true), d.upsidePct >= 0 ? 'giá thấp hơn DCF' : 'giá cao hơn DCF', d.upsidePct >= 10 ? 'vb-up' : (d.upsidePct <= -10 ? 'vb-down' : '')) +
        kpi('Giá trị doanh nghiệp (EV)', vbTy(d.ev) + ' tỷ', 'hiện giá dòng tiền ' + vbTy(d.pvFcff) + ' tỷ + giá trị cuối kỳ ' + vbTy(d.terminal.pv) + ' tỷ') + kpi('Giá trị cuối kỳ / EV', vbN(d.tvSharePct, 0) + '%', d.tvSharePct > 75 ? 'phụ thuộc nhiều vào g và WACC' : 'cân bằng hơn', d.tvSharePct > 75 ? 'vb-down' : '') +
        kpi('P/E ngầm định của DCF', impliedPe === null ? '—' : vbN(impliedPe, 1) + 'x', 'EV/EBITDA cuối kỳ ngầm định ' + (d.terminal.impliedExitMultiple ? vbN(d.terminal.impliedExitMultiple, 1) + 'x' : '—')) + '</div>';
    if (d.warnings.length) h += d.warnings.map(function (w) { return '<div class="vb-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>' + vbE(w) + '</span></div>'; }).join('');
    // cầu nối
    const b = d.bridge;
    h += '<div class="vb-grid2"><div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-arrow-right-arrow-left"></i> Từ EV đến giá trị mỗi cổ phiếu (tỷ đồng)</h3><div class="vb-table-wrap"><table class="vb-table"><tbody>' +
        '<tr><td class="l">Giá trị doanh nghiệp (EV)</td><td>' + vbTy(d.ev) + '</td></tr><tr class="vb-sub"><td>+ Tiền và đầu tư tài chính ngắn hạn</td><td>' + vbTy(b.cash) + '</td></tr><tr class="vb-sub"><td>+ Đầu tư dài hạn (liên kết, tài chính)</td><td>' + vbTy(b.associates) + '</td></tr><tr class="vb-sub"><td>− Nợ vay</td><td>' + vbTy(b.debt) + '</td></tr>' +
        '<tr class="vb-sub"><td>− Cổ đông thiểu số' + (a.minorityShare !== null && a.minorityShare !== undefined ? ' (' + vbN(a.minorityShare * 100, 1) + '% lợi nhuận)' : ' (sổ sách)') + '</td><td>' + vbTy(b.minorities) + '</td></tr><tr class="vb-strong"><td class="l">Giá trị vốn chủ (cổ đông công ty mẹ)</td><td>' + vbTy(d.equity) + '</td></tr>' +
        '<tr><td class="l">Số cổ phiếu (triệu)</td><td>' + vbN(r.shares / 1e6, 1) + '</td></tr><tr class="vb-strong"><td class="l">Giá trị / cổ phiếu (đồng)</td><td>' + vbN(d.perShare) + '</td></tr></tbody></table></div></div>';
    // kịch bản
    const sc = r.scenarios;
    h += '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-code-branch"></i> Kịch bản có xác suất<span class="vl-muted">kỳ vọng ' + vbN(sc.expected) + ' đ</span></h3><div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Kịch bản</th><th>Xác suất</th><th>Giá trị / cp</th><th>So với giá</th></tr></thead><tbody>' + sc.list.map(function (x) { return '<tr><td class="l"><b>' + vbE(x.name) + '</b></td><td>' + vbN(x.prob * 100, 0) + '%</td><td>' + vbN(x.perShare) + '</td><td class="' + (x.upsidePct >= 0 ? 'vb-up' : 'vb-down') + '">' + vbPct(x.upsidePct === null ? null : x.upsidePct / 100, 0, true) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
        '<p class="vb-note">Bi quan: tăng trưởng −4 điểm %, biên −3 điểm %, WACC +1 điểm %. Lạc quan: +4 điểm %, +2 điểm %, WACC −0,5 điểm %. Khoảng cách hai đầu là thước đo độ nhạy của cổ phiếu với giả định.</p></div></div>';
    // bảng dự phóng
    h += '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-table"></i> Dự phóng dòng tiền (tỷ đồng)</h3><div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Năm</th>' + d.rows.map(function (x) { return '<th>' + x.t + '</th>'; }).join('') + '</tr></thead><tbody>' +
        [['Doanh thu', (x) => vbTy(x.revenue)], ['Tăng trưởng', (x) => vbPct(x.growth, 1)], ['Biên EBIT', (x) => vbPct(x.ebitMargin, 1)], ['EBIT', (x) => vbTy(x.ebit)], ['Thuế suất', (x) => vbPct(x.taxRate, 1)], ['NOPAT', (x) => vbTy(x.nopat)], ['Tái đầu tư', (x) => vbTy(x.reinvest)], ['FCFF', (x) => vbTy(x.fcff), true], ['Hệ số chiết khấu', (x) => vbN(x.df, 3)], ['Hiện giá FCFF', (x) => vbTy(x.pv), true]].map(function (row) { return '<tr' + (row[2] ? ' class="vb-strong"' : '') + '><td class="l">' + vbE(row[0]) + '</td>' + d.rows.map(function (x) { return '<td>' + row[1](x) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div></div>';
    // nhạy cảm
    const s1 = r.sensitivity, s2 = r.sensitivity2;
    h += '<div class="vb-grid2"><div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-table-cells"></i> Nhạy cảm: WACC × tăng trưởng dài hạn<span class="vl-muted">đồng/cổ phiếu</span></h3>' + sensGrid(s1.waccs, s1.gs, s1.values, price, (v) => vbN(v * 100, 1) + '%', (v) => 'g ' + vbN(v * 100, 1) + '%', 2, 2) + '<p class="vb-note">Xanh: cao hơn giá ≥10%; đỏ: thấp hơn giá ≥10%. Ô đậm là giả định hiện tại.</p></div>' +
        '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-table-cells"></i> Nhạy cảm: biên EBIT mục tiêu × tăng trưởng đầu kỳ<span class="vl-muted">đồng/cổ phiếu</span></h3>' + sensGrid(s2.margins, s2.growths, s2.values, price, (v) => 'biên ' + vbN(v * 100, 1) + '%', (v) => 'g₁ ' + vbN(v * 100, 1) + '%', 2, 2) + '<p class="vb-note">Cho biết giá trị đổi bao nhiêu nếu doanh nghiệp đạt biên hoặc tăng trưởng khác kỳ vọng.</p></div></div>';
    // Monte Carlo + DCF ngược
    const mc = r.monteCarlo, im = r.implied;
    h += '<div class="vb-grid2"><div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-dice"></i> Mô phỏng Monte Carlo<span class="vl-muted">' + (mc && mc.ok ? mc.n + ' lần · hạt giống ' + mc.seed : '') + '</span></h3>' + (mc && mc.ok ? '<div class="vb-chart"><canvas id="vb-ch-mc" aria-label="Phân phối giá trị DCF"></canvas></div>' +
        '<div class="vb-kpis" style="margin:12px 0 0"><div class="vb-kpi"><span class="l">Trung vị</span><span class="v">' + vbN(mc.median) + '</span></div><div class="vb-kpi"><span class="l">p5 – p95</span><span class="v" style="font-size:1.05rem">' + vbN(mc.p5) + ' – ' + vbN(mc.p95) + '</span></div><div class="vb-kpi"><span class="l">p25 – p75</span><span class="v" style="font-size:1.05rem">' + vbN(mc.p25) + ' – ' + vbN(mc.p75) + '</span></div><div class="vb-kpi"><span class="l">Xác suất giá trị > giá</span><span class="v">' + vbN(mc.probAbovePrice * 100, 0) + '%</span></div></div><p class="vb-note">' + vbE(mc.note) + '</p>' : '<div class="vl-empty">Không chạy được mô phỏng với giả định hiện tại.</div>') + '</div>' +
        '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-arrows-rotate"></i> DCF ngược: điều gì đã được tính vào giá?</h3>' + (im ? '<ul class="vb-list"><li class="mute"><i class="fa-solid fa-chart-line"></i><span>Với các giả định khác giữ nguyên, giá ' + vbN(price) + ' đ ngầm định tăng trưởng doanh thu giai đoạn đầu khoảng <b>' + (im.impliedGrowthStage1 === null ? 'ngoài vùng giải được' : vbN(im.impliedGrowthStage1 * 100, 1) + '%/năm') + '</b> (giả định hiện tại ' + vbN(im.baseGrowthStage1 * 100, 1) + '%' + (r.fundamental && r.fundamental.growth.revenue3y !== null ? ', CAGR doanh thu 3 năm ' + vbN(r.fundamental.growth.revenue3y * 100, 1) + '%' : '') + ').</span></li>' +
        '<li class="mute"><i class="fa-solid fa-percent"></i><span>Hoặc thị trường đang chiết khấu ở WACC <b>' + (im.impliedWacc === null ? 'ngoài vùng giải được' : vbN(im.impliedWacc * 100, 1) + '%') + '</b> (giả định ' + vbN(a.wacc * 100, 1) + '%).</span></li>' +
        '<li class="mute"><i class="fa-solid fa-arrows-up-down"></i><span>Hoặc biên EBIT thấp hơn giả định khoảng <b>' + (im.impliedMarginShift === null ? 'ngoài vùng giải được' : vbN(-im.impliedMarginShift * 100, 1) + ' điểm %') + '</b> mỗi năm.</span></li></ul><p class="vb-note">Mỗi dòng giải riêng một biến, các biến khác giữ nguyên. Nếu giá ngầm định kỳ vọng tăng trưởng thấp hơn nhiều so với lịch sử, thị trường đang bi quan (cổ phiếu rẻ nếu lợi nhuận vẫn tăng); nếu cao hơn nhiều, giá đã tính trước thành công lớn.</p>' : '<div class="vl-empty">Không giải được DCF ngược.</div>') + '</div></div>';
    return h;
}

// ---------- ngân hàng / chứng khoán / bảo hiểm ----------
function bankSection(r) {
    const bi = r.bankInputs || {}, keys = ['justified-pb', 'ri', 'fcfe'];
    const ms = r.methods.filter(function (m) { return keys.indexOf(m.key) !== -1; });
    const inputs = '<div class="vb-inputs">' + vbField('bank', 'roe', 'ROE bền vững (%)', bi.roe, bi.roe, 'pct', 'Mặc định: ROE năm gần nhất') + vbField('bank', 'g', 'Tăng trưởng giai đoạn đầu (%)', bi.g, 0.08, 'pct', 'Dùng cho FCFE trong số năm bên dưới') + vbField('bank', 'gT', 'Tăng trưởng dài hạn (%)', bi.gT, 0.05, 'pct', 'Cho P/B hợp lý, thu nhập thặng dư; không vượt lãi suất phi rủi ro') + vbField('bank', 'payout', 'Tỷ lệ chi trả cổ tức (%)', bi.payout, 0.2, 'pct', 'Tỷ lệ giữ lại = 1 − chi trả') +
        vbField('bank', 'ke', 'Chi phí vốn chủ Ke (%)', bi.ke, bi.ke, 'pct', 'CAPM: rf + beta × ERP') + vbField('bank', 'years', 'Số năm thu nhập thặng dư', bi.years, 5, 'num', '', '1') + vbField('bank', 'roeTerminal', 'ROE cuối kỳ (%)', bi.roeTerminal, bi.roeTerminal, 'pct', 'Mặc định: Ke + một nửa phần ROE vượt Ke') +
        vbField('top', 'beta', 'Beta', (VB.params.beta !== null && VB.params.beta !== undefined) ? VB.params.beta : ((VB.bundle && VB.bundle.peers && VB.bundle.peers.self && VB.bundle.peers.self.metrics) ? VB.bundle.peers.self.metrics.beta : null), null, 'num', 'Ghi đè beta VNDirect') + vbField('top', 'erp', 'ERP (%)', (VB.params.erp !== null && VB.params.erp !== undefined) ? VB.params.erp : 0.08, 0.08, 'pct', '') + '</div>';
    let grid = '';
    if (bi.roe !== null && bi.roe !== undefined && bi.ke && r.multiples && r.multiples.bvps > 0) {
        const kes = VBDcf.around(bi.ke, 0.01, 2), gs = VBDcf.around(bi.gT, 0.01, 2), bv = r.multiples.bvps;
        grid = '<h4 style="margin:14px 0 6px;font-size:0.82rem">Nhạy cảm giá trị theo P/B hợp lý: Ke × g (đồng/cổ phiếu)</h4>' + sensGrid(kes, gs, kes.map(function (k) { return gs.map(function (g) { return k > g ? (bi.roe - g) / (k - g) * bv : null; }); }), r.price, (v) => 'Ke ' + vbN(v * 100, 1) + '%', (v) => 'g ' + vbN(v * 100, 1) + '%', 2, 2);
    }
    return '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-building-columns"></i> Định giá ' + vbE(r.formLabel.toLowerCase()) + ': thu nhập thặng dư, P/B hợp lý, FCFE<span class="vl-muted">nợ là nguyên liệu kinh doanh nên không dùng FCFF</span></h3>' + inputs +
        '<div class="vb-actions"><button type="button" class="vb-btn ghost sm" onclick="resetParams(\'bank\')"><i class="fa-solid fa-rotate-left"></i> Đặt lại</button></div>' +
        (ms.length ? '<div class="vb-table-wrap" style="margin-top:12px"><table class="vb-table"><thead><tr><th class="l">Phương pháp</th><th>Giá trị / cp</th><th>So với giá</th><th class="l">Ghi chú</th></tr></thead><tbody>' + ms.map(function (m) { return '<tr><td class="l"><b>' + vbE(m.label) + '</b></td><td>' + vbN(m.base) + '</td><td class="' + (m.base >= r.price ? 'vb-up' : 'vb-down') + '">' + vbPct(m.base / r.price - 1, 0, true) + '</td><td class="l" style="white-space:normal">' + vbE(m.note) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="vl-empty" style="margin-top:12px">Chưa tính được: cần ROE, giá trị sổ sách và chi phí vốn.</div>') + grid +
        '<p class="vb-note"><b>Kiểm tra bắt buộc với ngân hàng:</b> nợ xấu (NPL), bao nợ xấu, CAR và CASA không có trong dữ liệu miễn phí. Giá trị sổ sách chỉ đáng tin khi chất lượng tài sản tốt; hãy đối chiếu báo cáo thường niên.</p></div>';
}

// ---------- bội số ----------
function multiplesSection(r) {
    const c = r.multiples; if (!c) return '';
    const stats = VB.bundle && VB.bundle.peers && VB.bundle.peers.sector ? VB.bundle.peers.sector.stats : {}, n = r.form === 'NON_FINANCE';
    const pctIn = function (key) { const st = stats && stats[key]; return st && st.n >= 5 && c[key] > 0 && typeof PeerValuation !== 'undefined' ? PeerValuation.percentile(c[key], st.q) : null; };
    const bandOf = { pe: r.bandPE, pb: r.bandPB };
    const rows = [['pe', 'P/E', 1], ['pb', 'P/B', 2], ['ps', 'P/S', 2], ['evEbitda', 'EV/EBITDA', 1], ['evEbit', 'EV/EBIT', 1], ['evSales', 'EV/Doanh thu', 2], ['pcf', 'P/CF (dòng tiền kinh doanh)', 1]].filter(function (x) { return n || x[0] === 'pe' || x[0] === 'pb'; });
    const tbl = '<div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Bội số</th><th>Hiện tại</th><th>Trung vị ngành</th><th>Phân vị trong ngành</th><th>TB lịch sử 5 năm</th><th>Phân vị lịch sử</th></tr></thead><tbody>' + rows.map(function (x) {
        const st = stats && stats[x[0]], band = bandOf[x[0]], p = pctIn(x[0]);
        return '<tr><td class="l"><b>' + x[1] + '</b></td><td>' + (c[x[0]] > 0 ? vbN(c[x[0]], x[2]) + 'x' : '—') + '</td><td>' + (st && st.n >= 5 ? vbN(st.median, x[2]) + 'x <span class="vb-muted">(' + st.n + ' mã)</span>' : '—') + '</td><td>' + (p === null ? '—' : vbN(p, 0)) + '</td><td>' + (band ? vbN(band.mean, x[2]) + 'x' : '—') + '</td><td>' + (band ? vbN(band.percentile, 0) : '—') + '</td></tr>'; }).join('') +
        '<tr><td class="l"><b>Lợi suất lợi nhuận</b></td><td>' + (c.earningsYield ? vbPct(c.earningsYield, 1) : '—') + '</td><td colspan="4" class="l vb-muted">1 / P/E; so với trái phiếu chính phủ 10 năm ở tab Thị trường</td></tr>' +
        (n ? '<tr><td class="l"><b>Lợi suất FCF · cổ tức</b></td><td>' + (c.fcfYield === null ? '—' : vbPct(c.fcfYield, 1)) + ' · ' + (c.dividendYield === null ? '—' : vbPct(c.dividendYield, 1)) + '</td><td colspan="4" class="l vb-muted">dòng tiền tự do / vốn hoá · cổ tức đã trả / vốn hoá</td></tr>' : '') + (c.peg ? '<tr><td class="l"><b>PEG</b></td><td>' + vbN(c.peg, 2) + '</td><td colspan="4" class="l vb-muted">P/E chia CAGR EPS 3 năm (%)</td></tr>' : '') + '</tbody></table></div>';
    const imp = r.methods.filter(function (m) { return m.key.indexOf('peer-') === 0 || m.key.indexOf('hist-') === 0; });
    const impTbl = imp.length ? '<div class="vb-table-wrap" style="margin-top:14px"><table class="vb-table"><thead><tr><th class="l">Giá ngầm định từ</th><th>Bội số thấp / cơ sở / cao</th><th>Giá thấp</th><th>Giá cơ sở</th><th>Giá cao</th><th>Cơ sở so với giá</th></tr></thead><tbody>' + imp.map(function (m) { return '<tr><td class="l"><b>' + vbE(m.label) + '</b>' + (m.n ? ' <span class="vb-muted">' + m.n + (m.key.indexOf('hist-') === 0 ? ' phiên' : ' mã') + '</span>' : '') + '</td><td>' + (m.multiples ? vbN(m.multiples.low, 1) + ' / ' + vbN(m.multiples.base, 1) + ' / ' + vbN(m.multiples.high, 1) + 'x' : '—') + '</td><td>' + vbN(m.low) + '</td><td><b>' + vbN(m.base) + '</b></td><td>' + vbN(m.high) + '</td><td class="' + (m.base >= r.price ? 'vb-up' : 'vb-down') + '">' + vbPct(m.base / r.price - 1, 0, true) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="vl-empty" style="margin-top:12px">Chưa có thống kê ngành (cần tối thiểu 5 mã cùng ngành trong ảnh chụp thị trường) hoặc lịch sử bội số.</div>';
    return '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-percent"></i> Bội số: so với ngành và với lịch sử của chính nó<span class="vl-muted">' + (VB.bundle && VB.bundle.peers ? vbE(VB.bundle.peers.sectorName) : '') + '</span></h3>' + tbl + impTbl +
        '<div class="vb-chart" style="margin-top:14px"><canvas id="vb-ch-pe" aria-label="P/E theo thời gian"></canvas></div><div class="vb-legend"><span><i style="background:var(--finance-accent)"></i>P/E hằng ngày</span><span><i style="background:var(--vb-ma20)"></i>Trung bình · p20 · p80</span></div>' +
        '<p class="vb-note">Phân vị trong ngành: 0 = rẻ nhất ngành (P/E, P/B, P/S, EV). Chưa tính khác biệt tăng trưởng và chất lượng: rẻ hơn ngành vì kém hơn khác với rẻ thật. EV/EBITDA và EV/Doanh thu của ngành lấy EBITDA hoạt động 4 quý và tiền mặt ròng từ VNDirect, còn bội số của mã tính từ báo cáo tài chính: có thể lệch nhẹ về định nghĩa, nên đọc như xu hướng hơn là con số chính xác.</p></div>';
}

// ---------- tài sản, thu nhập, cổ tức ----------
function assetSection(r) {
    const keys = ['epv', 'graham', 'grahamGrowth', 'lynch', 'ddm', 'nav', 'sotp'], ms = r.methods.filter(function (m) { return keys.indexOf(m.key) !== -1; });
    let h = '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-coins"></i> Phương pháp tài sản, thu nhập và cổ tức</h3>';
    h += ms.length ? '<div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Phương pháp</th><th>Thấp</th><th>Cơ sở</th><th>Cao</th><th>So với giá</th><th class="l">Giả định / ghi chú</th></tr></thead><tbody>' + ms.map(function (m) { return '<tr><td class="l"><b>' + vbE(m.label) + '</b></td><td>' + vbN(m.low) + '</td><td><b>' + vbN(m.base) + '</b></td><td>' + vbN(m.high) + '</td><td class="' + (m.base >= r.price ? 'vb-up' : 'vb-down') + '">' + vbPct(m.base / r.price - 1, 0, true) + '</td><td class="l" style="white-space:normal;min-width:260px">' + vbE(m.note) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="vl-empty">Chưa tính được phương pháp nào (cần EPS, giá trị sổ sách hoặc cổ tức dương).</div>';
    if (r.form === 'NON_FINANCE') {
        const nc = r.ncav, tq = r.tobinQ;
        h += '<div class="vb-kpis" style="margin-top:14px"><div class="vb-kpi"><span class="l">NCAV / cổ phiếu (net-net)</span><span class="v">' + (nc ? vbN(nc.perShare) : '—') + '</span><span class="s">' + (nc ? (nc.perShare > 0 && r.price < nc.threshold ? 'giá dưới 2/3 NCAV: vùng net-net' : 'chỉ hiển thị, không vào đồng thuận') : 'thiếu số liệu') + '</span></div>' +
            '<div class="vb-kpi"><span class="l">Giá trị sổ sách / cổ phiếu</span><span class="v">' + (r.nav ? vbN(r.nav.book) : '—') + '</span><span class="s">P/B ' + (r.multiples && r.multiples.pb ? vbN(r.multiples.pb, 2) + 'x' : '—') + (r.nav && r.nav.tangible !== null ? ' · hữu hình ' + vbN(r.nav.tangible) : '') + '</span></div>' +
            '<div class="vb-kpi"><span class="l">Tobin\'s Q đơn giản</span><span class="v">' + (tq ? vbN(tq.q, 2) : '—') + '</span><span class="s">(vốn hoá + nợ phải trả) / tổng tài sản</span></div></div>';
        h += '<h4 style="margin:16px 0 6px;font-size:0.84rem">Điều chỉnh NAV (đánh giá lại tài sản)<span class="vb-muted" style="font-weight:400"> — nhập khoản điều chỉnh (tỷ đồng, âm được) để đưa phương pháp NAV vào giá trị đồng thuận</span></h4>';
        h += (VB.params.navAdj || []).map(function (x) { return '<div class="vb-actions vb-navadj-row" style="margin-bottom:6px"><input class="vb-in" data-f="label" value="' + vbE(x.label) + '" style="flex:1 1 220px;max-width:340px;font-family:var(--font-body)" onchange="onNavAdjChange()"><input class="vb-in w" style="width:100px" data-f="amount" type="number" step="1" value="' + vbE(String(Math.round(x.amount / 1e9 * 100) / 100)) + '" onchange="onNavAdjChange()"> tỷ đồng</div>'; }).join('');
        h += '<div class="vb-actions"><button type="button" class="vb-btn ghost sm" onclick="addNavAdj()"><i class="fa-solid fa-plus"></i> Thêm điều chỉnh</button>' + ((VB.params.navAdj || []).length ? '<button type="button" class="vb-btn ghost sm" onclick="resetParams(\'navAdj\')">Xoá hết</button>' : '') + '</div>';
        h += '<h4 style="margin:16px 0 6px;font-size:0.84rem">Tổng các phần (SOTP)<span class="vb-muted" style="font-weight:400"> — nhập chỉ tiêu từng mảng (ví dụ EBITDA, tỷ đồng) và bội số; nợ ròng và thiểu số lấy từ báo cáo</span></h4>';
        h += (VB.params.sotp || []).map(function (x) { return '<div class="vb-actions vb-sotp-row" style="margin-bottom:6px"><input class="vb-in" data-f="name" value="' + vbE(x.name) + '" style="flex:1 1 180px;max-width:260px;font-family:var(--font-body)" onchange="onSotpChange()"><input class="vb-in w" style="width:110px" data-f="metric" type="number" step="1" value="' + vbE(String(Math.round(x.metric / 1e9 * 100) / 100)) + '" onchange="onSotpChange()" title="Chỉ tiêu (tỷ đồng)"> tỷ × <input class="vb-in w" data-f="multiple" type="number" step="0.5" value="' + vbE(String(x.multiple)) + '" onchange="onSotpChange()" title="Bội số"> x</div>'; }).join('');
        h += '<div class="vb-actions"><button type="button" class="vb-btn ghost sm" onclick="addSotp()"><i class="fa-solid fa-plus"></i> Thêm mảng</button>' + ((VB.params.sotp || []).length ? '<button type="button" class="vb-btn ghost sm" onclick="resetParams(\'sotp\')">Xoá hết</button>' : '') + '</div>';
    }
    return h + '</div>';
}
function afterValuation(r) {
    const mc = r.monteCarlo, cv = document.getElementById('vb-ch-mc');
    if (cv && mc && mc.ok) { const P = VBCharts.palette(); VBCharts.histogram(cv, { lo: mc.histogram.lo, step: mc.histogram.step, counts: mc.histogram.counts, height: 190, marks: [{ value: r.price, color: P.down, label: 'Giá ' + vbN(r.price) }, { value: mc.median, color: P.accent, label: 'Trung vị ' + vbN(mc.median) }, { value: mc.p5, color: P.muted, label: 'p5', dash: [3, 3] }, { value: mc.p95, color: P.muted, label: 'p95', dash: [3, 3] }] }); }
    const pe = document.getElementById('vb-ch-pe'), vb = VB.bundle && VB.bundle.vb;
    if (pe) {
        const key = r.form === 'NON_FINANCE' || !(vb && vb.ratioSeries && vb.ratioSeries.pe && vb.ratioSeries.pe.length) ? 'pe' : 'pe', vals = vb && vb.ratioSeries ? vb.ratioSeries[key] : null, dates = vb && vb.ratioDates ? vb.ratioDates[key] : null, band = r.bandPE;
        if (vals && dates && vals.length > 20) { const P = VBCharts.palette(); VBCharts.lines(pe, { t: dates, window: dates.length, height: 200, digits: 1, series: [{ data: vals, color: P.accent, width: 1.6, label: 'P/E' }], refs: band ? [{ y: band.mean, color: P.ma20 }, { y: band.p20, color: P.ma20 }, { y: band.p80, color: P.ma20 }] : [] }); }
        else pe.parentElement.innerHTML = '<div class="vl-empty">Chưa có chuỗi P/E lịch sử.</div>';
    }
}

// ---------- tab Kỹ thuật ----------
function techToggle(k) { VB.tech.show[k] = !VB.tech.show[k]; renderStockBody(); }
function techWindow(n) { VB.tech.window = n; renderStockBody(); }
function tabTechnical(r) {
    const t = r.technical;
    if (!t || !t.ok) return '<div class="vl-card"><div class="vl-empty"><i class="fa-solid fa-chart-line"></i> ' + vbE((t && t.reason) || 'Chưa có nến giá của mã này.') + '</div></div>';
    const L = t.latest, show = VB.tech.show, win = VB.tech.window;
    const tg = [['sma20', 'SMA20'], ['sma50', 'SMA50'], ['sma200', 'SMA200'], ['bb', 'Bollinger'], ['ich', 'Ichimoku'], ['st', 'Supertrend'], ['vwap', 'VWAP20'], ['volume', 'Khối lượng']];
    const wins = [[60, '3 tháng'], [120, '6 tháng'], [250, '1 năm'], [500, '2 năm'], [99999, 'Tất cả']];
    let h = '<div class="vb-kpis"><div class="vb-kpi"><span class="l">Điểm kỹ thuật</span><span class="v">' + vbN(t.score, 0) + '</span><span class="s">' + vbPill(t.rating.tone, t.rating.label) + '</span></div>' +
        '<div class="vb-kpi"><span class="l">Bối cảnh vào lệnh</span><span class="v" style="font-size:1rem;line-height:1.3">' + vbE(t.timing ? t.timing.label : '—') + '</span><span class="s">' + (t.overbought ? 'đang nóng (quá mua / giãn xa)' : (t.oversold ? 'đang quá bán' : 'không quá mua / quá bán')) + '</span></div>' +
        '<div class="vb-kpi"><span class="l">RSI 14 · ADX</span><span class="v">' + vbN(L.rsi, 0) + ' · ' + vbN(L.adx, 0) + '</span><span class="s">' + (L.adx >= 25 ? 'xu hướng rõ' : (L.adx >= 20 ? 'xu hướng yếu' : 'đi ngang')) + '</span></div>' +
        '<div class="vb-kpi"><span class="l">Biến động (HV20 / ATR)</span><span class="v">' + vbPct(t.volatility.hv20, 0) + '</span><span class="s">' + vbE(t.volatility.regime || '') + ' · ATR ' + vbPct(t.volatility.atrPct, 1) + ' giá</span></div>' +
        '<div class="vb-kpi"><span class="l">Sụt giảm từ đỉnh</span><span class="v ' + (t.volatility.drawdown < -0.2 ? 'vb-down' : '') + '">' + vbPct(t.volatility.drawdown, 0) + '</span><span class="s">tối đa 1 năm ' + vbPct(t.volatility.maxDrawdown1y, 0) + '</span></div></div>';
    h += '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-chart-candlestick"></i> Biểu đồ nến ' + vbE(r.symbol) + '<span class="vl-muted">đến ' + vbDate(t.asOf) + ' · giá đã điều chỉnh cổ tức/chia tách</span></h3>' +
        '<div class="vb-toggles">' + tg.map(function (x) { return '<button type="button" class="vl-chip" aria-pressed="' + !!show[x[0]] + '" onclick="techToggle(\'' + x[0] + '\')">' + x[1] + '</button>'; }).join('') + '<span style="flex:1"></span>' + wins.map(function (x) { return '<button type="button" class="vl-chip" aria-pressed="' + (win === x[0]) + '" onclick="techWindow(' + x[0] + ')">' + x[1] + '</button>'; }).join('') + '</div>' +
        '<div class="vb-chart"><canvas id="vb-ch-candle" aria-label="Biểu đồ nến"></canvas></div>' +
        '<div class="vb-legend"><span><i style="background:var(--vb-ma20)"></i>SMA20</span><span><i style="background:var(--vb-ma50)"></i>SMA50</span><span><i style="background:var(--vb-ma200)"></i>SMA200</span><span><i style="background:var(--vb-up)"></i>Hỗ trợ</span><span><i style="background:var(--vb-down)"></i>Kháng cự</span></div>' +
        '<div class="vb-sub-chart"><h5>RSI 14 <span>' + vbN(L.rsi, 1) + '</span></h5><div class="vb-chart"><canvas id="vb-ch-rsi"></canvas></div></div>' +
        '<div class="vb-sub-chart"><h5>MACD (12, 26, 9) <span>' + vbN(L.macd, 2) + ' / ' + vbN(L.macdSignal, 2) + '</span></h5><div class="vb-chart"><canvas id="vb-ch-macd"></canvas></div></div>' +
        '<div class="vb-sub-chart"><h5>Stochastic (14, 3, 3) <span>%K ' + vbN(L.stochK, 0) + ' · %D ' + vbN(L.stochD, 0) + '</span></h5><div class="vb-chart"><canvas id="vb-ch-stoch"></canvas></div></div>' +
        '<div class="vb-sub-chart"><h5>ADX 14 và +DI / −DI <span>ADX ' + vbN(L.adx, 0) + ' · +DI ' + vbN(L.plusDi, 0) + ' · −DI ' + vbN(L.minusDi, 0) + '</span></h5><div class="vb-chart"><canvas id="vb-ch-adx"></canvas></div></div>' +
        '<div class="vb-sub-chart"><h5>OBV (khối lượng cộng dồn) <span>CMF ' + (L.cmf === null ? '—' : vbN(L.cmf, 2)) + ' · MFI ' + vbN(L.mfi, 0) + '</span></h5><div class="vb-chart"><canvas id="vb-ch-obv"></canvas></div></div></div>';
    // tín hiệu theo nhóm
    const gl = t.groups;
    h += '<div class="vb-grid2">' + ['trend', 'momentum', 'flow', 'position'].map(function (g) {
        const G = gl[g], list = t.signals.filter(function (s) { return s.group === g; });
        return '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-signal"></i> ' + vbE(G.label) + '<span class="vl-muted">điểm ' + (G.score === null ? '—' : vbN(G.score, 0)) + ' · ' + G.bull + ' tăng · ' + G.bear + ' giảm · trọng số ' + G.weight + '%</span></h3>' + meterHtml(G.score) + list.map(function (s) {
            return '<div class="vb-sig"><span class="ic ' + s.state + '"><i class="fa-solid ' + (s.state === 'bull' ? 'fa-arrow-up' : (s.state === 'bear' ? 'fa-arrow-down' : 'fa-minus')) + '"></i></span><span><b>' + vbE(s.label) + '</b><small>' + vbE(s.detail) + '</small></span><span class="sc">' + vbN(s.score * 100, 0) + '</span></div>'; }).join('') + '</div>';
    }).join('') + '</div>';
    h += '<p class="vb-note" style="margin-top:-6px"><b>Cách đọc điểm:</b> mỗi tín hiệu từ −100 (giảm) đến +100 (tăng), nhân trọng số rồi lấy trung bình trong nhóm; điểm tổng = xu hướng 40% + động lượng 30% + dòng tiền 15% + vị thế giá 15%. Các chỉ báo tương quan với nhau nên nhiều tín hiệu cùng hướng không làm xác suất tăng theo cấp số nhân.</p>';
    // mức giá
    const px = t.price, dist = function (v) { return (v / px - 1); };
    const lv = t.levels, piv = lv.pivots;
    const lvRows = lv.resistances.slice().reverse().map(function (x) { return '<tr><td class="l">Kháng cự</td><td>' + vbN(x.price) + '</td><td class="vb-down">' + vbPct(dist(x.price), 1, true) + '</td><td>' + x.touches + '</td></tr>'; }).join('') + '<tr class="vb-strong"><td class="l">Giá hiện tại</td><td>' + vbN(px) + '</td><td></td><td></td></tr>' + lv.supports.map(function (x) { return '<tr><td class="l">Hỗ trợ</td><td>' + vbN(x.price) + '</td><td class="vb-up">' + vbPct(dist(x.price), 1, true) + '</td><td>' + x.touches + '</td></tr>'; }).join('');
    const prow = function (name, k) { return '<tr><td class="l">' + name + '</td><td>' + vbN(piv.daily.classic[k]) + '</td><td>' + vbN(piv.weekly.classic[k]) + '</td><td>' + vbN(piv.monthly.classic[k]) + '</td><td>' + vbN(piv.daily.fibonacci[k]) + '</td></tr>'; };
    h += '<div class="vb-grid2"><div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-grip-lines"></i> Hỗ trợ và kháng cự theo cụm<span class="vl-muted">52 tuần: ' + vbN(lv.low52) + ' – ' + vbN(lv.high52) + '</span></h3><div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Loại</th><th>Mức giá</th><th>Cách giá</th><th>Số lần chạm</th></tr></thead><tbody>' + lvRows + '</tbody></table></div></div>' +
        '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-crosshairs"></i> Điểm xoay (pivot)</h3><div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l"></th><th>Ngày</th><th>Tuần</th><th>Tháng</th><th>Fib ngày</th></tr></thead><tbody>' + prow('R3', 'r3') + prow('R2', 'r2') + prow('R1', 'r1') + prow('Pivot', 'p') + prow('S1', 's1') + prow('S2', 's2') + prow('S3', 's3') + '</tbody></table></div></div></div>';
    if (lv.fibonacci) { const f = lv.fibonacci; h += '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-wave-square"></i> Fibonacci (sóng ' + (f.direction === 'up' ? 'tăng' : 'giảm') + ' từ ' + vbN(f.direction === 'up' ? f.low : f.high) + ' đến ' + vbN(f.direction === 'up' ? f.high : f.low) + ')<span class="vl-muted">giá ở ' + vbN(f.positionPct, 0) + '% biên sóng</span></h3><div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Mức</th>' + f.retracements.map(function (x) { return '<th>' + vbN(x.ratio * 100, 1) + '%</th>'; }).join('') + f.extensions.map(function (x) { return '<th>mở rộng ' + vbN(x.ratio * 100, 1) + '%</th>'; }).join('') + '</tr></thead><tbody><tr><td class="l">Giá</td>' + f.retracements.concat(f.extensions).map(function (x) { return '<td>' + vbN(x.price) + '</td>'; }).join('') + '</tr><tr><td class="l">Cách giá</td>' + f.retracements.concat(f.extensions).map(function (x) { return '<td class="' + (x.price >= px ? 'vb-down' : 'vb-up') + '">' + vbPct(dist(x.price), 1, true) + '</td>'; }).join('') + '</tr></tbody></table></div></div>'; }
    // mẫu hình, phân kỳ, nén, giao cắt
    const notes = [];
    t.patterns.forEach(function (p) { notes.push([p.bias === 'bull' ? 'pos' : (p.bias === 'bear' ? 'neg' : 'mute'), p.label + ': ' + p.detail]); });
    if (t.divergence) notes.push([t.divergence.type === 'bull' ? 'pos' : 'neg', t.divergence.label + ': ' + t.divergence.detail]);
    if (t.squeeze.active) notes.push(['flag', 'Nén biến động: ' + t.squeeze.detail]);
    if (t.cross) notes.push([t.cross.type === 'golden' ? 'pos' : 'neg', t.cross.label + ' cách đây ' + t.cross.daysAgo + ' phiên.']);
    h += '<div class="vb-grid2"><div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-shapes"></i> Mẫu nến, phân kỳ và sự kiện<span class="vl-muted">' + notes.length + ' mục</span></h3>' + (notes.length ? '<ul class="vb-list">' + notes.map(function (n) { return '<li class="' + n[0] + '"><i class="fa-solid fa-circle"></i><span>' + vbE(n[1]) + '</span></li>'; }).join('') + '</ul>' : '<div class="vl-empty">Không có mẫu nến, phân kỳ hay giao cắt đáng chú ý trong các phiên gần đây.</div>') + '</div>';
    const rs = t.relativeStrength;
    h += '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-ranking-star"></i> Sức mạnh tương đối so với VN-Index</h3>' + (rs ? '<div class="vb-kpis" style="margin-bottom:6px">' + [['1 tháng', rs.excess1m], ['3 tháng', rs.excess3m], ['6 tháng', rs.excess6m], ['12 tháng', rs.excess12m]].map(function (x) { return '<div class="vb-kpi"><span class="l">Vượt/thua ' + x[0] + '</span><span class="v ' + (x[1] >= 0 ? 'vb-up' : 'vb-down') + '">' + vbPct(x[1], 1, true) + '</span></div>'; }).join('') + '</div><div class="vb-chart"><canvas id="vb-ch-rs" aria-label="Đường sức mạnh tương đối"></canvas></div><p class="vb-note">Đường RS = giá cổ phiếu / VN-Index, đang ở phân vị ' + vbN(rs.percentile, 0) + ' của 250 phiên. RS đi lên nghĩa là cổ phiếu mạnh hơn thị trường.</p>' : '<div class="vl-empty">Chưa có dữ liệu VN-Index để tính sức mạnh tương đối.</div>') + '</div></div>';
    return h;
}
function afterTechnical(r) {
    const t = r.technical; if (!t || !t.ok) return;
    const c = VB.bundle.vb.candles, S = t.series, P = VBCharts.palette(), win = VB.tech.window;
    VBCharts.candles(document.getElementById('vb-ch-candle'), c, { height: 430, window: win, series: S, show: VB.tech.show, levels: t.levels });
    const sub = function (id, spec) { const el = document.getElementById(id); if (el) VBCharts.lines(el, Object.assign({ t: S.t, window: win, height: 110 }, spec)); };
    sub('vb-ch-rsi', { series: [{ data: S.rsi, color: P.accent, label: 'RSI' }], refs: [{ y: 70, color: P.down }, { y: 30, color: P.up }, { y: 50, color: P.muted }], min: 0, max: 100, digits: 0 });
    sub('vb-ch-macd', { series: [{ data: S.macdHist, type: 'bars', label: 'Histogram' }, { data: S.macd, color: P.ma50, label: 'MACD' }, { data: S.macdSignal, color: P.ma20, label: 'Tín hiệu' }], zeroLine: true, digits: 2 });
    sub('vb-ch-stoch', { series: [{ data: S.stochK, color: P.accent, label: '%K' }, { data: S.stochD, color: P.ma20, label: '%D' }], refs: [{ y: 80, color: P.down }, { y: 20, color: P.up }], min: 0, max: 100, digits: 0 });
    sub('vb-ch-adx', { series: [{ data: S.adx, color: P.primary, width: 2, label: 'ADX' }, { data: S.plusDi, color: P.up, label: '+DI' }, { data: S.minusDi, color: P.down, label: '−DI' }], refs: [{ y: 25, color: P.muted }], min: 0, digits: 0 });
    sub('vb-ch-obv', { series: [{ data: S.obv.map(function (v) { return v === null ? null : v / 1e6; }), color: P.accent, type: 'area', label: 'OBV (triệu cp)' }], digits: 1 });
    const rs = t.relativeStrength, el = document.getElementById('vb-ch-rs');
    if (rs && el) { const v = rs.series.values, base = v[Math.max(0, v.length - 250)], from = Math.max(0, v.length - 250); VBCharts.lines(el, { t: rs.series.dates, window: Math.min(250, v.length), height: 150, digits: 1, series: [{ data: v.map(function (x, i) { return i < from ? null : x / base * 100; }), color: P.accent, width: 1.8, type: 'area', label: 'RS (100 = 12 tháng trước)' }], refs: [{ y: 100, color: P.muted }] }); }
}
