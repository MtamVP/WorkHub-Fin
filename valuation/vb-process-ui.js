/* --- FILE: /valuation/vb-process-ui.js ---
   Valuation Bench > tab "Quy trình": định giá theo 7 bước có ghi vết (phân loại mô hình, cổng dữ liệu, kế hoạch phương pháp, giả định, đối chiếu, kiểm tra hợp lý, kết luận).
   Chỉ dựng HTML từ r.process (VBProcess.plan + review, chạy trong VBEngine.analyze); người dùng chỉnh mô hình / vai trò phương pháp / lý do ở đây, mọi chỉnh sửa đi vào VB.params.process
   rồi tính lại. Mọi chuỗi chèn vào HTML đều qua vbE(). */

const VB_LV = { pass: ['fa-circle-check', 'Đạt'], warn: ['fa-triangle-exclamation', 'Cảnh báo'], fail: ['fa-circle-xmark', 'Không đạt'], info: ['fa-circle-info', 'Thông tin'] };
const VB_STEP_STATE = { done: ['fa-check', 'ok'], warn: ['fa-exclamation', 'warn'], fail: ['fa-xmark', 'fail'] };

function procLevelHtml(level) { const l = VB_LV[level] || VB_LV.info; return '<span class="vb-lv ' + level + '" title="' + vbE(l[1]) + '"><i class="fa-solid ' + l[0] + '"></i></span>'; }
function procGoto(tab) { return 'setHash(\'stock\',\'' + vbE(VB.symbol) + '\',\'' + tab + '\')'; }

// trạng thái từng bước (cho thanh tiến độ)
function procStepStates(p) {
    const tri = p.triangulation, lv = (p.checks || []).reduce(function (o, c) { o[c.level] = (o[c.level] || 0) + 1; return o; }, {});
    const dcfWarn = (p.checks || []).some(function (c) { return c.key.indexOf('dcf-') === 0 && c.level !== 'pass'; });
    return [
        p.archetype.source === 'user' ? 'warn' : 'done',
        p.gate.status === 'ok' ? 'done' : (p.gate.status === 'limited' ? 'warn' : 'fail'),
        p.gaps.length ? 'warn' : (p.coreActive >= 2 ? 'done' : 'fail'),
        dcfWarn ? 'warn' : 'done',
        !tri ? 'fail' : (tri.verdict.key === 'agree' ? 'done' : (tri.verdict.key === 'moderate' ? 'warn' : 'fail')),
        lv.fail ? 'fail' : (lv.warn ? 'warn' : 'done'),
        p.status === 'complete' ? 'done' : (p.status === 'conditional' ? 'warn' : 'fail'),
    ];
}
function procBannerHtml(r) {
    const p = r.process; if (!p) return '';
    const tone = { complete: 'ok', conditional: 'mute', review: 'warn', blocked: 'warn' }[p.status] || 'mute';
    return '<div class="vl-card vb-proc-banner"><div class="vb-proc-banner-in"><div><b>Quy trình định giá:</b> ' + vbPill(tone, p.statusLabel, 'fa-list-check') + ' <span class="vb-muted">' + vbE(p.archetype.label) + ' · ' + p.rows.filter(function (x) { return x.computed && x.weight > 0; }).length + ' phương pháp tính vào giá trị đồng thuận · ' + (p.fails ? p.fails + ' không đạt' : '') + (p.fails && p.warns ? ', ' : '') + (p.warns ? p.warns + ' cảnh báo' : '') + (!p.fails && !p.warns ? 'mọi kiểm tra đạt' : '') + '</span></div>' +
        '<button type="button" class="vb-btn sm" onclick="' + procGoto('process') + '"><i class="fa-solid fa-list-check"></i> Xem quy trình</button></div></div>';
}

function tabProcess(r) {
    const p = r.process; if (!p) return '<div class="vl-card"><div class="vl-empty">Chưa có quy trình cho mã này.</div></div>';
    const st = procStepStates(p), names = VBProcess.STEPS;
    const stepper = '<ol class="vb-steps" aria-label="Các bước của quy trình">' + names.map(function (n, i) {
        const s = VB_STEP_STATE[st[i]];
        return '<li class="vb-step ' + s[1] + '"><a href="#proc-step-' + (i + 1) + '" onclick="document.getElementById(\'proc-step-' + (i + 1) + '\').scrollIntoView({behavior:\'smooth\',block:\'start\'});return false"><span class="vb-step-dot"><i class="fa-solid ' + s[0] + '"></i></span><span class="vb-step-name">' + (i + 1) + '. ' + vbE(n) + '</span></a></li>';
    }).join('') + '</ol>';
    const intro = '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-list-check"></i> Định giá theo quy trình<span class="vl-muted">mọi phương pháp được chọn, đặt vai trò và kiểm tra theo một trình tự cố định, có ghi vết</span></h3>' + stepper +
        '<p class="vb-note">Quy trình không tự đưa ra khuyến nghị: nó bảo đảm mỗi con số có lý do được chọn, có giới hạn được nêu và có kiểm tra chéo. Vai trò và trọng số tính từ mô hình kinh doanh (luật cố định, công khai ở từng bước); bạn đổi được và lựa chọn của bạn được lưu cùng bản định giá.</p></div>';
    return intro + procStep1(r, p) + procStep2(p) + procStep3(r, p) + procStep4(r, p) + procStep5(p) + procStep6(p) + procStep7(r, p);
}

function procCard(n, icon, title, sub, body, stateKey) {
    const s = VB_STEP_STATE[stateKey || 'done'];
    return '<section class="vl-card vb-proc" id="proc-step-' + n + '"><h3 class="vl-card-title"><span class="vb-step-dot ' + s[1] + '"><i class="fa-solid ' + s[0] + '"></i></span><i class="fa-solid ' + icon + '"></i> Bước ' + n + ': ' + vbE(title) + (sub ? '<span class="vl-muted">' + sub + '</span>' : '') + '</h3>' + body + '</section>';
}

// ---------- 1. Phân loại ----------
function procStep1(r, p) {
    const a = p.archetype, sg = a.signals, isFin = ['BANK', 'SECURITIES', 'INSURANCE'].indexOf(r.form) !== -1;
    const keys = Object.keys(VBProcess.ARCH).filter(function (k) { return isFin ? ['BANK', 'SECURITIES', 'INSURANCE'].indexOf(k) !== -1 : ['BANK', 'SECURITIES', 'INSURANCE'].indexOf(k) === -1; });
    const sel = '<label class="vb-field">Mô hình kinh doanh<select class="vb-in" onchange="setProcArch(this.value)" aria-label="Chọn mô hình kinh doanh">' +
        '<option value="">Tự nhận: ' + vbE(a.autoLabel) + '</option>' + keys.map(function (k) { return '<option value="' + k + '"' + (a.source === 'user' && a.key === k ? ' selected' : '') + '>' + vbE(VBProcess.ARCH[k].label) + '</option>'; }).join('') + '</select></label>';
    const sig = function (l, v) { return '<div class="vb-kv"><span class="l">' + vbE(l) + '</span><span class="v">' + v + '</span></div>'; };
    const sigs = '<div class="vb-kvs">' + sig('Tăng trưởng doanh thu 3 năm', sg.revCagr3 === null ? '—' : vbPct(sg.revCagr3, 1)) + sig('Biến thiên lợi nhuận (CV)', sg.cvNI === null ? '—' : vbN(sg.cvNI, 2)) +
        sig('Tồn kho / tổng tài sản', sg.inventoryShare === null ? '—' : vbPct(sg.inventoryShare, 0)) + sig('Đầu tư dài hạn / tổng tài sản', sg.investShare === null ? '—' : vbPct(sg.investShare, 0)) +
        sig('Chi trả cổ tức / lợi nhuận', sg.payout === null ? '—' : vbPct(sg.payout, 0)) + sig('ROE', sg.roe === null ? '—' : vbPct(sg.roe, 1)) + sig('Ngành ICB', sg.sector ? vbE(sg.sector) : '—') + '</div>';
    const body = '<div class="vb-proc-top"><div><div class="vb-arch">' + vbE(a.label) + ' ' + vbPill(a.source === 'user' ? 'warn' : 'info', a.source === 'user' ? 'Bạn chọn' : 'Tự nhận', a.source === 'user' ? 'fa-user' : 'fa-wand-magic-sparkles') + '</div><p class="vb-note" style="margin:6px 0 0">' + vbE(a.desc) + '</p></div>' + sel + '</div>' +
        '<ul class="vb-list">' + a.why.map(function (t) { return '<li class="mute"><i class="fa-solid fa-arrow-right"></i><span>' + vbE(t) + '</span></li>'; }).join('') + '</ul>' + sigs +
        '<p class="vb-note">Luật phân loại (theo thứ tự): mẫu báo cáo tài chính → lợi nhuận không dương → đầu tư dài hạn ≥35% tài sản hoặc có SOTP → bất động sản (ICB 8600 hoặc tồn kho ≥35%) → chu kỳ (ngành chu kỳ hoặc biến thiên lợi nhuận ≥0,6) → cổ tức/tiện ích → tăng trưởng (doanh thu ≥15%/năm) → trưởng thành.</p>';
    return procCard(1, 'fa-sitemap', 'Phân loại mô hình kinh doanh', 'quyết định phương pháp nào là chính', body, a.source === 'user' ? 'warn' : 'done');
}

// ---------- 2. Cổng dữ liệu ----------
function procStep2(p) {
    const g = p.gate, tone = { ok: 'ok', limited: 'mute', blocked: 'warn' }[g.status];
    const body = '<p style="margin:0 0 10px">' + vbPill(tone, g.label, g.status === 'ok' ? 'fa-circle-check' : 'fa-triangle-exclamation') + '</p><ul class="vb-checks">' + g.items.map(function (i) {
        return '<li>' + procLevelHtml(i.level) + '<div><b>' + vbE(i.label) + '</b><span class="vb-muted"> — ' + vbE(i.detail) + '</span></div></li>'; }).join('') + '</ul>' +
        '<p class="vb-note">Thiếu dữ liệu then chốt (giá, số cổ phiếu, dưới 3 năm báo cáo) thì giá trị chỉ mang tính minh hoạ. Hạn chế dữ liệu hạ độ tin cậy và được ghi vào hồ sơ.</p>';
    return procCard(2, 'fa-database', 'Cổng dữ liệu', 'đủ dữ liệu để kết luận chưa', body, g.status === 'ok' ? 'done' : (g.status === 'limited' ? 'warn' : 'fail'));
}

// IC 12 tháng của phương pháp trong backtest (theo mô hình nếu có đủ mẫu, không thì toàn bộ)
function procEvidenceHtml(e) {
    if (!e) return '<span class="vb-muted">—</span>';
    const ic = (e.ic >= 0 ? '+' : '−') + Math.abs(e.ic).toFixed(2).replace('.', ',');
    const cls = e.verdict === 'positive' ? 'vb-up' : (e.verdict === 'negative' ? 'vb-down' : 'vb-muted');
    const tip = 'IC 12 tháng ' + ic + ' trong backtest (' + (e.scope === 'archetype' ? 'riêng mô hình này' : 'toàn bộ mã') + ', ' + e.n + ' mẫu); ' + (e.verdict === 'positive' ? 'có bằng chứng dự báo được' : (e.verdict === 'negative' ? 'dự báo ngược' : 'chưa có bằng chứng'));
    return '<span class="' + cls + '" title="' + vbE(tip) + '"><b>' + ic + '</b>' + (e.scope === 'overall' ? '<sup>*</sup>' : '') + '</span>';
}

// ---------- 3. Kế hoạch phương pháp ----------
function procRoleSelect(row) {
    return '<select class="vb-in sm' + (row.user ? ' changed' : '') + '" onchange="setProcRole(\'' + vbE(row.key) + '\',this.value)" aria-label="Vai trò của ' + vbE(row.label) + '">' +
        ['core', 'support', 'check', 'ref', 'off'].map(function (k) { return '<option value="' + k + '"' + (row.role === k ? ' selected' : '') + '>' + vbE(VBProcess.ROLES[k].label) + (k === row.defaultRole ? ' (mặc định)' : '') + '</option>'; }).join('') + '</select>';
}
function procStep3(r, p) {
    const gaps = p.gaps.length ? '<div class="vb-gap"><b><i class="fa-solid fa-triangle-exclamation"></i> Phương pháp quan trọng chưa tính được</b><ul class="vb-list">' + p.gaps.map(function (g) {
        return '<li class="flag"><i class="fa-solid fa-circle-exclamation"></i><span><b>' + vbE(g.label) + '</b> (' + vbE(VBProcess.ROLES[g.role].label.toLowerCase()) + '): ' + vbE(g.reason) + '</span></li>'; }).join('') + '</ul><button type="button" class="vb-btn ghost sm" onclick="' + procGoto('valuation') + '"><i class="fa-solid fa-scale-balanced"></i> Mở tab Định giá để bổ sung</button></div>' : '';
    const rows = p.rows.map(function (x) {
        const stt = x.status === 'ok' ? vbPill('ok', 'Đạt', 'fa-check') : (x.status === 'limited' ? vbPill('mute', 'Hạn chế', 'fa-triangle-exclamation') : vbPill('warn', 'Chưa tính', 'fa-ban'));
        const dev = x.computed && r.synthesis && r.synthesis.fair ? r.synthesis.fair.base : null;
        const reasonIn = x.user ? '<input class="vb-in" style="margin-top:6px;width:100%" maxlength="160" placeholder="Lý do đổi vai trò" aria-label="Lý do đổi vai trò" value="' + vbE((VB.params.process.reasons || {})[x.key] || '') + '" onchange="setProcReason(\'' + vbE(x.key) + '\',this.value)">' : '';
        return '<tr class="vb-role-' + x.role + '"><td class="l"><b>' + vbE(x.label) + '</b>' + (x.lib ? ' <a class="vb-muted" href="/valuation/#methods" title="Xem định nghĩa và công thức trong thư viện phương pháp">?</a>' : '') + '</td><td>' + procRoleSelect(x) + '</td><td>' + (x.computed ? vbN(x.base) : '—') +
            '</td><td>' + (x.computed && dev ? vbPct(x.base / dev - 1, 0, true) : '—') + '</td><td><b>' + vbN(x.weight, 2) + '</b></td><td>' + procEvidenceHtml(x.evidence) + '</td><td>' + stt + '</td><td class="l vb-muted">' + vbE(x.limit ? x.limit + ' ' : '') + vbE(x.why) + reasonIn + '</td></tr>';
    }).join('');
    const tbl = '<div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Phương pháp</th><th>Vai trò</th><th>Giá trị cơ sở</th><th>So với đồng thuận</th><th>Trọng số</th><th>Backtest</th><th>Tình trạng</th><th class="l">Vì sao</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    const body = gaps + tbl + '<p class="vb-note">Trọng số = trọng số của vai trò (Chính ' + vbN(VBProcess.ROLES.core.weight, 1) + ', Hỗ trợ ' + vbN(VBProcess.ROLES.support.weight, 1) + ', Đối chiếu ' + vbN(VBProcess.ROLES.check.weight, 1) + ', Tham khảo/Loại 0), giảm một nửa khi phương pháp ở tình trạng "Hạn chế". Đổi vai trò để thay đổi cách phương pháp tham gia; muốn tinh chỉnh từng trọng số, dùng cột trọng số ở tab Tổng hợp (lựa chọn thủ công thắng quy trình). Cột Backtest là IC 12 tháng của phương pháp trong bảng điểm lịch sử (xem trang Độ chính xác); dấu * nghĩa là lấy IC của toàn bộ mã vì mô hình này chưa đủ mẫu riêng.' +
        (Object.keys(VB.params.process.roles || {}).length || VB.params.process.archetype ? ' <button type="button" class="vb-btn ghost sm" onclick="resetProcess()"><i class="fa-solid fa-rotate-left"></i> Về mặc định của quy trình</button>' : '') + '</p>';
    return procCard(3, 'fa-diagram-project', 'Kế hoạch phương pháp', 'vai trò, trọng số và lý do cho từng phương pháp', body, p.gaps.length ? 'warn' : (p.coreActive >= 2 ? 'done' : 'fail'));
}

// ---------- 4. Giả định ----------
function procStep4(r, p) {
    const a = r.dcfAssumptions, ch = VB.params.dcf || {}, bank = r.bankInputs, bch = VB.params.bank || {};
    const mark = function (k, g) { return (g || ch)[k] !== undefined ? ' ' + vbPill('warn', 'Bạn sửa', 'fa-user') : ''; };
    const row = function (l, v, src, k, g) { return '<tr><td class="l"><b>' + vbE(l) + '</b>' + mark(k, g) + '</td><td>' + v + '</td><td class="l vb-muted">' + vbE(src) + '</td></tr>'; };
    let rows = '';
    if (a) {
        rows += row('WACC', vbPct(a.wacc, 2), 'CAPM (lãi phi rủi ro + beta điều chỉnh × phần bù) và chi phí vay thực tế, theo tỷ trọng vốn chủ/nợ thị trường', 'wacc');
        rows += row('Tăng trưởng giai đoạn đầu', vbPct(a.g1, 1), '60% CAGR doanh thu 3 năm + 40% tăng trưởng bền vững (ROE × giữ lại), kẹp 2%-20%', 'g1');
        rows += row('Tăng trưởng dài hạn', vbPct(a.gTerminal, 1), 'Không vượt lãi suất phi rủi ro và 5%', 'gTerminal');
        rows += row('Biên EBIT mục tiêu', a.marginTarget === null ? '—' : vbPct(a.marginTarget, 1), 'Bình quân 3 năm gần nhất của EBIT hoạt động / doanh thu', 'marginTarget');
        rows += row('Thuế suất', vbPct(a.taxRate, 1) + ' → ' + vbPct(a.taxTarget, 1), 'Thuế thực tế bình quân 3 năm, hội tụ dần về 20%', 'taxRate');
        rows += row('Doanh thu trên vốn đầu tư', vbN(a.salesToCapital, 2), 'Δ doanh thu / Δ tài sản hoạt động ròng, bình quân các năm hợp lệ', 'salesToCapital');
        if (a.minorityShare !== null && a.minorityShare !== undefined) rows += row('Cổ đông thiểu số', vbPct(a.minorityShare, 1), 'Tỷ lệ lợi nhuận thuộc cổ đông thiểu số, bình quân 3 năm', 'minorityShare');
    }
    if (bank) {
        rows += row('Ke (chi phí vốn chủ)', vbPct(bank.ke, 2), 'CAPM: lãi phi rủi ro + beta × phần bù rủi ro', 'ke', bch);
        rows += row('ROE hiện tại', bank.roe === null ? '—' : vbPct(bank.roe, 1), 'ROE bình quân vốn chủ năm gần nhất', 'roe', bch);
        rows += row('Tăng trưởng giai đoạn đầu', vbPct(bank.g, 1), 'Mặc định 8% cho giai đoạn FCFE', 'g', bch);
        rows += row('Tăng trưởng dài hạn', vbPct(bank.gT, 1), 'Không vượt lãi suất phi rủi ro và 5%', 'gT', bch);
        rows += row('ROE cuối kỳ', bank.roeTerminal === undefined ? '—' : vbPct(bank.roeTerminal, 1), 'Một nửa phần ROE vượt Ke còn tồn tại (lợi thế cạnh tranh phai dần)', 'roeTerminal', bch);
        rows += row('Tỷ lệ chi trả', vbPct(bank.payout, 0), 'Cổ tức tiền mặt / lợi nhuận 4 quý', 'payout', bch);
    }
    const notes = a && a.notes ? '<ul class="vb-list">' + a.notes.map(function (t) { return '<li class="mute"><i class="fa-solid fa-circle-info"></i><span>' + vbE(t) + '</span></li>'; }).join('') + '</ul>' : '';
    const body = (rows ? '<div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Giả định</th><th>Giá trị</th><th class="l">Nguồn gốc</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="vb-note">Mô hình này không dùng giả định DCF; các phương pháp chạy từ số liệu báo cáo và bội số.</p>') + notes +
        '<div class="vb-actions"><button type="button" class="vb-btn ghost sm" onclick="' + procGoto('valuation') + '"><i class="fa-solid fa-sliders"></i> Chỉnh giả định ở tab Định giá</button></div>' +
        '<p class="vb-note">Mỗi giả định mặc định đều suy ra từ số liệu lịch sử của chính doanh nghiệp (không phải con số chọn tay). Giả định bạn đã sửa được đánh dấu và được lưu cùng bản định giá; bước 6 kiểm tra chúng có hợp lý so với lịch sử và ngành không.</p>';
    const dcfWarn = (p.checks || []).some(function (c) { return c.key.indexOf('dcf-') === 0 && c.level !== 'pass'; });
    return procCard(4, 'fa-sliders', 'Giả định và nguồn gốc', 'mỗi giả định đến từ đâu', body, dcfWarn ? 'warn' : 'done');
}

// ---------- 5. Đối chiếu ----------
function procStep5(p) {
    const t = p.triangulation; if (!t) return procCard(5, 'fa-code-compare', 'Chạy và đối chiếu chéo', '', '<div class="vl-empty">Chưa có giá trị để đối chiếu.</div>', 'fail');
    const core = p.rows.filter(function (x) { return x.computed && x.role === 'core'; });
    const cons = t.consensus;
    const rows = core.map(function (x) { return '<tr><td class="l"><b>' + vbE(x.label) + '</b></td><td>' + vbN(x.base) + '</td><td class="' + (x.base >= cons ? 'vb-up' : 'vb-down') + '">' + vbPct(x.base / cons - 1, 0, true) + '</td><td>' + vbN(x.weight, 2) + '</td>' +
        '<td>' + (t.dropped && t.dropped.key === x.key ? vbPill('warn', 'Lệch xa, tách riêng', 'fa-arrows-left-right') : vbPill('ok', 'Trong phép đối chiếu', 'fa-check')) + '</td></tr>'; }).join('');
    const body = '<p style="margin:0 0 10px">' + vbPill(t.verdict.tone, t.verdict.label, 'fa-code-compare') + (t.spread !== null ? ' <span class="vb-muted">chênh ' + vbN(t.spread * 100, 0) + '% giữa phương pháp chính thấp nhất và cao nhất</span>' : '') + '</p>' +
        (rows ? '<div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Phương pháp chính</th><th>Giá trị cơ sở</th><th>So với đồng thuận (' + vbN(cons) + ')</th><th>Trọng số</th><th>Đối chiếu</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '') +
        (t.groupNote ? '<p class="vb-note"><b>Nội tại so với bội số ngành:</b> ' + vbE(t.groupNote) + '</p>' : '') +
        (t.outliers.length ? '<p class="vb-note"><b>Phương pháp lệch xa giá trị đồng thuận:</b> ' + t.outliers.map(function (o) { return vbE(o.label) + ' (' + vbN(o.base) + ')'; }).join('; ') + '. Kiểm tra giả định của chúng trước khi tin kết luận.</p>' : '') +
        '<p class="vb-note">Giá trị đồng thuận là trung vị có trọng số của các phương pháp theo vai trò; hai nhóm phương pháp độc lập (nội tại và so sánh) nên dẫn tới cùng một vùng giá thì kết luận mới đáng tin.</p>';
    return procCard(5, 'fa-code-compare', 'Chạy và đối chiếu chéo', 'các phương pháp chính có đồng thuận không', body, t.verdict.key === 'agree' ? 'done' : (t.verdict.key === 'moderate' ? 'warn' : 'fail'));
}

// ---------- 6. Kiểm tra hợp lý ----------
function procStep6(p) {
    const cks = p.checks || [];
    const items = cks.map(function (c) {
        return '<li class="vb-check ' + c.level + '">' + procLevelHtml(c.level) + '<div><b>' + vbE(c.label) + '</b> <span class="vb-chk-val">' + vbE(c.value) + '</span><div class="vb-muted">' + vbE(c.detail) + '</div>' +
            (c.fix && (c.level === 'warn' || c.level === 'fail') ? '<button type="button" class="vb-btn ghost sm" style="margin-top:6px" onclick="' + procGoto(c.fix.tab) + '"><i class="fa-solid fa-wrench"></i> ' + vbE(c.fix.hint) + '</button>' : '') + '</div></li>'; }).join('');
    const body = '<p style="margin:0 0 10px">' + vbPill(p.fails ? 'warn' : 'ok', p.fails + ' không đạt', 'fa-circle-xmark') + ' ' + vbPill(p.warns ? 'mute' : 'ok', p.warns + ' cảnh báo', 'fa-triangle-exclamation') + ' ' + vbPill('ok', cks.filter(function (c) { return c.level === 'pass'; }).length + ' đạt', 'fa-circle-check') + '</p>' +
        '<ul class="vb-checks">' + items + '</ul><p class="vb-note">Ngưỡng là phán đoán thực hành (khoảng WACC thường gặp, tỷ trọng giá trị cuối kỳ, độ lệch so với lịch sử và ngành), không phải chuẩn thống kê. "Không đạt" không có nghĩa kết luận sai: nó buộc bạn phải xử lý hoặc ghi rõ lý do chấp nhận ở bước 7.</p>';
    return procCard(6, 'fa-clipboard-check', 'Kiểm tra hợp lý', 'danh mục kiểm tra có ngưỡng', body, p.fails ? 'fail' : (p.warns ? 'warn' : 'done'));
}

// ---------- 7. Kết luận ----------
function procStep7(r, p) {
    const s = r.synthesis, tone = { complete: 'ok', conditional: 'mute', review: 'warn', blocked: 'warn' }[p.status];
    const ack = (VB.params.process && VB.params.process.ack) || '';
    const k = function (l, v, sub) { return '<div class="vb-kpi"><span class="l">' + vbE(l) + '</span><span class="v">' + v + '</span><span class="s">' + sub + '</span></div>'; };
    const kpis = s && s.ok ? '<div class="vb-kpis">' + k('Giá trị hợp lý', vbN(s.fair.base) + ' đ', 'dải ' + vbN(s.fair.low) + ' – ' + vbN(s.fair.high)) + k('Biên an toàn', vbPct(s.marginOfSafety, 0, true), 'so với giá ' + vbN(s.price)) + k('Độ tin cậy', vbE(s.confidence.label), 'điểm ' + vbN(s.confidenceScore, 0) + '/100') + k('Nhận định', vbE(s.stance.label), vbE(r.technical && r.technical.ok ? r.technical.rating.label : '')) + '</div>' : '';
    const watch = p.watch && p.watch.length ? '<h4 style="margin:14px 0 6px;font-size:0.82rem">Điều gì làm đổi kết luận này</h4><ul class="vb-list">' + p.watch.map(function (t) { return '<li class="mute"><i class="fa-solid fa-eye"></i><span>' + vbE(t) + '</span></li>'; }).join('') + '</ul>' : '';
    const ackBox = '<label class="vb-field" style="margin-top:12px"><span>Lý do chấp nhận kết luận' + (p.needsAck ? ' <b class="vb-down">(bắt buộc: còn mục không đạt hoặc thiếu dữ liệu)</b>' : ' (tuỳ chọn)') + '</span>' +
        '<textarea id="vb-proc-ack" class="vb-in" rows="3" maxlength="600" placeholder="Ví dụ: DCF cao hơn bội số vì hợp đồng X đã ký; chấp nhận chênh vì…" onchange="setProcAck(this.value)">' + vbE(ack) + '</textarea></label>';
    const body = '<p style="margin:0 0 6px">' + vbPill(tone, p.statusLabel, 'fa-flag-checkered') + '</p><p class="vb-note" style="margin:0 0 12px">' + vbE(p.statusText) + '</p>' + kpis + watch + ackBox +
        '<div class="vb-actions" style="margin-top:12px"><button type="button" class="vb-btn" onclick="saveValuation()"><i class="fa-solid fa-floppy-disk"></i> Lưu bản định giá kèm hồ sơ quy trình</button><button type="button" class="vb-btn ghost" onclick="' + procGoto('summary') + '"><i class="fa-solid fa-gauge-high"></i> Về tab Tổng hợp</button></div>' +
        '<p class="vb-note">Bản lưu gồm: mô hình kinh doanh, vai trò và trọng số từng phương pháp, kết quả từng kiểm tra, các lỗ hổng còn lại và lý do bạn ghi ở trên: để sau này xem lại vì sao đã kết luận như vậy.</p>';
    return procCard(7, 'fa-flag-checkered', 'Kết luận và hồ sơ quyết định', 'trạng thái quy trình và điều chưa giải quyết', body, p.status === 'complete' ? 'done' : (p.status === 'conditional' ? 'warn' : 'fail'));
}
