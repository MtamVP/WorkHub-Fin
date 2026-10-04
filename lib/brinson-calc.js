// Logic thuần: phân tích Brinson-Fachler -- tách chênh lệch giữa lợi suất danh mục và DANH MỤC CHUẨN CHIẾN LƯỢC của nhóm thành 3 phần theo từng ngành:
//   Phân bổ  = (tỷ trọng thực − tỷ trọng chuẩn) × (lợi suất ngành chuẩn − lợi suất chuẩn tổng): nắm nhiều/ít ngành đúng hay sai lúc.
//   Chọn mã  = tỷ trọng chuẩn × (lợi suất ngành của danh mục − lợi suất ngành chuẩn): trong ngành, chọn mã giỏi hay kém chỉ số ngành.
//   Tương tác = (tỷ trọng thực − tỷ trọng chuẩn) × (lợi suất ngành của danh mục − lợi suất ngành chuẩn): phần chung của hai quyết định trên.
// Tổng ba phần của mọi ngành (cộng tiền mặt) = lợi suất danh mục − lợi suất chuẩn (đúng từng điểm phần trăm). KHÔNG đụng DOM/mạng/Supabase.
// Nạp bằng thẻ <script> thường (global BrinsonCalc) và module.exports cho Vitest. Cần FinCalc (lib/finance-calc.js) nạp trước khi gọi sectorReturns.
//
// Dữ liệu vào lấy từ AttributionCalc.analyze (lib/attribution-calc.js): lãi/lỗ và vốn bình quân đang dùng của từng ngành trong kỳ, mẫu số `base` (NAV đầu kỳ + ½ vốn nạp ròng).
//   tỷ trọng thực của ngành = vốn bình quân trong ngành ÷ base; lợi suất ngành của danh mục = lãi/lỗ ngành ÷ vốn bình quân trong ngành
//   => tỷ trọng × lợi suất = đóng góp của ngành, khớp đúng bảng Nguồn gốc lợi nhuận. Tiền mặt = phần còn lại, lợi suất 0 (cả hai bên).
// Lợi suất ngành của chuẩn = lợi suất GIÁ của chỉ số ngành HOSE tương ứng (VNFIN, VNREAL...) trong kỳ; ngành chưa có chỉ số riêng dùng VN-Index.
// Giới hạn cần biết: dùng tỷ trọng chuẩn HIỆN TẠI cho cả kỳ (đổi chuẩn giữa kỳ sẽ làm kết quả cũ không còn đúng nghĩa); lợi suất theo giá, chưa gồm cổ tức của chỉ số.
const BrinsonCalc = (function () {
  const FC = (typeof require === 'function' && typeof module !== 'undefined') ? require('./finance-calc.js') : (typeof FinCalc !== 'undefined' ? FinCalc : null);
  const EPS = 1e-9;
  const CASH = 'Tiền mặt';
  const FALLBACK_INDEX = 'VNINDEX';

  // Ngành nội bộ (FinCalc) -> chỉ số ngành của HOSE
  const SECTOR_INDEX = {
    'Ngân hàng': 'VNFIN', 'Chứng khoán': 'VNFIN', 'Bảo hiểm': 'VNFIN',
    'Bất động sản': 'VNREAL',
    'Thép & vật liệu': 'VNMAT', 'Hóa chất & phân bón': 'VNMAT', 'Cao su & nhựa': 'VNMAT',
    'Công nghệ': 'VNIT', 'Y tế & dược': 'VNHEAL',
    'Bán lẻ': 'VNCOND', 'Dệt may': 'VNCOND', 'Thực phẩm & đồ uống': 'VNCONS',
    'Dầu khí & năng lượng': 'VNENE', 'Xây dựng & hạ tầng': 'VNIND', 'Vận tải & logistics': 'VNIND', 'Điện & tiện ích': 'VNUTI',
    // ngành thêm theo phân loại ICB (lib/sector-map.js) cho mã ngoài bảng tự gõ
    'Công nghiệp & dịch vụ': 'VNIND', 'Ô tô & phụ tùng': 'VNCOND', 'Hàng cá nhân & gia dụng': 'VNCOND', 'Truyền thông': 'VNCOND', 'Du lịch & giải trí': 'VNCOND',
  };
  const SECTORS_WITHOUT_INDEX = ['Viễn thông'];       // chưa có chỉ số ngành HOSE riêng: dùng VN-Index
  const SECTOR_INDEX_CODES = Array.from(new Set(Object.keys(SECTOR_INDEX).map(function (k) { return SECTOR_INDEX[k]; })));

  const num = function (v) { const n = Number(v); return isFinite(n) ? n : 0; };
  const iso = function (v) { return String(v || '').slice(0, 10); };
  function indexFor(sector) { return SECTOR_INDEX[sector] || FALLBACK_INDEX; }
  function allSectors() { return Object.keys(SECTOR_INDEX).concat(SECTORS_WITHOUT_INDEX); }

  function valueAtOrBefore(series, d) {
    let lo = 0, hi = series.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid][0] <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans === -1 ? null : num(series[ans][1]);
  }

  // Lợi suất giá (%) của chỉ số ngành tương ứng từng ngành giữa (from, to]. histories: { VNFIN: [[ngày, điểm]], VNINDEX... }.
  // Trả { [ngành]: { index, returnPct } } -- returnPct null nếu thiếu dữ liệu chỉ số.
  function sectorReturns(histories, sectors, from, to) {
    const out = {}, cache = {};
    (sectors || []).forEach(function (s) {
      const code = indexFor(s);
      if (!(code in cache)) {
        const raw = (histories && histories[code]) || [];
        const series = raw.map(function (p) { return [iso(p[0]), num(p[1])]; }).filter(function (p) { return p[1] > 0; }).sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
        const a = valueAtOrBefore(series, iso(from)), b = valueAtOrBefore(series, iso(to));
        cache[code] = a > 0 && b > 0 ? (b / a - 1) * 100 : null;
      }
      out[s] = { index: code, returnPct: cache[code] };
    });
    return out;
  }

  // Kiểm tra bộ tỷ trọng chuẩn { ngành: % }: mỗi ngành 0-100, tổng không vượt 100; phần còn lại là tiền mặt.
  function validatePolicy(weights) {
    const w = {};
    let sum = 0;
    const known = allSectors().concat(['Chưa phân ngành']);
    for (const k of Object.keys(weights || {})) {
      const v = Number(weights[k]);
      if (!(v >= 0 && v <= 100)) return { ok: false, error: 'Tỷ trọng của "' + k + '" phải từ 0 đến 100%' };
      if (known.indexOf(k) === -1) return { ok: false, error: 'Ngành không hợp lệ: ' + k };
      if (v > 0) { w[k] = v; sum += v; }
    }
    if (sum > 100.0001) return { ok: false, error: 'Tổng tỷ trọng các ngành là ' + (Math.round(sum * 10) / 10) + '%, không được vượt 100% (phần còn lại là tiền mặt)' };
    return { ok: true, weights: w, sum: sum, cashPct: Math.max(0, 100 - sum) };
  }

  // input: { attribution: kết quả AttributionCalc.analyze, policy: { ngành: % }, returns: kết quả sectorReturns }
  function analyze(input) {
    const o = input || {}, a = o.attribution;
    const out = { ok: false, reason: null };
    if (!a || !(a.base > 0)) { out.reason = 'noBase'; return out; }
    if (!a.hasBench) { out.reason = 'noBench'; return out; }
    const v = validatePolicy(o.policy || {});
    if (!v.ok || !Object.keys(v.weights).length) { out.reason = !v.ok ? 'badPolicy' : 'noPolicy'; out.error = v.error || null; return out; }
    const base = a.base, ret = o.returns || {};
    const sec = {};
    (a.sectors || []).forEach(function (s) { sec[s.sector] = s; });
    const names = Array.from(new Set(Object.keys(sec).concat(Object.keys(v.weights))));
    let residual = 0, missingIndex = [];
    const rows = names.map(function (name) {
      const s = sec[name] || null;
      const wp = s && s.avgMv > EPS ? s.avgMv / base : 0;
      const rp = s && s.avgMv > EPS ? s.pnl / s.avgMv : null;
      if (s && !(s.avgMv > EPS)) residual += s.pnl / base;          // lãi/lỗ phát sinh khi vốn bình quân ~ 0 (mua rồi bán trong cùng khoảng giữa hai phiên): không gán được tỷ trọng
      const wb = (v.weights[name] || 0) / 100;
      const r = ret[name] || { index: indexFor(name), returnPct: null };
      let rb = r.returnPct === null || r.returnPct === undefined ? null : r.returnPct / 100;
      if (rb === null && missingIndex.indexOf(r.index) === -1) missingIndex.push(r.index);
      return { sector: name, index: r.index, wp: wp, wb: wb, rp: rp, rb: rb, held: !!s };
    });
    // Ngành thiếu chỉ số: coi lợi suất chuẩn của ngành bằng lợi suất của chính danh mục ở ngành đó (nên phần chọn mã = 0), hoặc 0 nếu không giữ -- vẫn giữ đúng đẳng thức tổng
    rows.forEach(function (r) { if (r.rb === null) { r.rb = r.rp !== null ? r.rp : 0; r.noIndex = true; } });
    const wpCash = 1 - rows.reduce(function (s, r) { return s + r.wp; }, 0), wbCash = 1 - rows.reduce(function (s, r) { return s + r.wb; }, 0);
    rows.push({ sector: CASH, index: null, wp: wpCash, wb: wbCash, rp: 0, rb: 0, held: true, isCash: true });
    const Rp = rows.reduce(function (s, r) { return s + r.wp * (r.rp === null ? 0 : r.rp); }, 0);
    const Rb = rows.reduce(function (s, r) { return s + r.wb * r.rb; }, 0);
    rows.forEach(function (r) {
      const rp = r.rp === null ? r.rb : r.rp;                      // không giữ ngành: coi như bằng chuẩn (không có phần chọn mã/tương tác)
      r.allocation = (r.wp - r.wb) * (r.rb - Rb) * 100;
      r.selection = r.noIndex ? 0 : r.wb * (rp - r.rb) * 100;
      r.interaction = r.noIndex ? 0 : (r.wp - r.wb) * (rp - r.rb) * 100;
      r.total = r.allocation + r.selection + r.interaction;
      ['wp', 'wb'].forEach(function (k) { r[k + 'Pct'] = r[k] * 100; });
      r.rpPct = r.rp === null ? null : r.rp * 100; r.rbPct = r.rb * 100;
    });
    const sum = function (k) { return rows.reduce(function (s, r) { return s + r[k]; }, 0); };
    const active = (Rp - Rb) * 100;
    const res = {
      ok: true, from: a.from, to: a.to, rows: rows.sort(function (x, y) { return Math.abs(y.total) - Math.abs(x.total) || (x.sector < y.sector ? -1 : 1); }),
      portfolioPct: Rp * 100, benchmarkPct: Rb * 100, activePct: active,
      allocation: sum('allocation'), selection: sum('selection'), interaction: sum('interaction'),
      cashPolicyPct: wbCash * 100, cashActualPct: wpCash * 100, residualPct: residual * 100, missingIndex: missingIndex, reportedPct: a.totals ? a.totals.contributionPct : null,
    };
    res.gap = active - (res.allocation + res.selection + res.interaction);       // phải ~ 0 (đẳng thức Brinson); giữ lại để kiểm tra
    res.notes = narrative(res);
    return res;
  }

  const f1 = function (v) { return Number(v).toLocaleString('vi-VN', { maximumFractionDigits: 2, minimumFractionDigits: 0 }); };
  const sgn = function (v) { return (v > 0 ? '+' : (v < 0 ? '−' : '')) + f1(Math.abs(v)); };
  function narrative(r) {
    const n = [];
    n.push('Danh mục ' + (r.activePct >= 0 ? 'hơn' : 'kém') + ' chuẩn chiến lược ' + f1(Math.abs(r.activePct)) + ' điểm % (danh mục ' + sgn(r.portfolioPct) + '%, chuẩn ' + sgn(r.benchmarkPct) + '%).');
    const parts = [['phân bổ ngành', r.allocation], ['chọn mã trong ngành', r.selection], ['tương tác', r.interaction]];
    n.push('Nguồn gốc: ' + parts.map(function (p) { return p[0] + ' ' + sgn(p[1]) + ' điểm'; }).join(', ') + '.');
    const secRows = r.rows.filter(function (x) { return !x.isCash; });
    const bestA = secRows.slice().sort(function (a, b) { return b.allocation - a.allocation; })[0], worstA = secRows.slice().sort(function (a, b) { return a.allocation - b.allocation; })[0];
    if (bestA && bestA.allocation > 0.05) n.push('Phân bổ tốt nhất: ' + bestA.sector + ' (' + sgn(bestA.allocation) + ' điểm, tỷ trọng thực ' + f1(bestA.wpPct) + '% so với chuẩn ' + f1(bestA.wbPct) + '%).');
    if (worstA && worstA.allocation < -0.05) n.push('Phân bổ kém nhất: ' + worstA.sector + ' (' + sgn(worstA.allocation) + ' điểm, tỷ trọng thực ' + f1(worstA.wpPct) + '% so với chuẩn ' + f1(worstA.wbPct) + '%).');
    const bestS = secRows.filter(function (x) { return !x.noIndex; }).sort(function (a, b) { return b.selection - a.selection; })[0], worstS = secRows.filter(function (x) { return !x.noIndex; }).sort(function (a, b) { return a.selection - b.selection; })[0];
    if (bestS && bestS.selection > 0.05) n.push('Chọn mã tốt nhất: ' + bestS.sector + ' (' + sgn(bestS.selection) + ' điểm so với chỉ số ngành ' + bestS.index + ').');
    if (worstS && worstS.selection < -0.05) n.push('Chọn mã kém nhất: ' + worstS.sector + ' (' + sgn(worstS.selection) + ' điểm so với chỉ số ngành ' + worstS.index + ').');
    const cash = r.rows.find(function (x) { return x.isCash; });
    if (cash && Math.abs(cash.allocation) > 0.05) n.push('Giữ tiền mặt ' + f1(r.cashActualPct) + '% so với chuẩn ' + f1(r.cashPolicyPct) + '% ' + (cash.allocation >= 0 ? 'đã giúp' : 'làm mất') + ' ' + f1(Math.abs(cash.allocation)) + ' điểm.');
    if (r.missingIndex.length) n.push('Thiếu dữ liệu chỉ số ' + r.missingIndex.join(', ') + ': các ngành này chưa tách được phần chọn mã.');
    return n;
  }

  // ---- NỐI NHIỀU KỲ (Carino 1999) ----
  // Brinson từng tháng KHÔNG cộng dồn được: lợi suất nối theo lãi kép nên tổng các điểm % từng tháng không bằng chênh lệch cả kỳ. Carino nhân hiệu ứng mỗi kỳ với k_t / K,
  // k_t = (ln(1+Rp_t) − ln(1+Rb_t)) / (Rp_t − Rb_t), K tính cùng công thức trên lợi suất cả kỳ: tổng các hiệu ứng đã nối = Rp − Rb (lãi kép cả kỳ) CHÍNH XÁC.
  // results: mảng kết quả analyze() của từng kỳ liên tiếp (cũ -> mới). Trả { ok, periods, portfolioPct, benchmarkPct, activePct, allocation, selection, interaction, rows[{sector, allocation, selection, interaction, total}], gap, factors[] }.
  function carinoK(rp, rb) { const d = rp - rb; return Math.abs(d) > 1e-12 ? (Math.log(1 + rp) - Math.log(1 + rb)) / d : 1 / (1 + rp); }
  function link(results) {
    const rs = (results || []).filter(function (r) { return r && r.ok; });
    if (!rs.length) return { ok: false, reason: 'empty' };
    let P = 1, B = 1;
    rs.forEach(function (r) { P *= 1 + r.portfolioPct / 100; B *= 1 + r.benchmarkPct / 100; });
    const Rp = P - 1, Rb = B - 1, K = carinoK(Rp, Rb);
    const by = {}, tot = { allocation: 0, selection: 0, interaction: 0 };
    const factors = rs.map(function (r) {
      const f = carinoK(r.portfolioPct / 100, r.benchmarkPct / 100) / K;
      r.rows.forEach(function (x) {
        const row = by[x.sector] || (by[x.sector] = { sector: x.sector, allocation: 0, selection: 0, interaction: 0, isCash: !!x.isCash });
        row.allocation += x.allocation * f; row.selection += x.selection * f; row.interaction += x.interaction * f;
      });
      tot.allocation += r.allocation * f; tot.selection += r.selection * f; tot.interaction += r.interaction * f;
      return f;
    });
    const rows = Object.keys(by).map(function (k) { const r = by[k]; r.total = r.allocation + r.selection + r.interaction; return r; })
      .sort(function (x, y) { return Math.abs(y.total) - Math.abs(x.total) || (x.sector < y.sector ? -1 : 1); });
    const active = (Rp - Rb) * 100;
    return { ok: true, periods: rs.length, portfolioPct: Rp * 100, benchmarkPct: Rb * 100, activePct: active, allocation: tot.allocation, selection: tot.selection, interaction: tot.interaction,
      rows: rows, factors: factors, gap: active - (tot.allocation + tot.selection + tot.interaction), months: rs.map(function (r) { return { from: r.from, to: r.to, portfolioPct: r.portfolioPct, benchmarkPct: r.benchmarkPct, activePct: r.activePct }; }) };
  }

  return { CASH, SECTOR_INDEX, SECTOR_INDEX_CODES, indexFor, allSectors, sectorReturns, validatePolicy, analyze, link, carinoK };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BrinsonCalc;
