// Kiểm tra hệ thống, phần MÁY CHỦ: khớp lịch pg_cron, phát hiện lần chạy bị lỡ / lỗi, độ tươi dữ liệu nền (có tính cuối tuần và ngày lễ).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SC from '../../lib/self-check.js';

const U = (iso) => Date.parse(iso + 'Z');                       // '2026-10-12T02:20:00' -> ms (UTC)

describe('cronMatches / lastScheduled', () => {
  it('khớp các dạng trường của lịch hiện có', () => {
    expect(SC.cronMatches('30 12 * * 1-5', U('2026-10-12T12:30:00'))).toBe(true);        // thứ hai
    expect(SC.cronMatches('30 12 * * 1-5', U('2026-10-11T12:30:00'))).toBe(false);       // chủ nhật
    expect(SC.cronMatches('*/10 * * * *', U('2026-10-12T02:20:00'))).toBe(true);
    expect(SC.cronMatches('*/10 * * * *', U('2026-10-12T02:25:00'))).toBe(false);
    expect(SC.cronMatches('2-57/5 2-7 * * 1-5', U('2026-10-12T02:17:00'))).toBe(true);
    expect(SC.cronMatches('2-57/5 2-7 * * 1-5', U('2026-10-12T02:15:00'))).toBe(false);
    expect(SC.cronMatches('10 */3 * * *', U('2026-10-12T00:10:00'))).toBe(true);
    expect(SC.cronMatches('10 */3 * * *', U('2026-10-12T01:10:00'))).toBe(false);
    expect(SC.cronMatches('15 0,11 * * *', U('2026-10-12T11:15:00'))).toBe(true);
    expect(SC.cronMatches('0 20 * * 0', U('2026-10-11T20:00:00'))).toBe(true);           // chủ nhật = 0
    expect(SC.cronMatches('5 1 * * 2-6', U('2026-10-10T01:05:00'))).toBe(true);          // thứ bảy
    expect(SC.cronMatches('bậy', U('2026-10-12T00:00:00'))).toBe(false);
  });
  it('lần lên lịch gần nhất lùi qua cuối tuần', () => {
    const t = SC.lastScheduled('30 12 * * 1-5', U('2026-10-12T02:20:00'));              // sáng thứ hai -> chiều thứ sáu
    expect(new Date(t).toISOString()).toBe('2026-10-09T12:30:00.000Z');
    expect(SC.lastScheduled('0 0 31 2 *', U('2026-10-12T02:20:00'), 3)).toBeNull();
  });
});

describe('cronHealth', () => {
  const NOW = U('2026-10-12T13:00:00');                                                 // thứ hai 20:00 giờ VN
  const row = (o) => Object.assign({ jobname: 'x', schedule: '30 12 * * 1-5', active: true, last_start: '2026-10-12T12:30:00.1+00:00', last_status: 'succeeded', last_message: '1 row', runs_48h: 1, fails_48h: 0 }, o);
  it('đúng giờ gần nhất -> ok', () => {
    expect(SC.cronHealth([row()], NOW).status).toBe('ok');
  });
  it('lỡ lần chạy hôm nay -> LỖI, nêu tên job và giờ', () => {
    const r = SC.cronHealth([row({ jobname: 'bt-fill-daily', last_start: '2026-10-09T12:30:00+00:00' })], NOW);
    expect(r.status).toBe('fail'); expect(r.detail).toMatch(/bt-fill-daily: lỡ lần chạy 2026-10-12 12:30 UTC/);
  });
  it('chưa tới giờ chạy hôm nay thì lần của thứ sáu vẫn là mới nhất; job mới tạo chưa chạy lần nào chỉ là chú ý', () => {
    const early = U('2026-10-12T02:20:00');
    expect(SC.cronHealth([row({ last_start: '2026-10-09T12:30:00+00:00' })], early).status).toBe('ok');
    const r = SC.cronHealth([row({ jobname: 'moi', last_start: null, last_status: null })], early);
    expect(r.status).toBe('warn'); expect(r.detail).toMatch(/moi: chưa chạy lần nào/);
  });
  it('lần chạy gần nhất báo lỗi -> lỗi; có lỗi trong 48 giờ -> chú ý; job tắt -> chú ý; không có dữ liệu -> chú ý', () => {
    expect(SC.cronHealth([row({ last_status: 'failed', last_message: 'server closed' })], NOW).status).toBe('fail');
    expect(SC.cronHealth([row({ fails_48h: 2 })], NOW).status).toBe('warn');
    expect(SC.cronHealth([row({ active: false })], NOW).status).toBe('warn');
    expect(SC.cronHealth([], NOW).status).toBe('warn');
    expect(SC.cronHealth(null, NOW).status).toBe('warn');
  });
  it('lịch */5 trong giờ giao dịch: ngoài giờ không bị coi là lỡ', () => {
    const r = row({ schedule: '*/5 2-7 * * 1-5', last_start: '2026-10-12T07:55:00+00:00' });
    expect(SC.cronHealth([r], U('2026-10-12T13:00:00')).status).toBe('ok');
    const inSession = row({ schedule: '*/5 2-7 * * 1-5', last_start: '2026-10-12T07:15:00+00:00' });
    expect(SC.cronHealth([inSession], U('2026-10-12T07:20:00')).status).toBe('ok');
    expect(SC.cronHealth([row({ schedule: '*/5 2-7 * * 1-5', last_start: '2026-10-12T06:00:00+00:00' })], U('2026-10-12T07:20:00')).status).toBe('fail');   // giữa phiên mà 80 phút không chạy
  });
});

describe('dataFreshness', () => {
  const mon = U('2026-10-12T13:30:00');                                                  // thứ hai 20:30 giờ VN, sau 19:30
  const fresh = (o) => Object.assign({ price_days: '2026-10-12', pit_market: '2026-10-12', nav_history: '2026-10-12', sim_watch: '2026-10-12T11:55:05+00:00', sim_runs_open: 1, pit_news: '2026-10-12T12:10:00+00:00', financials: '2026-10-12T11:15:00+00:00', ownership: '2026-10-12T12:15:00+00:00', market_snapshot: '2026-10-12T11:20:00+00:00', data_health_open_errors: 0 }, o);
  it('mọi thứ mới -> ok', () => {
    const v = SC.freshnessVerdict(SC.dataFreshness(fresh(), mon));
    expect(v.status).toBe('ok');
  });
  it('kho giá thiếu ngày hôm nay sau 19:30 giờ VN -> chú ý', () => {
    const items = SC.dataFreshness(fresh({ price_days: '2026-10-09' }), mon);
    expect(items.find((i) => i.key === 'price_days')).toMatchObject({ status: 'warn' });
    expect(items.find((i) => i.key === 'price_days').detail).toMatch(/2026-10-09.*2026-10-12/);
  });
  it('trước giờ nạp (sáng thứ hai) thì dữ liệu thứ sáu vẫn đúng hạn; cuối tuần cũng vậy', () => {
    const morning = U('2026-10-12T02:20:00');
    expect(SC.dataFreshness(fresh({ price_days: '2026-10-09', pit_market: '2026-10-09', sim_watch: '2026-10-09T11:55:00+00:00', pit_news: '2026-10-12T00:10:00+00:00' }), morning).find((i) => i.key === 'price_days').status).toBe('ok');
    const sat = U('2026-10-10T10:00:00');
    expect(SC.dataFreshness(fresh({ price_days: '2026-10-09', pit_market: '2026-10-09', nav_history: '2026-10-10', sim_watch: '2026-10-09T11:55:00+00:00', pit_news: '2026-10-10T09:10:00+00:00', ownership: '2026-10-09T12:15:00+00:00', financials: '2026-10-10T00:15:00+00:00', market_snapshot: '2026-10-10T01:15:00+00:00' }), sat).filter((i) => i.status !== 'ok')).toEqual([]);
  });
  it('ngày lễ: không đòi dữ liệu của ngày nghỉ', () => {
    const holiday = U('2026-09-02T13:30:00');                                         // 2/9 quốc khánh (thứ tư)
    const isTD = (iso) => iso !== '2026-09-02' && ![0, 6].includes(new Date(iso + 'T00:00:00Z').getUTCDay());
    const items = SC.dataFreshness(fresh({ price_days: '2026-09-01', pit_market: '2026-09-01', nav_history: '2026-09-02', sim_watch: '2026-09-02T11:55:00+00:00', pit_news: '2026-09-02T12:10:00+00:00', financials: '2026-09-02T11:15:00+00:00', ownership: '2026-09-02T12:15:00+00:00', market_snapshot: '2026-09-02T11:20:00+00:00' }), holiday, { isTradingDay: isTD });
    expect(items.find((i) => i.key === 'price_days').status).toBe('ok');
  });
  it('tin quá 5 giờ, báo cáo quá 36 giờ, NAV thiếu ngày, cảnh báo dữ liệu mức lỗi -> chú ý; chưa có lần mô phỏng nào thì không đòi sim_watch', () => {
    const items = SC.dataFreshness(fresh({ pit_news: '2026-10-12T05:00:00+00:00', financials: '2026-10-10T00:00:00+00:00', nav_history: '2026-10-09', data_health_open_errors: 3, sim_runs_open: 0, sim_watch: null }), mon);
    const bad = items.filter((i) => i.status !== 'ok').map((i) => i.key).sort();
    expect(bad).toEqual(['data_health', 'financials', 'nav_history', 'pit_news']);
    expect(items.find((i) => i.key === 'sim_watch')).toBeUndefined();
  });
  it('kết quả rỗng/không có quyền -> mọi mục chú ý (không ném lỗi)', () => {
    expect(() => SC.dataFreshness({}, mon)).not.toThrow();
    expect(SC.freshnessVerdict(SC.dataFreshness({}, mon)).status).toBe('warn');
  });
});

describe('phía ứng dụng và migration', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (rel) => fs.readFileSync(path.join(here, '../../', rel), 'utf8');
  it('self-check.js gọi đúng hai RPC và migration định nghĩa chúng chỉ cho finance/admin', () => {
    const ui = read('self-check.js'), sql = read('finance-system-health-migration.sql');
    expect(ui).toMatch(/rpc\('fn_cron_health'\)/); expect(ui).toMatch(/rpc\('fn_data_freshness'\)/);
    ['fn_cron_health', 'fn_data_freshness'].forEach((f) => {
      expect(sql).toContain('function public.' + f + '()');
      expect(sql).toMatch(new RegExp('revoke all on function public\\.' + f + '\\(\\) from public, anon'));
      expect(sql).toMatch(new RegExp('grant execute on function public\\.' + f + '\\(\\) to authenticated'));
    });
    expect((sql.match(/in \('admin', 'finance'\)/g) || []).length).toBe(2);
    expect(sql).toMatch(/security definer/i);
  });
});
