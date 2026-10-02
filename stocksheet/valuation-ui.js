/* --- FILE: /stocksheet/valuation-ui.js ---
   Hàm dựng HTML + định dạng số dùng chung cho 2 trang Tổng Hợp CP và Định Giá CP (không đụng DOM thật, không gọi API).
   Nạp bằng thẻ <script> thường (global ValuationUI) và module.exports cho Vitest. Phụ thuộc lib/valuation-calc.js (ValuationCalc).
   Mọi chuỗi chèn vào HTML đều qua esc(). */
const ValuationUI = (function () {
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const isNum = (v) => v !== null && v !== undefined && v !== '' && isFinite(Number(v));
  const NA = '—';

  function dec(v, digits) {
    if (!isNum(v)) return NA;
    const d = digits === undefined ? 2 : digits;
    return Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: d });
  }
  function vnd(v) { return isNum(v) ? Math.round(Number(v)).toLocaleString('vi-VN') : NA; }
  function mult(v, digits) { return isNum(v) ? dec(v, digits === undefined ? 1 : digits) + 'x' : NA; }
  function pct(v, digits, sign) {
    if (!isNum(v)) return NA;
    const n = Number(v);
    return (sign && n > 0 ? '+' : '') + dec(n, digits === undefined ? 1 : digits) + '%';
  }
  function signedClass(v) {
    if (!isNum(v)) return 'pnl-flat';
    return Number(v) > 0 ? 'pnl-up' : (Number(v) < 0 ? 'pnl-down' : 'pnl-flat');
  }

  const VERDICT_ICON = { cheap: 'fa-tag', fair: 'fa-scale-balanced', expensive: 'fa-triangle-exclamation', none: 'fa-circle-question' };
  function verdictPill(verdict) {
    const v = verdict || { key: 'none', label: 'Chưa đủ dữ liệu' };
    return `<span class="vl-pill vl-pill-${esc(v.key)}"><i class="fa-solid ${VERDICT_ICON[v.key] || VERDICT_ICON.none}" aria-hidden="true"></i> ${esc(v.label)}</span>`;
  }

  const SECTOR_OPTIONS = () => Object.keys(ValuationCalc.SECTORS).map((k) => ({ value: k, label: ValuationCalc.SECTORS[k].label }));

  // Một khoảng giá nằm trên trục chung: thanh = [xấu, tốt], vạch đứng = cơ sở. Tên + khoảng giá nằm ở cột trái.
  function footballHtml(ff, price) {
    if (!ff || !ff.rows.length) return '<div class="vl-empty">Chưa đủ dữ liệu để vẽ khoảng giá — cần ít nhất một mục tiêu P/E hoặc P/B.</div>';
    const priceTag = ff.pricePct !== null
      ? `<span class="vl-ff-pricetag" style="left:${ff.pricePct.toFixed(2)}%">Giá ${esc(vnd(price))}</span>` : '';
    const rows = ff.rows.map((r) => {
      const base = r.basePct !== null ? `<span class="vl-ff-base" style="left:${r.basePct.toFixed(2)}%" title="Cơ sở ${esc(vnd(r.base))}"></span>` : '';
      const line = ff.pricePct !== null ? `<span class="vl-ff-price" style="left:${ff.pricePct.toFixed(2)}%"></span>` : '';
      const range = `${esc(vnd(r.low))} – ${esc(vnd(r.high))}`;
      const note = r.note ? `<span class="vl-ff-note">${esc(r.note)}</span>` : '';
      return `<div class="vl-ff-row">
        <div class="vl-ff-label"><span class="vl-ff-name">${esc(r.label)}</span><span class="vl-ff-range">${range}</span>${note}</div>
        <div class="vl-ff-track"><span class="vl-ff-bar vl-ff-bar-${esc(r.kind)}" style="left:${r.leftPct.toFixed(2)}%;width:${r.widthPct.toFixed(2)}%"></span>${base}${line}</div>
      </div>`;
    }).join('');
    return `<div class="vl-ff">
      <div class="vl-ff-row vl-ff-axis"><div class="vl-ff-label"></div><div class="vl-ff-track">${priceTag}</div></div>
      ${rows}
    </div>
    <div class="vl-ff-legend"><span><i class="vl-lg vl-lg-bar"></i>Khoảng giá (xấu → tốt)</span><span><i class="vl-lg vl-lg-base"></i>Kịch bản cơ sở</span><span><i class="vl-lg vl-lg-price"></i>Giá hiện tại</span></div>`;
  }

  // Thanh khoảng nhỏ trong thẻ kết luận: xấu — cơ sở — tốt và vị trí giá hiện tại.
  function rangeHtml(bear, fair, bull, price) {
    const ff = ValuationCalc.football([{ label: 'Giá hợp lý', low: bear, base: fair, high: bull }], price);
    if (!ff) return '';
    const r = ff.rows[0];
    const pricePos = ff.pricePct !== null ? `<span class="vl-range-price" style="left:${ff.pricePct.toFixed(2)}%"><b>${esc(vnd(price))}</b></span>` : '';
    return `<div class="vl-range" aria-hidden="true">
      <div class="vl-range-track"><span class="vl-ff-bar vl-ff-bar-method" style="left:${r.leftPct.toFixed(2)}%;width:${r.widthPct.toFixed(2)}%"></span><span class="vl-ff-base" style="left:${r.basePct.toFixed(2)}%"></span>${ff.pricePct !== null ? `<span class="vl-ff-price" style="left:${ff.pricePct.toFixed(2)}%"></span>` : ''}</div>
      ${pricePos}
      <div class="vl-range-ends"><span>Xấu ${esc(vnd(bear))}</span><span>Tốt ${esc(vnd(bull))}</span></div>
    </div>`;
  }

  // Khối đầu trang: mã + giá hiện tại + câu kết luận (trái), giá hợp lý + nhãn Rẻ/Hợp lý/Đắt + thanh khoảng (phải).
  // o: { symbol, meta: [chuỗi nhãn nhỏ], statusHtml (đã escape), priceNote, a: kết quả ValuationCalc.analyze }
  function heroHtml(o) {
    const a = o.a, v = a.v;
    const meta = (o.meta || []).filter(Boolean).map((t) => `<span class="vl-chipmeta">${esc(t)}</span>`).join('');
    return `<div class="vl-hero">
      <div class="vl-hero-main">
        <div class="vl-hero-id"><span class="vl-hero-symbol">${esc(o.symbol || NA)}</span>${meta}${o.statusHtml || ''}</div>
        <div class="vl-hero-price"><b>${vnd(a.price)}</b><span>${esc(o.priceNote || '')}</span></div>
        <p class="vl-hero-sentence">${esc(verdictSentence(a.verdict, v.fair, a.price))}</p>
      </div>
      <div class="vl-hero-side">
        <span class="vl-hero-fairlabel">Giá hợp lý (gộp ${v.methods.length} phương pháp)</span>
        <div class="vl-hero-fair"><b>${vnd(v.fair)}</b>${verdictPill(a.verdict)}</div>
        ${v.fair > 0 ? rangeHtml(v.fairBear, v.fair, v.fairBull, a.price) : ''}
      </div>
    </div>`;
  }

  // Bảng kịch bản: mỗi phương pháp 1 dòng (xấu / cơ sở / tốt) kèm % so với giá hiện tại; dòng cuối là giá hợp lý gộp.
  function scenarioTableHtml(v, price) {
    if (!v || !v.methods.length) return '<div class="vl-empty">Chưa có phương pháp nào tính được — nhập P/E hoặc P/B mục tiêu (và EPS/BVPS dương).</div>';
    const cell = (val, strong) => {
      const up = price > 0 && val > 0 ? (val - price) / price * 100 : null;
      return `<td class="num${strong ? ' vl-strong' : ''}">${esc(vnd(val))}${up !== null ? `<small class="${signedClass(up)}-text">${esc(pct(up, 0, true))}</small>` : ''}</td>`;
    };
    const rows = v.methods.map((m) => `<tr>
      <td><span class="vl-m-name">${esc(m.label)}</span> <span class="vl-m-weight">${esc(dec(m.share * 100, 0))}%</span>${m.note ? `<small>${esc(m.note)}</small>` : ''}</td>
      ${cell(m.bear)}${cell(m.base, true)}${cell(m.bull)}
    </tr>`).join('');
    return `<div class="vl-table-wrap"><table class="vl-scen">
      <thead><tr><th>Phương pháp · tỷ trọng</th><th class="num">Xấu</th><th class="num">Cơ sở</th><th class="num">Tốt</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>Giá hợp lý (gộp)</td>${cell(v.fairBear)}${cell(v.fair, true)}${cell(v.fairBull)}</tr></tfoot>
    </table></div>`;
  }

  // Một dòng chỉ số: nhãn - giá trị - ghi chú so sánh (lịch sử / ngành / tăng trưởng).
  function metricRow(label, valueHtml, subHtml, title) {
    return `<div class="vl-metric"${title ? ` title="${esc(title)}"` : ''}>
      <span class="vl-metric-label">${esc(label)}</span>
      <span class="vl-metric-value">${valueHtml}</span>
      ${subHtml ? `<span class="vl-metric-sub">${subHtml}</span>` : ''}
    </div>`;
  }
  function growthTag(v, suffix) {
    if (!isNum(v)) return '';
    return `<span class="pnl-pill ${signedClass(v)}"><i class="fa-solid ${v > 0 ? 'fa-arrow-up' : (v < 0 ? 'fa-arrow-down' : 'fa-minus')}" aria-hidden="true"></i>${esc(pct(v, 1, true))}</span>${suffix ? ` <span class="vl-muted">${esc(suffix)}</span>` : ''}`;
  }

  // Câu kết luận 1 dòng cho thẻ kết luận. Nói rõ cơ sở (giá hợp lý) và vùng so với kịch bản xấu / tốt.
  function verdictSentence(verdict, fair, price) {
    if (!verdict || verdict.key === 'none') return 'Cần giá hiện tại và ít nhất một mục tiêu P/E hoặc P/B để đưa ra kết luận.';
    const diff = Math.abs(verdict.upsidePct);
    const dir = verdict.upsidePct >= 0 ? `thấp hơn giá hợp lý khoảng ${dec(verdict.marginOfSafetyPct, 0)}%` : `cao hơn giá hợp lý khoảng ${dec(Math.abs((price - fair) / fair * 100), 0)}%`;
    const zone = verdict.zone === 'below-bear' ? ' Giá đang thấp hơn cả kịch bản xấu.' : (verdict.zone === 'above-bull' ? ' Giá đang cao hơn cả kịch bản tốt.' : '');
    return `Giá hiện tại ${dir} (tiềm năng ${verdict.upsidePct >= 0 ? '+' : '−'}${dec(diff, 0)}% để về giá hợp lý).${zone}`;
  }

  // Cảnh báo chất lượng dữ liệu hiển thị cạnh kết quả — để người dùng biết con số dựa trên gì.
  function dataNotes(n, m) {
    const notes = [];
    if (m.basis === 'charter') notes.push('EPS/BVPS suy từ vốn điều lệ (mệnh giá 10.000, không trừ cổ phiếu quỹ). Nhập số cổ phiếu lưu hành để chính xác hơn.');
    if (m.lossMaking) notes.push('Doanh nghiệp đang lỗ: P/E không có nghĩa, giá hợp lý chỉ dựa vào P/B (và DDM nếu có).');
    if (m.roeBasis === 'end') notes.push('ROE tính trên vốn chủ cuối kỳ (chưa có số liệu năm trước để lấy bình quân).');
    if (n.legacy) notes.push('Hồ sơ nhập từ phiên bản cũ — mở Định Giá CP và lưu lại để bổ sung đầy đủ chỉ số.');
    return notes;
  }

  return { esc, isNum, dec, vnd, mult, pct, signedClass, verdictPill, footballHtml, rangeHtml, heroHtml, scenarioTableHtml, metricRow, growthTag, verdictSentence, dataNotes, SECTOR_OPTIONS, NA };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ValuationUI;
