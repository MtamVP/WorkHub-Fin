// Logic thuần: DUYỆT LỆNH LỚN TRƯỚC KHI ĐẶT -- quy trình hội đồng đầu tư thu nhỏ. Lệnh có giá trị từ một ngưỡng (% NAV và/hoặc số tiền tuyệt đối) phải được quản lý duyệt
// trước khi ghi vào sổ; người duyệt phải là người KHÁC người đề xuất (nguyên tắc hai người, "maker-checker"); đề xuất được duyệt có hạn dùng ngắn và chỉ khớp đúng lệnh đã duyệt.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global ApprovalCalc) và module.exports cho Vitest. Quy tắc này lặp lại ở trigger DB của finance_order_requests
// (finance-approval-migration.sql) để không lách được bằng gọi API trực tiếp việc DUYỆT; việc GHI lệnh có cần đề xuất hay không do api.js (addTransaction) kiểm.
const ApprovalCalc = (function () {
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const iso = (v) => String(v || '').slice(0, 10);
  const addDays = (d, n) => new Date(Date.parse(iso(d) + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const PRICE_TOLERANCE = 0.05;     // lệnh thực tế được lệch giá trị tới +5% so với đề xuất đã duyệt (giá nhích nhẹ, phí...)
  const SELF_APPROVE_MIN_NOTE = 10; // admin tự duyệt lệnh của chính mình phải ghi lý do tối thiểu từng này ký tự

  const STATUS = {
    pending: { label: 'Chờ duyệt', tone: 'warn' }, approved: { label: 'Đã duyệt', tone: 'ok' }, rejected: { label: 'Bị từ chối', tone: 'bad' },
    executed: { label: 'Đã thực hiện', tone: 'mute' }, cancelled: { label: 'Đã huỷ', tone: 'mute' }, expired: { label: 'Hết hạn', tone: 'mute' },
  };

  // Dòng DB -> dạng chuẩn
  function normalizePolicy(row) {
    const r = row || {};
    return { active: !!r.active, thresholdPct: r.threshold_pct === null || r.threshold_pct === undefined ? (r.thresholdPct === undefined ? null : r.thresholdPct) : num(r.threshold_pct),
      thresholdVnd: r.threshold_vnd === null || r.threshold_vnd === undefined ? (r.thresholdVnd === undefined ? null : r.thresholdVnd) : num(r.threshold_vnd), validDays: num(r.valid_days || r.validDays) || 3 };
  }

  function validatePolicy(input) {
    const p = normalizePolicy(input);
    const pct = p.thresholdPct === null || p.thresholdPct === '' ? null : Number(p.thresholdPct), vnd = p.thresholdVnd === null || p.thresholdVnd === '' ? null : Number(p.thresholdVnd);
    if (pct !== null && !(pct > 0 && pct <= 100)) return { ok: false, error: 'Ngưỡng % NAV phải lớn hơn 0 và không quá 100' };
    if (vnd !== null && !(vnd > 0)) return { ok: false, error: 'Ngưỡng số tiền phải lớn hơn 0' };
    if (p.active && pct === null && vnd === null) return { ok: false, error: 'Bật duyệt lệnh thì cần ít nhất một ngưỡng (% NAV hoặc số tiền)' };
    if (!(p.validDays >= 1 && p.validDays <= 30)) return { ok: false, error: 'Hạn dùng của đề xuất đã duyệt từ 1 đến 30 ngày' };
    return { ok: true, policy: { active: p.active, thresholdPct: pct, thresholdVnd: vnd, validDays: Math.round(p.validDays) } };
  }

  // Lệnh có cần duyệt không? trade: { quantity, price }. Trả { needed, value, pct, byPct, byVnd }.
  function needsApproval(policy, nav, trade) {
    const p = normalizePolicy(policy), value = num(trade && trade.quantity) * num(trade && trade.price);
    const pct = num(nav) > 0 ? value / num(nav) * 100 : null;
    const byPct = p.thresholdPct > 0 && pct !== null && pct > p.thresholdPct + 1e-9;
    const byVnd = p.thresholdVnd > 0 && value > p.thresholdVnd + 1e-9;
    return { needed: p.active && value > 0 && (byPct || byVnd), value: value, pct: pct, byPct: !!(p.active && byPct), byVnd: !!(p.active && byVnd) };
  }

  // Trạng thái hiệu lực: đề xuất đã duyệt quá hạn coi như hết hạn
  function effectiveStatus(req, today) {
    const r = req || {};
    if (r.status === 'approved' && r.valid_until && iso(r.valid_until) < iso(today)) return 'expired';
    return r.status || 'pending';
  }

  // Tìm đề xuất đã duyệt, còn hạn, của đúng người, mã, chiều và đủ chỗ cho lệnh này. trade: { symbol, type, quantity, price }.
  // Chọn đề xuất được duyệt sớm nhất còn hạn để dùng lần lượt (cũ trước).
  function matchApproval(requests, userId, trade, today) {
    const sym = String((trade && trade.symbol) || '').toUpperCase(), side = trade && trade.type === 'sell' ? 'sell' : 'buy';
    const qty = num(trade && trade.quantity), value = qty * num(trade && trade.price);
    const ok = (requests || []).filter(function (r) {
      return r.user_id === userId && effectiveStatus(r, today) === 'approved' && String(r.symbol).toUpperCase() === sym && r.side === side
        && qty > 0 && qty <= num(r.quantity) + 1e-9 && value <= num(r.value) * (1 + PRICE_TOLERANCE) + 1e-9;
    }).sort(function (a, b) { return String(a.decided_at || a.created_at) < String(b.decided_at || b.created_at) ? -1 : 1; });
    return ok[0] || null;
  }

  // Ai được duyệt/từ chối? actor: { isManager, isAdmin, actorId }. req: dòng đề xuất. decision: 'approved' | 'rejected'. note: ghi chú của người duyệt.
  function canDecide(actor, req, decision, note) {
    const a = actor || {}, r = req || {};
    if (!a.isManager) return { allowed: false, reason: 'Chỉ quản lý danh mục hoặc admin được duyệt lệnh.' };
    if (r.status !== 'pending') return { allowed: false, reason: 'Đề xuất này không còn ở trạng thái chờ duyệt.' };
    const text = String(note || '').trim();
    if (decision === 'rejected' && text.length < 3) return { allowed: false, reason: 'Từ chối cần ghi lý do.' };
    // "Của chính mình" gồm cả đề xuất do mình nhập hộ người khác (created_by), không chỉ danh mục của mình
    const own = !!(a.actorId && ((r.user_id && r.user_id === a.actorId) || (r.created_by && r.created_by === a.actorId)));
    if (own) {
      if (!a.isAdmin) return { allowed: false, reason: 'Không được tự duyệt lệnh của chính mình (nguyên tắc hai người). Nhờ một quản lý khác duyệt.' };
      if (decision === 'approved' && text.length < SELF_APPROVE_MIN_NOTE) return { allowed: false, reason: 'Admin tự duyệt lệnh của mình phải ghi lý do (tối thiểu ' + SELF_APPROVE_MIN_NOTE + ' ký tự).' };
    }
    return { allowed: true, selfApproval: own };
  }

  // Dựng bản ghi đề xuất mới. input: { symbol, side, quantity, price, reason }; ctx: { nav, today, validDays }
  function buildRequest(input, ctx) {
    const i = input || {}, c = ctx || {};
    const symbol = String(i.symbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(symbol)) return { ok: false, error: 'Mã không hợp lệ' };
    const side = i.side === 'sell' ? 'sell' : (i.side === 'buy' ? 'buy' : null);
    if (!side) return { ok: false, error: 'Chọn mua hoặc bán' };
    const quantity = num(i.quantity), price = num(i.price);
    if (!(quantity > 0) || !(price > 0)) return { ok: false, error: 'Khối lượng và giá phải lớn hơn 0' };
    const reason = String(i.reason || '').trim();
    if (reason.length < 10) return { ok: false, error: 'Ghi lý do đề xuất (ít nhất 10 ký tự) để quản lý có căn cứ duyệt' };
    const value = quantity * price;
    return { ok: true, row: { symbol: symbol, side: side, quantity: quantity, price_ref: price, value: value, nav_at_request: num(c.nav) || null, order_pct: num(c.nav) > 0 ? value / num(c.nav) * 100 : null, reason: reason.slice(0, 1000), status: 'pending' } };
  }

  // Hạn dùng khi duyệt: hôm nay + validDays (ngày lịch)
  function validUntil(today, validDays) { return addDays(today, Math.max(1, Math.min(30, Math.round(num(validDays) || 3)))); }

  function summarize(requests, today) {
    const s = { pending: 0, approved: 0, rejected: 0, executed: 0, cancelled: 0, expired: 0, total: 0 };
    (requests || []).forEach(function (r) { const k = effectiveStatus(r, today); if (s[k] !== undefined) s[k]++; s.total++; });
    return s;
  }

  return { STATUS, PRICE_TOLERANCE, SELF_APPROVE_MIN_NOTE, normalizePolicy, validatePolicy, needsApproval, effectiveStatus, matchApproval, canDecide, buildRequest, validUntil, summarize };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ApprovalCalc;
