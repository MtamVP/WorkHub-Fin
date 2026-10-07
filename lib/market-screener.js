// Logic thuần: SÀNG LỌC TOÀN THỊ TRƯỜNG trên ảnh chụp ~1.500 mã niêm yết (finance_market_snapshot, cập nhật mỗi ngày làm việc từ VNDirect) và thống kê ngành (finance_sector_stats).
// Khác bộ lọc Tổng Hợp CP (chỉ các mã bạn đã nhập số liệu): ở đây tìm được cả mã bạn chưa từng xem, với tiêu chí định giá TƯƠNG ĐỐI trong ngành (phân vị), chất lượng, tăng trưởng, cổ tức, đòn bẩy, thanh khoản.
// Nguyên tắc (giống lib/screener.js): tiêu chí nào đang bật mà mã THIẾU số liệu thì mã không đạt (không đoán) nhưng được đếm riêng để biết "bao nhiêu mã bị loại vì thiếu dữ liệu";
// điểm 0-100 chỉ để XẾP HẠNG mã đã đạt, không phải khuyến nghị đầu tư. Đòn bẩy (nợ/vốn) không áp dụng cho ngân hàng, bảo hiểm, dịch vụ tài chính (vay là nguyên liệu kinh doanh).
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global MarketScreener) và module.exports cho Vitest. Cần PeerValuation (lib/peer-valuation.js).
const MarketScreener = (function () {
  const PV = (typeof require === 'function' && typeof module !== 'undefined') ? require('./peer-valuation.js') : PeerValuation;
  const FINANCIAL_ICB = ['8300', '8500', '8700'];       // ngân hàng, bảo hiểm, dịch vụ tài chính
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };

  // Mỗi tiêu chí: op 'min' (>= ngưỡng) / 'max' (<= ngưỡng); `pct`: người dùng gõ % nhưng số liệu là tỷ lệ thập phân; `scale`: đổi đơn vị gõ -> đơn vị số liệu (tỷ đồng -> đồng).
  const CRITERIA = [
    { key: 'cap', group: 'Quy mô & thanh khoản', label: 'Vốn hoá tối thiểu', unit: 'tỷ đồng', op: 'min', scale: 1e9, get: (r) => r.m.marketcap },
    { key: 'capMax', group: 'Quy mô & thanh khoản', label: 'Vốn hoá tối đa', unit: 'tỷ đồng', op: 'max', scale: 1e9, get: (r) => r.m.marketcap, hint: 'Kết hợp với vốn hoá tối thiểu để lọc theo khoảng quy mô (ví dụ 1.000 đến 10.000 tỷ).' },
    { key: 'adv', group: 'Quy mô & thanh khoản', label: 'Giá trị giao dịch TB 20 phiên tối thiểu', unit: 'tỷ đồng/ngày', op: 'min', scale: 1e9, get: (r) => r.m.advValue20, hint: 'Mã thanh khoản thấp khó mua bán với vị thế lớn.' },
    { key: 'pe', group: 'Định giá', label: 'P/E tối đa', unit: 'x', op: 'max', positive: true, get: (r) => r.m.pe },
    { key: 'pb', group: 'Định giá', label: 'P/B tối đa', unit: 'x', op: 'max', positive: true, get: (r) => r.m.pb },
    { key: 'valPct', group: 'Định giá', label: 'Định giá thuộc nhóm rẻ nhất ngành (phân vị tối đa)', unit: '0-100', op: 'max', get: (r) => r.valuationPct, hint: 'Trung bình phân vị P/E và P/B trong cùng ngành ICB: 0 = rẻ nhất ngành. Cần ngành có ít nhất 5 mã vốn hoá từ 300 tỷ.' },
    { key: 'peHist', group: 'Định giá', label: 'P/E hiện tại so với bình quân 5 năm tối đa', unit: '%', op: 'max', pct: true, get: (r) => (r.m.pe > 0 && r.m.pe5y > 0 ? r.m.pe / r.m.pe5y : null), hint: '70% nghĩa là đang rẻ hơn 30% so với chính lịch sử của mã (chưa tính tăng trưởng đã đổi).' },
    { key: 'roe', group: 'Chất lượng', label: 'ROE tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.roae },
    { key: 'margin', group: 'Chất lượng', label: 'Biên lợi nhuận ròng tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.netMargin, hint: 'Không so sánh được giữa ngân hàng và doanh nghiệp thường.' },
    { key: 'epsG', group: 'Tăng trưởng', label: 'Tăng trưởng EPS so với cùng kỳ tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.epsGrowthYoY },
    { key: 'netG', group: 'Tăng trưởng', label: 'Tăng trưởng lợi nhuận ròng 12 tháng so với cùng kỳ tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.netProfitGrowthYoY, hint: 'Lợi nhuận ròng 4 quý gần nhất so với 4 quý cùng kỳ năm trước (VNDirect).' },
    { key: 'netGq', group: 'Tăng trưởng', label: 'Tăng trưởng lợi nhuận ròng quý gần nhất so với cùng quý tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.netProfitGrowthQ },
    { key: 'net3y', group: 'Tăng trưởng', label: 'Tăng trưởng lợi nhuận ròng bình quân 3 năm tối thiểu', unit: '%/năm', op: 'min', pct: true, get: (r) => r.m.netProfitGrowth3y, hint: 'Tốc độ tăng trưởng kép mỗi năm trong 3 năm: lọc bớt mã chỉ tăng nhờ một kỳ.' },
    { key: 'pretaxG', group: 'Tăng trưởng', label: 'Tăng trưởng lợi nhuận trước thuế 12 tháng tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.pretaxGrowthYoY },
    { key: 'salesG', group: 'Tăng trưởng', label: 'Tăng trưởng doanh thu so với cùng kỳ tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.salesGrowthYoY },
    { key: 'div', group: 'Cổ tức', label: 'Tỷ suất cổ tức tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.divYield },
    { key: 'de', group: 'An toàn', label: 'Nợ / vốn chủ tối đa', unit: 'x', op: 'max', get: (r) => r.m.debtToEquity, nonFinancial: true, hint: 'Không áp dụng cho ngân hàng, bảo hiểm, dịch vụ tài chính.' },
    { key: 'ytd', group: 'Giá', label: 'Biến động giá từ 1/1 đến nay tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.chgYtd, hint: 'Giá hiện tại so với giá đóng cửa cuối năm trước (VNDirect, có thể lệch nhẹ so với giá điều chỉnh).' },
    { key: 'ytdMax', group: 'Giá', label: 'Biến động giá từ 1/1 đến nay tối đa', unit: '%', op: 'max', pct: true, get: (r) => r.m.chgYtd, hint: 'Kết hợp với mức tối thiểu để lọc theo khoảng (ví dụ từ -10 đến +20). Số âm để tìm mã đã giảm từ đầu năm.' },
    { key: 'chg1m', group: 'Giá', label: 'Biến động giá 1 tháng tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.chg1m },
    { key: 'chg3m', group: 'Giá', label: 'Biến động giá 3 tháng tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.chg3m, hint: 'Động lượng ngắn hạn: giá 3 tháng qua tăng ít nhất bao nhiêu.' },
    { key: 'chg6m', group: 'Giá', label: 'Biến động giá 6 tháng tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.chg6m },
    { key: 'jdkRs', group: 'Giá', label: 'RS-Ratio (JdK) tối thiểu', unit: '100 = ngang thị trường', op: 'min', get: (r) => r.m.jdkRs, hint: 'Sức mạnh tương đối so với thị trường theo VNDirect; từ 100 trở lên là mạnh hơn thị trường.' },
    { key: 'jdkMom', group: 'Giá', label: 'RS-Momentum (JdK) tối thiểu', unit: '100 = ngang thị trường', op: 'min', get: (r) => r.m.jdkMom, hint: 'Sức mạnh tương đối đang tăng tốc (từ 100 trở lên) hay chậm lại.' },
    { key: 'chg1y', group: 'Giá', label: 'Biến động giá 12 tháng tối đa', unit: '%', op: 'max', pct: true, get: (r) => r.m.chg1y, hint: 'Đặt số âm (ví dụ -25) để tìm mã đã giảm sâu; kết hợp với ROE để tránh mã giảm vì kém.' },
  ];
  const BY_KEY = {}; CRITERIA.forEach((c) => { BY_KEY[c.key] = c; });

  const PRESETS = [
    { key: 'qgarp', label: 'Rẻ và chất lượng', desc: 'Định giá thuộc 40% rẻ nhất ngành, ROE từ 15%, vốn hoá từ 1.000 tỷ, thanh khoản từ 5 tỷ/ngày.', values: { valPct: 40, roe: 15, cap: 1000, adv: 5 } },
    { key: 'income', label: 'Cổ tức bền', desc: 'Tỷ suất cổ tức từ 5%, ROE từ 10%, nợ/vốn chủ không quá 1,5 lần, vốn hoá từ 1.000 tỷ.', values: { div: 5, roe: 10, de: 1.5, cap: 1000 } },
    { key: 'growth', label: 'Tăng trưởng giá hợp lý', desc: 'Tăng trưởng EPS từ 15%, P/E không quá 15, ROE từ 12%, vốn hoá từ 1.000 tỷ.', values: { epsG: 15, pe: 15, roe: 12, cap: 1000 } },
    { key: 'history', label: 'Rẻ hơn lịch sử', desc: 'P/E hiện tại không quá 70% bình quân 5 năm của chính mã, ROE từ 10%, vốn hoá từ 1.000 tỷ.', values: { peHist: 70, roe: 10, cap: 1000 } },
    { key: 'momentum', label: 'Dẫn đầu và có nền tảng', desc: 'Sức mạnh tương đối so với thị trường từ 100 và đang tăng tốc (JdK dẫn đầu), ROE từ 12%, vốn hoá từ 1.000 tỷ, thanh khoản từ 5 tỷ/ngày, không đắt quá so với ngành (phân vị định giá tối đa 70).', values: { jdkRs: 100, jdkMom: 100, roe: 12, cap: 1000, adv: 5, valPct: 70 } },
    { key: 'bysector', label: 'Dẫn đầu từng ngành', desc: 'Vốn hoá từ 1.000 tỷ, thanh khoản từ 2 tỷ/ngày, lợi nhuận ròng 12 tháng tăng từ 10%, lấy tối đa 5 mã mỗi ngành theo điểm tổng hợp (khoảng 100 mã nếu chọn nhiều ngành).', values: { cap: 1000, adv: 2, netG: 10 }, perSector: 5 },
    { key: 'drawdown', label: 'Giảm sâu, nền tảng còn tốt', desc: 'Giá 12 tháng giảm từ 25%, ROE từ 12%, P/E không quá 15, thanh khoản từ 5 tỷ/ngày. Cần xem vì sao giảm trước khi quan tâm.', values: { chg1y: -25, roe: 12, pe: 15, adv: 5 } },
  ];

  const WEIGHTS = { value: 0.3, quality: 0.3, growth: 0.2, income: 0.1, safety: 0.1 };
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const lin = (v, lo, hi) => clamp01((v - lo) / (hi - lo)) * 100;

  // Chuẩn hoá ảnh chụp -> hàng có thêm phân vị ngành. statsByIcb: { icb2_code: { stats } } (kể cả 'ALL' dùng khi ngành không đủ thống kê)
  function buildRows(snapshot, statsByIcb, meta) {
    const st = statsByIcb || {}, mt = meta || {}, qcache = {};
    return (snapshot || []).map((s) => {
      const m = s.metrics || {}, icb = s.icb2_code || null, sec = icb && st[icb] ? st[icb].stats : null;
      const a = sec ? PV.assess(m, sec) : null;
      const info = mt[s.symbol] || {};
      return { symbol: String(s.symbol).toUpperCase(), name: info.name || '', exchange: info.exchange || '', icb2_code: icb, financial: FINANCIAL_ICB.indexOf(icb) !== -1, m: m,
        valuationPct: a ? a.valuationPct : null, qualityPct: a ? a.qualityPct : null, verdict: a ? a.verdict : null, sectorN: a && a.n ? a.n : null,
        peerQuality: sec ? (qcache[icb] = qcache[icb] || PV.quality(st[icb], { financial: FINANCIAL_ICB.indexOf(icb) !== -1 })) : null };
    });
  }

  function threshold(c, raw) {
    const v = num(raw);
    if (v === null) return null;
    return c.pct ? v / 100 : (c.scale ? v * c.scale : v);
  }
  function normalizeFilters(f) {
    const out = { values: {}, icbs: [], perSector: 0, topN: 0 };
    const src = f && f.values ? f.values : {};
    CRITERIA.forEach((c) => { const v = num(src[c.key]); if (v !== null) out.values[c.key] = v; });
    const raw = f && Array.isArray(f.icbs) ? f.icbs : (f && typeof f.icb === 'string' && f.icb ? [f.icb] : []);      // f.icb: định dạng cũ (một ngành)
    out.icbs = [...new Set(raw.map((x) => String(x)).filter(Boolean))];
    const cnt = (v) => { const n = num(v); return n !== null && n >= 1 ? Math.floor(n) : 0; };
    out.perSector = cnt(f && f.perSector); out.topN = cnt(f && f.topN);
    return out;
  }

  function check(row, c, raw) {
    if (c.nonFinancial && row.financial) return { key: c.key, status: 'na' };
    const v = num(c.get(row));
    if (v === null) return { key: c.key, status: 'missing' };
    if (c.positive && !(v > 0)) return { key: c.key, status: 'fail', value: v };
    const t = threshold(c, raw);
    const ok = c.op === 'min' ? v >= t - 1e-12 : v <= t + 1e-12;
    return { key: c.key, status: ok ? 'pass' : 'fail', value: v };
  }

  // Điểm xếp hạng 0-100: ghép 5 nhóm, chuẩn hoá trọng số theo nhóm có dữ liệu (cần >= 2 nhóm)
  function score(row) {
    const m = row.m, parts = {};
    if (row.valuationPct !== null) parts.value = 100 - row.valuationPct;
    else if (num(m.pe) > 0) parts.value = lin(25 - m.pe, 0, 20);
    const q = []; if (num(m.roae) !== null) q.push(lin(m.roae, 0.03, 0.25)); if (num(m.netMargin) !== null) q.push(lin(m.netMargin, 0.02, 0.2)); if (q.length) parts.quality = q.reduce((a, b) => a + b, 0) / q.length;
    const g = []; if (num(m.epsGrowthYoY) !== null) g.push(lin(m.epsGrowthYoY, -0.1, 0.3)); if (num(m.salesGrowthYoY) !== null) g.push(lin(m.salesGrowthYoY, -0.05, 0.25)); if (g.length) parts.growth = g.reduce((a, b) => a + b, 0) / g.length;
    if (num(m.divYield) !== null) parts.income = lin(m.divYield, 0, 0.07);
    if (!row.financial && num(m.debtToEquity) !== null) parts.safety = 100 - lin(m.debtToEquity, 0.3, 2.5);
    let sum = 0, wsum = 0, n = 0;
    Object.keys(parts).forEach((k) => { sum += parts[k] * WEIGHTS[k]; wsum += WEIGHTS[k]; n++; });
    return { total: n >= 2 ? sum / wsum : null, parts: parts };
  }

  // Cảnh báo "coi chừng" cho từng mã: số liệu trông đẹp nhưng thường do nguyên nhân không bền (lợi nhuận một lần, thanh khoản mỏng...)
  function flags(row) {
    const m = row.m, out = [];
    if (num(m.pe) > 0 && m.pe < 4) out.push('P/E dưới 4x thường do lợi nhuận bất thường một lần: kiểm tra báo cáo');
    if (num(m.epsGrowthYoY) !== null && m.epsGrowthYoY > 1) out.push('EPS tăng hơn gấp đôi cùng kỳ: có thể do khoản thu nhập một lần');
    if (num(m.roae) !== null && m.roae > 0.4 && !row.financial) out.push('ROE trên 40% bất thường: có thể do vốn chủ quá nhỏ hoặc lợi nhuận một lần');
    if (num(m.advValue20) !== null && m.advValue20 < 1e9) out.push('Thanh khoản dưới 1 tỷ/ngày: khó mua bán');
    if (row.sectorN !== null && row.sectorN < 10) out.push('Ngành chỉ có ' + row.sectorN + ' mã trong thống kê: phân vị kém chắc chắn');
    return out;
  }

  // rows: kết quả buildRows; filters: { values, icb }. Trả { entries (đạt, điểm cao trước), counts: { universe, passed, missing: {key: số mã bị loại vì thiếu số liệu}, failedBy } }
  function evaluate(rows, filters) {
    const f = normalizeFilters(filters), active = CRITERIA.filter((c) => f.values[c.key] !== undefined);
    const counts = { universe: 0, passed: 0, missing: {}, failedBy: {} };
    const entries = [];
    (rows || []).forEach((r) => {
      if (f.icbs.length && f.icbs.indexOf(r.icb2_code) === -1) return;
      counts.universe++;
      let ok = true;
      active.forEach((c) => {
        const res = check(r, c, f.values[c.key]);
        if (res.status === 'missing') { counts.missing[c.key] = (counts.missing[c.key] || 0) + 1; ok = false; }
        else if (res.status === 'fail') { counts.failedBy[c.key] = (counts.failedBy[c.key] || 0) + 1; ok = false; }
      });
      if (ok) { const s = score(r); entries.push({ row: r, score: s.total, parts: s.parts, flags: flags(r) }); }
    });
    entries.sort((a, b) => (b.score === null ? -1 : b.score) - (a.score === null ? -1 : a.score) || b.row.m.marketcap - a.row.m.marketcap);
    counts.matched = entries.length;            // số mã đạt trước khi cắt theo "tối đa mỗi ngành / tổng"
    let out = entries;
    if (f.perSector) { const used = {}; out = out.filter((e) => { const k = e.row.icb2_code || ''; used[k] = (used[k] || 0) + 1; return used[k] <= f.perSector; }); }
    if (f.topN) out = out.slice(0, f.topN);
    counts.passed = out.length;
    counts.active = active.length;
    counts.cut = counts.matched - out.length;
    return { entries: out, counts: counts };
  }

  // Trong danh sách mã `symbols`, mã nào đạt mẫu lọc `presetKey` (mặc định "Rẻ và chất lượng"): { SYM: { label, score, valuationPct, roe, flags, name } }.
  // Dùng cho danh sách theo dõi: báo mã đang canh vừa lọt vào nhóm rẻ và chất lượng. Mã bị cờ số liệu bất thường (P/E dưới 4x, EPS tăng gấp đôi, ROE trên 40%) vẫn đạt nhưng kèm cờ để người dùng soát.
  function matches(rows, symbols, presetKey) {
    const preset = PRESETS.find((p) => p.key === (presetKey || 'qgarp')), want = {};
    (symbols || []).forEach((s) => { want[String(s).toUpperCase()] = true; });
    const out = {};
    if (!preset) return out;
    const sub = (rows || []).filter((r) => want[r.symbol]);
    evaluate(sub, { values: preset.values }).entries.forEach((e) => {
      out[e.row.symbol] = { label: preset.label, score: e.score, valuationPct: e.row.valuationPct, roe: num(e.row.m.roae), flags: e.flags, name: e.row.name };
    });
    return out;
  }

  function describe(key, raw) {
    const c = BY_KEY[key], v = num(raw);
    if (!c || v === null) return '';
    return c.label + (c.op === 'min' ? ' ≥ ' : ' ≤ ') + v + (c.unit && c.unit !== '0-100' ? ' ' + c.unit : '');
  }

  return { CRITERIA, BY_KEY, PRESETS, WEIGHTS, FINANCIAL_ICB, buildRows, normalizeFilters, evaluate, score, describe, flags, matches };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MarketScreener;
