// Logic thuần: báo cáo định kỳ của nhóm (gửi lãnh đạo / lưu hồ sơ) -- dựng mô hình báo cáo từ kết quả các phép tính cấp nhóm, rồi xuất HTML (xem/in PDF) và các sheet Excel.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global GroupReport) và module.exports cho Vitest. Chỉ định dạng và tóm tắt, KHÔNG tính lại số liệu:
// mọi con số đến từ GroupCalc / PerfCalc / RiskCalc / LimitsCalc (đã có kiểm thử riêng), nên báo cáo luôn khớp với màn hình Toàn Nhóm.
const GroupReport = (function () {
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d) => (v === null || v === undefined || !isFinite(v)) ? '—' : Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: d === undefined ? 0 : d });
  const pct = (v, d, signed) => (v === null || v === undefined || !isFinite(v)) ? '—' : ((signed && v > 0 ? '+' : '') + fmt(v, d === undefined ? 1 : d) + '%');
  const vnd = (v) => (v === null || v === undefined || !isFinite(v)) ? '—' : fmt(Math.round(v), 0) + ' đ';
  const dmy = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; };

  const KIND_LABEL = { max_symbol_pct: 'Một mã tối đa', max_sector_pct: 'Một ngành tối đa', min_cash_pct: 'Tiền mặt tối thiểu', max_leverage: 'Đòn bẩy tối đa', max_position_vnd: 'Một vị thế tối đa', blocked_symbol: 'Mã bị cấm' };
  const AUDIT_KIND = { unapproved: 'ghi không qua duyệt', reconcile: 'điều chỉnh đối soát', import: 'nhập từ sao kê', restricted: 'mã đang hạn chế', split: 'nghi chia nhỏ lệnh' };
  const MODE_LABEL = { warn: 'Cảnh báo', reason: 'Phải ghi lý do', block: 'Chặn' };

  // Kỳ báo cáo: from = ngày CHỐT của kỳ trước (mốc gốc để tính lợi suất), start = ngày đầu kỳ, to = ngày cuối kỳ (không quá hôm nay). today = 'YYYY-MM-DD'.
  function periodFor(key, today) {
    const t = String(today).slice(0, 10);
    const y = Number(t.slice(0, 4)), mo = Number(t.slice(5, 7));
    const iso = (d) => d.toISOString().slice(0, 10);
    const addDays = (s, n) => iso(new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000));
    const monthEnd = (yy, mm) => iso(new Date(Date.UTC(yy, mm, 0)));          // mm = 1..12 -> ngày cuối tháng đó
    const clamp = (d) => (d > t ? t : d);
    const first = (yy, mm) => yy + '-' + String(mm).padStart(2, '0') + '-01';
    switch (key) {
      case 'this-month': { const start = first(y, mo); return { key: key, label: 'Tháng ' + mo + '/' + y + ' (đến nay)', from: addDays(start, -1), start: start, to: t }; }
      case 'last-month': { const pm = mo === 1 ? 12 : mo - 1, py = mo === 1 ? y - 1 : y; const start = first(py, pm); return { key: key, label: 'Tháng ' + pm + '/' + py, from: addDays(start, -1), start: start, to: monthEnd(py, pm) }; }
      case 'this-quarter': { const q = Math.floor((mo - 1) / 3), sm = q * 3 + 1; const start = first(y, sm); return { key: key, label: 'Quý ' + (q + 1) + '/' + y + ' (đến nay)', from: addDays(start, -1), start: start, to: clamp(monthEnd(y, sm + 2)) }; }
      case 'last-quarter': { let q = Math.floor((mo - 1) / 3) - 1, yy = y; if (q < 0) { q = 3; yy = y - 1; } const sm = q * 3 + 1; const start = first(yy, sm); return { key: key, label: 'Quý ' + (q + 1) + '/' + yy, from: addDays(start, -1), start: start, to: monthEnd(yy, sm + 2) }; }
      case 'ytd': { const start = y + '-01-01'; return { key: key, label: 'Từ đầu năm ' + y, from: addDays(start, -1), start: start, to: t }; }
      default: { const start = addDays(t, -364); return { key: '12m', label: '12 tháng gần nhất', from: addDays(start, -1), start: start, to: t }; }
    }
  }

  // input: { asOf, period: { from, to, label }, benchLabel, group, portfolios, groupPerf, memberRows, risk, compliance, exceptions, flow, trades }
  function build(input) {
    const x = input || {};
    const g = x.group || { symbols: [], nav: 0, marketValue: 0, cash: 0, debt: 0, sharedCount: 0, sharedValuePct: 0 };
    const gp = x.groupPerf && x.groupPerf.ok ? x.groupPerf : null;
    const rk = x.risk && x.risk.ok && x.risk.portfolio ? x.risk : null;
    const period = x.period || {};
    const nameOf = {}; (x.portfolios || []).forEach((p) => { nameOf[p.id] = p.name; });

    const kpis = [
      { key: 'nav', label: 'NAV cả nhóm', value: g.nav, text: vnd(g.nav), sub: (x.portfolios || []).length + ' thành viên' },
      { key: 'marketValue', label: 'Giá trị cổ phiếu', value: g.marketValue, text: vnd(g.marketValue), sub: g.symbols.length + ' mã' },
      { key: 'cash', label: 'Tiền mặt', value: g.cash, text: vnd(g.cash), sub: g.nav > 0 ? pct(g.cash / g.nav * 100, 1) + ' NAV' : '' },
      { key: 'debt', label: 'Nợ vay', value: g.debt, text: vnd(g.debt), sub: g.debt > 0 ? 'có dùng đòn bẩy' : 'không vay' },
      { key: 'return', label: 'Lợi suất kỳ (TWR)', value: gp ? gp.cumulativePct : null, text: gp ? pct(gp.cumulativePct, 2, true) : '—', sub: gp && gp.annualizedPct !== null ? pct(gp.annualizedPct, 1, true) + '/năm' : (gp ? gp.periods + ' kỳ NAV' : 'chưa đủ lịch sử NAV') },
      { key: 'excess', label: 'Vượt / thua ' + (x.benchLabel || 'VN-Index'), value: gp && gp.hasBench ? gp.excessCumulativePct : null, text: gp && gp.hasBench ? pct(gp.excessCumulativePct, 2, true) : '—', sub: gp && gp.hasBench ? 'điểm % cùng kỳ' : 'chưa có dữ liệu chuẩn' },
      { key: 'alpha', label: 'Alpha / Beta', value: gp && gp.enough && gp.hasBench ? gp.alphaPct : null, text: gp && gp.enough && gp.hasBench ? pct(gp.alphaPct, 1, true) + ' / ' + fmt(gp.beta, 2) : '—', sub: gp && gp.enough ? '' : 'cần thêm lịch sử' },
      { key: 'maxDD', label: 'Sụt giảm tối đa', value: gp && gp.enough ? gp.maxDD : null, text: gp && gp.enough ? pct(gp.maxDD, 1) : '—', sub: rk ? 'VaR 95%/ngày ' + pct(rk.portfolio.varPct, 2) : '' },
      { key: 'shared', label: 'Mã nhiều người cùng giữ', value: g.sharedCount, text: String(g.sharedCount), sub: pct(g.sharedValuePct, 0) + ' giá trị cổ phiếu' },
    ];

    const sectorMap = {};
    g.symbols.forEach((s) => { const r = sectorMap[s.sector] || (sectorMap[s.sector] = { sector: s.sector, value: 0, symbols: [] }); r.value += s.value; r.symbols.push(s.symbol); });
    const sectors = Object.keys(sectorMap).map((k) => Object.assign({}, sectorMap[k], { weightPct: g.marketValue > 0 ? sectorMap[k].value / g.marketValue * 100 : 0 })).sort((a, b) => b.value - a.value);

    const holdings = g.symbols.slice(0, 25).map((s) => ({ symbol: s.symbol, sector: s.sector, quantity: s.quantity, value: s.value, weightPct: s.weightPct, holderCount: s.holderCount, unrealizedPct: s.unrealizedPct, holders: s.holders.map((h) => h.name) }));

    const members = (x.memberRows || []).map((r) => ({ name: r.name, nav: r.nav, sharePct: r.sharePct, holdingCount: r.holdingCount, topSymbol: r.topSymbol, topWeightPct: r.topWeightPct, cashPct: r.cashPct,
      returnPct: r.returnPct, excessPct: r.excessPct, alphaPct: r.alphaPct, beta: r.beta, sharpe: r.sharpe, maxDD: r.maxDD, overlapWithGroupPct: r.overlapWithGroupPct }));

    const comp = x.compliance || { rows: [], consolidated: null, totalBreaches: 0 };
    const compRows = comp.rows.concat(comp.consolidated ? [comp.consolidated] : []);
    const breaches = [];
    compRows.forEach((r) => (r.breaches || []).forEach((b) => breaches.push({ name: r.name, kind: b.kind, kindLabel: KIND_LABEL[b.kind] || b.kind, subject: b.subject, current: b.current, threshold: b.threshold, mode: b.mode, modeLabel: MODE_LABEL[b.mode] || b.mode })));
    const warns = compRows.reduce((s, r) => s + (r.warns || []).length, 0);
    const limitsCount = compRows.reduce((s, r) => s + (r.limits || 0), 0);

    const exceptions = (x.exceptions || []).map((e) => ({ date: String(e.created_at || '').slice(0, 10), name: nameOf[e.user_id] || 'Thành viên', kind: e.kind, kindLabel: KIND_LABEL[e.kind] || e.kind, symbol: e.symbol || (e.metrics && e.metrics.subject) || '', mode: e.mode, modeLabel: MODE_LABEL[e.mode] || e.mode || '', override: !!e.override, reason: e.reason || '', source: e.metrics && e.metrics.source === 'statement-import' ? 'Nhập sao kê' : 'Lệnh' }));

    const flow = x.flow || { totals: { trades: 0, buyValue: 0, sellValue: 0, net: 0 }, symbols: [], members: [], consensusBuy: [], consensusSell: [], conflicts: [] };
    const trades = (x.trades || []).slice(0, 2000);

    // Nhận xét tự động: chỉ nêu điều đo được từ số liệu, không đưa khuyến nghị
    const notes = [];
    if (gp) notes.push('Danh mục chung ' + (gp.cumulativePct >= 0 ? 'tăng ' : 'giảm ') + pct(Math.abs(gp.cumulativePct), 2) + ' trong kỳ' + (gp.hasBench ? ', ' + (gp.excessCumulativePct >= 0 ? 'vượt ' : 'thua ') + (x.benchLabel || 'VN-Index') + ' ' + pct(Math.abs(gp.excessCumulativePct), 2) + ' điểm' : '') + '.');
    else notes.push('Chưa đủ lịch sử NAV để tính lợi suất kỳ của cả nhóm.');
    if (g.sharedCount) notes.push(g.sharedCount + ' mã được từ 2 thành viên trở lên cùng giữ, chiếm ' + pct(g.sharedValuePct, 0) + ' giá trị cổ phiếu — rủi ro của các mã này bị nhân lên.');
    if (g.symbols.length && g.symbols[0].weightPct >= 25) notes.push('Mã lớn nhất ' + g.symbols[0].symbol + ' chiếm ' + pct(g.symbols[0].weightPct, 1) + ' giá trị cổ phiếu của nhóm.');
    if (sectors.length && sectors[0].weightPct >= 40) notes.push('Ngành ' + sectors[0].sector + ' chiếm ' + pct(sectors[0].weightPct, 1) + ' giá trị cổ phiếu.');
    if (breaches.length) notes.push(breaches.length + ' giới hạn đầu tư đang bị vượt (xem mục Tuân thủ).');
    else if (limitsCount) notes.push('Tất cả giới hạn đầu tư đang trong mức' + (warns ? ', ' + warns + ' mục gần chạm hạn mức' : '') + '.');
    else notes.push('Nhóm chưa đặt giới hạn đầu tư nào.');
    if (exceptions.length) notes.push(exceptions.length + ' ngoại lệ giới hạn đã được ghi trong kỳ' + (exceptions.some((e) => e.override) ? ', gồm ' + exceptions.filter((e) => e.override).length + ' lần quản lý ghi đè' : '') + '.');
    if (flow.consensusBuy.length) notes.push('Nhiều thành viên cùng mua trong kỳ: ' + flow.consensusBuy.slice(0, 5).map((s) => s.symbol).join(', ') + '.');
    const cm = x.committee || null;
    if (cm && cm.governance) {
      const gv = cm.governance, rq = gv.requests;
      if (gv.policy.active) notes.push('Duyệt lệnh lớn đang bật' + (gv.policy.thresholdPct ? ' (từ ' + fmt(gv.policy.thresholdPct, 1) + '% NAV' + (gv.policy.thresholdVnd ? ' hoặc ' + vnd(gv.policy.thresholdVnd) : '') + ')' : (gv.policy.thresholdVnd ? ' (từ ' + vnd(gv.policy.thresholdVnd) + ')' : '')) + ': ' + rq.total + ' đề xuất trong kỳ' + (rq.approvalRatePct !== null ? ', ' + fmt(rq.approvalRatePct, 0) + '% được duyệt' : '') + '.');
      else notes.push('Quy định duyệt lệnh lớn đang tắt.');
      if (rq.pendingNow) notes.push(rq.pendingNow + ' đề xuất lệnh đang chờ duyệt' + (rq.oldestPendingDays ? ', lâu nhất ' + rq.oldestPendingDays + ' ngày' : '') + '.');
      if (gv.audit.openNow) notes.push(gv.audit.openNow + ' lệnh ở mục Kiểm tra độc lập chưa được xem xét.');
      if (gv.restricted.count) notes.push(gv.restricted.count + ' mã đang trong danh sách hạn chế giao dịch.');
    }
    if (cm && cm.stress) {
      const s20 = cm.stress.scenarios.find((q) => q.indexPct === -20) || cm.stress.scenarios[cm.stress.scenarios.length - 1];
      if (s20 && s20.portfolioPct !== null) notes.push('Kịch bản "' + s20.label + '": NAV nhóm giảm khoảng ' + fmt(Math.abs(s20.portfolioPct), 1) + '% (' + vnd(s20.navLoss) + ')' + (s20.newBreaches ? ', phát sinh ' + s20.newBreaches + ' vi phạm giới hạn mới' : '') + (s20.marginBreached ? ', chạm ngưỡng ký quỹ giả định' : '') + '.');
    }
    if (flow.conflicts.length) notes.push('Mua bán trái chiều giữa các thành viên: ' + flow.conflicts.slice(0, 5).map((s) => s.symbol).join(', ') + '.');

    return {
      meta: { title: 'Báo cáo định kỳ của nhóm', asOf: x.asOf || '', from: period.from || '', to: period.to || '', label: period.label || '', benchLabel: x.benchLabel || 'VN-Index', generatedAt: x.generatedAt || new Date().toISOString(), memberCount: (x.portfolios || []).length },
      kpis, notes, holdings, sectors, members, committee: cm,
      compliance: { limitsCount, breaches, warnCount: warns, rows: compRows.map((r) => ({ name: r.name, nav: r.nav, limits: r.limits, breachCount: (r.breaches || []).length, warnCount: (r.warns || []).length })) },
      exceptions, activity: { totals: flow.totals, consensusBuy: flow.consensusBuy, consensusSell: flow.consensusSell, conflicts: flow.conflicts, symbols: flow.symbols.slice(0, 20), members: flow.members },
      trades,
    };
  }

  const table = (heads, rows, rightFrom) => '<div class="gr-rep-table"><table class="excel-table asset-table"><thead><tr>' + heads.map((h, i) => '<th' + (rightFrom !== undefined && i >= rightFrom ? ' class="text-right"' : '') + '>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map((r) => '<tr>' + r.map((c, i) => '<td' + (rightFrom !== undefined && i >= rightFrom ? ' class="text-right"' : '') + '>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';

  const TONE = { good: 'Tốt', warn: 'Lưu ý', info: 'Thông tin', mute: '' };
  const liList = (items) => items && items.length ? '<ul class="gr-rep-notes">' + items.map((i) => '<li>' + (TONE[i.tone] ? '<b>' + esc(TONE[i.tone]) + ':</b> ' : '') + esc(i.text) + '</li>').join('') + '</ul>' : '';

  // Các mục dành cho hội đồng đầu tư (CommitteePack): quản trị, căng thẳng, hành trình ý tưởng, chất lượng khớp lệnh. Mục nào chưa có dữ liệu thì không in.
  function committeeHtml(c) {
    if (!c) return '';
    let h = '';
    if (c.governance) {
      const g = c.governance, q = g.requests, a = g.audit;
      h += '<section><h3>Quản trị và kiểm soát</h3><p class="tl-hint">' + (g.policy.active ? 'Duyệt lệnh lớn: bật' + (g.policy.thresholdPct ? ', ngưỡng ' + esc(fmt(g.policy.thresholdPct, 1)) + '% NAV' : '') + (g.policy.thresholdVnd ? ', ngưỡng ' + esc(vnd(g.policy.thresholdVnd)) : '') + (g.policy.validDays ? ', hiệu lực ' + g.policy.validDays + ' ngày' : '') + (g.policy.selfApprovers ? ', ' + g.policy.selfApprovers + ' người được miễn nguyên tắc hai người' : '') : 'Duyệt lệnh lớn: đang tắt') + '.</p>'
        + table(['Đề xuất lệnh trong kỳ', 'Đã duyệt / dùng', 'Hết hạn', 'Từ chối', 'Chờ duyệt (hiện tại)', 'Thời gian quyết định (trung vị)', 'Tự duyệt'],
          [[String(q.total), String(q.approved + q.executed), String(q.expired), String(q.rejected), String(q.pendingNow) + (q.oldestPendingDays ? ' (lâu nhất ' + q.oldestPendingDays + ' ngày)' : ''), q.medianDecideHours === null ? '—' : esc(fmt(q.medianDecideHours, 1)) + ' giờ', String(q.selfApproved)]], 0)
        + '<p class="tl-hint">Kiểm tra độc lập: ' + a.inPeriod + ' lệnh được ghi nhận trong kỳ (' + (Object.keys(a.byKind).length ? Object.keys(a.byKind).map((k) => esc(AUDIT_KIND[k] || k) + ' ' + a.byKind[k]).join(', ') : 'không có') + '), ' + a.reviewedInPeriod + ' đã xem xét; hiện còn ' + a.openNow + ' chưa xem xét.</p>'
        + (g.restricted.count ? '<h4>Mã đang bị hạn chế giao dịch</h4>' + table(['Mã', 'Áp dụng cho', 'Từ ngày', 'Lý do'], g.restricted.items.map((x) => [esc(x.symbol), esc(x.scope), esc(dmy(x.since)), esc(x.reason)])) : '') + '</section>';
    }
    if (c.stress) {
      const s = c.stress;
      h += '<section><h3>Kịch bản căng thẳng</h3>' + table(['Kịch bản', 'NAV thay đổi', 'NAV sau', 'Mã mất nhiều nhất', 'Vi phạm giới hạn mới', 'Ký quỹ'],
        s.scenarios.map((x) => [esc(x.label), esc(pct(x.portfolioPct, 1, true)), esc(vnd(x.navAfter)), x.worst ? esc(x.worst.symbol + ' ' + pct(x.worst.pct, 0, true)) : '—', x.newBreaches === null ? '—' : String(x.newBreaches), x.hasDebt ? (x.marginBreached ? 'chạm ngưỡng' : 'an toàn') : '—']), 1)
        + '<h4>Kịch bản ngược: VN-Index phải giảm bao nhiêu thì…</h4>' + table(['Sự kiện', 'VN-Index giảm', 'NAV mất', 'Ghi chú'], s.reverse.map((x) => [esc(x.label), x.indexPct === null ? 'không xảy ra' : esc(pct(x.indexPct, 1, true)), x.navLossPct === null ? '—' : esc(pct(x.navLossPct, 0)), esc(x.note)]), 1)
        + '<p class="tl-hint">Tính theo beta điều chỉnh của từng mã (mã chưa có beta coi là 1)' + (s.maintenancePct ? '; ngưỡng ký quỹ giả định ' + s.maintenancePct + '%' : '') + '. Beta là ước lượng từ quá khứ: khủng hoảng thật thường khiến các mã giảm cùng chiều mạnh hơn beta gợi ý.</p></section>';
    }
    if (c.journey) {
      const j = c.journey, f = j.funnel, p = j.paths;
      const pathRow = (k, l) => [esc(l), String(p[k].n), p[k].alphaN ? esc(pct(p[k].avgAlpha, 1, true)) + ' (' + p[k].alphaN + ' có kết quả)' : '—'];
      h += '<section><h3>Hành trình ý tưởng đầu tư</h3><p class="tl-hint">' + f.total + ' ý tưởng · ' + f.decided + ' đã có quyết định · ' + f.approved + ' được duyệt · ' + f.executed + ' đã vào danh mục · ' + f.rejected + ' bị bác. Trung vị: đề xuất → duyệt ' + (j.timing.toDecide === null ? '—' : esc(fmt(j.timing.toDecide, 0)) + ' ngày') + ', duyệt → ghi lệnh ' + (j.timing.toExecute === null ? '—' : esc(fmt(j.timing.toExecute, 0)) + ' ngày') + '.</p>'
        + table(['Đường đi', 'Số ý tưởng', 'Vượt VN-Index (trung bình)'], [pathRow('executed', 'Đã thực hiện'), pathRow('idle', 'Duyệt rồi để đó'), pathRow('rejected', 'Bị bác'), pathRow('pending', 'Chưa quyết định')], 1) + liList(j.insights)
        + '<p class="tl-hint">Chỉ so sánh các nhóm có từ ' + j.minN + ' ý tưởng có kết quả. Kết quả tính từ giá lúc đề xuất, không phải lợi nhuận thực tế của ai.</p></section>';
    }
    if (c.execution) {
      const e = c.execution;
      h += '<section><h3>Chất lượng khớp lệnh' + (e.months ? ' (' + e.months + ' tháng gần nhất)' : '') + '</h3>' + table(['Số lệnh', 'Giá trị', 'Phí + thuế', 'Mua so với đóng cửa', 'Bán so với đóng cửa', 'Đề xuất → khớp', 'Sau mua 5 phiên', 'Sau bán 5 phiên'],
        [[String(e.n), esc(vnd(e.value)), e.costPct === null ? esc(vnd(e.cost)) : esc(vnd(e.cost) + ' (' + pct(e.costPct, 2) + ')'), e.vsCloseBuy.n ? esc(pct(e.vsCloseBuy.pct, 2, true)) + ' (' + e.vsCloseBuy.n + ' lệnh)' : '—', e.vsCloseSell.n ? esc(pct(e.vsCloseSell.pct, 2, true)) + ' (' + e.vsCloseSell.n + ' lệnh)' : '—', e.vsRef.n ? esc(pct(e.vsRef.pct, 2, true)) + ' (' + e.vsRef.n + ' lệnh)' : '—', e.forwardBuy.n ? esc(pct(e.forwardBuy.pct, 1, true)) : '—', e.forwardSell.n ? esc(pct(e.forwardSell.pct, 1, true)) : '—']], 0)
        + liList(e.insights) + '<p class="tl-hint">Dương ở các cột so với tham chiếu = khớp xấu hơn (mua cao hơn, bán thấp hơn). Chỉ có giá đóng cửa nên là thước đo thô; chỉ có ý nghĩa khi nhiều lệnh cùng xu hướng.</p></section>';
    }
    return h;
  }

  // HTML của báo cáo (đã escape). Dùng class của tools.css/style.css để hợp giao diện; khi in dùng nền sáng của @media print.
  function toHtml(r) {
    const m = r.meta;
    let h = '<article class="gr-report"><header class="gr-rep-head"><h2>' + esc(m.title) + '</h2><p>' + esc(m.label) + (m.from ? ' · kỳ ' + esc(dmy(m.from)) + ' → ' + esc(dmy(m.to)) : '') + ' · số liệu đến ' + esc(dmy(m.asOf)) + ' · ' + m.memberCount + ' thành viên</p></header>';
    h += '<section><h3>Tóm tắt</h3><ul class="gr-rep-notes">' + r.notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul></section>';
    h += '<section><h3>Chỉ số chính</h3><div class="tl-kpis">' + r.kpis.map((k) => '<div class="tl-kpi"><span class="k">' + esc(k.label) + '</span><span class="v">' + esc(k.text) + '</span>' + (k.sub ? '<span class="s">' + esc(k.sub) + '</span>' : '') + '</div>').join('') + '</div></section>';
    h += '<section><h3>Danh mục chung (25 mã lớn nhất)</h3>' + (r.holdings.length ? table(['Mã', 'Ngành', 'Giá trị', 'Tỷ trọng', 'Lãi/lỗ chưa chốt', 'Số người giữ', 'Thành viên'],
      r.holdings.map((s) => [esc(s.symbol), esc(s.sector), esc(vnd(s.value)), esc(pct(s.weightPct, 1)), esc(pct(s.unrealizedPct, 1, true)), String(s.holderCount), esc(s.holders.join(', '))]), 2) : '<p class="tl-hint">Chưa có cổ phiếu.</p>');
    if (r.sectors.length) h += table(['Ngành', 'Giá trị', 'Tỷ trọng', 'Mã'], r.sectors.map((s) => [esc(s.sector), esc(vnd(s.value)), esc(pct(s.weightPct, 1)), esc(s.symbols.join(', '))]), 1);
    h += '</section>';
    h += '<section><h3>Thành viên</h3>' + table(['Thành viên', 'NAV', '% nhóm', 'Số mã', 'Lợi suất', 'Vượt chuẩn', 'Alpha', 'Beta', 'Sụt giảm tối đa', 'Trùng với người khác'],
      r.members.map((x) => [esc(x.name), esc(vnd(x.nav)), esc(pct(x.sharePct, 1)), String(x.holdingCount), esc(pct(x.returnPct, 2, true)), esc(pct(x.excessPct, 2, true)), esc(pct(x.alphaPct, 1, true)), esc(fmt(x.beta, 2)), esc(pct(x.maxDD, 1)), esc(pct(x.overlapWithGroupPct, 0))]), 1) + '</section>';
    h += '<section><h3>Tuân thủ giới hạn đầu tư</h3>' + (r.compliance.limitsCount ? (r.compliance.breaches.length
      ? table(['Thành viên', 'Giới hạn', 'Đối tượng', 'Hiện tại', 'Ngưỡng', 'Chế độ'], r.compliance.breaches.map((b) => [esc(b.name), esc(b.kindLabel), esc(b.subject), esc(fmt(b.current, b.kind === 'max_position_vnd' ? 0 : 2)), esc(fmt(b.threshold, b.kind === 'max_position_vnd' ? 0 : 2)), esc(b.modeLabel)]), 3)
      : '<p class="tl-hint">Không có giới hạn nào đang bị vượt.</p>') : '<p class="tl-hint">Nhóm chưa đặt giới hạn đầu tư.</p>');
    if (r.exceptions.length) h += '<h4>Ngoại lệ đã ghi trong kỳ</h4>' + table(['Ngày', 'Thành viên', 'Giới hạn', 'Mã', 'Nguồn', 'Ghi đè', 'Lý do'], r.exceptions.map((e) => [esc(dmy(e.date)), esc(e.name), esc(e.kindLabel), esc(e.symbol), esc(e.source), e.override ? 'Có' : '', esc(e.reason)]));
    h += '</section>';
    const a = r.activity;
    h += '<section><h3>Hoạt động giao dịch trong kỳ</h3><p class="tl-hint">' + a.totals.trades + ' lệnh · mua ' + esc(vnd(a.totals.buyValue)) + ' · bán ' + esc(vnd(a.totals.sellValue)) + ' · ròng ' + esc(vnd(a.totals.net)) + '</p>'
      + (a.symbols.length ? table(['Mã', 'Mua', 'Bán', 'Ròng', 'Người mua', 'Người bán', 'Nhận định'], a.symbols.map((s) => [esc(s.symbol), esc(vnd(s.buyValue)), esc(vnd(s.sellValue)), esc(vnd(s.net)), esc(s.buyers.join(', ')), esc(s.sellers.join(', ')), esc({ consensus_buy: 'Nhiều người cùng mua', consensus_sell: 'Nhiều người cùng bán', conflict: 'Mua bán trái chiều', buy: 'Mua', sell: 'Bán', mixed: 'Hỗn hợp' }[s.stance] || '')]), 1) : '<p class="tl-hint">Không có giao dịch trong kỳ.</p>') + '</section>';
    h += committeeHtml(r.committee);
    h += '<footer class="tl-hint">Số liệu lấy từ sổ lệnh và lịch sử NAV của từng thành viên, tính bằng cùng công thức với màn hình Toàn Nhóm. Lợi suất dùng phương pháp Modified Dietz đã loại nạp/rút vốn. Báo cáo chỉ mô tả, không phải khuyến nghị đầu tư.</footer></article>';
    return h;
  }

  // Các sheet Excel (đưa vào XlsxWriter.build)
  function toSheets(r) {
    const H = (v) => ({ v, s: 'header' });
    const int = (v) => ({ v: v === null || v === undefined ? null : Math.round(v), s: 'int' });
    const dec = (v) => ({ v: v === null || v === undefined ? null : v, s: 'dec' });
    const m = r.meta;
    const sheets = [];
    sheets.push({ name: '01_Tong_quan', columns: [{ width: 30 }, { width: 26 }, { width: 42 }], rows: [
      [H(m.title), H(m.label + (m.from ? ' · ' + m.from + ' → ' + m.to : '')), H('Số liệu đến ' + m.asOf)],
      [],
      [H('Chỉ số'), H('Giá trị'), H('Ghi chú')],
    ].concat(r.kpis.map((k) => [k.label, typeof k.value === 'number' && /^(nav|marketValue|cash|debt)$/.test(k.key) ? int(k.value) : k.text, k.sub || '']))
      .concat([[], [H('Nhận xét tự động'), H(''), H('')]]).concat(r.notes.map((n) => [n, '', ''])) });
    sheets.push({ name: '02_Danh_muc_chung', freezeHeader: true, columns: [{ width: 10 }, { width: 18 }, { width: 14 }, { width: 18 }, { width: 12 }, { width: 14 }, { width: 10 }, { width: 40 }], rows:
      [[H('Mã'), H('Ngành'), H('Số lượng'), H('Giá trị (đ)'), H('Tỷ trọng %'), H('Lãi/lỗ chưa chốt %'), H('Số người giữ'), H('Thành viên')]]
        .concat(r.holdings.map((s) => [s.symbol, s.sector, int(s.quantity), int(s.value), dec(s.weightPct), dec(s.unrealizedPct), s.holderCount, s.holders.join(', ')])) });
    sheets.push({ name: '03_Thanh_vien', freezeHeader: true, columns: [{ width: 22 }, { width: 18 }, { width: 10 }, { width: 8 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 8 }, { width: 10 }, { width: 14 }, { width: 14 }], rows:
      [[H('Thành viên'), H('NAV (đ)'), H('% nhóm'), H('Số mã'), H('Lợi suất %'), H('Vượt chuẩn %'), H('Alpha %'), H('Beta'), H('Sharpe'), H('Sụt giảm tối đa %'), H('Trùng với người khác %')]]
        .concat(r.members.map((x) => [x.name, int(x.nav), dec(x.sharePct), x.holdingCount, dec(x.returnPct), dec(x.excessPct), dec(x.alphaPct), dec(x.beta), dec(x.sharpe), dec(x.maxDD), dec(x.overlapWithGroupPct)])) });
    sheets.push({ name: '04_Tuan_thu', freezeHeader: true, columns: [{ width: 22 }, { width: 22 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 16 }], rows:
      [[H('Thành viên'), H('Giới hạn'), H('Đối tượng'), H('Hiện tại'), H('Ngưỡng'), H('Chế độ')]]
        .concat(r.compliance.breaches.map((b) => [b.name, b.kindLabel, b.subject, dec(b.current), dec(b.threshold), b.modeLabel])) });
    sheets.push({ name: '05_Ngoai_le', freezeHeader: true, columns: [{ width: 12 }, { width: 20 }, { width: 22 }, { width: 10 }, { width: 14 }, { width: 8 }, { width: 60 }], rows:
      [[H('Ngày'), H('Thành viên'), H('Giới hạn'), H('Mã'), H('Nguồn'), H('Ghi đè'), H('Lý do')]]
        .concat(r.exceptions.map((e) => [{ v: e.date, s: 'date' }, e.name, e.kindLabel, e.symbol, e.source, e.override ? 'Có' : '', e.reason])) });
    sheets.push({ name: '06_So_lenh', freezeHeader: true, columns: [{ width: 12 }, { width: 20 }, { width: 8 }, { width: 10 }, { width: 12 }, { width: 14 }, { width: 18 }, { width: 12 }, { width: 12 }, { width: 28 }], rows:
      [[H('Ngày'), H('Thành viên'), H('Loại'), H('Mã'), H('Khối lượng'), H('Giá'), H('Giá trị (đ)'), H('Phí'), H('Thuế'), H('Ngoại lệ giới hạn')]]
        .concat(r.trades.map((t) => [{ v: t.date, s: 'date' }, t.name, t.type === 'buy' ? 'Mua' : 'Bán', t.symbol, int(t.quantity), int(t.price), int(t.value), int(t.fee), int(t.tax), t.exception ? t.exception.reason : ''])) });
    const c = r.committee;
    if (c && c.governance) {
      const g = c.governance, q = g.requests;
      sheets.push({ name: '07_Quan_tri', columns: [{ width: 42 }, { width: 22 }, { width: 50 }], rows: [
        [H('Chỉ số'), H('Giá trị'), H('Ghi chú')],
        ['Duyệt lệnh lớn', g.policy.active ? 'Bật' : 'Tắt', (g.policy.thresholdPct ? 'Ngưỡng ' + g.policy.thresholdPct + '% NAV. ' : '') + (g.policy.thresholdVnd ? 'Ngưỡng ' + Math.round(g.policy.thresholdVnd) + ' đ. ' : '') + (g.policy.validDays ? 'Hiệu lực ' + g.policy.validDays + ' ngày.' : '')],
        ['Đề xuất trong kỳ', q.total, ''], ['Đã duyệt / đã dùng', q.approved + q.executed, ''], ['Hết hạn', q.expired, ''], ['Từ chối', q.rejected, ''],
        ['Chờ duyệt hiện tại', q.pendingNow, q.oldestPendingDays ? 'Lâu nhất ' + q.oldestPendingDays + ' ngày' : ''], ['Tỷ lệ được duyệt %', dec(q.approvalRatePct), ''], ['Thời gian quyết định trung vị (giờ)', dec(q.medianDecideHours), ''], ['Tự duyệt', q.selfApproved, 'Người miễn nguyên tắc hai người / admin, có ghi lý do'],
        ['Kiểm tra độc lập trong kỳ', g.audit.inPeriod, Object.keys(g.audit.byKind).map((k) => (AUDIT_KIND[k] || k) + ' ' + g.audit.byKind[k]).join(', ')], ['Kiểm tra độc lập chưa xem xét', g.audit.openNow, ''],
        [], [H('Mã hạn chế'), H('Áp dụng cho'), H('Lý do')]].concat(g.restricted.items.map((x) => [x.symbol, x.scope, x.reason])) });
    }
    if (c && c.stress) {
      sheets.push({ name: '08_Can_thang', columns: [{ width: 40 }, { width: 14 }, { width: 18 }, { width: 22 }, { width: 14 }, { width: 14 }], rows: [
        [H('Kịch bản'), H('NAV thay đổi %'), H('NAV sau (đ)'), H('Mã mất nhiều nhất'), H('Vi phạm mới'), H('Ký quỹ')]]
        .concat(c.stress.scenarios.map((x) => [x.label, dec(x.portfolioPct), int(x.navAfter), x.worst ? x.worst.symbol + ' ' + fmt(x.worst.pct, 0) + '%' : '', x.newBreaches === null ? '' : x.newBreaches, x.hasDebt ? (x.marginBreached ? 'Chạm ngưỡng' : 'An toàn') : '']))
        .concat([[], [H('Kịch bản ngược'), H('VN-Index giảm %'), H('NAV mất %'), H('Ghi chú'), H(''), H('')]])
        .concat(c.stress.reverse.map((x) => [x.label, dec(x.indexPct), dec(x.navLossPct), x.note, '', ''])) });
    }
    if (c && c.journey) {
      const j = c.journey;
      sheets.push({ name: '09_Hanh_trinh_y_tuong', columns: [{ width: 36 }, { width: 14 }, { width: 24 }], rows: [
        [H('Chỉ số'), H('Giá trị'), H('Ghi chú')],
        ['Tổng ý tưởng', j.funnel.total, ''], ['Đã có quyết định', j.funnel.decided, ''], ['Được duyệt', j.funnel.approved, ''], ['Đã vào danh mục', j.funnel.executed, ''], ['Bị bác', j.funnel.rejected, ''],
        ['Đề xuất → duyệt (trung vị, ngày)', dec(j.timing.toDecide), ''], ['Duyệt → ghi lệnh (trung vị, ngày)', dec(j.timing.toExecute), ''],
        [], [H('Đường đi'), H('Số ý tưởng'), H('Vượt VN-Index TB %')],
        ['Đã thực hiện', j.paths.executed.n, dec(j.paths.executed.avgAlpha)], ['Duyệt rồi để đó', j.paths.idle.n, dec(j.paths.idle.avgAlpha)], ['Bị bác', j.paths.rejected.n, dec(j.paths.rejected.avgAlpha)], ['Chưa quyết định', j.paths.pending.n, dec(j.paths.pending.avgAlpha)],
        [], [H('Nhận xét'), H(''), H('')]].concat(j.insights.map((i) => [i.text, '', ''])) });
    }
    if (c && c.execution) {
      const e = c.execution;
      sheets.push({ name: '10_Khop_lenh', columns: [{ width: 38 }, { width: 16 }, { width: 14 }], rows: [
        [H('Chỉ số'), H('Giá trị'), H('Số lệnh')],
        ['Số lệnh', e.n, ''], ['Giá trị (đ)', int(e.value), ''], ['Phí + thuế (đ)', int(e.cost), ''], ['Phí + thuế % giá trị', dec(e.costPct), ''],
        ['Mua so với đóng cửa %', dec(e.vsCloseBuy.pct), e.vsCloseBuy.n], ['Bán so với đóng cửa %', dec(e.vsCloseSell.pct), e.vsCloseSell.n], ['Đề xuất → khớp %', dec(e.vsRef.pct), e.vsRef.n], ['Trễ duyệt → ghi lệnh (ngày)', dec(e.delayDays), ''],
        ['Sau mua 5 phiên %', dec(e.forwardBuy.pct), e.forwardBuy.n], ['Sau bán 5 phiên %', dec(e.forwardSell.pct), e.forwardSell.n]] });
    }
    return sheets;
  }

  return { build, toHtml, toSheets, periodFor, KIND_LABEL, MODE_LABEL };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GroupReport;
