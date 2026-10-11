/* --- FILE: /lab/lab-factor-views.js ---
   Giao diện tab "Yếu tố và phong cách": danh mục lãi / lỗ vì yếu tố nào (thị trường, quy mô, giá trị, động lượng, biến động thấp, chất lượng), đóng góp từng yếu tố vào lợi suất, độ nghiêng của từng mã đang nắm,
   hiệu quả các yếu tố theo thời gian. Chỉ dựng chuỗi HTML (kiểm thử được bằng Vitest). Phụ thuộc InsUtil, FactorModel. Nạp bằng thẻ <script> thường (global LabFactorViews) và module.exports. */
const LabFactorViews = (function () {
  const NODE = typeof require === 'function' && typeof module !== 'undefined';
  const U = NODE ? require('../insight/insight-util.js') : InsUtil;
  const FM = NODE ? require('../lib/factor-model.js') : FactorModel;
  const LV = NODE ? require('./lab-views.js') : LabViews;
  const e = U.esc;
  const SUBJECTS = { mine: 'Danh mục của tôi', group: 'Danh mục nhóm', custom: 'Mã tự chọn' };
  const WINDOWS = { 252: '1 năm', 504: '2 năm', 756: '3 năm' };
  const COLORS = { MKT: '#8A8377', SIZE: '#2F6FDE', VALUE: '#12855A', MOM: '#C23B3B', LVOL: '#8E5CC9', QUAL: '#B7791F' };
  const nm = (k) => (FM.BY_KEY[k] ? FM.BY_KEY[k].short : k);
  const f2 = (v) => (U.isNum(v) ? (v >= 0 ? '+' : '−') + U.dec(Math.abs(v), 2) : '—');

  function controls(S) {
    const seg = (items, cur, fn) => '<div class="ins-seg" role="group">' + Object.keys(items).map((k) => '<button type="button" aria-pressed="' + (String(cur) === String(k) ? 'true' : 'false') + '" onclick="' + fn + '(\'' + k + '\')">' + e(items[k]) + '</button>').join('') + '</div>';
    return U.card('layer-group', 'Phân tích yếu tố', '<div class="ins-bar"><span class="lab-lbl">Đối tượng</span>' + seg(SUBJECTS, S.subject, 'labFacSubject') + '<span class="lab-lbl" style="margin-left:10px">Cửa sổ</span>' + seg(WINDOWS, S.window, 'labFacWindow') + '</div>' +
      (S.subject === 'custom' ? '<label class="ins-field" style="margin-bottom:10px">Mã (cách nhau bằng dấu phẩy hoặc khoảng trắng; ghi MÃ:tỷ trọng nếu muốn khác nhau)<input type="text" id="lab-fac-custom" value="' + e(S.custom || '') + '" placeholder="FPT, HPG, VCB hoặc FPT:40 HPG:30 VCB:30" onchange="labFacCustom(this.value)"></label>' : '') +
      '<div class="ins-bar" style="margin:0"><button type="button" class="ins-btn" onclick="labFacRun()"' + (S.state === 'running' || S.ready === false ? ' disabled' : '') + '><i class="fa-solid fa-play"></i> ' + (S.state === 'running' ? 'Đang phân tích…' : 'Phân tích') + '</button><span class="ins-muted" style="font-size:.76rem">Hồi quy lợi suất ngày của danh mục (tỷ trọng hiện tại, hồi tố) lên sáu yếu tố tự dựng từ kho giá.</span></div>');
  }

  // Thanh hệ số: giữa là 0, sang phải dương, sang trái âm
  function bar(label, sub, v, t, maxAbs) {
    const w = U.isNum(v) && maxAbs > 0 ? Math.min(50, Math.abs(v) / maxAbs * 50) : 0;
    return '<div class="lab-bar"><div class="lbl">' + e(label) + (sub ? '<small>' + e(sub) + '</small>' : '') + '</div><div class="track"><span class="zero"></span>' + (U.isNum(v) ? '<span class="fill ' + (v >= 0 ? 'pos' : 'neg') + '" style="width:' + w.toFixed(1) + '%"></span>' : '') + '</div><div class="val ' + U.sign(v) + '">' + f2(v) + (U.isNum(t) ? '<br><small class="ins-muted">t = ' + U.dec(t, 1) + '</small>' : '') + '</div></div>';
  }

  function curveSvg(c) {
    if (!c || !c.dates || c.dates.length < 2) return '';
    const W = 760, H = 250, L = 46, R = 12, T = 12, B = 26, n = c.dates.length, keys = Object.keys(c.series);
    let lo = Infinity, hi = -Infinity; keys.forEach((k) => c.series[k].forEach((v) => { const x = Math.log(v); if (x < lo) lo = x; if (x > hi) hi = x; }));
    if (!(hi > lo)) hi = lo + 1;
    const x = (i) => L + (W - L - R) * i / (n - 1), y = (v) => T + (H - T - B) * (1 - (Math.log(v) - lo) / (hi - lo));
    const ticks = U.niceTicks(Math.exp(lo), Math.exp(hi), 4).filter((v) => v > 0);
    const grid = ticks.map((v) => '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/><text x="' + (L - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + U.dec(v, 2) + '×</text>').join('');
    const xl = []; c.dates.forEach((d, i) => { if (d.slice(5, 7) === '01' && (i === 0 || c.dates[i - 1].slice(5, 7) !== '01')) xl.push('<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + d.slice(0, 4) + '</text>'); });
    const lines = keys.map((k) => '<polyline fill="none" stroke="' + (COLORS[k] || '#888') + '" stroke-width="' + (k === 'MKT' ? 1.4 : 1.9) + '"' + (k === 'MKT' ? ' stroke-dasharray="4 3"' : '') + ' points="' + c.series[k].map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ') + '"/>').join('');
    return '<svg class="ins-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Giá trị tích luỹ của từng yếu tố">' + grid + '<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '"/>' + xl.join('') + lines + '</svg>' +
      '<div class="ins-legend">' + keys.map((k) => '<span><i style="display:inline-block;width:14px;height:3px;background:' + (COLORS[k] || '#888') + ';vertical-align:middle"></i> ' + e(nm(k)) + '</span>').join('') + '</div>';
  }

  function resultHtml(S) {
    const r = S.res;
    if (S.state === 'running') return U.loading(S.progress || 'Đang phân tích…');
    if (S.state === 'error') return U.card('triangle-exclamation', 'Không phân tích được', U.empty('triangle-exclamation', e(S.error)));
    if (!r) return '';
    if (!r.ok) return U.card('triangle-exclamation', 'Không phân tích được', U.empty('triangle-exclamation', e(r.reason)));
    const maxAbs = Math.max.apply(null, r.contrib.map((c) => Math.abs(c.beta)).concat([0.5]));
    const narr = FM.narrate(r);
    const head = U.kpis([
      U.kpi('Lợi suất danh mục', U.pct(r.port.annReturn, 1, true), r.n + ' phiên (' + U.dec(r.years, 1) + ' năm), biến động ' + U.pct(r.port.annVol, 1)),
      U.kpi('Yếu tố giải thích', U.dec(r.r2 * 100, 0) + '%', 'R² điều chỉnh ' + U.dec(r.adjR2 * 100, 0) + '%'),
      U.kpi('Alpha năm', U.pct(r.alphaAnn, 1, true), 't = ' + U.dec(r.tAlpha, 1) + (Math.abs(r.tAlpha) < 2 ? ' (chưa khác 0 rõ rệt)' : ''), Math.abs(r.tAlpha) >= 2 ? 'good' : 'warn'),
      U.kpi('Rủi ro riêng từng mã', U.pct(r.residVol, 1) + '/năm', 'phần yếu tố không giải thích'),
    ]);
    const loadings = r.contrib.map((c) => bar(nm(c.key), c.key === 'MKT' ? 'beta' : (c.vif > 5 ? 'VIF ' + U.dec(c.vif, 1) + ': tương quan mạnh với yếu tố khác' : ''), c.beta, c.t, maxAbs)).join('');
    const contribRows = r.contrib.map((c) => '<tr><td class="t">' + e(nm(c.key)) + (c.sig ? ' ' + U.tag('có ý nghĩa', 'ok') : '') + '</td><td>' + f2(c.beta) + '</td><td>' + U.dec(c.t, 1) + '</td><td class="' + U.sign(c.meanFactorAnn) + '">' + U.pct(c.meanFactorAnn, 1, true) + '</td><td class="' + U.sign(c.contribAnn) + '"><b>' + U.pct(c.contribAnn, 1, true) + '</b></td></tr>').join('') +
      '<tr><td class="t">Alpha (phần không giải thích bằng yếu tố)</td><td>—</td><td>' + U.dec(r.tAlpha, 1) + '</td><td>—</td><td class="' + U.sign(r.alphaAnn) + '"><b>' + U.pct(r.alphaAnn, 1, true) + '</b></td></tr>' +
      '<tr class="sel"><td class="t"><b>Lợi suất năm vượt lãi suất tiền mặt</b></td><td></td><td></td><td></td><td class="' + U.sign(r.excessAnn) + '"><b>' + U.pct(r.excessAnn, 1, true) + '</b></td></tr>';
    const ex = S.expo, exRows = ex ? ex.rows.map((x) => '<tr><td class="t">' + e(nm(x.key)) + '</td><td>' + (x.pct === null ? '<span class="ins-muted">' + e(x.note || 'thiếu số liệu') + '</span>' : '<div style="min-width:120px">' + U.meter(x.pct) + '</div>') + '</td><td>' + (x.pct === null ? '—' : U.dec(x.pct * 100, 0) + '%') + '</td><td>' + (x.z === null ? '—' : f2(x.z)) + '</td><td>' + U.pct(x.coverage, 0) + '</td></tr>').join('') : '';
    const perf = U.table(['Yếu tố', 'Lợi suất năm (cửa sổ)', 'Biến động', 'Sharpe', 'Sụt giảm tối đa', 'Cả giai đoạn', 'Tháng dựng · mã/rổ'], [r.factorPerf.map((p) => '<tr><td class="t">' + e(nm(p.key)) + '</td><td class="' + U.sign(p.annReturn) + '">' + U.pct(p.annReturn, 1, true) + '</td><td>' + U.pct(p.annVol, 1) + '</td><td>' + U.dec(p.sharpe, 2) + '</td><td>' + U.pct(p.maxDD, 1) + '</td><td class="' + U.sign(p.fullAnnReturn) + '">' + U.pct(p.fullAnnReturn, 1, true) + '</td><td>' + (p.key === 'MKT' ? '—' : p.built + ' · ' + p.legN) + '</td></tr>').join('')], { left: [0] });
    const hold = r.symbols.map((s, i) => e(s) + ' ' + U.dec(r.weights[i] * 100, 0) + '%').join(', ');
    return U.note('<b>Đọc nhanh:</b><ul style="margin:6px 0 0 18px">' + narr.map((t) => '<li>' + e(t) + '</li>').join('') + '</ul>') + head +
      '<div class="ins-grid even">' + U.card('sliders', 'Danh mục nghiêng về yếu tố nào', loadings + '<p class="tl-hint">Hệ số hồi quy ' + e(r.from.slice(0, 10)) + ' → ' + e(r.to.slice(0, 10)) + '. Thanh sang phải = nghiêng về phía mua của yếu tố; |t| ≥ 2 mới đáng tin.</p>') +
      U.card('table-list', 'Đóng góp vào lợi suất', U.table(['Yếu tố', 'Hệ số', 't', 'Lợi suất yếu tố/năm', 'Đóng góp/năm'], [contribRows], { left: [0] })) + '</div>' +
      (ex ? U.card('crosshairs', 'Từng mã đang nắm so với vũ trụ hôm nay (' + U.date(ex.asOf) + ')', U.table(['Đặc trưng', 'Phân vị của danh mục', '', 'Z', 'Phủ số liệu'], [exRows], { left: [0] }) + '<p class="tl-hint">Phân vị 50% = ngang vũ trụ ' + U.int(ex.universe) + ' mã đủ thanh khoản; cao hơn = nghiêng về phía mua của yếu tố (mã nhỏ, rẻ, đang thắng, ít biến động, ROE cao). Số liệu cơ bản dùng bản chụp ' + (ex.fundAsOf ? U.date(ex.fundAsOf) : 'không có') + '. Danh mục: ' + hold + '.</p>') : '') +
      U.card('chart-line', 'Hiệu quả các yếu tố theo thời gian', curveSvg(S.curve) + '<p class="tl-hint">Giá trị tích luỹ của từng danh mục mua-bán (thang logarit). Yếu tố có thể âm nhiều năm liền: không có yếu tố nào luôn thưởng.</p>' + perf) +
      U.note('<b>Giới hạn:</b> mô hình tự dựng từ số liệu miễn phí, không so trực tiếp được với MSCI Barra hay Fama-French của Mỹ; hồi tố với tỷ trọng hiện tại không phản ánh danh mục đã giữ thật; vũ trụ nhỏ nên yếu tố nhiễu; VN-Index là chỉ số giá nên alpha hơi thấp (cổ tức ~1-2%/năm).');
  }

  function factorsHtml(L) {
    const S = L.fac, d = L.data || {};
    S.ready = d.state === 'ready';
    return '<div id="lab-databar">' + LV.dataBarHtml(L) + '</div>' + controls(S) + '<div id="lab-result">' + resultHtml(S) + '</div>';
  }

  return { factorsHtml, resultHtml, controls, bar, curveSvg, SUBJECTS, WINDOWS };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LabFactorViews;
