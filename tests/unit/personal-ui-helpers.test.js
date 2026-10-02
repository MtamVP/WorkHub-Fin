// lib/personal-ui-helpers.js -- hàm thuần của giao diện Không Gian Riêng. Múi giờ cố định để các ca "hôm nay/ngày mai"
// và "cả ngày" không phụ thuộc máy chạy test.
import { describe, it, expect } from 'vitest';
import {
  personalDayKey, personalGreeting, personalRelativeDayLabel, personalIsAllDay, personalTimeLabel,
  groupAgendaByDay, personalNormalize, personalHighlightHtml, personalItemMatches, personalEventMatches, personalChecklistStats,
  personalDomainOf, personalAvatar, personalSyncedAtLabel, personalFolderName, personalFormatBytes,
} from '../../lib/personal-ui-helpers.js';

process.env.TZ = 'America/Edmonton';

// Mốc "bây giờ" cố định: Thứ Sáu 2/10/2026 10:00 giờ địa phương.
const NOW = new Date(2026, 9, 2, 10, 0, 0).getTime();
const at = (d, h = 9, m = 0) => new Date(2026, 9, d, h, m, 0).toISOString();
const ev = (id, day, h1, h2, extra = {}) => ({ id, title: id, startTime: at(day, h1), endTime: at(day, h2), ...extra });

describe('personalGreeting', () => {
  it('chọn lời chào theo giờ', () => {
    expect(personalGreeting(7)).toBe('Chào buổi sáng');
    expect(personalGreeting(12)).toBe('Chào buổi trưa');
    expect(personalGreeting(15)).toBe('Chào buổi chiều');
    expect(personalGreeting(21)).toBe('Chào buổi tối');
  });
});

describe('personalRelativeDayLabel', () => {
  it('Hôm nay / Ngày mai / thứ-ngày/tháng', () => {
    expect(personalRelativeDayLabel(new Date(2026, 9, 2, 23, 0), NOW)).toBe('Hôm nay');
    expect(personalRelativeDayLabel(new Date(2026, 9, 3, 0, 5), NOW)).toBe('Ngày mai');
    expect(personalRelativeDayLabel(new Date(2026, 9, 5), NOW)).toBe('Thứ Hai, 5/10');
  });
});

describe('personalTimeLabel / personalIsAllDay', () => {
  it('nhận ra sự kiện cả ngày (00:00:00 -> 23:59:59 giờ địa phương)', () => {
    const allDay = { startTime: new Date(2026, 9, 5, 0, 0, 0).toISOString(), endTime: new Date(2026, 9, 5, 23, 59, 59).toISOString() };
    expect(personalIsAllDay(allDay.startTime, allDay.endTime)).toBe(true);
    const noSeconds = { startTime: new Date(2026, 9, 5, 0, 0, 0).toISOString(), endTime: new Date(2026, 9, 5, 23, 59, 0).toISOString() };
    expect(personalIsAllDay(noSeconds.startTime, noSeconds.endTime)).toBe(true);
    expect(personalIsAllDay(at(5, 0), at(5, 22))).toBe(false);
    expect(personalTimeLabel(allDay)).toBe('Cả ngày');
  });

  it('sự kiện có giờ hiện HH:mm – HH:mm theo giờ địa phương', () => {
    expect(personalTimeLabel(ev('a', 5, 9, 10))).toBe('09:00 – 10:00');
  });
});

describe('groupAgendaByDay', () => {
  it('nhóm theo ngày, sắp theo giờ, gắn nhãn Hôm nay/Ngày mai', () => {
    const groups = groupAgendaByDay([
      ev('muon', 2, 15, 16), ev('sang', 2, 8, 9), ev('mai', 3, 9, 10), ev('tuan-sau', 9, 9, 10),
    ], { now: NOW });
    expect(groups.map(g => g.label)).toEqual(['Hôm nay', 'Ngày mai', 'Thứ Sáu, 9/10']);
    expect(groups[0].isToday).toBe(true);
    expect(groups[0].events.map(e => e.id)).toEqual(['sang', 'muon']);
  });

  it('bỏ sự kiện ngoài cửa sổ [hôm nay, +45 ngày]', () => {
    const groups = groupAgendaByDay([
      ev('hom-qua', 1, 9, 10),
      { id: 'xa', title: 'xa', startTime: new Date(2026, 11, 25, 9).toISOString(), endTime: new Date(2026, 11, 25, 10).toISOString() },
      ev('trong', 4, 9, 10),
    ], { now: NOW });
    expect(groups.flatMap(g => g.events.map(e => e.id))).toEqual(['trong']);
  });

  it('sự kiện kéo dài nhiều ngày xuất hiện ở từng ngày', () => {
    const groups = groupAgendaByDay([{ id: 'hoi-nghi', title: 'Hội nghị', startTime: at(5, 9), endTime: at(7, 17) }], { now: NOW });
    expect(groups.map(g => g.dayKey)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
  });

  it('sự kiện kết thúc đúng 00:00 ngày sau không chiếm ngày sau', () => {
    const groups = groupAgendaByDay([{ id: 'x', title: 'x', startTime: at(5, 22), endTime: new Date(2026, 9, 6, 0, 0, 0).toISOString() }], { now: NOW });
    expect(groups.map(g => g.dayKey)).toEqual(['2026-10-05']);
  });

  it('danh sách rỗng hoặc dữ liệu hỏng không làm vỡ', () => {
    expect(groupAgendaByDay([], { now: NOW })).toEqual([]);
    expect(groupAgendaByDay(null, { now: NOW })).toEqual([]);
    expect(groupAgendaByDay([{ id: 'hong', startTime: 'không phải ngày' }], { now: NOW })).toEqual([]);
  });
});

describe('tìm kiếm bỏ dấu', () => {
  it('personalNormalize bỏ dấu và chữ đ', () => {
    expect(personalNormalize('Báo cáo ĐỒNG bộ')).toBe('bao cao dong bo');
    expect(personalNormalize(null)).toBe('');
  });

  it('gõ không dấu vẫn thấy mục có dấu, mọi từ đều phải khớp', () => {
    const note = { title: 'Báo cáo tài chính Q3', data: { text: 'Số liệu doanh thu' }, tags: ['quan-trong'] };
    expect(personalItemMatches(note, 'bao cao')).toBe(true);
    expect(personalItemMatches(note, 'doanh thu q3')).toBe(true);
    expect(personalItemMatches(note, 'quan-trong')).toBe(true);
    expect(personalItemMatches(note, 'bao cao thue')).toBe(false);
    expect(personalItemMatches(note, '')).toBe(true);
  });

  it('khớp cả url của lối tắt và địa điểm của sự kiện', () => {
    expect(personalItemMatches({ title: 'VN-Index', data: { url: 'https://vietstock.vn/chi-so' } }, 'vietstock')).toBe(true);
    expect(personalEventMatches({ title: 'Họp', location: 'Phòng Đà Nẵng' }, 'da nang')).toBe(true);
    expect(personalEventMatches({ title: 'Họp', location: 'Phòng A' }, 'da nang')).toBe(false);
  });
});

describe('personalHighlightHtml', () => {
  it('tô sáng không phân biệt dấu/hoa thường và giữ nguyên chữ gốc', () => {
    expect(personalHighlightHtml('Báo cáo tài chính', 'bao cao')).toBe('<mark>Báo</mark> <mark>cáo</mark> tài chính');
    expect(personalHighlightHtml('Báo cáo tài chính', 'tai chinh')).toBe('Báo cáo <mark>tài</mark> <mark>chính</mark>');
    expect(personalHighlightHtml('Đồng bộ thư mục', 'dong')).toBe('<mark>Đồng</mark> bộ thư mục');
  });

  it('nhiều từ, nhiều lần xuất hiện', () => {
    expect(personalHighlightHtml('họp họp tuần', 'hop tuan')).toBe('<mark>họp</mark> <mark>họp</mark> <mark>tuần</mark>');
  });

  it('escape HTML để không chèn được thẻ qua tiêu đề', () => {
    expect(personalHighlightHtml('<img src=x onerror=1>', 'img')).toBe('&lt;<mark>img</mark> src=x onerror=1&gt;');
    expect(personalHighlightHtml('a & b', '')).toBe('a &amp; b');
  });
});

describe('personalChecklistStats', () => {
  it('đếm xong/chưa xong và phần trăm, bỏ qua loại khác', () => {
    const items = [
      { type: 'checklist', data: { done: true } }, { type: 'checklist', data: { done: false } },
      { type: 'checklist', data: {} }, { type: 'checklist', data: { done: true } }, { type: 'note' },
    ];
    expect(personalChecklistStats(items)).toEqual({ total: 4, done: 2, open: 2, percent: 50 });
    expect(personalChecklistStats([])).toEqual({ total: 0, done: 0, open: 0, percent: 0 });
  });
});

describe('các hàm nhỏ', () => {
  it('personalDomainOf lấy tên miền, chấp nhận url thiếu giao thức', () => {
    expect(personalDomainOf('https://www.vietstock.vn/a/b')).toBe('vietstock.vn');
    expect(personalDomainOf('cafef.vn/x')).toBe('cafef.vn');
    expect(personalDomainOf('')).toBe('');
  });

  it('personalAvatar ổn định theo tên', () => {
    expect(personalAvatar('Đầu tư').letter).toBe('Đ');
    expect(personalAvatar('abc').tone).toBe(personalAvatar('abc').tone);
    expect(personalAvatar('abc').tone).toBeGreaterThanOrEqual(0);
    expect(personalAvatar('abc').tone).toBeLessThan(6);
  });

  it('personalSyncedAtLabel: hôm nay / hôm qua / ngày khác', () => {
    expect(personalSyncedAtLabel(null, NOW)).toBe('Chưa đồng bộ');
    expect(personalSyncedAtLabel(new Date(2026, 9, 2, 9, 5).getTime(), NOW)).toBe('Đồng bộ lúc 09:05');
    expect(personalSyncedAtLabel(new Date(2026, 9, 1, 21, 10).getTime(), NOW)).toBe('Đồng bộ hôm qua 21:10');
    expect(personalSyncedAtLabel(new Date(2026, 8, 20, 8, 0).getTime(), NOW)).toBe('Đồng bộ 20/09 08:00');
  });

  it('personalFolderName lấy tên thư mục cuối ở cả đường dẫn Windows và Unix', () => {
    expect(personalFolderName('C:\\Users\\Tam\\Tài liệu\\Dự án\\')).toBe('Dự án');
    expect(personalFolderName('/home/tam/docs')).toBe('docs');
  });

  it('personalFormatBytes', () => {
    expect(personalFormatBytes(512)).toBe('512 B');
    expect(personalFormatBytes(2048)).toBe('2.0 KB');
    expect(personalFormatBytes(30171543)).toBe('28.8 MB');
    expect(personalFormatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
  });

  it('personalDayKey dùng ngày giờ địa phương', () => {
    expect(personalDayKey(new Date(2026, 9, 2, 23, 59))).toBe('2026-10-02');
  });
});
