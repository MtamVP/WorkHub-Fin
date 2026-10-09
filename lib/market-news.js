// Logic thuần: PHÂN LOẠI và ĐIỂM TIN thị trường cho thẻ "Tin thị trường" của trang Tổng Quan TT. KHÔNG dùng AI: phân chủ đề bằng bộ từ khoá tiếng Việt (bỏ dấu, khớp nguyên từ), nhận mã cổ phiếu được nhắc
// bằng cách đối chiếu các từ viết hoa 3-4 ký tự với danh sách mã đang niêm yết, rồi tổng hợp "điểm tin" (số tin theo chủ đề, mã được nhắc nhiều, tin trong 3 giờ qua).
// Tin đến từ Edge Function market-news (RSS các báo, đã chuẩn hoá: { id, title, link, source, sourceName, ts, summary }). Bộ phân loại là QUY TẮC ĐƠN GIẢN nên sẽ có tin xếp chưa chuẩn;
// "Khác" là chủ đề cho tin không khớp từ khoá nào. Mã cổ phiếu trùng từ thông dụng (VND tiền tệ, USD, CPI, CEO...) nằm trong danh sách loại trừ nên các tin nhắc "VND" không bị gán cho mã VND (VNDirect).
// KHÔNG đụng DOM/mạng. Nạp bằng thẻ <script> thường (global MarketNews) và module.exports cho Vitest.
const MarketNews = (function () {
  const fold = (s) => ' ' + String(s === null || s === undefined ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9&]+/g, ' ').trim() + ' ';
  // Bản GIỮ dấu (chỉ hạ chữ thường, dấu câu thành khoảng trắng) cho các từ khoá dễ nhầm khi bỏ dấu: "thuế" với "thuê", "Mỹ" với "my". Từ khoá có dấu khớp với bản này, từ khoá không dấu khớp với bản bỏ dấu.
  const keep = (s) => ' ' + String(s === null || s === undefined ? '' : s).toLowerCase().normalize('NFC').replace(/[^a-z0-9&À-ỹ]+/g, ' ').trim() + ' ';
  const accented = (k) => /[^\x00-\x7f]/.test(k);
  // Chủ đề theo thứ tự ưu tiên khi hoà điểm. Từ khoá thường đã bỏ dấu; khớp nguyên từ (có khoảng trắng hai đầu).
  const TOPICS = [
    { key: 'macro', label: 'Vĩ mô & chính sách', kw: ['lai suat', 'ty gia', 'gdp', 'cpi', 'lam phat', 'ngan hang nha nuoc', 'nhnn', 'chinh phu', 'thu ngan sach', 'thuế', 'trai phieu chinh phu', 'dau tu cong', 'giai ngan', 'xuat khau', 'nhap khau', 'xuat sieu', 'nhap sieu', 'chinh sach tien te', 'tang truong kinh te', 'bo tai chinh', 'quoc hoi', 'fdi', 'von fdi', 'ha tang', 'nghi dinh', 'thong tu', 'cung tien', 'room tin dung'] },
    { key: 'market', label: 'Chứng khoán', kw: ['vnindex', 'vn index', 'vn30', 'chung khoan', 'khoi ngoai', 'tu doanh', 'thanh khoan', 'phien giao dich', 'margin', 'etf', 'hnx', 'upcom', 'hose', 'mua rong', 'ban rong', 'nhom co phieu', 'nha dau tu', 'dong tien', 'co phieu', 'khop lenh', 'tang tran', 'giam san', 'ttck', 'ubck', 'nang hang thi truong', 'kqkd'] },
    { key: 'bank', label: 'Ngân hàng', kw: ['ngan hang', 'nim', 'no xau', 'tang von dieu le', 'lai suat tien gui', 'tin dung ngan hang', 'trich lap du phong', 'casa', 'bao hiem tien gui'] },
    { key: 'realestate', label: 'Bất động sản', kw: ['bat dong san', 'nha o', 'chung cu', 'dat nen', 'quy dat', 'khu do thi', 'khu cong nghiep', 'bds', 'nha o xa hoi', 'du an bat dong san', 'gia nha', 'gia dat', 'mo ban', 'sang nhuong du an', 'quy hoach', 'du an'] },
    { key: 'corp', label: 'Doanh nghiệp', kw: ['loi nhuan', 'doanh thu', 'co tuc', 'dai hoi dong co dong', 'dhdcd', 'phat hanh', 'chao ban', 'ket qua kinh doanh', 'bao cao tai chinh', 'quy 3', 'quy iii', 'quy 2', 'quy ii', 'quy 4', 'quy 1', 'sap nhap', 'm&a', 'thoai von', 'mua lai co phieu', 'hoi dong quan tri', 'tong giam doc', 'lai rong', 'ke hoach kinh doanh', 'chu tich', 'ban co phieu quy', 'niem yet', 'huy niem yet'] },
    { key: 'commodity', label: 'Hàng hoá & năng lượng', kw: ['gia vang', 'vang mieng', 'vang sjc', 'dau tho', 'gia dau', 'xang dau', 'gia xang', 'thep', 'gia thep', 'cao su', 'ca phe', 'gia gao', 'xuat khau gao', 'thuy san', 'ca tra', 'gia heo', 'gia duong', 'khi dot', 'than da', 'gia dien', 'phan bon', 'gia vang the gioi', 'opec', 'nickel'] },
    { key: 'world', label: 'Thế giới', kw: ['fed', 'cuc du tru lien bang', 'mỹ', 'trung quoc', 'phao wall', 'wall street', 'chau au', 'nhat ban', 'trump', 'dow jones', 'nasdaq', 's&p 500', 'the gioi', 'dong usd', 'ecb', 'boj', 'thue quan', 'chien tranh thuong mai', 'han quoc', 'an do', 'trung dong', 'ukraine'] },
  ];
  const TOPIC_BY_KEY = {}; TOPICS.forEach((t) => { TOPIC_BY_KEY[t.key] = t; });
  const OTHER = { key: 'other', label: 'Khác' };
  // Từ viết hoa 3-4 ký tự thường gặp trong tin nhưng không phải (hoặc dễ nhầm với) mã cổ phiếu
  const STOP = new Set(['GDP', 'CPI', 'USD', 'VND', 'FED', 'ETF', 'IPO', 'EPS', 'ROE', 'ROA', 'VAT', 'FDI', 'PMI', 'OPEC', 'WTO', 'EVN', 'TTCK', 'UBCK', 'NHNN', 'HOSE', 'HNX', 'NIM', 'CIC', 'IMF', 'OTC', 'CEO', 'ESG', 'NAV', 'CAGR', 'USDT', 'BTC', 'ETH', 'HDQT', 'API', 'BIG', 'CAR', 'PPI', 'TOP', 'CAN', 'NEW', 'ALL', 'ECB', 'BOJ', 'DXY', 'WEF', 'ADB', 'TPCP', 'NPL', 'SME', 'KPI', 'LDR', 'CFO', 'COO']);

  const prep = (x) => ({ f: fold(x), k: keep(x) });
  const has = (hay, kw) => (accented(kw) ? hay.k : hay.f).indexOf(' ' + kw + ' ') !== -1;
  // Chủ đề tốt nhất của một tin: điểm = 2 × số từ khoá khớp ở tiêu đề + số từ khoá khớp ở mô tả; hoà điểm lấy chủ đề đứng trước trong TOPICS; 0 điểm là 'other'
  function classify(item) {
    const t = prep(item && item.title), d = prep(item && item.summary);
    let best = null, bestScore = 0;
    TOPICS.forEach((tp) => {
      let sc = 0; tp.kw.forEach((k) => { if (has(t, k)) sc += 2; else if (has(d, k)) sc += 1; });
      if (sc > bestScore) { bestScore = sc; best = tp.key; }
    });
    return best || 'other';
  }
  // Mã cổ phiếu được nhắc trong tiêu đề hoặc mô tả: từ viết hoa 3-4 ký tự (chữ/số, bắt đầu bằng chữ) có trong `symbols` và không thuộc danh sách loại trừ. Giữ thứ tự xuất hiện, bỏ trùng.
  function tickers(item, symbols) {
    const set = symbols instanceof Set ? symbols : new Set(symbols || []), seen = new Set(), out = [];
    const src = String((item && item.title) || '') + ' . ' + String((item && item.summary) || '');
    const re = /(^|[^A-Za-z0-9])([A-Z][A-Z0-9]{2,3})(?![A-Za-z0-9])/g;
    let m;
    while ((m = re.exec(src)) !== null) { const s = m[2]; if (set.has(s) && !STOP.has(s) && !seen.has(s)) { seen.add(s); out.push(s); } }
    return out;
  }
  function enrich(items, symbols) {
    const set = symbols instanceof Set ? symbols : new Set(symbols || []);
    return (items || []).filter((x) => x && x.title && x.link).map((x) => Object.assign({}, x, { topic: classify(x), tickers: tickers(x, set) }));
  }
  const labelOf = (key) => (TOPIC_BY_KEY[key] || OTHER).label;

  // Điểm tin: trong `hours` giờ gần nhất (mặc định 24) tính số tin theo chủ đề, theo báo, mã được nhắc nhiều nhất; số tin trong 3 giờ qua. Tin không rõ giờ không tính vào cửa sổ giờ.
  function digest(items, opts) {
    const o = opts || {}, now = o.now === undefined ? Date.now() : o.now, hours = o.hours > 0 ? o.hours : 24;
    const win = (items || []).filter((x) => x.ts !== null && x.ts !== undefined && x.ts >= now - hours * 3600000 && x.ts <= now + 3600000);
    const byTopic = {}, bySource = {}, tk = {};
    win.forEach((x) => { byTopic[x.topic] = (byTopic[x.topic] || 0) + 1; bySource[x.sourceName || x.source] = (bySource[x.sourceName || x.source] || 0) + 1; (x.tickers || []).forEach((s) => { tk[s] = (tk[s] || 0) + 1; }); });
    const topics = TOPICS.concat([OTHER]).map((t) => ({ key: t.key, label: t.label, count: byTopic[t.key] || 0 })).filter((t) => t.count > 0).sort((a, b) => b.count - a.count);
    const topTickers = Object.keys(tk).map((s) => ({ symbol: s, count: tk[s] })).sort((a, b) => b.count - a.count || (a.symbol < b.symbol ? -1 : 1)).slice(0, o.topN > 0 ? o.topN : 6);
    return { hours: hours, total: win.length, recent3h: win.filter((x) => x.ts >= now - 3 * 3600000).length, topics: topics, topTickers: topTickers, bySource: bySource };
  }
  // Lọc theo chủ đề ('all' hoặc key), theo tập mã quan tâm (mine: Set/mảng; null = không lọc) và theo báo ('all' hoặc id)
  function filter(items, f) {
    const o = f || {}, mine = o.mine ? (o.mine instanceof Set ? o.mine : new Set(o.mine)) : null;
    return (items || []).filter((x) => (!o.topic || o.topic === 'all' || x.topic === o.topic) && (!o.source || o.source === 'all' || x.source === o.source) && (!mine || (x.tickers || []).some((s) => mine.has(s))));
  }
  // "5 phút trước", "3 giờ trước", "hôm qua", hoặc ngày/tháng nếu quá 2 ngày; thiếu giờ thì chuỗi rỗng
  function ago(ts, now) {
    if (ts === null || ts === undefined || !isFinite(ts)) return '';
    const n = now === undefined ? Date.now() : now, m = Math.floor((n - ts) / 60000);
    if (m < -5) return '';
    if (m < 1) return 'vừa xong';
    if (m < 60) return m + ' phút trước';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' giờ trước';
    const d = Math.floor(h / 24);
    if (d < 2) return 'hôm qua';
    const t = new Date(ts + 7 * 3600000);
    return String(t.getUTCDate()).padStart(2, '0') + '/' + String(t.getUTCMonth() + 1).padStart(2, '0');
  }

  return { TOPICS, OTHER, STOP, fold, keep, classify, tickers, enrich, labelOf, digest, filter, ago };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MarketNews;
