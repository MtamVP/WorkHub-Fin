// Logic thuần: CẢNH BÁO ĐỊNH GIÁ -- gom các tín hiệu "thị trường / ngành đang nắm đang đắt hoặc rẻ so với CHÍNH LỊCH SỬ của nó" thành một danh sách ngắn, ưu tiên cái cần xem trước.
// Dùng lib/valuation-history.js (phân vị P/E, P/B tổng hợp theo vốn hoá trong 5 năm). Chỉ tính trên dữ liệu đã tải, KHÔNG đụng DOM/mạng/Supabase.
// Nạp bằng thẻ <script> thường (global ValuationAlerts) và module.exports cho Vitest. Cần ValuationHistory nạp trước.
// Cảnh báo là tín hiệu để xem xét, không phải lệnh: "rẻ so với lịch sử" có thể là bẫy giá trị (lợi nhuận đi xuống), "đắt" có thể kéo dài nhiều năm.
const ValuationAlerts = (function () {
  const VH = (typeof require === 'function' && typeof module !== 'undefined') ? require('./valuation-history.js') : ValuationHistory;
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const DEFAULTS = { years: 5, hi: 80, lo: 20, minWeightPct: 10, concentrationPct: 20, shiftPts: 20, shiftDays: 91 };
  const r0 = (x) => Math.round(x);
  const fx = (x) => (Math.round(x * (x < 5 ? 100 : 10)) / (x < 5 ? 100 : 10)).toString().replace('.', ',') + 'x';

  // Phân vị tại thời điểm cách điểm cuối `days` ngày (cắt chuỗi rồi tính lại), để biết định giá vừa dịch chuyển bao nhiêu
  function pctBack(series, years, days) {
    if (!series || !series.length) return null;
    const last = series[series.length - 1].d;
    const cut = new Date(Date.parse(last + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
    const s = series.filter((x) => x.d <= cut);
    const sum = s.length ? VH.summarize(s, { years }) : null;
    return sum && sum.enough ? sum.pct : null;
  }

  // histRows: finance_valuation_history; sectors: [{ code, name, weightPct }] (tỷ trọng danh mục theo ngành ICB); opts.bond10yPct (tuỳ chọn)
  function build(histRows, sectors, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const out = [];
    const add = (a) => out.push(a);
    const sum = (scope, key) => VH.summarize(VH.seriesOf(histRows, scope, key), { years: o.years });
    const peM = sum('ALL', 'pe_agg'), pbM = sum('ALL', 'pb_agg'), peMed = sum('ALL', 'pe_median');

    // 1. Mặt bằng thị trường
    [['P/E', peM, 'pe_agg'], ['P/B', pbM, 'pb_agg']].forEach((t) => {
      const s = t[1];
      if (!s || !s.enough) return;
      const prev = pctBack(VH.seriesOf(histRows, 'ALL', t[2]), o.years, o.shiftDays);
      if (s.pct >= o.hi) add({ key: 'market-rich-' + t[0], level: 'warn', scope: 'Thị trường', title: 'Thị trường đắt so với lịch sử (' + t[0] + ')', detail: t[0] + ' tổng hợp ' + fx(s.now) + ', phân vị ' + r0(s.pct) + ' trong ' + o.years + ' năm (trung bình ' + fx(s.mean) + '). Cân nhắc giảm tỷ lệ mua mới, không phải lý do bán ngay.' });
      else if (s.pct <= o.lo) add({ key: 'market-cheap-' + t[0], level: 'info', scope: 'Thị trường', title: 'Thị trường rẻ so với lịch sử (' + t[0] + ')', detail: t[0] + ' tổng hợp ' + fx(s.now) + ', phân vị ' + r0(s.pct) + ' trong ' + o.years + ' năm (trung bình ' + fx(s.mean) + '). Rẻ có thể do lợi nhuận sắp đi xuống: kiểm tra triển vọng lợi nhuận.' });
      if (prev !== null && Math.abs(s.pct - prev) >= o.shiftPts) add({ key: 'market-shift-' + t[0], level: 'info', scope: 'Thị trường', title: 'Định giá thị trường dịch chuyển nhanh (' + t[0] + ')', detail: 'Phân vị ' + t[0] + ' ' + (s.pct > prev ? 'tăng' : 'giảm') + ' từ ' + r0(prev) + ' lên ' + r0(s.pct) + ' trong khoảng ' + Math.round(o.shiftDays / 30) + ' tháng.' });
    });
    // Chênh lệch giữa cổ phiếu vốn hoá lớn và mã trung vị
    if (peM && peM.enough && peMed && peMed.enough && Math.abs(peM.pct - peMed.pct) >= 40) {
      add({ key: 'breadth', level: 'info', scope: 'Thị trường', title: peM.pct > peMed.pct ? 'Đắt ở nhóm vốn hoá lớn, mã trung vị còn bình thường' : 'Rẻ ở nhóm vốn hoá lớn, mã trung vị lại đắt hơn',
        detail: 'P/E tổng hợp theo vốn hoá ở phân vị ' + r0(peM.pct) + ' còn P/E trung vị của các mã ở phân vị ' + r0(peMed.pct) + ': mặt bằng bị kéo bởi một số mã lớn, không phải cả thị trường.' });
    }
    const spread = VH.earningsYieldSpread(peM && peM.now, o.bond10yPct);
    if (spread && spread.spreadPct !== null && spread.spreadPct < 0) add({ key: 'spread', level: 'warn', scope: 'Thị trường', title: 'Lợi suất lợi nhuận thấp hơn trái phiếu 10 năm', detail: 'Lợi suất lợi nhuận (1/P/E) ' + (Math.round(spread.earningsYieldPct * 10) / 10) + '% so với trái phiếu chính phủ 10 năm ' + (Math.round(spread.bondPct * 100) / 100) + '%: cổ phiếu không còn phần bù so với trái phiếu.' });

    // 2. Ngành đang nắm (chỉ ngành có tỷ trọng đủ lớn)
    let richPct = 0, cheapPct = 0;
    (sectors || []).forEach((sc) => {
      const w = num(sc.weightPct);
      if (w === null || w <= 0) return;
      const pe = sum(sc.code, 'pe_agg'), pb = sum(sc.code, 'pb_agg'), nm = sc.name || ('ICB ' + sc.code);
      if (pe && pe.enough) { if (pe.pct >= o.hi) richPct += w; else if (pe.pct <= o.lo) cheapPct += w; }
      if (w < o.minWeightPct) return;
      const dir = (s) => (s && s.enough ? (s.pct >= o.hi ? 'rich' : (s.pct <= o.lo ? 'cheap' : null)) : null);
      const dPe = dir(pe), dPb = dir(pb);
      const stat = (s, met) => met + ' tổng hợp ' + fx(s.now) + ', phân vị ' + r0(s.pct) + ' (trung bình ' + fx(s.mean) + ')';
      const mk = (d, key, met, detail) => add(d === 'rich'
        ? { key: 'sector-rich-' + key, level: 'warn', scope: nm, title: 'Ngành ' + nm + ' đắt so với lịch sử (' + met + ')', detail: 'Chiếm ' + r0(w) + '% danh mục; ' + detail + '.' }
        : { key: 'sector-cheap-' + key, level: 'info', scope: nm, title: 'Ngành ' + nm + ' rẻ so với lịch sử (' + met + ')', detail: 'Chiếm ' + r0(w) + '% danh mục; ' + detail + '. Xem lợi nhuận ngành có đang giảm không.' });
      if (dPe && dPe === dPb) mk(dPe, sc.code, 'P/E và P/B', stat(pe, 'P/E') + '; ' + stat(pb, 'P/B'));
      else { if (dPe) mk(dPe, sc.code + '-P/E', 'P/E', stat(pe, 'P/E')); if (dPb) mk(dPb, sc.code + '-P/B', 'P/B', stat(pb, 'P/B')); }
    });
    if (richPct >= o.concentrationPct) add({ key: 'concentration-rich', level: 'warn', scope: 'Danh mục', title: 'Nhiều danh mục nằm trong ngành đang đắt', detail: r0(richPct) + '% danh mục thuộc ngành có P/E ở phân vị từ ' + o.hi + ' so với lịch sử của chính ngành.' });
    if (cheapPct >= o.concentrationPct) add({ key: 'concentration-cheap', level: 'info', scope: 'Danh mục', title: 'Nhiều danh mục nằm trong ngành đang rẻ', detail: r0(cheapPct) + '% danh mục thuộc ngành có P/E ở phân vị đến ' + o.lo + ' so với lịch sử của chính ngành.' });

    const rank = { warn: 0, info: 1 };
    out.sort((a, b) => rank[a.level] - rank[b.level]);
    return { alerts: out, warn: out.filter((a) => a.level === 'warn').length, info: out.filter((a) => a.level === 'info').length, asOf: peM ? peM.date : null, enough: !!(peM && peM.enough) };
  }

  return { DEFAULTS, build, pctBack };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ValuationAlerts;
globalThis.ValuationAlerts = ValuationAlerts;
