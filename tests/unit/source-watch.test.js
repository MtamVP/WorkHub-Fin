import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { SOURCEWATCH_LIBS, expectedCopy } from '../../scripts/sync-edge-libs.mjs';
import {
  vnDate, tradingDaysBetween, prevTradingDay, judgeVci, judgeFinfo, judgeDchart, consecutiveFailures, dayRate, evaluateProbes, evaluateSnapshot, describeFlag, buildEmail, SOURCE_LABEL,
} from '../../supabase/functions/source-watch/logic.ts';
import VnHolidays from '../../lib/vn-holidays.js';

const hol = (iso) => VnHolidays.isHoliday(iso);
const T = (day, hh, mm) => new Date(Date.parse(day + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00+07:00')).toISOString();
// dựng lịch sử thăm dò: mỗi ngày 12 lần (9:00-14:30), kết quả theo hàm ok(source, day, i)
function history(days, ok) {
  const runs = [];
  days.forEach((d) => { for (let i = 0; i < 12; i++) { const hh = 9 + Math.floor(i / 2), mm = (i % 2) * 30; ['vci', 'finfo', 'dchart'].forEach((s) => runs.push({ mode: 'probe:' + s, run_at: T(d, hh, mm), ok: ok(s, d, i) })); } });
  return runs.sort((a, b) => (a.run_at < b.run_at ? 1 : -1));        // mới nhất trước
}

describe('bản sao lịch lễ cho Edge Function', () => {
  it('khớp nguyên văn lib/vn-holidays.js (quên chạy node scripts/sync-edge-libs.mjs sẽ đỏ ở đây) và chạy được khi nạp kiểu Deno', () => {
    const lib = SOURCEWATCH_LIBS[0];
    const copy = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/source-watch', lib.file), 'utf8');
    expect(copy).toBe(expectedCopy(lib));
    const g = { globalThis: null }; g.globalThis = g; vm.createContext(g);
    vm.runInContext(copy, g); expect(g.VnHolidays.isHoliday('2026-09-02')).toBe(true); expect(g.VnHolidays.isHoliday('2026-10-07')).toBe(false);
  });
});

describe('ngày giao dịch', () => {
  it('vnDate theo giờ VN; tradingDaysBetween bỏ cuối tuần và ngày lễ; prevTradingDay', () => {
    expect(vnDate(new Date('2026-10-06T18:30:00Z'))).toBe('2026-10-07');                 // 01:30 giờ VN ngày hôm sau
    expect(tradingDaysBetween('2026-10-02', '2026-10-07', hol)).toBe(3);                   // T2, T3, T4
    expect(tradingDaysBetween('2026-08-28', '2026-09-03', hol)).toBe(1);                   // 31/8, 1/9, 2/9 nghỉ lễ -> chỉ còn 3/9
    expect(tradingDaysBetween('2026-10-07', '2026-10-07', hol)).toBe(0);
    expect(prevTradingDay('2026-10-07', hol)).toBe('2026-10-06'); expect(prevTradingDay('2026-10-05', hol)).toBe('2026-10-02'); expect(prevTradingDay('2026-09-03', hol)).toBe('2026-08-28');
  });
});

describe('đánh giá một lần thăm dò', () => {
  it('VCI: cần đủ số mã có giá; finfo: ngày lễ không có dòng hôm nay vẫn khoẻ; dchart: cần nến', () => {
    const row = (c) => ({ s: 'X', c, ref: 10000 });
    expect(judgeVci(Array.from({ length: 430 }, () => row(10000))).ok).toBe(true);
    expect(judgeVci(Array.from({ length: 40 }, () => row(10000))).ok).toBe(false);          // bảng thiếu mã (VCI đổi cấu trúc/chặn một phần)
    expect(judgeVci(Array.from({ length: 430 }, () => ({ s: 'X' }))).ok).toBe(false);       // có mã nhưng không có giá
    expect(judgeVci({ message: 'x' }).ok).toBe(false);
    expect(judgeFinfo({ data: [] }, '2026-10-07')).toMatchObject({ ok: true, detail: { hasToday: false } });
    expect(judgeFinfo({ data: [{ date: '2026-10-07' }] }, '2026-10-07').detail.hasToday).toBe(true); expect(judgeFinfo({}, 'x').ok).toBe(false); expect(judgeFinfo(null, 'x').ok).toBe(false);
    expect(judgeDchart({ s: 'ok', t: [1, 2] }).ok).toBe(true); expect(judgeDchart({ s: 'ok', t: [] }).ok).toBe(false); expect(judgeDchart({ s: 'no_data' }).ok).toBe(false); expect(judgeDchart(null).ok).toBe(false);
  });
});

describe('phân tích lịch sử thăm dò', () => {
  const TODAY = '2026-10-07', PREV = '2026-10-06';
  it('đếm lỗi liên tiếp gần nhất và tỷ lệ theo ngày VN', () => {
    const runs = history([PREV, TODAY], (s, d, i) => !(s === 'vci' && d === TODAY && i >= 6));      // VCI hôm nay lỗi từ lần thứ 7 trở đi
    expect(consecutiveFailures(runs, 'vci')).toBe(6); expect(consecutiveFailures(runs, 'finfo')).toBe(0);
    expect(dayRate(runs, 'vci', TODAY)).toEqual({ ok: 6, total: 12 }); expect(dayRate(runs, 'vci', PREV)).toEqual({ ok: 12, total: 12 });
  });
  it('4 lần lỗi liên tiếp: cảnh báo (không email); khỏe thì không có gì', () => {
    const runs = history([PREV, TODAY], (s, d, i) => !(s === 'vci' && d === TODAY && i >= 8));
    const f = evaluateProbes(runs, TODAY, hol);
    expect(f).toHaveLength(1); expect(f[0]).toMatchObject({ kind: 'source_probe', severity: 'warn', symbol: null, ref_date: TODAY, dedupe_key: 'probe:vci:2026-10-07:warn' }); expect(f[0].detail).toMatchObject({ key: 'vci', failed: 4 });
    expect(evaluateProbes(history([PREV, TODAY], () => true), TODAY, hol)).toEqual([]);
    expect(evaluateProbes(history([PREV, TODAY], (s, d, i) => !(s === 'finfo' && d === TODAY && i >= 9)), TODAY, hol)).toEqual([]);     // chỉ 3 lần lỗi liền
  });
  it('lỗi quá nửa trong CẢ HAI ngày giao dịch: mức lỗi (email); chỉ một ngày thì chưa', () => {
    const both = history([PREV, TODAY], (s, d) => s !== 'dchart');
    const f = evaluateProbes(both, TODAY, hol).filter((x) => x.severity === 'error');
    expect(f).toHaveLength(1); expect(f[0].dedupe_key).toBe('probe:dchart:2026-10-07:error'); expect(f[0].detail).toMatchObject({ key: 'dchart', level: 'day', today: { ok: 0, total: 12 }, previous: { date: PREV, ok: 0, total: 12 } });
    const oneDay = history([PREV, TODAY], (s, d) => !(s === 'dchart' && d === TODAY));
    expect(evaluateProbes(oneDay, TODAY, hol).filter((x) => x.severity === 'error')).toEqual([]);
    const fewProbes = history([TODAY], () => false).slice(0, 15);                               // quá ít lần thăm dò thì không kết luận theo ngày
    expect(evaluateProbes(fewProbes, TODAY, hol).filter((x) => x.severity === 'error')).toEqual([]);
  });
  it('ngày trước ngày giao dịch hôm nay bỏ qua cuối tuần/ngày lễ khi so', () => {
    const runs = history(['2026-08-28', '2026-09-03'], (s) => s !== 'vci');                      // 28/8 (T6) rồi 3/9: giữa là cuối tuần + nghỉ lễ
    expect(evaluateProbes(runs, '2026-09-03', hol).filter((x) => x.severity === 'error').map((x) => x.detail.key)).toEqual(['vci']);
  });
});

describe('ảnh chụp thị trường chậm ngày', () => {
  it('ngày số liệu kỳ vọng là ngày giao dịch liền trước (đo thật: chạy tối 06/10 ra số liệu 05/10); chậm 1: cảnh báo; từ 2: lỗi; ngày lễ/cuối tuần không kiểm', () => {
    expect(evaluateSnapshot('2026-10-06', '2026-10-07', hol)).toEqual([]);                        // đúng kỳ vọng
    expect(evaluateSnapshot('2026-10-05', '2026-10-06', hol)).toEqual([]);                        // dữ liệu thật hôm 06/10
    const w = evaluateSnapshot('2026-10-05', '2026-10-07', hol); expect(w[0]).toMatchObject({ kind: 'snapshot_stale', severity: 'warn', dedupe_key: 'snapshot:2026-10-07:warn' }); expect(w[0].detail).toMatchObject({ asOf: '2026-10-05', behind: 1 });
    expect(evaluateSnapshot('2026-10-02', '2026-10-07', hol)[0]).toMatchObject({ severity: 'error', dedupe_key: 'snapshot:2026-10-07:error' });
    expect(evaluateSnapshot('2026-10-01', '2026-10-05', hol)[0].severity).toBe('warn');          // T2 05/10: kỳ vọng 02/10 (T6); có 01/10 -> chậm 1 phiên
    expect(evaluateSnapshot('2026-10-02', '2026-10-05', hol)).toEqual([]);
    expect(evaluateSnapshot('2026-08-28', '2026-09-03', hol)).toEqual([]);                        // sau kỳ nghỉ lễ 31/8-2/9: kỳ vọng 28/8
    expect(evaluateSnapshot('2026-08-28', '2026-09-02', hol)).toEqual([]);                        // 2/9 là ngày lễ
    expect(evaluateSnapshot('2026-10-01', '2026-10-10', hol)).toEqual([]);                        // thứ bảy
    expect(evaluateSnapshot(null, '2026-10-07', hol)[0]).toMatchObject({ severity: 'error' });
  });
});

describe('email', () => {
  it('mô tả cảnh báo, tiêu đề đếm số lỗi, không chứa dữ liệu cá nhân', () => {
    const rows = [
      { severity: 'error', kind: 'source_probe', detail: { source: SOURCE_LABEL.vci, level: 'day', today: { ok: 1, total: 12 }, previous: { date: '2026-10-06', ok: 0, total: 12 } } },
      { severity: 'error', kind: 'snapshot_stale', detail: { source: 'Ảnh chụp thị trường', asOf: '2026-10-02', behind: 3 } },
      { severity: 'warn', kind: 'source_probe', detail: { source: SOURCE_LABEL.finfo, level: 'streak', failed: 5 } },
    ];
    expect(describeFlag(rows[0])).toContain('hôm nay 1/12 đạt'); expect(describeFlag(rows[1])).toBe('Ảnh chụp thị trường: số liệu ngày 2026-10-02, chậm 3 ngày giao dịch'); expect(describeFlag(rows[2])).toContain('5 lần thăm dò liên tiếp');
    const m = buildEmail(rows);
    expect(m.subject).toBe('WorkHub: nguồn dữ liệu có sự cố (3 cảnh báo, 2 lỗi)'); expect(m.text).toContain('[LỖI]'); expect(m.html).toContain('Nguồn dữ liệu có sự cố'); expect(m.text).not.toMatch(/@|Bearer|eyJ/);
    expect(describeFlag({ kind: 'snapshot_stale', detail: { source: 'S', asOf: null } })).toBe('S: chưa có số liệu');
  });
});
