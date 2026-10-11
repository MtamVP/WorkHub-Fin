// Trích sự kiện từ tiêu đề tin theo mã: lib/news-events.js (luật từ khoá, kiểm trên tiêu đề thật đã lưu trong kho tin 11/10/2026)
import { describe, it, expect } from 'vitest';
import NE from '../../lib/news-events.js';

const kinds = (title, summary) => NE.classify(title, summary).map((e) => e.type + (e.dir > 0 ? '+' : (e.dir < 0 ? '-' : '0'))).sort();
const has = (title, key, dir) => NE.classify(title).some((e) => e.type === key && (dir === undefined || e.dir === dir));

describe('norm', () => {
  it('bỏ dấu tiếng Việt và ký tự lạ, chữ thường', () => {
    expect(NE.norm('Đình chỉ giao dịch: "Cổ phiếu" ABC!')).toBe('dinh chi giao dich co phieu abc');
    expect(NE.norm(null)).toBe('');
  });
});

describe('phân loại tiêu đề thật', () => {
  it('giải chấp là cảnh báo xấu, không bị tính thêm là người nhà bán', () => {
    const e = NE.classify('Người nhà Chủ tịch Cao Thị Ngọc Dung bị bán giải chấp gần 3 triệu cổ phiếu PNJ');
    expect(e.map((x) => x.type)).toEqual(['margin_call']); expect(e[0].sev).toBe('alert'); expect(e[0].dir).toBe(-1);
  });
  it('tổ chức bán cổ phiếu, khối ngoại bán thỏa thuận, quỹ ETF mua', () => {
    expect(has('Diamond Properties bán ra 2,58 triệu cổ phiếu NVL', 'holder_trade', -1)).toBe(true);
    expect(has('Khối ngoại bán thỏa thuận hơn 9.600 tỷ MCH cho cá nhân trong nước phiên cuối tuần', 'foreign_flow', -1)).toBe(true);
    expect(has('Khối ngoại tiếp tục bán ròng 451 tỷ đồng, vẫn tiếp tục xả PNJ', 'foreign_flow', -1)).toBe(true);
    expect(has('Dự báo PNJ sắp được các quỹ ETF mua vào hơn 3 triệu cổ', 'fund_flow', 1)).toBe(true);
  });
  it('người nhà lãnh đạo đăng ký mua = tín hiệu nội bộ tích cực; em trai Chủ tịch bán = nội bộ bán', () => {
    expect(has('Vợ Tổng Giám đốc DIC Group đăng ký mua 1 triệu cổ phiếu DIG', 'insider_buy', 1)).toBe(true);
    expect(has('Người nhà Chủ tịch Kosy đăng ký mua 8 triệu cổ phiếu KOS giữa chuỗi 15 phiên giảm sàn', 'insider_buy', 1)).toBe(true);
    const k = kinds('Quỹ thành viên Dragon Capital rút khỏi PNJ, em trai Chủ tịch bán xong 9 triệu cổ phiếu');
    expect(k).toContain('insider_sell-'); expect(k).toContain('fund_flow-');
  });
  it('nguy cơ đình chỉ / hủy niêm yết là cảnh báo; nằm sàn là biến động giá', () => {
    const e = NE.classify('DRH tiếp tục nằm sàn phiên thứ 3, sắp bị đình chỉ và nguy cơ hủy niêm yết');
    expect(e.find((x) => x.type === 'delist').sev).toBe('alert'); expect(e.some((x) => x.type === 'price_action' && x.dir === -1)).toBe(true);
  });
  it('khởi tố, thao túng = pháp lý nghiêm trọng', () => {
    expect(has('Chủ tịch bị khởi tố, bắt tạm giam về hành vi thao túng thị trường', 'legal', -1)).toBe(true);
  });
  it('kết quả kinh doanh: hướng theo từ ngữ (tăng / giảm / lỗ)', () => {
    expect(has('Hòa Phát báo lãi ròng quý 3 tăng 45%, vượt kế hoạch', 'earnings', 1)).toBe(true);
    expect(has('Công ty báo lỗ ròng quý 2, lợi nhuận sụt giảm mạnh', 'earnings', -1)).toBe(true);
    expect(has('Doanh nghiệp công bố lợi nhuận quý 3', 'earnings', 0)).toBe(true);
  });
  it('cổ tức, mua lại cổ phiếu, phát hành, M&A, nhân sự, hợp đồng, khuyến nghị', () => {
    expect(has('6.000 đồng/cổ phiếu năm 2026: MSR đặt nền móng cho chính sách cổ tức tiền mặt dài hạn', 'dividend', 1)).toBe(true);
    expect(has('VNM chốt quyền cổ tức tỷ lệ 15%', 'dividend')).toBe(true);
    expect(has('SSI đăng ký mua lại cổ phiếu quỹ 10 triệu cổ phiếu', 'buyback', 1)).toBe(true);
    expect(has('ABC chào bán 50 triệu cổ phiếu riêng lẻ để tăng vốn', 'issuance', 0)).toBe(true);
    expect(has('J.P. Morgan: Thương vụ Elmet làm rõ hơn giá trị của MSR trong Masan', 'mna')).toBe(true);
    expect(has('J.P. Morgan: Thương vụ Elmet làm rõ hơn giá trị của MSR trong Masan', 'analyst')).toBe(true);
    expect(has('Vinamilk miễn nhiệm Tổng giám đốc, bổ nhiệm người mới', 'mgmt')).toBe(true);
    expect(has('HHV trúng thầu dự án cao tốc 5.000 tỷ', 'contract', 1)).toBe(true);
    expect(has('Hai nhóm nhà đầu tư ngoại cùng rời danh sách cổ đông lớn PNJ', 'holder_change', -1)).toBe(true);
  });
  it('nợ: chậm trả trái phiếu là cảnh báo', () => {
    const e = NE.classify('Doanh nghiệp chậm trả lãi trái phiếu, nguy cơ vỡ nợ');
    expect(e.some((x) => x.type === 'debt_stress' && x.sev === 'alert')).toBe(true);
  });
  it('tăng trần / lập đỉnh là biến động giá (thông tin), không phải cảnh báo', () => {
    const e = NE.classify('Cổ phiếu khoáng sản đồng loạt tăng trần, MSR lập đỉnh mới');
    expect(e.length).toBe(1); expect(e[0].type).toBe('price_action'); expect(e[0].sev).toBe('info'); expect(e[0].dir).toBe(1);
  });
  it('tin không có sự kiện rõ ràng thì không bịa', () => {
    expect(NE.classify('Từng thắng lớn với dầu gội X-Men, ông Phan Quốc Công đang tạm lỗ 16 tỷ đồng tại PNJ')).toEqual([]);
    expect(NE.classify('Thanh khoản bất ngờ tăng mạnh, SHB và HDB là tâm điểm')).toEqual([]);
    expect(NE.classify('', '')).toEqual([]);
  });
  it('"khối ngoại" đứng một mình không phải sự kiện', () => {
    expect(NE.classify('Khối ngoại và thị trường tuần tới')).toEqual([]);
  });
  it('chỉ khớp cả từ: "lo" trong từ khác, "am" trong "amazon" không làm đổi hướng', () => {
    expect(NE.toneOf(NE.norm('Amazon lobby')).dir).toBe(0);
  });
  it('cụm ở tóm tắt (không có ở tiêu đề) vẫn nhận ra nhưng độ tin cậy thấp hơn', () => {
    const a = NE.extract({ id: 'x1', title: 'ABC công bố thông tin', summary: 'Hội đồng quản trị đã miễn nhiệm Tổng giám đốc', symbols: ['ABC'], published_at: '2026-10-10T01:00:00Z', link: 'http://x' });
    expect(a.length).toBe(1); expect(a[0].event_type).toBe('mgmt'); expect(a[0].confidence).toBeLessThan(0.6);
    const b = NE.extract({ id: 'x2', title: 'ABC miễn nhiệm Tổng giám đốc', symbols: ['ABC'], published_at: '2026-10-10T01:00:00Z' });
    expect(b[0].confidence).toBeGreaterThan(a[0].confidence);
  });
});

describe('extract / extractAll', () => {
  const item = { id: 'n1', title: 'Chủ tịch bị khởi tố, bắt tạm giam', symbols: ['FLC'], published_at: '2026-10-09T03:00:00Z', link: 'https://x/1', source: 'cafef' };
  it('gắn mã, loại, hướng, mức, bằng chứng và liên kết gốc; id ổn định (chạy lại không nhân đôi)', () => {
    const r = NE.extract(item);
    expect(r.length).toBeGreaterThanOrEqual(1);
    const e = r.find((x) => x.event_type === 'legal');
    expect(e).toMatchObject({ id: 'n1|FLC|legal', news_id: 'n1', symbol: 'FLC', direction: -1, severity: 'alert', link: 'https://x/1', source: 'cafef', multi: false });
    expect(e.matched.length).toBeGreaterThanOrEqual(1);
    expect(NE.extract(item)).toEqual(r);
  });
  it('tiêu đề nhắc nhiều mã: gắn cho từng mã, đánh dấu multi và giảm độ tin cậy', () => {
    const one = NE.extract(Object.assign({}, item, { symbols: ['FLC'] })).find((x) => x.event_type === 'legal');
    const three = NE.extract(Object.assign({}, item, { symbols: ['FLC', 'ROS', 'HAI'] })).filter((x) => x.event_type === 'legal');
    expect(three.map((x) => x.symbol)).toEqual(['FLC', 'ROS', 'HAI']);
    expect(three[0].multi).toBe(true); expect(three[0].confidence).toBeLessThan(one.confidence);
  });
  it('tin không có mã hoặc không có sự kiện cho ra danh sách rỗng', () => {
    expect(NE.extract({ id: 'a', title: 'Chủ tịch bị khởi tố', symbols: [] })).toEqual([]);
    expect(NE.extract({ id: 'b', title: 'Thị trường hôm nay', symbols: ['AAA'] })).toEqual([]);
    expect(NE.extract(null)).toEqual([]);
    expect(NE.extractAll([item, { id: 'c', title: 'x', symbols: ['AAA'] }]).length).toBeGreaterThan(0);
  });
});

describe('tổng hợp và sắp xếp', () => {
  const now = Date.parse('2026-10-11T00:00:00Z');
  const ev = (type, sev, dir, d) => ({ event_type: type, severity: sev, direction: dir, published_at: d, confidence: 0.7 });
  const list = [ev('legal', 'alert', -1, '2026-10-09T00:00:00Z'), ev('dividend', 'info', 1, '2026-10-10T00:00:00Z'), ev('mgmt', 'watch', 0, '2026-09-01T00:00:00Z'), ev('delist', 'alert', -1, '2026-08-01T00:00:00Z')];
  it('summarize chỉ đếm trong cửa sổ ngày', () => {
    const s = NE.summarize(list, now, 30);
    expect(s.negAlert).toBe(1); expect(s.alert).toBe(1); expect(s.watch).toBe(0); expect(s.byType.legal).toBe(1);
    const s90 = NE.summarize(list, now, 90);
    expect(s90.negAlert).toBe(2); expect(s90.watch).toBe(1);
  });
  it('sortEvents: nghiêm trọng trước rồi mới nhất', () => {
    expect(NE.sortEvents(list).map((x) => x.event_type)).toEqual(['legal', 'delist', 'mgmt', 'dividend']);
  });
  it('mọi loại có nhãn', () => {
    NE.TYPES.forEach((t) => expect(NE.LABELS[t.key]).toBeTruthy());
    ['insider_buy', 'insider_sell', 'holder_trade'].forEach((k) => expect(NE.LABELS[k]).toBeTruthy());
  });
});
