/* --- FILE: /valuation/vb-deep-ui.js ---
   Valuation Bench > tab Định giá: ba công cụ làm sâu định giá. (1) Điều chỉnh khoản bất thường (chuẩn hoá lợi nhuận), (2) Bộ mã so sánh do người dùng chọn, (3) DCF theo động lực (dự báo từng năm theo mảng kinh doanh).
   Chỉ dựng HTML và chuyển thao tác của người dùng vào VB.params (adjustments, peerSet, driver) rồi tính lại; mọi phép tính nằm ở VBNormalize / VBMultiples / VBDcf / VBEngine. Chuỗi chèn HTML đều qua vbE(). */

const deepPct = (v, d) => (v === null || v === undefined || !isFinite(v) ? '' : String(Math.round(v * 100 * Math.pow(10, d === undefined ? 1 : d)) / Math.pow(10, d === undefined ? 1 : d)).replace('.', ','));
const deepList = (arr, d) => (Array.isArray(arr) ? arr : [arr]).map(function (x) { return deepPct(x, d); }).join(', ');
function parsePctList(text) {
    const out = String(text || '').split(/[;,\s]+/).map(function (t) { return t.replace(',', '.').trim(); }).filter(function (t) { return t !== ''; }).map(Number);
    return out.length && out.every(function (x) { return isFinite(x); }) ? out.map(function (x) { return x / 100; }) : null;
}
function deepEach(sel, fn) { document.querySelectorAll(sel).forEach(fn); }

// ================= 1. Điều chỉnh khoản bất thường =================
function normalizeSection(r) {
    if (r.form !== 'NON_FINANCE') return '';
    const adj = VB.params.adjustments || [], n = r.normalization, sug = r.normalizeSuggest || { suggestions: [], flags: [] };
    const rows = adj.map(function (a, i) {
        return '<tr><td class="l"><input class="vb-in" style="width:100%" maxlength="80" value="' + vbE(a.label) + '" aria-label="Tên khoản điều chỉnh" onchange="adjSet(' + i + ',\'label\',this.value)"></td>' +
            '<td><select class="vb-in sm" aria-label="Loại khoản" onchange="adjSet(' + i + ',\'type\',this.value)"><option value="nonoperating"' + (a.type === 'nonoperating' ? ' selected' : '') + '>Dưới EBIT (tài chính, đầu tư)</option><option value="operating"' + (a.type === 'operating' ? ' selected' : '') + '>Trong EBIT (hoạt động)</option></select></td>' +
            '<td><input class="vb-in w" type="number" step="0.1" value="' + vbE(String(Math.round(a.amount / 1e8) / 10)) + '" aria-label="Số tiền, tỷ đồng" onchange="adjSet(' + i + ',\'amount\',this.value)"></td>' +
            '<td><label class="vb-chk"><input type="checkbox"' + (a.afterTax ? ' checked' : '') + ' onchange="adjSet(' + i + ',\'afterTax\',this.checked)"> đã sau thuế</label></td>' +
            '<td><button type="button" class="vb-btn ghost sm" onclick="adjRemove(' + i + ')" aria-label="Xoá khoản"><i class="fa-solid fa-xmark"></i></button></td></tr>';
    }).join('');
    const tbl = adj.length ? '<div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Khoản</th><th>Loại</th><th>Số tiền (tỷ, âm = loại khỏi lợi nhuận)</th><th></th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="vb-note">Chưa có điều chỉnh. Thêm khoản lãi/lỗ một lần để P/E, EV/EBITDA, EPV và biên DCF dùng lợi nhuận "sạch" thay vì lợi nhuận kế toán.</p>';
    const sugHtml = sug.suggestions.length ? '<div class="vb-gap"><b><i class="fa-solid fa-wand-magic-sparkles"></i> Gợi ý từ số liệu (chỉ là heuristic, bạn quyết định)</b><ul class="vb-list">' + sug.suggestions.map(function (s) {
        return '<li class="flag"><i class="fa-solid fa-circle-exclamation"></i><span><b>' + vbE(s.label) + '</b> (' + vbN(s.amount / 1e9, 0) + ' tỷ): ' + vbE(s.why) + ' <button type="button" class="vb-btn ghost sm" onclick="adjApplySuggestion(\'' + vbE(s.id) + '\')">Áp dụng</button></span></li>'; }).join('') + '</ul></div>' : '';
    const flags = sug.flags.length ? '<ul class="vb-list">' + sug.flags.map(function (t) { return '<li class="mute"><i class="fa-solid fa-circle-info"></i><span>' + vbE(t) + '</span></li>'; }).join('') + '</ul>' : '';
    const eff = n ? '<div class="vb-kvs"><div class="vb-kv"><span class="l">Lợi nhuận sau thuế kỳ cơ sở</span><span class="v">' + vbTy(n.before.netIncome) + ' → ' + vbTy(n.after.netIncome) + ' tỷ</span></div>' +
        '<div class="vb-kv"><span class="l">EPS</span><span class="v">' + vbN(r.multiples ? r.multiples.eps : null) + ' đ</span></div><div class="vb-kv"><span class="l">P/E</span><span class="v">' + (r.multiples && r.multiples.pe ? vbN(r.multiples.pe, 1) + 'x' : '—') + '</span></div>' +
        '<div class="vb-kv"><span class="l">Dịch biên EBIT</span><span class="v">' + vbPct(n.marginShift, 2, true) + '</span></div></div>' : '';
    return '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-broom"></i> Điều chỉnh khoản bất thường<span class="vl-muted">chuẩn hoá lợi nhuận trước khi định giá</span></h3>' + sugHtml + flags + tbl + eff +
        '<div class="vb-actions"><button type="button" class="vb-btn ghost sm" onclick="adjAdd()"><i class="fa-solid fa-plus"></i> Thêm khoản</button>' + (adj.length ? '<button type="button" class="vb-btn ghost sm" onclick="adjClear()"><i class="fa-solid fa-rotate-left"></i> Bỏ hết điều chỉnh</button>' : '') + '</div>' +
        '<p class="vb-note">Khoản "trong EBIT" (hoàn nhập dự phòng, thanh lý tài sản) đổi EBIT, EBITDA và lợi nhuận; khoản "dưới EBIT" (lãi bán đầu tư, đánh giá lại) chỉ đổi lợi nhuận. Số tiền là TRƯỚC thuế (nhân thuế suất thực tế) trừ khi tích "đã sau thuế". Điều chỉnh áp lên kỳ cơ sở (4 quý gần nhất hoặc năm gần nhất); xác định khoản bất thường bằng thuyết minh báo cáo, không đoán.</p></div>';
}
function adjAdd() { VB.params.adjustments = (VB.params.adjustments || []).concat([{ label: 'Khoản điều chỉnh', type: 'nonoperating', amount: -1e9, afterTax: false }]); recompute(); renderStockBody(); }
function adjSet(i, f, v) {
    const a = (VB.params.adjustments || [])[i]; if (!a) return;
    if (f === 'amount') { const n = Number(String(v).replace(',', '.')); if (!isFinite(n)) return; a.amount = n * 1e9; } else if (f === 'afterTax') a.afterTax = !!v; else if (f === 'type') a.type = v === 'operating' ? 'operating' : 'nonoperating'; else a.label = String(v).slice(0, 80);
    recompute(); renderStockBody();
}
function adjRemove(i) { VB.params.adjustments.splice(i, 1); recompute(); renderStockBody(); }
function adjClear() { VB.params.adjustments = []; recompute(); renderStockBody(); }
function adjApplySuggestion(id) {
    const s = VB.result && VB.result.normalizeSuggest ? VB.result.normalizeSuggest.suggestions.find(function (x) { return x.id === id; }) : null; if (!s) return;
    VB.params.adjustments = (VB.params.adjustments || []).concat([{ label: s.label, type: s.type, amount: s.amount, afterTax: false }]); recompute(); renderStockBody();
}

// ================= 2. Bộ mã so sánh tự chọn =================
function peerSetSection(r) {
    const ps = VB.params.peerSet || { mode: 'sector', symbols: [] }, custom = ps.mode === 'custom', sector = VB.bundle && VB.bundle.peers ? VB.bundle.peers : null;
    const rows = custom ? (VB.customPeerRows || []) : [];
    const fm = function (m, k, d) { return m && m[k] > 0 ? vbN(m[k], d) : '—'; };
    const tbl = custom && rows.length ? '<div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Mã</th><th>Vốn hoá (tỷ)</th><th>P/E</th><th>P/B</th><th>P/S</th><th>EV/EBITDA</th><th>EV/Doanh thu</th><th></th></tr></thead><tbody>' + rows.map(function (x) {
        const m = x.metrics || {};
        return '<tr><td class="l"><b>' + vbE(x.symbol) + '</b></td><td>' + (m.marketcap ? vbN(m.marketcap / 1e9, 0) : '—') + '</td><td>' + fm(m, 'pe', 1) + '</td><td>' + fm(m, 'pb', 2) + '</td><td>' + fm(m, 'ps', 2) + '</td><td>' + fm(m, 'evEbitda', 1) + '</td><td>' + fm(m, 'evSales', 2) +
            '</td><td><button type="button" class="vb-btn ghost sm" onclick="peerSetRemove(\'' + vbE(x.symbol) + '\')" aria-label="Bỏ mã"><i class="fa-solid fa-xmark"></i></button></td></tr>'; }).join('') + '</tbody></table></div>' : '';
    const missing = custom && ps.symbols.length ? ps.symbols.filter(function (s) { return !rows.some(function (x) { return x.symbol === s; }); }) : [];
    const stats = r.peerSet && r.peerSet.mode === 'custom' && VB.customPeerRows ? VBMultiples.statsFromRows(VB.customPeerRows, 3) : null;
    const summary = stats ? '<p class="vb-note"><b>Trung vị của bộ này:</b> ' + ['pe', 'pb', 'ps', 'evEbitda', 'evSales'].filter(function (k) { return stats[k]; }).map(function (k) { return VBMultiples.KEYS[k].label + ' ' + vbN(stats[k].median, 2) + 'x (' + stats[k].n + ' mã)'; }).join(' · ') + '</p>' : '';
    const sectorLine = sector && sector.sectorName ? 'Mặc định: toàn ngành ' + vbE(sector.sectorName) + (sector.sector ? ' (' + sector.sector.n + ' mã)' : '') + '.' : 'Mặc định: toàn ngành ICB của mã.';
    return '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-people-arrows"></i> Bộ mã so sánh<span class="vl-muted">' + (custom ? 'do bạn chọn' : 'cùng ngành ICB') + '</span></h3>' +
        '<div class="vb-actions" style="margin-bottom:10px"><button type="button" class="vl-chip" aria-pressed="' + !custom + '" onclick="peerSetMode(\'sector\')">Cùng ngành ICB</button><button type="button" class="vl-chip" aria-pressed="' + custom + '" onclick="peerSetMode(\'custom\')">Tự chọn mã</button></div>' +
        (custom ? '<label class="vb-field"><span>Mã so sánh (cách nhau bằng dấu phẩy hoặc khoảng trắng, tối thiểu 3 mã)</span><textarea id="vb-peer-input" class="vb-in" rows="2" placeholder="Ví dụ: CMG, ELC, FPT">' + vbE((ps.symbols || []).join(', ')) + '</textarea></label>' +
            '<div class="vb-actions"><button type="button" class="vb-btn sm" onclick="peerSetApply()"><i class="fa-solid fa-check"></i> Áp dụng bộ này</button><button type="button" class="vb-btn ghost sm" onclick="peerSetFromSector()"><i class="fa-solid fa-list"></i> Lấy 10 mã lớn nhất cùng ngành làm điểm xuất phát</button></div>' +
            (missing.length ? '<p class="vb-note vb-down">Không tìm thấy trong ảnh chụp thị trường: ' + vbE(missing.join(', ')) + '</p>' : '') + tbl + summary : '<p class="vb-note">' + sectorLine + ' Chọn "Tự chọn mã" để so với đúng các đối thủ trực tiếp (cùng mô hình kinh doanh, quy mô) thay vì cả ngành ICB cấp 2 vốn rất rộng.</p>') +
        '<p class="vb-note">Bộ tự chọn thay thế thống kê ngành ở mọi phương pháp so sánh bội số; bộ nhỏ cho trung vị kém ổn định nên quy trình sẽ ghi chú. Số liệu bội số lấy từ ảnh chụp thị trường hằng ngày; mã mới niêm yết hoặc thiếu báo cáo có thể không có đủ bội số.</p></div>';
}
function peerSetMode(mode) {
    VB.params.peerSet = mode === 'custom' ? { mode: 'custom', symbols: (VB.params.peerSet && VB.params.peerSet.symbols) || [] } : { mode: 'sector', symbols: [] };
    if (mode !== 'custom') VB.customPeerRows = null;
    recompute(); renderStockBody();
}
async function peerSetApply() {
    const box = document.getElementById('vb-peer-input'); if (!box) return;
    const syms = Array.from(new Set(String(box.value).toUpperCase().split(/[^A-Z0-9]+/).filter(function (s) { return /^[A-Z0-9]{1,12}$/.test(s) && s !== VB.symbol; }))).slice(0, 40);
    if (syms.length < 3) { showToast('Cần tối thiểu 3 mã so sánh (không tính chính mã đang định giá)', 'error'); return; }
    try {
        VB.customPeerRows = await call('getVbPeerRows', { symbols: syms });
        VB.params.peerSet = { mode: 'custom', symbols: syms };
        const got = VB.customPeerRows.length; if (got < 3) showToast('Chỉ tìm thấy ' + got + ' mã trong ảnh chụp thị trường: cần ít nhất 3', 'error');
        recompute(); renderStockBody();
    } catch (e) { showToast(e.message, 'error'); }
}
function peerSetFromSector() {
    const rows = VB.bundle && VB.bundle.peers && VB.bundle.peers.rows ? VB.bundle.peers.rows.filter(function (x) { return x.symbol !== VB.symbol && x.metrics && x.metrics.marketcap > 0; }) : [];
    rows.sort(function (a, b) { return b.metrics.marketcap - a.metrics.marketcap; });
    const box = document.getElementById('vb-peer-input'); if (box) box.value = rows.slice(0, 10).map(function (x) { return x.symbol; }).join(', ');
}
function peerSetRemove(sym) {
    VB.params.peerSet.symbols = VB.params.peerSet.symbols.filter(function (s) { return s !== sym; });
    VB.customPeerRows = (VB.customPeerRows || []).filter(function (x) { return x.symbol !== sym; });
    recompute(); renderStockBody();
}
// gọi sau khi nạp mã hoặc nạp lại bản đã lưu: lấy số liệu bội số của bộ so sánh đã chọn
async function ensureCustomPeers() {
    const ps = VB.params.peerSet;
    if (!ps || ps.mode !== 'custom' || !ps.symbols.length) { VB.customPeerRows = null; return; }
    try { VB.customPeerRows = await call('getVbPeerRows', { symbols: ps.symbols }); } catch (e) { VB.customPeerRows = null; }
}

// ================= 3. DCF theo động lực =================
function driverSection(r) {
    if (r.form !== 'NON_FINANCE' || !r.driverDefaults) return '';
    const on = !!(VB.params.driver && VB.params.driver.enabled), d = r.driverInput || r.driverDefaults, dv = r.driver;
    const head = '<h3 class="vl-card-title"><i class="fa-solid fa-industry"></i> DCF theo động lực<span class="vl-muted">dự báo từng năm theo mảng kinh doanh, do bạn dựng</span></h3>';
    const toggle = '<label class="vb-chk" style="margin-bottom:10px"><input type="checkbox"' + (on ? ' checked' : '') + ' onchange="drvToggle(this.checked)"> Dùng DCF theo động lực (thay DCF tự ngoại suy làm phương pháp chính)</label>';
    if (!on) return '<div class="vl-card">' + head + toggle + '<p class="vb-note">DCF ở trên ngoại suy tăng trưởng và biên từ lịch sử. DCF theo động lực cho bạn tự dự báo: từng mảng kinh doanh có đường tăng trưởng và biên riêng, cộng chi phí chung, đầu tư (capex), khấu hao và vốn lưu động. Phù hợp khi có luận điểm cụ thể (công suất mới, hợp đồng, mảng mới). Bật lên, mẫu được điền sẵn từ lịch sử để bạn sửa.</p></div>';
    const segs = d.segments.map(function (s, i) {
        return '<tr><td class="l"><input class="vb-in" style="width:100%" maxlength="40" value="' + vbE(s.name) + '" aria-label="Tên mảng" onchange="drvSeg(' + i + ',\'name\',this.value)"></td>' +
            '<td><input class="vb-in w" type="number" step="1" value="' + vbE(String(Math.round(s.baseRevenue / 1e9))) + '" aria-label="Doanh thu cơ sở, tỷ" onchange="drvSeg(' + i + ',\'baseRevenue\',this.value)"></td>' +
            '<td><input class="vb-in" style="width:100%;min-width:150px" value="' + vbE(deepList(s.growth)) + '" aria-label="Tăng trưởng doanh thu theo năm, %" onchange="drvSeg(' + i + ',\'growth\',this.value)"></td>' +
            '<td><input class="vb-in" style="width:100%;min-width:130px" value="' + vbE(deepList(s.margin)) + '" aria-label="Biên EBIT theo năm, %" onchange="drvSeg(' + i + ',\'margin\',this.value)"></td>' +
            '<td>' + (d.segments.length > 1 ? '<button type="button" class="vb-btn ghost sm" onclick="drvDelSeg(' + i + ')" aria-label="Xoá mảng"><i class="fa-solid fa-xmark"></i></button>' : '') + '</td></tr>'; }).join('');
    const segTbl = '<div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Mảng kinh doanh</th><th>Doanh thu cơ sở (tỷ)</th><th>Tăng trưởng theo năm (%)</th><th>Biên EBIT (%)</th><th></th></tr></thead><tbody>' + segs + '</tbody></table></div>' +
        '<p class="vb-note">Nhập đường theo năm cách nhau dấu phẩy, ví dụ "20, 15, 12, 10". Thiếu năm thì giữ giá trị cuối rồi giảm dần về tăng trưởng dài hạn ở năm cuối (biên thì giữ nguyên). Tổng doanh thu cơ sở các mảng nên khớp doanh thu 4 quý gần nhất (' + vbTy(r.dcfAssumptions ? r.dcfAssumptions.baseRevenue : null) + ' tỷ).</p>';
    const f = function (label, field, val, hint, pct) { return '<label class="vb-field"><span>' + vbE(label) + '</span><input class="vb-in w" value="' + vbE(pct === false ? String(val === null || val === undefined ? '' : val) : (Array.isArray(val) ? deepList(val) : deepPct(val))) + '" title="' + vbE(hint || '') + '" onchange="drvField(\'' + field + '\',this.value,' + (pct === false ? 'false' : 'true') + ')"></label>'; };
    const inputs = '<div class="vb-inputs">' + f('Số năm dự báo', 'years', d.years, '2 đến 10 năm', false) + f('Capex / doanh thu (%)', 'capexPct', d.capexPct, 'Đầu tư tài sản cố định: số hoặc đường theo năm') + f('Khấu hao / doanh thu (%)', 'daPct', d.daPct) + f('Vốn lưu động / doanh thu (%)', 'nwcPct', d.nwcPct, 'Δ vốn lưu động = tỷ lệ này × Δ doanh thu') +
        f('Chi phí chung chưa phân bổ (% doanh thu)', 'corpCostPct', d.corpCostPct) + f('Thuế suất (%)', 'taxRate', d.taxRate) + f('WACC (%)', 'wacc', d.wacc, 'Mặc định lấy từ DCF ở trên') + f('Tăng trưởng dài hạn (%)', 'gTerminal', d.gTerminal) + '</div>';
    let res = '';
    if (dv && dv.ok) {
        res = '<div class="vb-kpis">' + [['Giá trị mỗi cổ phiếu', vbN(dv.perShare) + ' đ', dv.upsidePct === null ? '' : vbPct(dv.upsidePct / 100, 0, true) + ' so với giá'], ['Giá trị doanh nghiệp (EV)', vbTy(dv.ev) + ' tỷ', 'EV/EBITDA năm 1: ' + (dv.impliedEvEbitda1 ? vbN(dv.impliedEvEbitda1, 1) + 'x' : '—')], ['Giá trị cuối kỳ', vbN(dv.tvSharePct, 0) + '%', 'phần EV từ sau năm dự báo'], ['Doanh thu tăng bình quân', vbPct(dv.revenueCagr, 1), dv.years + ' năm']].map(function (k) { return '<div class="vb-kpi"><span class="l">' + vbE(k[0]) + '</span><span class="v">' + k[1] + '</span><span class="s">' + vbE(k[2]) + '</span></div>'; }).join('') + '</div>' +
            '<div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Năm</th>' + dv.rows.map(function (x) { return '<th>' + x.t + '</th>'; }).join('') + '</tr></thead><tbody>' +
            [['Doanh thu (tỷ)', function (x) { return vbTy(x.revenue); }], ['Tăng trưởng', function (x) { return vbPct(x.growth, 1); }], ['Biên EBIT', function (x) { return vbPct(x.ebitMargin, 1); }], ['NOPAT (tỷ)', function (x) { return vbTy(x.nopat); }], ['Capex (tỷ)', function (x) { return vbTy(x.capex); }], ['Δ vốn lưu động (tỷ)', function (x) { return vbTy(x.dNwc); }], ['FCFF (tỷ)', function (x) { return '<b>' + vbTy(x.fcff) + '</b>'; }]].map(function (rw) { return '<tr><td class="l">' + rw[0] + '</td>' + dv.rows.map(function (x) { return '<td>' + rw[1](x) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>' +
            (dv.warnings.length ? '<ul class="vb-list">' + dv.warnings.map(function (t) { return '<li class="flag"><i class="fa-solid fa-triangle-exclamation"></i><span>' + vbE(t) + '</span></li>'; }).join('') + '</ul>' : '');
    } else if (dv) res = '<div class="vl-note"><i class="fa-solid fa-triangle-exclamation"></i><span>' + vbE(dv.reason || 'Chưa tính được.') + '</span></div>';
    return '<div class="vl-card">' + head + toggle + segTbl + '<div class="vb-actions" style="margin-bottom:10px"><button type="button" class="vb-btn ghost sm" onclick="drvAddSeg()"><i class="fa-solid fa-plus"></i> Thêm mảng</button><button type="button" class="vb-btn ghost sm" onclick="drvReset()"><i class="fa-solid fa-rotate-left"></i> Về mẫu từ lịch sử</button></div>' + inputs + res +
        '<p class="vb-note">FCFF = EBIT × (1 − thuế) + khấu hao − capex − Δ vốn lưu động. Giá trị cuối kỳ dùng tăng trưởng dài hạn và ROIC cuối kỳ như DCF ở trên. Khi bật, phương pháp này thành "Chính" trong quy trình và DCF tự ngoại suy chuyển thành "Hỗ trợ": hãy ghi luận điểm cho từng đường tăng trưởng, vì con số chỉ tốt bằng giả định của bạn.</p></div>';
}
function drvEnsure() { if (!VB.params.driver) VB.params.driver = { enabled: false }; return VB.params.driver; }
function drvToggle(on) { drvEnsure().enabled = !!on; recompute(); renderStockBody(); }
function drvField(f, text, pct) {
    const d = drvEnsure(), t = String(text).trim();
    if (t === '') { delete d[f]; } else if (f === 'capexPct') { const l = parsePctList(t); if (!l) return; d.capexPct = l.length === 1 ? l[0] : l; }
    else { const n = Number(t.replace(',', '.')); if (!isFinite(n)) return; d[f] = f === 'years' ? Math.max(2, Math.min(10, Math.round(n))) : (pct === false ? n : n / 100); }
    recompute(); renderStockBody();
}
function drvSegments() {
    const d = drvEnsure();
    if (!d.segments) d.segments = JSON.parse(JSON.stringify((VB.result.driverInput || VB.result.driverDefaults).segments));
    return d.segments;
}
function drvSeg(i, f, text) {
    const segs = drvSegments(), s = segs[i]; if (!s) return;
    if (f === 'name') s.name = String(text).slice(0, 40);
    else if (f === 'baseRevenue') { const n = Number(String(text).replace(',', '.')); if (!isFinite(n) || n <= 0) return; s.baseRevenue = n * 1e9; }
    else { const l = parsePctList(text); if (!l) return; s[f] = l; }
    recompute(); renderStockBody();
}
function drvAddSeg() { const segs = drvSegments(), first = segs[0]; segs.push({ name: 'Mảng mới', baseRevenue: 100e9, growth: first ? first.growth.slice() : [0.1], margin: first ? first.margin.slice() : [0.1] }); recompute(); renderStockBody(); }
function drvDelSeg(i) { const segs = drvSegments(); if (segs.length > 1) segs.splice(i, 1); recompute(); renderStockBody(); }
function drvReset() { VB.params.driver = { enabled: true }; recompute(); renderStockBody(); }
