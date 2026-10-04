// Edge Function check-limits: tính tuân thủ giới hạn theo ngày; và bản sao thư viện trong thư mục hàm phải khớp lib/ (và chạy được khi nạp kiểu Deno, không có require/module).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCompliance, vnDate } from '../../supabase/functions/check-limits/compliance.ts';
import { EDGE_LIBS, expectedCopy } from '../../scripts/sync-edge-libs.mjs';
import GroupCalc from '../../lib/group-calc.js';
import LimitsCalc from '../../lib/limits-calc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const edge = (f) => readFileSync(path.join(here, '../../supabase/functions/check-limits', f), 'utf8');

describe('bản sao thư viện trong hàm', () => {
  it.each(EDGE_LIBS)('$file khớp lib/ (chạy node scripts/sync-edge-libs.mjs nếu lệch)', (lib) => {
    expect(edge(lib.file)).toBe(expectedCopy(lib));
  });
  it('nạp kiểu Deno (không có require/module) vẫn chạy và cho cùng kết quả với bản trong lib/', () => {
    const sandbox = { console };
    vm.createContext(sandbox);
    // globalThis trong vm.createContext là chính sandbox: mô phỏng việc các module ESM gán lên globalThis. const top-level không lộ ra global nên phải đi qua dòng gán cuối file.
    EDGE_LIBS.forEach((lib) => vm.runInContext(edge(lib.file), sandbox));
    expect(typeof sandbox.GroupCalc.memberPortfolios).toBe('function');
    expect(typeof sandbox.LimitsCalc.complianceMatrix).toBe('function');
    const viaEdge = computeCompliance({ GroupCalc: sandbox.GroupCalc, LimitsCalc: sandbox.LimitsCalc }, INPUT());
    const viaLib = computeCompliance({ GroupCalc, LimitsCalc }, INPUT());
    expect(viaEdge).toEqual(viaLib);
  });
});

const MEMBERS = [{ id: 'u1', email: 'an@x.vn', nickname: 'An' }, { id: 'u2', email: 'binh@x.vn', nickname: 'Bình' }];
const tx = (id, user_id, type, symbol, quantity, price, trade_date) => ({ id, user_id, type, symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + 'T01:00:00Z', deleted_at: null });
const lim = (o) => Object.assign({ id: 'l' + Math.random().toString(36).slice(2, 6), scope: 'member', user_id: null, kind: 'max_symbol_pct', symbol: null, sector: null, value: 25, mode: 'reason', note: null, active: true }, o);
// An: FPT 100tr + VCB 20tr + tiền 30tr (NAV 150tr, FPT 66,7%); Bình: HPG 50tr + tiền 50tr (HPG 50%)
const INPUT = (over = {}) => Object.assign({
  members: MEMBERS,
  txns: [tx('1', 'u1', 'buy', 'FPT', 1000, 100000, '2026-01-02'), tx('2', 'u1', 'buy', 'VCB', 200, 100000, '2026-01-03'), tx('3', 'u2', 'buy', 'HPG', 2000, 25000, '2026-01-04')],
  actions: [],
  prices: [{ user_id: 'u1', symbol: 'FPT', market_price: 100000, price_date: '2026-10-02', updated_at: 'a' }, { user_id: 'u1', symbol: 'VCB', market_price: 100000, price_date: '2026-10-02', updated_at: 'a' }, { user_id: 'u2', symbol: 'HPG', market_price: 25000, price_date: '2026-10-02', updated_at: 'a' }],
  assets: [{ user_id: 'u1', cash: 30e6, debt: 0 }, { user_id: 'u2', cash: 50e6, debt: 0 }],
  limits: [lim({ value: 40 })],
}, over);
const libs = { GroupCalc, LimitsCalc };

describe('computeCompliance', () => {
  it('không có giới hạn nào đang bật -> không ghi gì', () => {
    expect(computeCompliance(libs, INPUT({ limits: [] }))).toEqual([]);
    expect(computeCompliance(libs, INPUT({ limits: [lim({ active: false })] }))).toEqual([]);
  });
  it('mỗi thành viên một dòng: NAV, số giới hạn, danh sách đang vượt', () => {
    const rows = computeCompliance(libs, INPUT());
    expect(rows.map(r => r.user_id)).toEqual(['u1', 'u2']);              // chưa có giới hạn gộp nên không có dòng cả nhóm
    const an = rows[0];
    expect(an.nav).toBe(150e6);
    expect(an.limit_count).toBe(1);
    expect(an.breaches).toHaveLength(1);
    expect(an.breaches[0]).toMatchObject({ kind: 'max_symbol_pct', subject: 'FPT', threshold: 40, mode: 'reason', scope: 'member' });
    expect(an.breaches[0].current).toBeCloseTo(66.6667, 3);
    expect(rows[1].breaches[0]).toMatchObject({ subject: 'HPG', current: 50 });
  });
  it('giới hạn cá nhân chỉ tính cho chính người đó', () => {
    const rows = computeCompliance(libs, INPUT({ limits: [lim({ value: 90 }), lim({ scope: 'user', user_id: 'u2', value: 30 })] }));
    expect(rows[0].breaches).toEqual([]);                                  // An: trần 90%, không vượt
    expect(rows[1].breaches).toHaveLength(1);                              // Bình: thêm trần cá nhân 30%
    expect(rows[1].limit_count).toBe(2);
  });
  it('giới hạn gộp tạo dòng cả nhóm (user_id rỗng)', () => {
    const rows = computeCompliance(libs, INPUT({ limits: [lim({ scope: 'consolidated', value: 30 })] }));
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].breaches[0]).toMatchObject({ subject: 'FPT', scope: 'consolidated' });   // FPT 100tr / NAV 220tr = 45%
  });
  it('gần chạm hạn mức (>= 90%) vào cảnh báo, kèm mức dùng', () => {
    const rows = computeCompliance(libs, INPUT({ limits: [lim({ value: 70 })] }));
    expect(rows[0].breaches).toEqual([]);
    expect(rows[0].warns[0]).toMatchObject({ subject: 'FPT' });
    expect(rows[0].warns[0].usage).toBeCloseTo(0.9524, 3);
  });
  it('mã bị cấm đang giữ -> vi phạm; giá trị JSON hoá được (không Infinity)', () => {
    const rows = computeCompliance(libs, INPUT({ limits: [lim({ kind: 'blocked_symbol', symbol: 'HPG', value: null, mode: 'block' })] }));
    expect(rows[1].breaches[0]).toMatchObject({ kind: 'blocked_symbol', subject: 'HPG', mode: 'block' });
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
  });
  it('lệnh đã xoá không tính (số liệu khớp màn hình)', () => {
    const txns = INPUT().txns.concat([Object.assign(tx('x', 'u2', 'buy', 'FPT', 100000, 100000, '2026-02-01'), { deleted_at: '2026-02-02T00:00:00Z' })]);
    const rows = computeCompliance(libs, INPUT({ txns }));
    expect(rows[1].breaches.map(b => b.subject)).toEqual(['HPG']);
  });
});

describe('vnDate', () => {
  it('đổi sang ngày giờ Việt Nam (UTC+7)', () => {
    expect(vnDate(new Date('2026-10-02T17:30:00Z'))).toBe('2026-10-03');
    expect(vnDate(new Date('2026-10-02T16:59:00Z'))).toBe('2026-10-02');
  });
});

describe('selfTest (bài tự kiểm sau triển khai)', () => {
  it('kết quả cố định -- phải khớp với phản hồi của hàm đã triển khai khi gọi {"selftest":true}', async () => {
    const { selfTest } = await import('../../supabase/functions/check-limits/compliance.ts');
    const rows = selfTest({ GroupCalc, LimitsCalc });
    expect(rows.map(r => r.user_id)).toEqual(['u1', 'u2', null]);
    // An: FPT 1000 x 1,1 = 1100 cp x 90.000 = 99tr; VCB 20tr; tiền 30tr -> NAV 149tr: FPT 66,4% > 40% (vượt, chế độ ghi lý do); tiền 20,1% < 25% (vượt, chế độ cảnh báo)
    expect(rows[0].nav).toBe(149000000);
    expect(rows[0].breaches.map(b => b.subject)).toEqual(['FPT', 'Tiền mặt']);
    expect(rows[0].breaches[1].mode).toBe('warn');
    if (process.env.DUMP_SELFTEST) (await import('node:fs')).writeFileSync(process.env.DUMP_SELFTEST, JSON.stringify(rows));
  });
});
