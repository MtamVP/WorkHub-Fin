// Logic thuần: bộ lọc tìm mã trên các mã đã có số liệu (Tổng Hợp CP). KHÔNG đụng DOM/mạng/Supabase.
// Nạp bằng thẻ <script> thường (global Screener) và module.exports cho Vitest. Cần ValuationCalc (lib/valuation-calc.js) nạp trước.
//
// Đầu vào là các "item" đã phân tích của trang Tổng Hợp CP: { symbol, year, held, watched, data, a } với a = ValuationCalc.analyze(...).
// Nguyên tắc:
//  - Tiêu chí nào người dùng bật mà mã THIẾU số liệu cho tiêu chí đó thì mã KHÔNG đạt (không đoán), nhưng được đếm riêng để người dùng biết
//    "bao nhiêu mã bị loại vì thiếu dữ liệu" thay vì tưởng là không có mã nào phù hợp.
//  - Điểm tổng hợp (0-100) chỉ để XẾP HẠNG các mã đã đạt; ghép 5 nhóm (định giá, chất lượng, tăng trưởng, cổ tức, an toàn) và chuẩn hoá trọng số
//    theo các nhóm có dữ liệu. Không phải khuyến nghị đầu tư.
const Screener = (function () {
  const VC = (typeof require === 'function' && typeof module !== 'undefined') ? require('./valuation-calc.js') : ValuationCalc;

  // op 'min': giá trị phải >= ngưỡng; 'max': giá trị phải <= ngưỡng (và > 0 nếu positive: P/E, P/B âm vô nghĩa)
  const CRITERIA = [
    { key: 'upside', group: 'Định giá', label: 'Tiềm năng tăng tối thiểu', unit: '%', op: 'min', hint: '(Giá hợp lý − giá hiện tại) / giá hiện tại. Cần đã đặt P/E, P/B mục tiêu.' },
    { key: 'mos', group: 'Định giá', label: 'Biên an toàn tối thiểu', unit: '%', op: 'min', hint: '(Giá hợp lý − giá) / giá hợp lý. 20% trở lên được xếp là “Rẻ”.' },
    { key: 'pe', group: 'Định giá', label: 'P/E tối đa', unit: 'x', op: 'max', positive: true },
    { key: 'pb', group: 'Định giá', label: 'P/B tối đa', unit: 'x', op: 'max', positive: true },
    { key: 'peDiscount', group: 'Định giá', label: 'P/E thấp hơn trung vị ngành tối thiểu', unit: '%', op: 'min', hint: 'So với trung vị P/E các mã cùng ngành trong bảng (cần ≥ 3 mã cùng ngành có P/E).' },
    { key: 'roe', group: 'Chất lượng', label: 'ROE tối thiểu', unit: '%', op: 'min' },
    { key: 'netMargin', group: 'Chất lượng', label: 'Biên lợi nhuận ròng tối thiểu', unit: '%', op: 'min', hint: 'Không so sánh được giữa ngân hàng và doanh nghiệp thường.' },
    { key: 'epsGrowth', group: 'Tăng trưởng', label: 'Tăng trưởng EPS tối thiểu', unit: '%', op: 'min', hint: 'So với năm trước; bỏ trống nếu số cổ phiếu đổi quá 3% (thưởng/phát hành thêm).' },
    { key: 'lnstGrowth', group: 'Tăng trưởng', label: 'Tăng trưởng lợi nhuận tối thiểu', unit: '%', op: 'min' },
    { key: 'peg', group: 'Tăng trưởng', label: 'PEG tối đa', unit: 'x', op: 'max', positive: true, hint: 'P/E chia tăng trưởng EPS. Dưới 1 thường coi là rẻ so với tốc độ tăng trưởng.' },
    { key: 'divYield', group: 'Cổ tức', label: 'Tỷ suất cổ tức tối thiểu', unit: '%', op: 'min' },
    { key: 'payout', group: 'Cổ tức', label: 'Tỷ lệ chi trả cổ tức tối đa', unit: '%', op: 'max', hint: 'Cổ tức / EPS. Trên 100% là đang chi nhiều hơn lợi nhuận kiếm được.' },
  ];
  const CRITERIA_BY_KEY = {};
  CRITERIA.forEach(function (c) { CRITERIA_BY_KEY[c.key] = c; });

  const DEFAULT_FILTERS = { values: {}, verdicts: [], sector: '', scope: 'all', excludeLoss: true };

  const PRESETS = [
    { key: 'value-quality', label: 'Rẻ và chất lượng', desc: 'Giá thấp hơn giá hợp lý ít nhất 15% và ROE từ 15%.', filters: { values: { upside: 15, roe: 15 } } },
    { key: 'dividend', label: 'Cổ tức cao và bền', desc: 'Cổ tức từ 5%/năm, không chi quá 80% lợi nhuận, ROE từ 10%.', filters: { values: { divYield: 5, payout: 80, roe: 10 } } },
    { key: 'growth-fair', label: 'Tăng trưởng giá hợp lý', desc: 'EPS tăng từ 15%, PEG không quá 1,2, ROE từ 15%.', filters: { values: { epsGrowth: 15, peg: 1.2, roe: 15 } } },
    { key: 'deep-value', label: 'Rẻ theo sổ sách', desc: 'P/B tối đa 1, P/E tối đa 10, còn tiềm năng từ 20%.', filters: { values: { pb: 1, pe: 10, upside: 20 } } },
    { key: 'peer-discount', label: 'Rẻ hơn cùng ngành', desc: 'P/E thấp hơn trung vị ngành từ 15%, ROE từ 12%.', filters: { values: { peDiscount: 15, roe: 12 } } },
    { key: 'margin-safety', label: 'Biên an toàn lớn', desc: 'Biên an toàn từ 30%, đã định giá là “Rẻ”.', filters: { values: { mos: 30 }, verdicts: ['cheap'] } },
  ];

  // Danh sách mã tham khảo để thêm hàng loạt. Thành phần rổ chỉ mang tính tham khảo, có thể đã thay đổi theo thời gian.
  const UNIVERSES = [
    { key: 'vn30', label: 'VN30 (tham khảo)', symbols: 'ACB BCM BID BVH CTG FPT GAS GVR HDB HPG LPB MBB MSN MWG PLX SAB SHB SSB SSI STB TCB TPB VCB VHM VIB VIC VJC VNM VPB VRE' },
    { key: 'bank', label: 'Ngân hàng', symbols: 'VCB BID CTG TCB MBB ACB VPB STB HDB TPB VIB SHB LPB MSB OCB EIB SSB' },
    { key: 'securities', label: 'Chứng khoán', symbols: 'SSI VND HCM VCI SHS MBS FTS BSI CTS VIX' },
    { key: 'realestate', label: 'Bất động sản', symbols: 'VIC VHM VRE NVL KDH NLG DXG PDR DIG CEO KBC IDC SZC BCM' },
    { key: 'materials', label: 'Thép, hoá chất, cao su', symbols: 'HPG HSG NKG DGC DPM DCM GVR PHR BMP NTP CSV' },
    { key: 'consumer', label: 'Tiêu dùng, bán lẻ', symbols: 'VNM SAB MSN MWG PNJ FRT DBC KDC QNS' },
    { key: 'infra', label: 'Công nghệ, năng lượng, vận tải', symbols: 'FPT CMG GMD VJC HVN GAS PLX POW REE PC1 PVS PVD' },
  ].map(function (u) { return { key: u.key, label: u.label, symbols: u.symbols.split(' ') }; });

  function isNum(v) { return v !== null && v !== undefined && isFinite(v) && typeof v === 'number'; }
  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort(function (a, b) { return a - b; });
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // items -> rows phẳng (kèm P/E so với trung vị ngành)
  function rowsFrom(items) {
    const rows = (items || []).map(function (it) {
      const a = it.a, m = a.m, v = a.verdict;
      return {
        item: it, symbol: it.symbol, year: it.year, held: !!it.held, watched: !!it.watched,
        sector: a.n.sector, sectorLabel: VC.SECTORS[a.n.sector] ? VC.SECTORS[a.n.sector].label : a.n.sector,
        price: a.price > 0 ? a.price : null, fair: a.v.fair > 0 ? a.v.fair : null,
        upside: isNum(v.upsidePct) ? v.upsidePct : null, mos: isNum(v.marginOfSafetyPct) ? v.marginOfSafetyPct : null,
        verdict: v.key, zone: v.zone,
        pe: isNum(m.pe) ? m.pe : null, pb: isNum(m.pb) ? m.pb : null, roe: isNum(m.roe) ? m.roe : null, roa: isNum(m.roa) ? m.roa : null,
        netMargin: isNum(m.netMargin) ? m.netMargin : null, epsGrowth: isNum(m.epsGrowth) ? m.epsGrowth : null,
        lnstGrowth: isNum(m.lnstGrowth) ? m.lnstGrowth : null, peg: isNum(m.peg) ? m.peg : null,
        divYield: isNum(m.divYield) ? m.divYield : null, payout: isNum(m.payout) ? m.payout : null,
        lossMaking: !!m.lossMaking, peDiscount: null, peerPe: null,
      };
    });
    const bySector = {};
    rows.forEach(function (r) { if (r.pe !== null && r.pe > 0) (bySector[r.sector] = bySector[r.sector] || []).push(r.pe); });
    rows.forEach(function (r) {
      const peers = bySector[r.sector] || [];
      if (peers.length >= 3 && r.pe !== null && r.pe > 0) {
        const med = median(peers);
        r.peerPe = med;
        r.peDiscount = med > 0 ? (med - r.pe) / med * 100 : null;
      }
    });
    return rows;
  }

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function lin(v, lo, hi) { return clamp01((v - lo) / (hi - lo)) * 100; }
  const WEIGHTS = { value: 35, quality: 30, growth: 20, income: 10, safety: 5 };

  // Điểm 0-100 + từng nhóm (null nếu thiếu dữ liệu nhóm đó). Trả { total, parts }.
  function score(row) {
    const parts = { value: null, quality: null, growth: null, income: null, safety: null };
    if (row.upside !== null) parts.value = lin(row.upside, -10, 50);
    else if (row.peDiscount !== null) parts.value = lin(row.peDiscount, -20, 40);
    const q = [];
    if (row.roe !== null) q.push([lin(row.roe, 5, 25), 0.6]);
    if (row.netMargin !== null) q.push([lin(row.netMargin, 0, 25), 0.4]);
    if (q.length) { const w = q.reduce(function (s, x) { return s + x[1]; }, 0); parts.quality = q.reduce(function (s, x) { return s + x[0] * x[1]; }, 0) / w; }
    if (row.epsGrowth !== null) {
      let g = lin(row.epsGrowth, -10, 30);
      if (row.peg !== null && row.peg > 2) g *= 0.7;       // tăng trưởng đang được định giá quá đắt
      parts.growth = g;
    }
    if (row.divYield !== null) parts.income = lin(row.divYield, 0, 7);
    let safety = 100;
    if (row.lossMaking) safety -= 60;
    if (row.payout !== null && row.payout > 100) safety -= 30;
    if (row.peg === null && row.pe !== null && row.pe > 30) safety -= 20;
    parts.safety = Math.max(0, safety);
    let sum = 0, wsum = 0, have = 0;
    Object.keys(parts).forEach(function (k) { if (parts[k] !== null) { sum += parts[k] * WEIGHTS[k]; wsum += WEIGHTS[k]; if (k !== 'safety') have++; } });
    return { total: have >= 2 ? sum / wsum : null, parts: parts };
  }

  function normalizeFilters(f) {
    const o = Object.assign({}, DEFAULT_FILTERS, f || {});
    o.values = {};
    const src = (f && f.values) || {};
    Object.keys(src).forEach(function (k) {
      const v = src[k];
      if (CRITERIA_BY_KEY[k] && v !== null && v !== '' && isFinite(Number(v))) o.values[k] = Number(v);
    });
    o.verdicts = Array.isArray(o.verdicts) ? o.verdicts.filter(function (v) { return v === 'cheap' || v === 'fair' || v === 'expensive'; }) : [];
    return o;
  }

  function checkCriterion(row, c, threshold) {
    const v = row[c.key];
    if (v === null || v === undefined) return { key: c.key, status: 'missing', value: null, threshold: threshold };
    if (c.positive && !(v > 0)) return { key: c.key, status: 'fail', value: v, threshold: threshold };
    const ok = c.op === 'min' ? v >= threshold : v <= threshold;
    return { key: c.key, status: ok ? 'pass' : 'fail', value: v, threshold: threshold };
  }

  // Lọc + xếp hạng. Trả { passed:[{row, score, checks}], near:[...], stats }.
  function evaluate(rows, filters) {
    const f = normalizeFilters(filters);
    const keys = Object.keys(f.values);
    const out = { passed: [], near: [], stats: { total: 0, inScope: 0, passed: 0, missingOnly: 0, active: keys.length + (f.verdicts.length ? 1 : 0) } };
    out.stats.total = rows.length;
    (rows || []).forEach(function (r) {
      if (f.scope === 'held' && !r.held) return;
      if (f.scope === 'watched' && !r.watched) return;
      if (f.scope === 'notheld' && r.held) return;
      if (f.sector && r.sector !== f.sector) return;
      out.stats.inScope++;
      const checks = keys.map(function (k) { return checkCriterion(r, CRITERIA_BY_KEY[k], f.values[k]); });
      if (f.verdicts.length) {
        const ok = f.verdicts.indexOf(r.verdict) !== -1;
        checks.push({ key: 'verdict', status: r.verdict === 'none' ? 'missing' : (ok ? 'pass' : 'fail'), value: r.verdict, threshold: f.verdicts });
      }
      if (f.excludeLoss && r.lossMaking) checks.push({ key: 'lossMaking', status: 'fail', value: true, threshold: false });
      const failed = checks.filter(function (c) { return c.status === 'fail'; });
      const missing = checks.filter(function (c) { return c.status === 'missing'; });
      const s = score(r);
      const entry = { row: r, score: s.total, parts: s.parts, checks: checks, failed: failed, missing: missing };
      if (!failed.length && !missing.length) { out.passed.push(entry); }
      else if (!failed.length && missing.length) { out.stats.missingOnly++; }
      else if (failed.length === 1 && !missing.length && failed[0].key !== 'lossMaking') { out.near.push(entry); }
    });
    const byScore = function (a, b) {
      const x = a.score === null ? -1 : a.score, y = b.score === null ? -1 : b.score;
      return (y - x) || (a.row.symbol < b.row.symbol ? -1 : 1);
    };
    out.passed.sort(byScore);
    out.near.sort(byScore);
    out.stats.passed = out.passed.length;
    return out;
  }

  // Các mã trong rổ chưa có trong bảng
  function missingFromUniverse(universeKey, haveSymbols) {
    const u = UNIVERSES.find(function (x) { return x.key === universeKey; });
    if (!u) return [];
    const have = new Set((haveSymbols || []).map(function (s) { return String(s).toUpperCase(); }));
    return u.symbols.filter(function (s) { return !have.has(s); });
  }

  // Văn bản mô tả 1 tiêu chí đang bật: "ROE ≥ 15%"
  function describe(key, threshold) {
    const c = CRITERIA_BY_KEY[key];
    if (!c) return key;
    const n = Number(threshold).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
    return c.label.replace(/ (tối thiểu|tối đa)$/, '') + ' ' + (c.op === 'min' ? '≥' : '≤') + ' ' + n + (c.unit || '');
  }

  return { CRITERIA, CRITERIA_BY_KEY, PRESETS, UNIVERSES, DEFAULT_FILTERS, WEIGHTS, rowsFrom, score, normalizeFilters, evaluate, missingFromUniverse, describe, median };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Screener;
