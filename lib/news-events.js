// Logic thuần: TRÍCH SỰ KIỆN TỪ TIÊU ĐỀ TIN THEO MÃ. Mỗi tin đã được gắn mã cổ phiếu (finance_pit_news.symbols); ở đây nhận ra tin NÓI VỀ VIỆC GÌ (lợi nhuận, cổ tức, giao dịch nội bộ, giải chấp, đình chỉ giao dịch...)
// và hướng tác động gợi ý, để bạn lọc tin theo loại sự kiện thay vì đọc cả dòng tin, và để điều kiện luận điểm ("không có sự kiện xấu nghiêm trọng 30 ngày") có số đo.
// Cách làm: LUẬT TỪ KHOÁ trên tiêu đề (+ phần tóm tắt nếu có), không dùng mô hình ngôn ngữ -- kiểm tra được từng quyết định, không có chi phí, chạy cả ở máy chủ lẫn trình duyệt với kết quả giống nhau.
// Bỏ dấu tiếng Việt trước khi so khớp. Mỗi sự kiện kèm các cụm từ đã khớp (matched) để người đọc thấy VÌ SAO tin bị xếp vào loại đó, và liên kết tin gốc.
// Giới hạn nói thẳng: (1) chỉ đọc tiêu đề + tóm tắt ngắn nên bỏ sót tin diễn đạt lạ (độ phủ thấp hơn mô hình ngôn ngữ) và có thể xếp nhầm tin có cụm từ đa nghĩa; (2) hướng (tăng/giảm) là GỢI Ý theo từ ngữ, không phải
// đánh giá tác động lên giá; (3) tiêu đề nhắc nhiều mã thì sự kiện gắn cho TẤT CẢ các mã đó với độ tin cậy thấp hơn; (4) đây là công cụ lọc và cảnh báo, không phải khuyến nghị.
// KHÔNG đụng DOM/mạng/tệp. Nạp bằng thẻ <script> thường (global NewsEvents) và module.exports cho Vitest; bản sao chạy ở Edge Function insight-sync.
const NewsEvents = (function () {
  const VERSION = 1;
  // Bỏ dấu, chữ thường, chỉ giữ chữ-số-khoảng trắng-%
  function norm(s) {
    return String(s === null || s === undefined ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
  }
  const escRe = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  const cache = {};
  function re(phrase) { return cache[phrase] || (cache[phrase] = new RegExp('(?:^|[^a-z0-9])' + escRe(phrase) + '(?![a-z0-9])')); }
  const find = (text, list) => (list || []).filter((p) => re(p).test(text));

  // Cụm từ chỉ người trong cuộc (giao dịch của họ là tín hiệu nội bộ)
  const INSIDER = ['chu tich', 'tong giam doc', 'nguoi nha', 'lanh dao', 'ban giam doc', 'hdqt', 'hoi dong quan tri', 'thanh vien hdqt', 'pho tong giam doc', 'ke toan truong', 'vo ong', 'vo ba', 'vo chu tich', 'vo tong giam doc', 'chong ba', 'chong ong', 'con gai', 'con trai', 'em trai', 'anh trai', 'em gai', 'chi gai', 'nguoi lien quan', 'cong ty me'];
  const BUY = ['dang ky mua', 'mua vao', 'mua them', 'mua thoa thuan', 'mua xong', 'gom', 'nang so huu', 'mua rong'];
  const SELL = ['dang ky ban', 'ban thoa thuan', 'ban ra', 'ban xong', 'ban het', 'ban rong', 'thoai von', 'ha so huu', 'xa', 'giai chap', 'rut khoi', 'ban bot', 'ban tho'];
  const UP = ['tang', 'ky luc', 'vuot', 'dot bien', 'bung no', 'but pha', 'phuc hoi', 'khoi sac', 'tich cuc', 'lai lon', 'gap doi', 'tang truong', 'lap dinh', 'cao nhat', 'tang tran', 'kich tran', 'thang lon'];
  const DOWN = ['giam', 'sut', 'lao doc', 'thua lo', 'lo', 'am', 'tieu cuc', 'ha', 'chung lai', 'xau di', 'thung day', 'nam san', 'giam san', 'giam sau', 'kem', 'that bai', 'rut'];
  const QTY = ['co phieu', 'trieu co phieu', 'trieu cp', 'cp', 'co phan'];

  // sev: alert (cần chú ý ngay), watch (đáng theo dõi), info (bối cảnh). dir mặc định: 1 tốt, -1 xấu, 0 chưa rõ, null = lấy theo từ ngữ. up/down: từ quyết định hướng khi dir = null.
  const TYPES = [
    { key: 'legal', label: 'Pháp lý nghiêm trọng', sev: 'alert', dir: -1, cues: ['khoi to', 'bat tam giam', 'bi bat', 'truy to', 'dieu tra', 'thao tung', 'lua dao', 'cao buoc', 'hinh su', 'lam dung', 'khoi to bi can', 'bi can'] },
    { key: 'delist', label: 'Nguy cơ đình chỉ / hủy niêm yết', sev: 'alert', dir: -1, cues: ['dinh chi giao dich', 'huy niem yet', 'bi huy niem yet', 'dien canh bao', 'dien kiem soat', 'kiem soat dac biet', 'han che giao dich', 'tam ngung giao dich', 'canh bao co phieu', 'bi canh bao', 'cat margin', 'dinh chi'] },
    { key: 'margin_call', label: 'Giải chấp / bán cưỡng bức', sev: 'alert', dir: -1, cues: ['giai chap', 'ban giai chap', 'force sell', 'margin call', 'call margin', 'ban cuong buc', 'bi xiet'] },
    { key: 'debt_stress', label: 'Căng thẳng nợ / trái phiếu', sev: 'alert', dir: -1, cues: ['cham tra', 'mat kha nang thanh toan', 'vo no', 'tre han', 'khong tra duoc', 'tai co cau no', 'gia han trai phieu', 'no xau tang', 'no qua han', 'cham thanh toan'] },
    { key: 'penalty', label: 'Bị xử phạt / vi phạm công bố thông tin', sev: 'watch', dir: -1, cues: ['xu phat', 'bi phat', 'nop phat', 'vi pham cong bo', 'vi pham', 'thanh tra', 'kiem tra bat thuong'] },
    { key: 'earnings', label: 'Kết quả kinh doanh', sev: 'watch', dir: null, cues: ['loi nhuan', 'lai rong', 'lnst', 'bao lai', 'bao lo', 'ket qua kinh doanh', 'lo rong', 'doanh thu thuan', 'kqkd', 'loi nhuan sau thue', 'loi nhuan truoc thue', 'lai quy'] },
    { key: 'guidance', label: 'Kế hoạch / đại hội cổ đông', sev: 'info', dir: 0, cues: ['ke hoach kinh doanh', 'muc tieu loi nhuan', 'dai hoi co dong', 'dhdcd', 'nghi quyet', 'ke hoach nam', 'ke hoach loi nhuan'] },
    { key: 'dividend', label: 'Cổ tức / cổ phiếu thưởng', sev: 'info', dir: 1, cues: ['co tuc', 'chot quyen', 'ngay giao dich khong huong quyen', 'co phieu thuong', 'tam ung co tuc', 'chia co tuc', 'tra co tuc'] },
    { key: 'issuance', label: 'Phát hành / tăng vốn', sev: 'watch', dir: 0, cues: ['phat hanh them', 'chao ban', 'tang von', 'phat hanh rieng le', 'esop', 'phat hanh co phieu', 'huy dong von', 'phat hanh trai phieu', 'phat hanh chuyen doi'] },
    { key: 'holder_change', label: 'Cổ đông lớn thay đổi', sev: 'info', dir: null, cues: ['roi danh sach co dong lon', 'khong con la co dong lon', 'tro thanh co dong lon', 'thanh co dong lon moi', 'thoai het von', 'xuat hien co dong lon'] },
    { key: 'buyback', label: 'Mua lại cổ phiếu', sev: 'info', dir: 1, cues: ['mua lai co phieu', 'co phieu quy', 'mua co phieu quy'] },
    { key: 'mna', label: 'M&A / thoái vốn', sev: 'watch', dir: 0, cues: ['thau tom', 'sap nhap', 'm&a', 'm a', 'mua lai cong ty', 'thoai von', 'chuyen nhuong von', 'chuyen nhuong co phan', 'chao mua cong khai', 'thuong vu', 'mua lai doanh nghiep'] },
    { key: 'mgmt', label: 'Thay đổi nhân sự cấp cao', sev: 'watch', dir: 0, cues: ['mien nhiem', 'tu nhiem', 'bo nhiem', 'thoi chuc', 'roi ghe', 'thay chu tich', 'thay tong giam doc', 'nhan su cap cao', 'ban giao', 'bau chu tich', 'tan chu tich'] },
    { key: 'contract', label: 'Hợp đồng / dự án', sev: 'watch', dir: 1, cues: ['trung thau', 'ky hop dong', 'hop dong', 'don hang', 'khoi cong', 'du an moi', 'ky ket', 'bat tay', 'hop tac chien luoc', 'nhan duoc don'] },
    { key: 'foreign_flow', label: 'Dòng tiền khối ngoại', sev: 'info', dir: null, cues: ['khoi ngoai'] },
    { key: 'fund_flow', label: 'Dòng tiền quỹ / ETF', sev: 'info', dir: null, cues: ['etf', 'quy thanh vien', 'danh muc etf', 'co cau danh muc', 'quy ngoai', 'quy dau tu'] },
    { key: 'analyst', label: 'Khuyến nghị / định giá của công ty chứng khoán', sev: 'info', dir: null, cues: ['khuyen nghi', 'gia muc tieu', 'nang xep hang', 'ha xep hang', 'j p morgan', 'jp morgan', 'moi gioi', 'dinh gia', 'trien vong'] },
    { key: 'price_action', label: 'Biến động giá đáng chú ý', sev: 'info', dir: null, cues: ['tang tran', 'kich tran', 'giam san', 'nam san', 'lap dinh', 'thung day', 'giam sau', 'but pha', 'chuoi phien giam', 'chuoi phien tang', 'lao doc', 'bay mau'] },
  ];
  const BY_KEY = {}; TYPES.forEach((t) => { BY_KEY[t.key] = t; });
  const SEV_RANK = { alert: 3, watch: 2, info: 1 };

  // Hướng theo từ ngữ: +1 nếu từ tích cực nhiều hơn tiêu cực, -1 ngược lại, 0 nếu bằng nhau hoặc không có
  function toneOf(text) {
    const up = find(text, UP).length, down = find(text, DOWN).length;
    return { up, down, dir: up > down ? 1 : (down > up ? -1 : 0), score: up + down ? (up - down) / (up + down) : 0 };
  }

  // Trích các sự kiện từ MỘT đoạn văn (tiêu đề và/hoặc tóm tắt). Trả [{ type, dir, sev, matched[], where }] (chưa gắn mã).
  function classify(title, summary) {
    const t = norm(title), s = norm(summary), out = [];
    const txt = t + (s ? ' | ' + s : '');
    const tone = toneOf(t || s);
    const add = (type, matched, where, dir) => out.push({ type: type.key, label: type.label, sev: type.sev, dir, matched: matched.slice(0, 4), where, tone: tone.score });
    TYPES.forEach((type) => {
      const mt = find(t, type.cues), ms = mt.length ? [] : find(s, type.cues);
      const matched = mt.length ? mt : ms;
      if (!matched.length) return;
      const where = mt.length ? 'title' : 'summary';
      let dir = type.dir;
      if (dir === null) {
        if (type.key === 'holder_change') dir = find(t, ['tro thanh co dong lon', 'thanh co dong lon moi', 'xuat hien co dong lon']).length ? 1 : -1;
        else if (type.key === 'foreign_flow' || type.key === 'fund_flow') {
          const buy = find(t, BUY).length, sell = find(t, SELL).length; dir = buy > sell ? 1 : (sell > buy ? -1 : 0);
          if (type.key === 'foreign_flow' && !find(t, ['mua rong', 'ban rong', 'mua vao', 'ban ra', 'xa', 'gom', 'ban thoa thuan', 'mua thoa thuan', 'thoa thuan']).length) return;     // "khối ngoại" đứng một mình không phải sự kiện
          if (type.key === 'fund_flow' && !find(t, BUY.concat(SELL, ['co cau', 'de xuat'])).length) return;
        } else dir = tone.dir;
        if (type.key === 'earnings' && !dir) dir = 0;
      }
      add(type, matched, where, dir);
    });
    // giao dịch cổ phiếu của cổ đông / người nội bộ: cần động từ mua bán + từ chỉ cổ phiếu; có từ chỉ người trong cuộc thì là tín hiệu nội bộ
    const buy = find(t, BUY).length, sell = find(t, SELL).length, hasQty = find(t, QTY).length > 0;
    if (hasQty && (buy || sell) && !out.some((e) => e.type === 'margin_call' || e.type === 'foreign_flow')) {
      const ins = find(t, INSIDER);
      const dir = buy > sell ? 1 : (sell > buy ? -1 : 0);
      if (dir) {
        if (ins.length) out.push({ type: dir > 0 ? 'insider_buy' : 'insider_sell', label: dir > 0 ? 'Người trong cuộc mua' : 'Người trong cuộc bán', sev: dir > 0 ? 'info' : 'watch', dir, matched: ins.slice(0, 2).concat(find(t, dir > 0 ? BUY : SELL).slice(0, 2)), where: 'title', tone: tone.score });
        else out.push({ type: 'holder_trade', label: dir > 0 ? 'Cổ đông mua cổ phiếu' : 'Cổ đông bán cổ phiếu', sev: 'info', dir, matched: find(t, dir > 0 ? BUY : SELL).slice(0, 2), where: 'title', tone: tone.score });
      }
    }
    // tin giải chấp của người nhà lãnh đạo là sự kiện giải chấp, không tính là "người trong cuộc bán" nữa
    if (out.some((e) => e.type === 'margin_call')) return out.filter((e) => e.type !== 'insider_sell' && e.type !== 'holder_trade');
    return out;
  }

  // Một tin đã gắn mã: { id, title, summary, symbols, published_at, link, source } -> hàng sự kiện cho từng mã. Nhiều mã trong một tiêu đề: độ tin cậy giảm.
  function extract(item) {
    if (!item || !item.title) return [];
    const evs = classify(item.title, item.summary);
    if (!evs.length) return [];
    const syms = (item.symbols || []).filter((s) => /^[A-Z0-9]{1,12}$/.test(s));
    const rows = [];
    syms.forEach((sym) => {
      evs.forEach((e) => {
        let conf = e.where === 'title' ? 0.65 : 0.4;
        if (e.matched.length >= 2) conf += 0.15;
        if (e.dir !== 0 && e.dir !== null && Math.sign(e.tone) === e.dir) conf += 0.05;
        if (syms.length > 2) conf -= 0.2; else if (syms.length === 2) conf -= 0.1;
        rows.push({
          id: String(item.id) + '|' + sym + '|' + e.type, news_id: String(item.id), symbol: sym, event_type: e.type, direction: e.dir, severity: e.sev,
          confidence: Math.round(Math.max(0.1, Math.min(0.95, conf)) * 100) / 100, matched: e.matched, published_at: item.published_at || null,
          title: String(item.title).slice(0, 300), link: item.link || null, source: item.source || null, multi: syms.length > 1,
        });
      });
    });
    return rows;
  }
  const extractAll = (items) => { const out = []; (items || []).forEach((it) => { extract(it).forEach((r) => out.push(r)); }); return out; };

  // Mức nghiêm trọng cao nhất của một nhóm sự kiện và số theo loại, trong cửa sổ `days` ngày kể từ now
  function summarize(events, now, days) {
    const cutoff = (now || Date.now()) - (days || 30) * 86400000, by = {};
    let alert = 0, watch = 0, negAlert = 0;
    (events || []).forEach((e) => {
      const t = e.published_at ? Date.parse(e.published_at) : NaN;
      if (isFinite(t) && t < cutoff) return;
      by[e.event_type] = (by[e.event_type] || 0) + 1;
      if (e.severity === 'alert') { alert++; if (e.direction < 0) negAlert++; } else if (e.severity === 'watch') watch++;
    });
    return { alert, watch, negAlert, byType: by, total: Object.keys(by).reduce((s, k) => s + by[k], 0) };
  }
  // Sắp xếp: nghiêm trọng trước, rồi mới nhất, rồi độ tin cậy
  function sortEvents(events) {
    return (events || []).slice().sort((a, b) => (SEV_RANK[b.severity] - SEV_RANK[a.severity]) || ((Date.parse(b.published_at) || 0) - (Date.parse(a.published_at) || 0)) || (b.confidence - a.confidence));
  }
  const LABELS = {}; TYPES.forEach((t) => { LABELS[t.key] = t.label; });
  LABELS.insider_buy = 'Người trong cuộc mua'; LABELS.insider_sell = 'Người trong cuộc bán'; LABELS.holder_trade = 'Cổ đông giao dịch';

  return { VERSION, TYPES, BY_KEY, LABELS, SEV_RANK, norm, toneOf, classify, extract, extractAll, summarize, sortEvents };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NewsEvents;
