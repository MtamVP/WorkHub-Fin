// Logic thuần: BỐI CẢNH cho Market Simulation -- thẻ sự kiện (AI gợi ý hoặc người dùng tự nhập) và trạng thái thị trường gửi cho AI.
//   * cardFromAi / cardNew / normalizeCard: một thẻ luôn có đủ trường hợp lệ (mức thô thuộc danh sách cố định, ngành thuộc danh sách ngành của app, xác suất 0..1 hoặc null = theo khả năng thô).
//   * mergeAi: lấy bối cảnh AI mới thì thay các thẻ AI cũ, GIỮ thẻ người dùng tự nhập; thẻ AI trùng tiêu đề với lần trước giữ lại phần người dùng đã chỉnh (bật/tắt, xác suất, mức).
//   * marketState: trạng thái thị trường dạng SỐ từ mô hình đã ước lượng (lib/market-sim.js) -- thứ duy nhất trang gửi cho AI ngoài tin do máy chủ tự lấy.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global SimContext) và module.exports cho Vitest.
const SimContext = (function () {
  // Ngành nội bộ (giống lib/sector-map.js và supabase/functions/market-news-ai/scenarios.ts; test kiểm ba nơi khớp nhau)
  const SECTORS = [
    'Dầu khí & năng lượng', 'Hóa chất & phân bón', 'Thép & vật liệu', 'Xây dựng & hạ tầng', 'Công nghiệp & dịch vụ', 'Ô tô & phụ tùng', 'Thực phẩm & đồ uống',
    'Hàng cá nhân & gia dụng', 'Y tế & dược', 'Bán lẻ', 'Truyền thông', 'Du lịch & giải trí', 'Viễn thông', 'Điện & tiện ích', 'Ngân hàng', 'Bảo hiểm',
    'Bất động sản', 'Chứng khoán', 'Công nghệ',
  ];
  const CATEGORIES = ['Vĩ mô', 'Chính sách', 'Dòng tiền', 'Ngành', 'Doanh nghiệp', 'Thế giới', 'Khác'];
  const pick = (v, list, d) => (list.indexOf(v) !== -1 ? v : d);
  const str = (v, n) => String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  const optNum = (v, lo, hi) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) && n >= lo && n <= hi ? n : null; };

  function normalizeCard(c) {
    const x = c || {};
    const sectors = Array.isArray(x.sectors) ? x.sectors.filter((s, i, a) => SECTORS.indexOf(s) !== -1 && a.indexOf(s) === i).slice(0, 6) : [];
    let scope = pick(x.scope, ['market', 'sector'], 'market'); if (scope === 'sector' && !sectors.length) scope = 'market';
    return {
      id: str(x.id, 40) || 'u' + Math.random().toString(36).slice(2, 8), source: x.source === 'ai' ? 'ai' : 'user', title: str(x.title, 110) || 'Sự kiện', category: pick(x.category, CATEGORIES, 'Khác'),
      window: pick(x.window, ['1w', '1m', '3m'], '1m'), likelihood: pick(x.likelihood, ['low', 'medium', 'high'], 'medium'), direction: pick(x.direction, ['up', 'down', 'mixed'], 'down'),
      magnitude: pick(x.magnitude, ['small', 'medium', 'large'], 'medium'), scope: scope, sectors: sectors, rationale: str(x.rationale, 300),
      signposts: Array.isArray(x.signposts) ? x.signposts.map((s) => str(s, 140)).filter(Boolean).slice(0, 3) : [],
      refs: Array.isArray(x.refs) ? x.refs.filter((r) => r && /^https:\/\//i.test(String(r.link))).slice(0, 4).map((r) => ({ n: Number(r.n) || 0, title: str(r.title, 160), link: String(r.link).slice(0, 500), sourceName: str(r.sourceName, 30) })) : [],
      on: x.on !== false, prob: optNum(x.prob, 0, 1), marketMove: optNum(x.marketMove, 0, 0.6), sectorMove: optNum(x.sectorMove, 0, 0.6),
    };
  }
  const cardFromAi = (e) => normalizeCard(Object.assign({}, e, { source: 'ai' }));
  function cardNew(id) { return normalizeCard({ id: id || 'u' + Date.now().toString(36), source: 'user', title: 'Sự kiện của tôi', category: 'Khác', direction: 'down', magnitude: 'medium', likelihood: 'medium', window: '1m' }); }
  const key = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // oldCards: thẻ hiện có; aiEvents: events trả về từ máy chủ. Thẻ AI mới trùng tiêu đề với thẻ AI cũ giữ phần người dùng đã chỉnh.
  function mergeAi(oldCards, aiEvents) {
    const old = (oldCards || []).map(normalizeCard), prevAi = {};
    old.filter((c) => c.source === 'ai').forEach((c) => { prevAi[key(c.title)] = c; });
    const fresh = (aiEvents || []).map(cardFromAi).map((c) => {
      const p = prevAi[key(c.title)];
      return p ? Object.assign(c, { on: p.on, prob: p.prob, marketMove: p.marketMove, sectorMove: p.sectorMove }) : c;
    });
    return fresh.concat(old.filter((c) => c.source === 'user'));
  }

  // Trạng thái thị trường dạng số. model: MarketSim.describe(ctx); result: MarketSim.simulate cho VN-Index KHÔNG có sự kiện (mốc cuối = 3 tháng).
  function marketState(model, result) {
    if (!model || !model.ok) return {};
    const L = (model.stressHist && model.stressHist.index) || [], n = L.length, last = n ? L[n - 1] : model.indexLevel;
    const ret = (k) => (n > k && L[n - 1 - k] > 0 ? last / L[n - 1 - k] - 1 : undefined);
    const K = model.hmm.K, cur = model.hmm.current, top = cur.indexOf(Math.max.apply(null, cur));
    const names = K === 2 ? ['Bình thường', 'Căng thẳng'] : ['Êm', 'Bình thường', 'Căng thẳng'];
    const out = { asOf: model.lastDate, index: model.indexLevel, ret1w: ret(5), ret1m: ret(21), ret3m: ret(63), ret1y: ret(252), volNow: model.garch.volNowAnn, volLong: model.garch.volLongAnn, regime: names[top], regimeProb: cur[top] };
    const lastH = result && result.byHorizon ? result.byHorizon[result.byHorizon.length - 1] : null;
    if (lastH && lastH.index) { out.pDown10 = lastH.index.pLoss10; out.pUp10 = lastH.index.pGain10; }
    Object.keys(out).forEach((k) => { if (out[k] === undefined || out[k] === null || (typeof out[k] === 'number' && !isFinite(out[k]))) delete out[k]; });
    return out;
  }

  return { SECTORS, CATEGORIES, normalizeCard, cardFromAi, cardNew, mergeAi, marketState };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SimContext;
