// Giao diện Việc cần làm và Sự kiện (insight/insight-views-d.js): chỉ dựng chuỗi HTML từ kết quả đã tính. Kiểm: trạng thái tải / lỗi / rỗng, bộ lọc, thoát HTML, liên kết ngoài an toàn, giải thích mức khẩn cấp.
import { describe, it, expect } from 'vitest';
import D from '../../insight/insight-views-d.js';
import AI from '../../lib/action-inbox.js';
import NE from '../../lib/news-events.js';

const NOW = Date.parse('2026-10-12T01:30:00Z');
function inbox(over) {
  const items = AI.build({ now: NOW, today: '2026-10-12', held: ['FPT'], watch: ['VCB'],
    ideas: [{ id: 'i1', symbol: 'FPT', title: '<b>AI</b>', status: 'broken', conditions: [{ label: 'Giá >= 52.000', severity: 'critical', state: 'fail', since: '2026-10-10T00:00:00Z' }] }],
    events: [{ news_id: 'n1', symbol: 'FPT', event_type: 'legal', label: 'Pháp lý nghiêm trọng', severity: 'alert', direction: -1, title: 'Chủ tịch bị khởi tố', link: 'https://cafef.vn/x', published_at: '2026-10-11T03:00:00Z' }],
    health: [{ kind: 'stale_price', severity: 'warn', symbol: 'ABC', ref_date: '2026-10-09' }] });
  return Object.assign({ state: 'ok', items, summary: AI.summarize(items), filter: { sev: 'all', kind: 'all' }, notes: [], now: NOW }, over || {});
}
describe('Việc cần làm', () => {
  it('đang tải / lỗi / rỗng', () => {
    expect(D.inboxHtml({ state: 'loading' })).toContain('Đang gom');
    expect(D.inboxHtml({ state: 'error', error: '<script>x</script>' })).not.toContain('<script>');
    const empty = D.inboxHtml(inbox({ items: [], summary: AI.summarize([]) }));
    expect(empty).toContain('Không có việc cần chú ý'); expect(empty).toContain('chưa có tín hiệu nào vượt ngưỡng');
  });
  it('danh sách xếp mức 1 trước, đếm theo mức, thoát HTML, liên kết tin gốc mở tab mới và có rel an toàn', () => {
    const h = D.inboxHtml(inbox());
    expect(h.indexOf('luận điểm bị phá vỡ')).toBeLessThan(h.indexOf('Dữ liệu: Giá cũ'));
    expect(h).not.toContain('<b>AI</b>'); expect(h).toContain('&lt;b&gt;AI&lt;/b&gt;');
    expect(h).toContain('target="_blank" rel="noopener noreferrer"'); expect(h).toContain('Đọc tin gốc');
    expect(h).toContain('2 việc nghiêm trọng');
  });
  it('bộ lọc mức và loại; giải thích quy tắc và email buổi sáng luôn hiện', () => {
    expect(D.inboxHtml(inbox({ filter: { sev: 'urgent', kind: 'all' } }))).not.toContain('Giá cũ');
    expect(D.inboxHtml(inbox({ filter: { sev: 'all', kind: 'health' } }))).not.toContain('FPT: luận điểm');
    expect(D.inboxHtml(inbox({ filter: { sev: 'all', kind: 'cash' } }))).toContain('Không có mục nào khớp bộ lọc');
    const h = D.inboxHtml(inbox());
    expect(h).toContain('Vì sao một mục nằm ở mức này'); expect(h).toContain('chỉ gửi khi có mục mới');
  });
  it('nguồn không đọc được được nêu rõ (không giả vờ là không có việc)', () => {
    expect(D.inboxHtml(inbox({ notes: ['giới hạn đầu tư'] }))).toContain('Không đọc được');
  });
});

describe('Sự kiện', () => {
  const ev = (o) => Object.assign({ id: 'n|FPT|legal', news_id: 'n', symbol: 'FPT', event_type: 'legal', direction: -1, severity: 'alert', confidence: 0.8, matched: ['khoi to'], multi: false, published_at: '2026-10-11T03:00:00Z', title: 'Chủ tịch <i>bị</i> khởi tố', link: 'https://cafef.vn/x' }, o);
  function evt(over) {
    const rows = [ev(), ev({ id: 'm|HPG|earnings', symbol: 'HPG', event_type: 'earnings', direction: 1, severity: 'watch', matched: ['loi nhuan', 'lai rong'], link: 'javascript:alert(1)', multi: true })];
    return Object.assign({ state: 'ok', raw: rows, rows, total: 2, summary: NE.summarize(rows, NOW, 30), filter: { scope: 'all', days: 30, type: 'all', dir: 'all', sev: 'all', q: '' }, held: ['FPT'], tracked: ['FPT'], lastRun: { run_at: '2026-10-12T00:00:00Z', ok: true }, now: NOW }, over || {});
  }
  it('đang tải / lỗi / chưa có sự kiện / bộ lọc không khớp', () => {
    expect(D.eventsHtml({ state: 'loading' })).toContain('Đang tải sự kiện');
    expect(D.eventsHtml({ state: 'error', error: 'x' })).toContain('Không tải được');
    expect(D.eventsHtml(evt({ rows: [], total: 0, raw: [] }))).toContain('Chưa có sự kiện nào');
    expect(D.eventsHtml(evt({ rows: [], tracked: [], filter: { scope: 'mine', days: 30, type: 'all', dir: 'all', sev: 'all', q: '' } }))).toContain('chưa giữ hay theo dõi');
  });
  it('bảng: thoát HTML trong tiêu đề, chỉ liên kết https, hiện cụm từ đã khớp, nhãn đang giữ, nhãn nhiều mã', () => {
    const h = D.eventsHtml(evt());
    expect(h).not.toContain('<i>bị</i>'); expect(h).toContain('&lt;i&gt;bị&lt;/i&gt;');
    expect(h).toContain('href="https://cafef.vn/x"'); expect(h).not.toContain('javascript:');
    expect(h).toContain('khoi to'); expect(h).toContain('loi nhuan, lai rong'); expect(h).toContain('đang giữ'); expect(h).toContain('(nhiều mã)');
  });
  it('luôn nêu giới hạn: luật từ khoá, hướng chỉ là gợi ý, không phải khuyến nghị', () => {
    const h = D.eventsHtml(evt());
    expect(h).toContain('LUẬT TỪ KHOÁ'); expect(h).toContain('gợi ý theo từ ngữ'); expect(h).toContain('không phải khuyến nghị');
  });
  it('lần chạy tin lỗi được cảnh báo; có đủ các loại sự kiện trong ô chọn', () => {
    const h = D.eventsHtml(evt({ lastRun: { run_at: '2026-10-12T00:00:00Z', ok: false } }));
    expect(h).toContain('lần chạy cuối bị lỗi');
    NE.TYPES.forEach((t) => expect(h).toContain('value="' + t.key + '"'));
  });
});
