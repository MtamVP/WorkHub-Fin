/* --- FILE: /stocksheet/vb-card.js ---
   Cầu nối Valuation Bench -> Investment Workbench: dựng thẻ "Định giá chuyên môn" (Chi tiết mã) và huy hiệu nhỏ (Danh Mục)
   từ bản định giá MỚI NHẤT đã lưu ở Valuation Bench (finance_vb_valuations). Hàm thuần, có kiểm thử; chỉ dựng chuỗi HTML.
   Mọi chuỗi chèn vào HTML đều qua esc(). Không tự tính lại giá trị hợp lý: chỉ đọc bản đã lưu và so với giá hiện tại. */
const VBCard = (function () {
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = (v) => v !== null && v !== undefined && v !== '' && isFinite(Number(v));
  const vnd = (v) => (isNum(v) ? Math.round(Number(v)).toLocaleString('vi-VN') : '—');
  const dec = (v, d) => (isNum(v) ? Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: d === undefined ? 1 : d }) : '—');
  const STALE_DAYS = 45;

  function daysBetween(asOf, now) {
    const a = Date.parse(String(asOf || '').slice(0, 10)), b = (now instanceof Date ? now : new Date(now || Date.now())).getTime();
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.max(0, Math.floor((b - a) / 86400000));
  }

  // Biên an toàn theo GIÁ HIỆN TẠI (không phải giá lúc lưu): (giá trị hợp lý - giá) / giá trị hợp lý
  function marginNow(rec, livePrice) {
    const base = Number(rec && rec.fair_base), p = isNum(livePrice) && Number(livePrice) > 0 ? Number(livePrice) : Number(rec && rec.price);
    if (!isFinite(base) || base <= 0 || !isFinite(p) || p <= 0) return null;
    return (base - p) / base;
  }

  // Giá hiện tại nằm ở đâu so với các vùng đã lưu: 'accumulate' | 'fair' | 'above' | 'below-invalidation' | null
  function zoneNow(rec, livePrice) {
    const p = isNum(livePrice) && Number(livePrice) > 0 ? Number(livePrice) : Number(rec && rec.price);
    if (!rec || !isFinite(p) || p <= 0) return null;
    if (isNum(rec.invalidation) && p < Number(rec.invalidation)) return { key: 'below-invalidation', label: 'Thủng mức vô hiệu hoá', cls: 'warn' };
    if (isNum(rec.accumulate_high) && p <= Number(rec.accumulate_high)) return { key: 'accumulate', label: 'Trong vùng tích luỹ', cls: 'ok' };
    if (isNum(rec.fair_high) && p > Number(rec.fair_high)) return { key: 'above', label: 'Trên vùng hợp lý', cls: 'warn' };
    if (isNum(rec.fair_low) && p >= Number(rec.fair_low)) return { key: 'fair', label: 'Trong vùng hợp lý', cls: 'info' };
    return { key: 'between', label: 'Dưới vùng hợp lý', cls: 'ok' };
  }

  function view(rec, livePrice, now) {
    if (!rec) return null;
    const age = daysBetween(rec.as_of || rec.created_at, now);
    return { symbol: rec.symbol, margin: marginNow(rec, livePrice), zone: zoneNow(rec, livePrice), age: age, stale: age !== null && age > STALE_DAYS, usedLive: isNum(livePrice) && Number(livePrice) > 0 };
  }

  function pctTxt(m) { return m === null ? '—' : (m > 0 ? '+' : (m < 0 ? '−' : '')) + dec(Math.abs(m) * 100, 1) + '%'; }
  function vbHref(symbol) { return '/valuation/#stock/' + encodeURIComponent(symbol); }

  // Huy hiệu nhỏ cho dòng Danh Mục / bảng so sánh
  function badge(rec, livePrice, now) {
    const v = view(rec, livePrice, now);
    if (!v) return '';
    const tone = v.margin === null ? 'mute' : (v.margin >= 0.15 ? 'ok' : (v.margin < 0 ? 'warn' : 'info'));
    const title = 'Định giá chuyên môn (Valuation Bench): hợp lý ' + vnd(rec.fair_base) + ' (' + vnd(rec.fair_low) + ' – ' + vnd(rec.fair_high) + ')'
      + (v.age !== null ? ', lưu ' + v.age + ' ngày trước' : '') + (v.stale ? ' — đã cũ, nên làm mới' : '') + '. ' + (rec.stance || '');
    return '<a class="vbc-badge vbc-' + tone + (v.stale ? ' stale' : '') + '" href="' + vbHref(rec.symbol) + '" title="' + esc(title) + '">'
      + '<i class="fa-solid fa-scale-balanced" aria-hidden="true"></i> ' + esc(vnd(rec.fair_base)) + ' <b>' + esc(pctTxt(v.margin)) + '</b></a>';
  }

  // Thẻ đầy đủ cho "Chi tiết mã". opts.loading / opts.error / opts.canOpen
  function html(rec, livePrice, now, opts) {
    const o = opts || {};
    const head = (sub) => '<h3 class="vl-card-title"><i class="fa-solid fa-scale-balanced"></i> Định giá chuyên môn<span class="vl-muted">' + sub + '</span></h3>';
    if (o.loading) return '<div class="vl-card vbc-card">' + head('Valuation Bench') + '<div class="vl-empty"><i class="fa-solid fa-spinner fa-spin"></i> Đang lấy bản định giá đã lưu…</div></div>';
    if (o.error) return '<div class="vl-card vbc-card">' + head('Valuation Bench') + '<div class="vl-note"><i class="fa-solid fa-triangle-exclamation"></i><span>Không đọc được bản định giá: ' + esc(o.error) + '</span></div></div>';
    const sym = esc(o.symbol || (rec && rec.symbol) || '');
    if (!rec) return '<div class="vl-card vbc-card">' + head('Valuation Bench') + '<div class="vl-empty">Chưa có định giá chuyên môn cho mã này.</div>'
      + '<div class="vl-apply-actions"><a class="btn-refresh" href="' + vbHref(o.symbol || '') + '"><i class="fa-solid fa-magnifying-glass-chart"></i> Mở ' + sym + ' trong Valuation Bench</a></div></div>';
    const v = view(rec, livePrice, now);
    const mTone = v.margin === null ? '' : (v.margin >= 0 ? 'vbc-up' : 'vbc-down');
    const sub = esc(rec.as_of || '') + (rec.author ? ' · ' + esc(rec.author) : '') + (v.stale ? ' · đã cũ ' + v.age + ' ngày' : '');
    const kv = (k, val, extra) => '<div class="vbc-kv"><span class="vbc-k">' + k + '</span><span class="vbc-v ' + (extra || '') + '">' + val + '</span></div>';
    const reasons = (rec.summary && Array.isArray(rec.summary.reasons) ? rec.summary.reasons : []).slice(0, 3);
    const flags = (rec.summary && Array.isArray(rec.summary.flags) ? rec.summary.flags : []).slice(0, 3);
    return '<div class="vl-card vbc-card">' + head(sub)
      + '<div class="vbc-top"><div class="vbc-main"><span class="vbc-fair">' + vnd(rec.fair_base) + '</span><span class="vbc-range">' + vnd(rec.fair_low) + ' – ' + vnd(rec.fair_high) + '</span></div>'
      + '<div class="vbc-pills">' + (rec.grade ? '<span class="vbc-pill info" title="Đánh giá tại thời điểm lưu bản định giá">Lúc lưu: ' + esc(rec.grade) + '</span>' : '') + (v.zone ? '<span class="vbc-pill ' + v.zone.cls + '">' + esc(v.zone.label) + '</span>' : '')
      + (rec.confidence ? '<span class="vbc-pill mute">Tin cậy ' + esc(rec.confidence) + '</span>' : '') + '</div></div>'
      + '<div class="vbc-grid">'
      + kv('Biên an toàn theo giá hiện tại', esc(pctTxt(v.margin)), mTone)
      + kv('Vùng tích luỹ', vnd(rec.accumulate_low) + ' – ' + vnd(rec.accumulate_high))
      + kv('Mức vô hiệu hoá', vnd(rec.invalidation))
      + kv('Kỹ thuật', esc(rec.tech_rating || '—') + (isNum(rec.tech_score) ? ' (' + (rec.tech_score > 0 ? '+' : '') + dec(rec.tech_score, 0) + ')' : ''))
      + kv('Thị trường', isNum(rec.market_score) ? (rec.market_score > 0 ? '+' : '') + dec(rec.market_score, 0) : '—')
      + kv('Điểm tổng hợp', isNum(rec.composite) ? dec(rec.composite, 0) : '—')
      + '</div>'
      + (rec.stance ? '<div class="vbc-stance"><b>' + esc(rec.stance) + '</b>' + (rec.timing ? ' · <span class="vl-muted">' + esc(rec.timing) + '</span>' : '') + '</div>' : '')
      + (reasons.length ? '<ul class="vbc-list">' + reasons.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>' : '')
      + (flags.length ? '<ul class="vbc-list warn">' + flags.map((t) => '<li><i class="fa-solid fa-flag"></i> ' + esc(t) + '</li>').join('') + '</ul>' : '')
      + (v.stale ? '<div class="vl-note"><i class="fa-solid fa-clock"></i><span>Bản này đã lưu hơn ' + STALE_DAYS + ' ngày — số liệu và vùng giá có thể lệch. Mở Valuation Bench để định giá lại.</span></div>' : '')
      + (rec.note ? '<div class="vl-note"><i class="fa-solid fa-note-sticky"></i><span>' + esc(rec.note) + '</span></div>' : '')
      + '<div class="vl-apply-actions"><a class="btn-refresh" href="' + vbHref(rec.symbol) + '"><i class="fa-solid fa-magnifying-glass-chart"></i> Mở hồ sơ ' + esc(rec.symbol) + ' trong Valuation Bench</a></div>'
      + '</div>';
  }

  return { html, badge, view, marginNow, zoneNow, STALE_DAYS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VBCard;
