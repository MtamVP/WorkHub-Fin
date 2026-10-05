// Logic thuần của VALUATION BENCH: BỐI CẢNH THỊ TRƯỜNG quanh một cổ phiếu -- xu hướng VN-Index (từ phân tích kỹ thuật), mặt bằng định giá thị trường so với lịch sử, phần bù cổ phiếu so với trái phiếu chính phủ,
// định giá và vòng quay sức mạnh của ngành, sức mạnh tương đối của chính cổ phiếu, dòng tiền khối ngoại và thanh khoản. Gom thành điểm −100..+100 (gió thuận / gió ngược) kèm từng yếu tố có số liệu.
// Đây là bối cảnh, không phải dự báo: thị trường thuận lợi không làm một cổ phiếu xấu thành tốt. Yếu tố thiếu số liệu bị bỏ qua (không đoán) và không tính vào điểm.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global VBMarket) và module.exports cho Vitest. Cần ValuationHistory (lib/valuation-history.js) và tuỳ chọn QuantCalc (vòng quay JdK).
const VBMarket = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const VH = (typeof require === 'function' && typeof module !== 'undefined') ? require('./valuation-history.js') : (typeof ValuationHistory !== 'undefined' ? ValuationHistory : null);
  const f = (x, d) => (x === null || x === undefined ? '—' : (Math.round(x * Math.pow(10, d === undefined ? 1 : d)) / Math.pow(10, d === undefined ? 1 : d)).toString().replace('.', ','));

  // Vòng quay JdK từ RS-Ratio và RS-Momentum (100 = ngang thị trường): Dẫn đầu / Suy yếu / Tụt hậu / Cải thiện
  function rotation(rs, mom) {
    const a = num(rs), b = num(mom);
    if (a === null || b === null) return null;
    if (a >= 100 && b >= 100) return { key: 'leading', label: 'Dẫn đầu', tone: 'ok' };
    if (a >= 100) return { key: 'weakening', label: 'Suy yếu', tone: 'mute' };
    if (b >= 100) return { key: 'improving', label: 'Cải thiện', tone: 'mute' };
    return { key: 'lagging', label: 'Tụt hậu', tone: 'warn' };
  }

  // ctx: {
  //   indexTech: kết quả VBTechnical.analyze của VN-Index (hoặc null),
  //   histRows: finance_valuation_history, bond10yPct, sectorCode, sectorName,
  //   sectorStats: stats ngành { jdkRs: { median }, jdkMom: { median } },
  //   stock: { relativeStrength (từ VBTechnical.analyze), metrics (finance_market_snapshot.metrics: foreign..., advValue20, beta, jdkRs, jdkMom) }
  // }
  function context(ctx) {
    const c = ctx || {}, factors = [], flags = [];
    const add = (key, label, score, weight, detail) => factors.push({ key: key, label: label, score: clamp(score, -1, 1), weight: weight, state: score > 0.15 ? 'bull' : (score < -0.15 ? 'bear' : 'neutral'), detail: detail });
    // 1. xu hướng thị trường chung
    if (c.indexTech && c.indexTech.ok && c.indexTech.score !== null) add('index', 'Xu hướng VN-Index', c.indexTech.score / 100, 3, 'Điểm kỹ thuật VN-Index ' + f(c.indexTech.score, 0) + ' (' + (c.indexTech.rating ? c.indexTech.rating.label : '—') + '), RSI ' + f(c.indexTech.latest.rsi, 0) + ', giá ' + (c.indexTech.latest.sma200 && c.indexTech.price > c.indexTech.latest.sma200 ? 'trên' : 'dưới') + ' SMA200.');
    // 2-3. định giá thị trường và phần bù
    let marketVal = null, spread = null;
    if (VH && c.histRows && c.histRows.length) {
      marketVal = VH.summarize(VH.seriesOf(c.histRows, 'ALL', 'pe_agg'), { years: 5 });
      if (marketVal && marketVal.enough) {
        add('market-val', 'Mặt bằng định giá thị trường', (50 - marketVal.pct) / 50, 2, 'P/E tổng hợp thị trường ' + f(marketVal.now, 1) + 'x ở phân vị ' + f(marketVal.pct, 0) + ' trong 5 năm (trung bình ' + f(marketVal.mean, 1) + 'x): ' + (marketVal.pct <= 40 ? 'rẻ so với lịch sử, có lợi cho người mua mới.' : (marketVal.pct >= 60 ? 'đắt so với lịch sử, biên an toàn của thị trường mỏng hơn.' : 'quanh trung bình.')));
        spread = VH.earningsYieldSpread(marketVal.now, c.bond10yPct);
        if (spread && spread.spreadPct !== null) add('spread', 'Phần bù cổ phiếu so với trái phiếu', clamp((spread.spreadPct - 2) / 4, -1, 1), 1, 'Lợi suất lợi nhuận ' + f(spread.earningsYieldPct, 1) + '% so với trái phiếu 10 năm ' + f(spread.bondPct, 2) + '%: phần bù ' + f(spread.spreadPct, 1) + ' điểm %.');
      }
    }
    // 4. ngành
    let sectorVal = null;
    if (VH && c.histRows && c.sectorCode) {
      sectorVal = VH.summarize(VH.seriesOf(c.histRows, c.sectorCode, 'pe_agg'), { years: 5 });
      if (sectorVal && sectorVal.enough) add('sector-val', 'Định giá ngành ' + (c.sectorName || c.sectorCode) + ' so với lịch sử', (50 - sectorVal.pct) / 50, 1, 'P/E tổng hợp của ngành ở phân vị ' + f(sectorVal.pct, 0) + ' trong 5 năm (nay ' + f(sectorVal.now, 1) + 'x, trung bình ' + f(sectorVal.mean, 1) + 'x).');
    }
    const st = c.sectorStats || {};
    const rot = rotation(st.jdkRs && st.jdkRs.median, st.jdkMom && st.jdkMom.median);
    if (rot) add('sector-rot', 'Vòng quay sức mạnh của ngành', rot.key === 'leading' ? 1 : (rot.key === 'improving' ? 0.4 : (rot.key === 'weakening' ? -0.2 : -1)), 1.5, 'Ngành đang ở nhóm "' + rot.label + '" so với thị trường (RS-Ratio ' + f(st.jdkRs.median, 1) + ', RS-Momentum ' + f(st.jdkMom.median, 1) + ').');
    // 5. sức mạnh tương đối của cổ phiếu
    const rs = c.stock && c.stock.relativeStrength;
    if (rs && (rs.excess3m !== null || rs.excess6m !== null)) {
      const e3 = rs.excess3m !== null ? rs.excess3m : 0, e6 = rs.excess6m !== null ? rs.excess6m : e3;
      add('stock-rs', 'Sức mạnh tương đối của cổ phiếu so với VN-Index', clamp((e3 * 0.5 + e6 * 0.5) / 0.15, -1, 1), 1.5, 'Vượt/thua VN-Index: 1 tháng ' + f(rs.excess1m === null ? null : rs.excess1m * 100, 1) + '%, 3 tháng ' + f(rs.excess3m === null ? null : rs.excess3m * 100, 1) + '%, 6 tháng ' + f(rs.excess6m === null ? null : rs.excess6m * 100, 1) + '%, 12 tháng ' + f(rs.excess12m === null ? null : rs.excess12m * 100, 1) + '%.');
    }
    // 6. dòng tiền khối ngoại và thanh khoản
    const m = (c.stock && c.stock.metrics) || {};
    if (num(m.foreignNet5d) !== null && num(m.advValue20) > 0) {
      const ratio = m.foreignNet5d / (m.advValue20 * 5);
      add('foreign', 'Dòng tiền khối ngoại 5 phiên', clamp(ratio / 0.1, -1, 1), 1, 'Khối ngoại ' + (m.foreignNet5d >= 0 ? 'mua ròng ' : 'bán ròng ') + f(Math.abs(m.foreignNet5d) / 1e9, 1) + ' tỷ trong 5 phiên (' + f(ratio * 100, 1) + '% giá trị giao dịch).');
    }
    if (num(m.advValue20) !== null) {
      if (m.advValue20 < 1e9) flags.push({ tone: 'warn', text: 'Thanh khoản thấp (' + f(m.advValue20 / 1e9, 2) + ' tỷ/ngày): tín hiệu kỹ thuật nhiễu và khó vào/ra vị thế lớn.' });
      else if (m.advValue20 < 5e9) flags.push({ tone: 'mute', text: 'Thanh khoản vừa phải (' + f(m.advValue20 / 1e9, 1) + ' tỷ/ngày): cân nhắc chia nhỏ lệnh.' });
    }
    if (num(m.beta) !== null && m.beta > 1.4) flags.push({ tone: 'mute', text: 'Beta ' + f(m.beta, 2) + ' cao: giá biến động mạnh hơn thị trường chung (cả lên lẫn xuống).' });
    if (num(m.foreignRoomLeftPct) !== null && m.foreignRoomLeftPct < 3) flags.push({ tone: 'mute', text: 'Room ngoại còn ' + f(m.foreignRoomLeftPct, 1) + '%: dư địa khối ngoại mua thêm hạn chế.' });

    let tw = 0, ts = 0; factors.forEach(function (x) { tw += x.weight; ts += x.score * x.weight; });
    const score = tw > 0 ? ts / tw * 100 : null;
    const trendLabel = c.indexTech && c.indexTech.ok && c.indexTech.rating ? c.indexTech.rating.label : null;
    const regime = score === null ? null : (score >= 30 ? { key: 'tailwind', label: 'Gió thuận', tone: 'ok' } : (score <= -30 ? { key: 'headwind', label: 'Gió ngược', tone: 'warn' } : { key: 'mixed', label: 'Hỗn hợp', tone: 'mute' }));
    return { score: score, regime: regime, factors: factors, flags: flags, marketValuation: marketVal, sectorValuation: sectorVal, spread: spread, rotation: rot, indexTrend: trendLabel, count: factors.length };
  }

  return { rotation, context };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VBMarket;
