// Logic thuần của VALUATION BENCH: TỔNG HỢP ĐỊNH GIÁ -- gom nhiều phương pháp định giá (dòng tiền chiết khấu, bội số ngang hàng, bội số lịch sử, thu nhập thặng dư, tài sản, cổ tức...) thành một dải giá trị và giá trị đồng thuận,
// rồi KẾT HỢP với phân tích kỹ thuật (thời điểm) và bối cảnh thị trường để ra kết luận có giải thích: giá đang rẻ/đắt so với giá trị ước tính, biên an toàn, vùng giá tham khảo, độ tin cậy và các cờ cần soát.
// Nguyên tắc minh bạch: mỗi phương pháp có trọng số hiển thị công khai (theo loại doanh nghiệp, người dùng chỉnh được), giá trị đồng thuận là TRUNG VỊ có trọng số (bền với phương pháp lệch xa), độ tin cậy giảm khi các phương pháp bất đồng,
// khi dữ liệu thiếu hoặc khi điểm chất lượng (Altman/Beneish/Piotroski) báo động. Kết luận kết hợp là bảng quy tắc cố định, không phải mô hình hộp đen.
// Đây là công cụ phân tích, KHÔNG phải khuyến nghị đầu tư: mọi giá trị ước tính rất nhạy với giả định; "rẻ" có thể là bẫy giá trị, "đắt" có thể kéo dài. KHÔNG đụng DOM/mạng/Supabase.
// Nạp bằng thẻ <script> thường (global VBSynthesis) và module.exports cho Vitest.
const VBSynthesis = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const f = (x, d) => (x === null || x === undefined ? '—' : (Math.round(x * Math.pow(10, d === undefined ? 0 : d)) / Math.pow(10, d === undefined ? 0 : d)).toLocaleString('vi-VN', { minimumFractionDigits: d === undefined ? 0 : d, maximumFractionDigits: d === undefined ? 0 : d }));

  // Trọng số mặc định theo loại doanh nghiệp (khoá phương pháp -> trọng số). 0 = hiển thị nhưng không tính vào giá trị đồng thuận.
  const WEIGHTS = {
    NON_FINANCE: { dcf: 3, 'peer-pe': 1.5, 'peer-pb': 0.4, 'peer-ps': 0.3, 'peer-evEbitda': 1.5, 'peer-evSales': 0.3, 'hist-pe': 1.5, 'hist-pb': 0.4, epv: 1, graham: 0.4, grahamGrowth: 0.3, lynch: 0.4, ddm: 0.3, nav: 0.4, sotp: 1, fcfe: 1, ri: 0, 'justified-pb': 0, ncav: 0 },
    BANK: { ri: 3, 'justified-pb': 2, fcfe: 1.5, 'peer-pb': 2, 'peer-pe': 1.5, 'hist-pb': 2, 'hist-pe': 1.5, ddm: 1, graham: 0.5, nav: 0, dcf: 0 },
    SECURITIES: { ri: 2.5, 'justified-pb': 2, fcfe: 1, 'peer-pb': 2, 'peer-pe': 1.5, 'hist-pb': 2, 'hist-pe': 1.5, ddm: 1, graham: 0.5, dcf: 0 },
    INSURANCE: { ri: 2.5, 'justified-pb': 2, fcfe: 1, 'peer-pb': 2, 'peer-pe': 1.5, 'hist-pb': 2, 'hist-pe': 1.5, ddm: 1, graham: 0.5, dcf: 0 },
  };
  const GROUP_LABEL = { intrinsic: 'Giá trị nội tại', relative: 'So sánh bội số', asset: 'Tài sản và thu nhập', income: 'Cổ tức và lợi suất' };

  function weightedMedian(items) {      // items: [{ v, w }]
    const a = items.filter(function (x) { return x.v !== null && x.w > 0; }).sort(function (x, y) { return x.v - y.v; });
    if (!a.length) return null;
    const tot = a.reduce(function (s, x) { return s + x.w; }, 0); let acc = 0;
    for (let i = 0; i < a.length; i++) { acc += a[i].w; if (acc >= tot / 2) { if (acc === tot / 2 && a[i + 1]) return (a[i].v + a[i + 1].v) / 2; return a[i].v; } }
    return a[a.length - 1].v;
  }
  function weightedMean(items) { const a = items.filter(function (x) { return x.v !== null && x.w > 0; }); const tot = a.reduce(function (s, x) { return s + x.w; }, 0); return tot > 0 ? a.reduce(function (s, x) { return s + x.v * x.w; }, 0) / tot : null; }

  // Chuẩn hoá danh sách phương pháp: giữ phương pháp có giá trị cơ sở dương, gán trọng số (mặc định theo loại, hoặc người dùng ghi đè) và nhãn nhóm.
  function prepare(methods, form, overrides) {
    const wt = WEIGHTS[form] || WEIGHTS.NON_FINANCE, ov = overrides || {};
    return (methods || []).filter(function (m) { return m && num(m.base) !== null && m.base > 0; }).map(function (m) {
      const key = m.key, def = wt[key] !== undefined ? wt[key] : (key.indexOf('peer-') === 0 || key.indexOf('hist-') === 0 ? 0.5 : 0.3);
      const w = ov[key] !== undefined && num(ov[key]) !== null ? Math.max(0, num(ov[key])) : def;
      const lo = num(m.low) > 0 ? m.low : m.base * 0.85, hi = num(m.high) > 0 ? m.high : m.base * 1.15;
      return Object.assign({}, m, { weight: w, defaultWeight: def, low: Math.min(lo, m.base), high: Math.max(hi, m.base), groupLabel: GROUP_LABEL[m.group] || m.group });
    });
  }

  // synth: { price, form, methods, weightOverrides, quality: { piotroski, altman, beneish, accruals }, technical, market, settings: { marginOfSafety (0..0.6, mặc định 0.2) }, implied (kết quả VBDcf.implied), cagr3 }
  function synthesize(inp) {
    const x = inp || {}, price = num(x.price), form = x.form || 'NON_FINANCE', set = Object.assign({ marginOfSafety: 0.2 }, x.settings || {});
    const methods = prepare(x.methods, form, x.weightOverrides), active = methods.filter(function (m) { return m.weight > 0; });
    const out = { price: price, form: form, methods: methods, active: active.length, flags: [], reasons: { pos: [], neg: [] } };
    if (!active.length || !(price > 0)) { out.ok = false; out.reason = !(price > 0) ? 'Thiếu giá hiện tại.' : 'Chưa có phương pháp nào cho giá trị hợp lệ.'; return out; }
    const base = weightedMedian(active.map(function (m) { return { v: m.base, w: m.weight }; }));
    let low = weightedMean(active.map(function (m) { return { v: m.low, w: m.weight }; })), high = weightedMean(active.map(function (m) { return { v: m.high, w: m.weight }; }));
    low = Math.min(low, base); high = Math.max(high, base);
    // độ phân tán giữa các phương pháp
    const mean = weightedMean(active.map(function (m) { return { v: m.base, w: m.weight }; }));
    const varw = active.reduce(function (s, m) { return s + m.weight * (m.base - mean) * (m.base - mean); }, 0) / active.reduce(function (s, m) { return s + m.weight; }, 0);
    const cv = mean > 0 ? Math.sqrt(varw) / mean : null;
    active.forEach(function (m) { m.outlier = m.base > base * 2.5 || m.base < base * 0.4; if (m.outlier) out.flags.push({ tone: 'mute', text: m.label + ' (' + f(m.base) + ' đ) lệch xa giá trị đồng thuận ' + f(base) + ' đ: kiểm tra giả định hoặc mẫu số của phương pháp này.' }); });
    methods.forEach(function (m) { if (m.weight === 0) m.outlier = false; });
    // độ tin cậy
    let conf = 100; const why = [];
    if (active.length < 3) { conf -= 25; why.push('chỉ ' + active.length + ' phương pháp được dùng'); } else if (active.length < 5) { conf -= 10; }
    if (cv !== null) { if (cv > 0.45) { conf -= 35; why.push('các phương pháp bất đồng lớn (độ phân tán ' + Math.round(cv * 100) + '%)'); } else if (cv > 0.25) { conf -= 22; why.push('các phương pháp khá lệch nhau (độ phân tán ' + Math.round(cv * 100) + '%)'); } else if (cv > 0.15) conf -= 8; }
    const q = x.quality || {};
    if (q.altman && q.altman.zone2 && q.altman.zone2.key === 'distress') { conf -= 20; why.push('Altman Z báo nguy cơ tài chính'); out.flags.push({ tone: 'warn', text: 'Altman Z" ở vùng nguy cơ: định giá dựa trên dòng tiền tương lai kém đáng tin nếu doanh nghiệp gặp áp lực nợ.' }); }
    if (q.beneish && q.beneish.flag && q.beneish.flag.key === 'risk') { conf -= 15; why.push('Beneish M-score có dấu hiệu cần soát'); out.flags.push({ tone: 'warn', text: 'Beneish M-score ' + f(q.beneish.m, 2) + ' vượt ngưỡng −1,78: cần soát chất lượng lợi nhuận trước khi tin các phương pháp dựa trên lợi nhuận.' }); }
    if (q.accruals && q.accruals.flag && q.accruals.flag.tone === 'warn') { conf -= 5; out.flags.push({ tone: 'warn', text: q.accruals.flag.label + ' (' + f(q.accruals.value * 100, 1) + '% tài sản).' }); }
    if (q.piotroski && q.piotroski.grade && q.piotroski.grade.key === 'weak') { conf -= 5; out.flags.push({ tone: 'mute', text: 'Piotroski F-score ' + q.piotroski.score + '/' + q.piotroski.available + ' yếu: các chỉ báo về xu hướng sinh lời và đòn bẩy đang xấu đi so với năm trước.' }); }
    conf = clamp(conf, 5, 100);
    const confidence = conf >= 75 ? { key: 'high', label: 'Cao', tone: 'ok' } : (conf >= 50 ? { key: 'mid', label: 'Vừa', tone: 'mute' } : { key: 'low', label: 'Thấp', tone: 'warn' });
    // so với giá
    const ratio = price / base, mos = 1 - ratio;
    const grade = ratio <= 0.7 ? { key: 'deep', label: 'Rẻ rõ rệt so với giá trị ước tính', tone: 'ok' } : (ratio <= 0.9 ? { key: 'cheap', label: 'Rẻ so với giá trị ước tính', tone: 'ok' } : (ratio <= 1.1 ? { key: 'fair', label: 'Quanh giá trị ước tính', tone: 'mute' } : (ratio <= 1.3 ? { key: 'rich', label: 'Cao hơn giá trị ước tính', tone: 'warn' } : { key: 'expensive', label: 'Đắt so với giá trị ước tính', tone: 'warn' })));
    const valScore = clamp(mos / 0.4, -1, 1) * 100;
    // kết hợp
    const tech = x.technical && x.technical.ok ? x.technical : null, mkt = x.market && x.market.score !== null && x.market.score !== undefined ? x.market : null;
    const parts = [{ k: 'valuation', w: 0.5, s: valScore }, { k: 'technical', w: 0.3, s: tech ? tech.score : null }, { k: 'market', w: 0.2, s: mkt ? mkt.score : null }].filter(function (p) { return p.s !== null; });
    const tw = parts.reduce(function (s, p) { return s + p.w; }, 0), composite = parts.reduce(function (s, p) { return s + p.s * p.w; }, 0) / tw;
    const cheap = ratio <= 0.9, expensive = ratio > 1.1, techGood = tech && tech.score >= 20, techBad = tech && tech.score <= -20, mktGood = mkt && mkt.score >= 30, mktBad = mkt && mkt.score <= -30;
    let stance;
    if (cheap && techGood && !mktBad) stance = { key: 'converge-pos', label: 'Định giá và giá cùng thuận lợi', tone: 'ok', text: 'Giá thấp hơn giá trị ước tính và xu hướng giá đang ủng hộ' + (mktGood ? ', thị trường chung cũng thuận' : '') + ': các tín hiệu hội tụ theo hướng thuận lợi. Vẫn cần kiểm tra giả định và quản trị rủi ro vị thế.' };
    else if (cheap && techBad) stance = { key: 'value-trap-risk', label: 'Rẻ nhưng giá chưa xác nhận', tone: 'mute', text: 'Giá thấp hơn giá trị ước tính nhưng xu hướng giá đang xấu: có thể thị trường đã nhìn thấy điều mô hình chưa thấy (bẫy giá trị). Cân nhắc chờ tín hiệu cải thiện hoặc chia nhỏ lệnh, và kiểm tra lại lợi nhuận.' };
    else if (cheap) stance = { key: 'cheap-neutral', label: 'Rẻ, xu hướng giá chưa rõ', tone: 'mute', text: 'Giá thấp hơn giá trị ước tính; xu hướng giá chưa ủng hộ hay phản đối rõ. Thời điểm vào lệnh không có lợi thế kỹ thuật rõ ràng.' };
    else if (expensive && techGood) stance = { key: 'momentum-expensive', label: 'Đà tăng đang chạy nhưng giá đã cao', tone: 'warn', text: 'Giá cao hơn giá trị ước tính trong khi xu hướng giá còn tốt: đà có thể tiếp diễn, nhưng biên an toàn mỏng và rủi ro đảo chiều lớn nếu kỳ vọng hụt.' };
    else if (expensive && techBad) stance = { key: 'converge-neg', label: 'Định giá và giá cùng bất lợi', tone: 'warn', text: 'Giá cao hơn giá trị ước tính và xu hướng giá đang xấu: các tín hiệu hội tụ theo hướng bất lợi.' };
    else if (expensive) stance = { key: 'expensive-neutral', label: 'Giá cao hơn giá trị ước tính', tone: 'warn', text: 'Giá cao hơn giá trị ước tính; xu hướng giá chưa rõ. Biên an toàn mỏng.' };
    else stance = { key: 'fair', label: 'Giá quanh giá trị ước tính', tone: 'mute', text: 'Giá nằm trong vùng giá trị ước tính; kết luận phụ thuộc nhiều vào kỳ vọng tăng trưởng và xu hướng giá.' + (techGood ? ' Xu hướng giá đang ủng hộ.' : (techBad ? ' Xu hướng giá đang bất lợi.' : '')) };
    if (mktBad && (stance.key === 'converge-pos' || stance.key === 'cheap-neutral')) stance.text += ' Lưu ý bối cảnh thị trường chung đang gió ngược.';
    // lý do chính (cho người đọc nhanh)
    if (mos >= 0.1) out.reasons.pos.push('Giá thấp hơn giá trị đồng thuận ' + Math.round(mos * 100) + '% (' + f(price) + ' so với ' + f(base) + ' đ).'); else if (mos <= -0.1) out.reasons.neg.push('Giá cao hơn giá trị đồng thuận ' + Math.round(-mos * 100) + '% (' + f(price) + ' so với ' + f(base) + ' đ).');
    if (tech) (tech.score >= 20 ? out.reasons.pos : (tech.score <= -20 ? out.reasons.neg : [])).push('Kỹ thuật: ' + tech.rating.label + ' (điểm ' + f(tech.score, 0) + ').');
    if (mkt) (mkt.score >= 30 ? out.reasons.pos : (mkt.score <= -30 ? out.reasons.neg : [])).push('Thị trường: ' + mkt.regime.label + ' (điểm ' + f(mkt.score, 0) + ').');
    if (q.piotroski && q.piotroski.grade) (q.piotroski.grade.key === 'strong' ? out.reasons.pos : (q.piotroski.grade.key === 'weak' ? out.reasons.neg : [])).push('Piotroski F-score ' + q.piotroski.score + '/' + q.piotroski.available + ' (' + q.piotroski.grade.label.toLowerCase() + ').');
    if (q.altman && q.altman.zone2 && q.altman.zone2.key === 'safe') out.reasons.pos.push('Altman Z" ở vùng an toàn (' + f(q.altman.z2, 2) + ').');
    // vùng giá tham khảo
    const sup = tech && tech.levels && tech.levels.supports && tech.levels.supports.length ? tech.levels.supports : [];
    const atr = tech && tech.latest ? tech.latest.atr : null;
    const accHigh = base * (1 - clamp(num(set.marginOfSafety) === null ? 0.2 : set.marginOfSafety, 0, 0.6));
    let accLow = low * 0.9; const supInZone = sup.filter(function (s) { return s.price <= accHigh && s.price >= accLow * 0.9; });
    if (supInZone.length) accLow = Math.max(accLow, supInZone[0].price - (atr || 0) * 0.5);
    accLow = Math.min(accLow, accHigh * 0.95);
    const strongSup = sup.length ? sup.slice().sort(function (a, b) { return (b.strength || 0) - (a.strength || 0); })[0] : null;
    const stop = strongSup ? strongSup.price - (atr || strongSup.price * 0.02) : (tech && tech.levels ? tech.levels.low52 : null);
    const resist = tech && tech.levels && tech.levels.resistances ? tech.levels.resistances : [];
    const zones = {
      accumulate: { low: accLow, high: accHigh, label: 'Vùng tích lũy tham khảo', note: 'Từ ' + f(accLow) + ' đến ' + f(accHigh) + ' đ: thấp hơn giá trị đồng thuận ít nhất ' + Math.round(clamp(num(set.marginOfSafety) === null ? 0.2 : set.marginOfSafety, 0, 0.6) * 100) + '% (biên an toàn đặt trước)' + (supInZone.length ? ', có hỗ trợ kỹ thuật ' + f(supInZone[0].price) + ' đ.' : '.') },
      fair: { low: low, high: high, label: 'Vùng giá trị hợp lý', note: 'Dải ước tính ' + f(low) + ' - ' + f(high) + ' đ (trung bình có trọng số của các phương pháp).' },
      trim: { low: high, high: null, label: 'Vùng cân nhắc giảm tỷ trọng', note: 'Từ ' + f(high) + ' đ trở lên giá đã vượt dải giá trị ước tính' + (resist.length ? '; kháng cự kỹ thuật gần nhất ' + f(resist[0].price) + ' đ.' : '.') },
      invalidation: { price: stop, label: 'Mức vô hiệu kỹ thuật tham khảo', note: stop ? 'Giá đóng cửa dưới ' + f(stop) + ' đ (dưới hỗ trợ mạnh một ATR) làm luận điểm kỹ thuật yếu đi.' : null },
    };
    zones.position = price < accLow ? 'below' : (price <= accHigh ? 'accumulate' : (price <= high ? 'fair' : 'trim'));
    // "điều gì phải đúng"
    const must = [];
    if (x.implied && x.implied.impliedGrowthStage1 !== null && x.implied.impliedGrowthStage1 !== undefined) {
      must.push('Giá hiện tại ngầm định tăng trưởng doanh thu khoảng ' + f(x.implied.impliedGrowthStage1 * 100, 1) + '%/năm trong giai đoạn đầu (DCF ngược), so với giả định cơ sở ' + f(x.implied.baseGrowthStage1 * 100, 1) + '%' + (num(x.cagr3) !== null ? ' và CAGR doanh thu 3 năm ' + f(x.cagr3 * 100, 1) + '%' : '') + '.');
      if (x.implied.impliedWacc !== null) must.push('Hoặc thị trường đang chiết khấu ở WACC khoảng ' + f(x.implied.impliedWacc * 100, 1) + '% (giả định cơ sở ' + f((x.implied.baseWacc || 0) * 100, 1) + '%).');
    }
    return Object.assign(out, { ok: true, fair: { low: low, base: base, high: high, mean: mean }, cv: cv, confidence: confidence, confidenceScore: conf, confidenceWhy: why, ratio: ratio, marginOfSafety: mos, grade: grade, valuationScore: valScore, technicalScore: tech ? tech.score : null, marketScore: mkt ? mkt.score : null,
      composite: composite, stance: stance, zones: zones, mustBeTrue: must, range: rangeOf(methods, price, low, high) });
  }

  // Khoảng giá hiển thị biểu đồ "football field": min/max của mọi phương pháp, giá hiện tại và dải đồng thuận
  function rangeOf(methods, price, low, high) {
    let lo = Math.min(price, low), hi = Math.max(price, high);
    methods.forEach(function (m) { lo = Math.min(lo, m.low); hi = Math.max(hi, m.high); });
    return { min: Math.max(0, lo * 0.9), max: hi * 1.1 };
  }

  return { WEIGHTS, GROUP_LABEL, weightedMedian, weightedMean, prepare, synthesize };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VBSynthesis;
