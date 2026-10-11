// Logic thuần: THEO DÕI LUẬN ĐIỂM ĐẦU TƯ. Mỗi ý tưởng đầu tư có vài điều kiện ĐO ĐƯỢC mô tả luận điểm còn đúng hay không (vd "ROE >= 15%", "nợ/vốn <= 1", "giá >= giá cắt lỗ", "phòng khối ngoại >= 5%").
// Máy chủ (insight-sync, chế độ thesis) và trang dùng CHUNG file này (bản sao nguyên văn trong thư mục hàm) nên kết quả hai nơi luôn khớp.
// Ngữ nghĩa: điều kiện là trạng thái PHẢI GIỮ ĐÚNG để luận điểm còn nguyên. state: 'ok' (đang đúng) | 'fail' (đang sai) | 'unknown' (chưa có số liệu). Mức độ: 'critical' (sai = luận điểm bị phá vỡ) | 'watch' (sai = cảnh báo).
//   Luận điểm: 'broken' nếu có điều kiện critical sai; 'warning' nếu chỉ có điều kiện watch sai; 'intact' nếu mọi điều kiện đã biết đều đúng; 'unknown' nếu không điều kiện nào có số liệu; 'none' nếu chưa đặt điều kiện.
// Điều kiện "thủ công" (manual) cho việc không đo tự động được (vd "được cấp phép dự án X"): người dùng tự bật/tắt. Số liệu thiếu KHÔNG bị coi là đúng hay sai: là 'unknown' và được nêu rõ.
// Đơn vị: tỷ lệ phần trăm nhập theo ĐƠN VỊ HIỂN THỊ (ROE 15 nghĩa là 15%); ảnh chụp thị trường lưu dạng phân số (0,15) nên metric có scale = 100.
// KHÔNG đụng DOM/mạng. Nạp bằng thẻ <script> thường (global ThesisCalc) và module.exports cho Vitest.
const ThesisCalc = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  // key trùng tên trường của ảnh chụp thị trường (finance_market_snapshot.metrics) trừ các key tính thêm (nguồn khác)
  const METRICS = [
    { key: 'price', label: 'Giá', unit: 'đ', scale: 1, group: 'Giá' },
    { key: 'upsideToTarget', label: 'Còn bao nhiêu % tới giá mục tiêu', unit: '%', scale: 1, group: 'Giá', derived: true },
    { key: 'chg1m', label: 'Biến động giá 1 tháng', unit: '%', scale: 100, group: 'Giá' },
    { key: 'chg3m', label: 'Biến động giá 3 tháng', unit: '%', scale: 100, group: 'Giá' },
    { key: 'jdkRs', label: 'Sức mạnh giá tương đối (0-100)', unit: '', scale: 1, group: 'Giá' },
    { key: 'pe', label: 'P/E', unit: 'x', scale: 1, group: 'Định giá' },
    { key: 'pb', label: 'P/B', unit: 'x', scale: 1, group: 'Định giá' },
    { key: 'evEbitda', label: 'EV/EBITDA', unit: 'x', scale: 1, group: 'Định giá' },
    { key: 'divYield', label: 'Tỷ suất cổ tức', unit: '%', scale: 100, group: 'Định giá' },
    { key: 'roae', label: 'ROE', unit: '%', scale: 100, group: 'Chất lượng' },
    { key: 'roaa', label: 'ROA', unit: '%', scale: 100, group: 'Chất lượng' },
    { key: 'grossMargin', label: 'Biên lợi nhuận gộp', unit: '%', scale: 100, group: 'Chất lượng' },
    { key: 'netMargin', label: 'Biên lợi nhuận ròng', unit: '%', scale: 100, group: 'Chất lượng' },
    { key: 'netProfitGrowthYoY', label: 'Tăng trưởng lợi nhuận so với cùng kỳ', unit: '%', scale: 100, group: 'Tăng trưởng' },
    { key: 'salesGrowthYoY', label: 'Tăng trưởng doanh thu so với cùng kỳ', unit: '%', scale: 100, group: 'Tăng trưởng' },
    { key: 'epsGrowthYoY', label: 'Tăng trưởng EPS so với cùng kỳ', unit: '%', scale: 100, group: 'Tăng trưởng' },
    { key: 'debtToEquity', label: 'Nợ / vốn chủ', unit: 'x', scale: 1, group: 'Rủi ro' },
    { key: 'interestCoverage', label: 'Khả năng trả lãi', unit: 'x', scale: 1, group: 'Rủi ro' },
    { key: 'advValue20', label: 'Giá trị giao dịch TB 20 phiên', unit: 'tỷ đ', scale: 1e-9, group: 'Thanh khoản' },
    { key: 'foreignRoomLeftPct', label: 'Phòng khối ngoại còn lại', unit: '%', scale: 1, group: 'Sở hữu', source: 'ratios' },
    { key: 'insiderNet90d', label: 'Nội bộ mua ròng 90 ngày (cổ phiếu)', unit: 'cp', scale: 1, group: 'Sở hữu', source: 'insider' },
    // Số sự kiện đếm từ tin đã trích theo mã (lib/news-events.js): chưa có kho tin thì 'unknown', không phải 0
    { key: 'evtAlert30d', label: 'Số tin xấu nghiêm trọng 30 ngày (pháp lý, đình chỉ, giải chấp, nợ)', unit: '', scale: 1, group: 'Tin tức', source: 'events' },
    { key: 'evtAlert90d', label: 'Số tin xấu nghiêm trọng 90 ngày', unit: '', scale: 1, group: 'Tin tức', source: 'events' },
    { key: 'evtMgmt90d', label: 'Số tin đổi nhân sự cấp cao 90 ngày', unit: '', scale: 1, group: 'Tin tức', source: 'events' },
    { key: 'manual', label: 'Sự kiện tự xác nhận', unit: '', scale: 1, group: 'Khác', manual: true },
  ];
  const BY_KEY = {}; METRICS.forEach((m) => { BY_KEY[m.key] = m; });
  const OPS = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b };
  const OP_LABEL = { '>=': '≥', '<=': '≤', '>': '>', '<': '<' };

  // Giá trị (đơn vị hiển thị) của metric cho một mã. ctx: { metrics: {ảnh chụp}, price, targetPrice, foreignRoomLeftPct, insiderNet90d }. null nếu thiếu.
  function valueOf(key, ctx) {
    const c = ctx || {}, m = BY_KEY[key];
    if (!m || m.manual) return null;
    let raw = null;
    if (key === 'price') raw = num(c.price);
    else if (key === 'upsideToTarget') { const p = num(c.price), t = num(c.targetPrice); raw = p > 0 && t > 0 ? (t / p - 1) * 100 : null; }
    else if (key === 'foreignRoomLeftPct') raw = num(c.foreignRoomLeftPct);
    else if (key === 'insiderNet90d') raw = num(c.insiderNet90d);
    else if (key === 'evtAlert30d' || key === 'evtAlert90d' || key === 'evtMgmt90d') raw = num(c[key]);
    else raw = c.metrics ? num(c.metrics[key]) : null;
    return raw === null ? null : raw * m.scale;
  }

  // Kiểm tra một điều kiện. cond: { metric, op, threshold, severity, manualMet }. Trả { state, value }.
  function evaluate(cond, ctx) {
    const m = BY_KEY[cond && cond.metric];
    if (!m) return { state: 'unknown', value: null, reason: 'Chỉ tiêu không hợp lệ' };
    if (m.manual) {
      const v = cond.manualMet;
      return { state: v === true ? 'ok' : (v === false ? 'fail' : 'unknown'), value: null, reason: v === null || v === undefined ? 'Chưa xác nhận' : null };
    }
    const f = OPS[cond.op], th = num(cond.threshold);
    if (!f || th === null) return { state: 'unknown', value: null, reason: 'Điều kiện chưa đầy đủ' };
    const v = valueOf(cond.metric, ctx);
    if (v === null) return { state: 'unknown', value: null, reason: 'Chưa có số liệu' };
    return { state: f(v, th) ? 'ok' : 'fail', value: v, reason: null };
  }

  // Đánh giá cả luận điểm. conds: [{id, metric, op, threshold, severity, label, manualMet}]. Trả { status, conditions: [{...cond, state, value}], counts, score }
  function evaluateIdea(conds, ctx) {
    const list = (conds || []).map((c) => Object.assign({}, c, evaluate(c, ctx)));
    const counts = { ok: 0, fail: 0, unknown: 0, criticalFail: 0, watchFail: 0 };
    list.forEach((c) => { counts[c.state]++; if (c.state === 'fail') counts[c.severity === 'critical' ? 'criticalFail' : 'watchFail']++; });
    let status = 'none';
    if (list.length) status = counts.criticalFail ? 'broken' : (counts.watchFail ? 'warning' : (counts.ok ? 'intact' : 'unknown'));
    const known = counts.ok + counts.fail;
    return { status: status, conditions: list, counts: counts, score: known ? counts.ok / known : null };
  }

  const STATUS = {
    broken: { label: 'Bị phá vỡ', tone: 'bad', order: 0 }, warning: { label: 'Cần chú ý', tone: 'warn', order: 1 }, unknown: { label: 'Chưa đủ số liệu', tone: 'muted', order: 2 },
    intact: { label: 'Còn nguyên', tone: 'good', order: 3 }, none: { label: 'Chưa đặt điều kiện', tone: 'muted', order: 4 },
  };

  // Mô tả điều kiện bằng chữ: "ROE ≥ 15%"; có ghi chú thì "ghi chú (ROE ≥ 15%)"
  function describe(c) {
    const m = BY_KEY[c.metric];
    if (!m) return String(c.label || c.metric || '');
    if (m.manual) return c.label || 'Sự kiện tự xác nhận';
    const th = num(c.threshold);
    const fmt = (v) => (v === null ? '?' : (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('vi-VN') : String(Math.round(v * 100) / 100).replace('.', ',')));
    const base = m.label + ' ' + (OP_LABEL[c.op] || c.op) + ' ' + fmt(th) + (m.unit ? (m.unit === '%' || m.unit === 'x' ? m.unit : ' ' + m.unit) : '');
    return c.label && c.label.trim() ? c.label.trim() + ' (' + base + ')' : base;
  }

  // Thay đổi trạng thái giữa hai lần kiểm (cùng id). prev: [{id, state}] hoặc map id->state. Trả [{id, from, to, cond}] chỉ cho điều kiện đổi trạng thái giữa ok/fail (unknown không tính là chuyển).
  function transitions(prev, next) {
    const pm = {};
    if (Array.isArray(prev)) prev.forEach((p) => { pm[p.id] = p.state; }); else Object.assign(pm, prev || {});
    const out = [];
    (next || []).forEach((c) => {
      const from = pm[c.id] || 'unknown';
      if (c.state !== 'unknown' && from !== c.state) out.push({ id: c.id, from: from, to: c.state, cond: c });
    });
    return out;
  }

  // Gợi ý điều kiện từ ý tưởng và số liệu hiện tại để người dùng khỏi bắt đầu từ trang trắng. Các ngưỡng quanh GIÁ TRỊ HIỆN TẠI (có biên an toàn) -- người dùng nên chỉnh theo luận điểm riêng.
  function suggest(idea, ctx) {
    const out = [], i = idea || {}, c = ctx || {};
    const has = (k) => valueOf(k, c) !== null;
    const round = (v, d) => { const p = Math.pow(10, d === undefined ? 1 : d); return Math.round(v * p) / p; };
    if (num(i.stop) > 0 || num(i.stop_price) > 0) out.push({ metric: 'price', op: '>=', threshold: num(i.stop) || num(i.stop_price), severity: 'critical', label: 'Giá không thủng mức cắt lỗ' });
    if (num(i.target) > 0 || num(i.target_price) > 0) out.push({ metric: 'upsideToTarget', op: '>=', threshold: 10, severity: 'watch', label: 'Còn ít nhất 10% tới giá mục tiêu' });
    if (has('roae')) { const v = valueOf('roae', c); out.push({ metric: 'roae', op: '>=', threshold: round(Math.max(0, v * 0.8), 1), severity: 'watch', label: 'ROE không giảm quá 20% so với hiện tại' }); }
    if (has('netProfitGrowthYoY')) out.push({ metric: 'netProfitGrowthYoY', op: '>=', threshold: 0, severity: 'watch', label: 'Lợi nhuận không giảm so với cùng kỳ' });
    if (has('debtToEquity')) { const v = valueOf('debtToEquity', c); out.push({ metric: 'debtToEquity', op: '<=', threshold: round(Math.max(0.5, v * 1.3), 2), severity: 'critical', label: 'Nợ / vốn không tăng quá 30% so với hiện tại' }); }
    if (has('foreignRoomLeftPct')) out.push({ metric: 'foreignRoomLeftPct', op: '>=', threshold: 2, severity: 'watch', label: 'Phòng khối ngoại không cạn' });
    if (has('evtAlert30d')) out.push({ metric: 'evtAlert30d', op: '<=', threshold: 0, severity: 'critical', label: 'Không có tin xấu nghiêm trọng trong 30 ngày' });
    return out;
  }

  // Chuẩn hoá điều kiện nhập từ form; trả { ok, cond, error }
  function validate(raw) {
    const r = raw || {}, m = BY_KEY[r.metric];
    if (!m) return { ok: false, error: 'Chọn chỉ tiêu.' };
    const severity = r.severity === 'critical' ? 'critical' : 'watch';
    const label = String(r.label || '').trim().slice(0, 120);
    if (m.manual) { if (label.length < 3) return { ok: false, error: 'Mô tả sự kiện cần ít nhất 3 ký tự.' }; return { ok: true, cond: { metric: 'manual', op: '>=', threshold: null, severity: severity, label: label, manualMet: r.manualMet === true ? true : (r.manualMet === false ? false : null) } }; }
    if (!OPS[r.op]) return { ok: false, error: 'Chọn phép so sánh.' };
    const th = num(r.threshold);
    if (th === null) return { ok: false, error: 'Nhập ngưỡng là một số.' };
    return { ok: true, cond: { metric: m.key, op: r.op, threshold: th, severity: severity, label: label, manualMet: null } };
  }

  return { METRICS, BY_KEY, OPS: Object.keys(OPS), OP_LABEL, STATUS, valueOf, evaluate, evaluateIdea, describe, transitions, suggest, validate };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ThesisCalc;
globalThis.ThesisCalc = ThesisCalc;
