// Edge Function butler-data: bản sao thư viện khớp lib/, chỉ đọc bằng JWT người hỏi (không service role), tính danh mục / nhóm / giới hạn / lệnh chờ duyệt đúng bằng thư viện của app, và công cụ đọc CSDL dùng đúng bảng + bộ lọc.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUTLERDATA_LIBS, BUTLERDATA_TS, expectedCopy } from '../../scripts/sync-edge-libs.mjs';
import FinCalc from '../../lib/finance-calc.js';
import PortfolioCalc from '../../lib/portfolio-calc.js';
import GroupCalc from '../../lib/group-calc.js';
import LimitsCalc from '../../lib/limits-calc.js';

// data.ts nạp bản sao thư viện kiểu Deno (gán globalThis); trong Vitest có `require` nên group-calc.js sẽ đòi perf-calc.js không có ở thư mục hàm -> thay bằng no-op và gán global từ lib/ (test khớp bản sao ở trên)
['finance-calc', 'portfolio-calc', 'group-calc', 'limits-calc'].forEach((n) => vi.doMock('../../supabase/functions/butler-data/' + n + '.js', () => ({})));
globalThis.FinCalc = FinCalc; globalThis.PortfolioCalc = PortfolioCalc; globalThis.GroupCalc = GroupCalc; globalThis.LimitsCalc = LimitsCalc;
const D = await import('../../supabase/functions/butler-data/data.ts');
const C = require('../../lib/butler-core.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '../..');
const DIR = 'supabase/functions/butler-data';
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('butler-data: bản sao và an toàn', () => {
  it('thư viện khớp lib/ và compliance.ts khớp check-limits (chạy node scripts/sync-edge-libs.mjs nếu đỏ)', () => {
    BUTLERDATA_LIBS.forEach((lib) => expect(read(DIR + '/' + lib.file), lib.file).toBe(expectedCopy(lib)));
    BUTLERDATA_TS.forEach((c) => expect(read(c.to)).toBe(read(c.from)));
  });
  it('không dùng service role, không cron-guard; client dựng từ khoá công khai + Authorization người gọi', () => {
    readdirSync(path.join(ROOT, DIR)).forEach((f) => expect(read(DIR + '/' + f), f).not.toMatch(/SERVICE_ROLE|service_role/i));
    const idx = read(DIR + '/index.ts');
    expect(idx).not.toMatch(/cron-guard|cronGuard/);
    expect(idx).toMatch(/SUPABASE_ANON_KEY/);
    expect(idx).toMatch(/Authorization: req\.headers\.get\("authorization"\)/);
  });
  it('chỉ ĐỌC: không insert / update / delete / upsert / rpc ở bất cứ tệp nào', () => {
    ['index.ts', 'data.ts'].forEach((f) => expect(read(DIR + '/' + f), f).not.toMatch(/\.(insert|update|delete|upsert)\(|\.rpc\(/));
  });
  it('kiểm đăng nhập + nhóm tài chính trước khi chạy công cụ; selftest không cần đăng nhập', () => {
    const idx = read(DIR + '/index.ts');
    expect(idx.indexOf('selftest')).toBeLessThan(idx.indexOf('auth.getUser'));
    expect(idx.indexOf('canSeeFinance(me)')).toBeLessThan(idx.indexOf('await toolPortfolio'));
  });
  it('hàm butler gọi butler-data bằng chính tiêu đề của người hỏi, và mọi công cụ dữ liệu của lõi đều có trong butler-data', () => {
    const b = read('supabase/functions/butler/index.ts'), idx = read(DIR + '/index.ts');
    expect(b).toMatch(/\/functions\/v1\/butler-data/);
    expect(b).toMatch(/headers\["authorization"\] = a/);
    Object.keys(C.TOOLS).filter((k) => C.TOOLS[k].data).forEach((k) => expect(idx, k).toContain('"' + k + '"'));
  });
});

const tx = (id, user_id, type, symbol, quantity, price, trade_date) => ({ id, user_id, type, symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + 'T01:00:00Z', deleted_at: null });
const raw = {
  members: [{ id: 'u1', email: 'an@x.vn', nickname: 'An' }, { id: 'u2', email: 'binh@x.vn', nickname: 'Bình' }],
  txns: [tx('1', 'u1', 'buy', 'FPT', 1000, 100000, '2026-01-02'), tx('2', 'u1', 'buy', 'VCB', 200, 100000, '2026-01-03'), tx('3', 'u2', 'buy', 'FPT', 500, 90000, '2026-01-04'), tx('4', 'u2', 'buy', 'HPG', 2000, 25000, '2026-01-05')],
  actions: [],
  prices: [{ user_id: 'u1', symbol: 'FPT', market_price: 120000, price_date: '2026-10-12', updated_at: 'a' }, { user_id: 'u1', symbol: 'VCB', market_price: 90000, price_date: '2026-10-12', updated_at: 'a' }, { user_id: 'u2', symbol: 'HPG', market_price: 25000, price_date: '2026-10-12', updated_at: 'a' }],
  assets: [{ user_id: 'u1', cash: 30000000, debt: 0 }, { user_id: 'u2', cash: 50000000, debt: 0 }],
};

describe('buildPortfolio / buildHolding / buildGroup', () => {
  it('danh mục của tôi: NAV, tiền mặt, lãi lỗ, mã xếp theo giá trị', () => {
    const f = D.buildPortfolio(raw, 'u1');
    // FPT 1000 x 120.000 = 120.000.000; VCB 200 x 90.000 = 18.000.000; cash 30.000.000
    expect(f).toMatchObject({ name: 'An', nav: 168000000, marketValue: 138000000, cash: 30000000, positionCount: 2, noPriceCount: 0, priceDate: '2026-10-12' });
    expect(f.holdings.map((h) => h.symbol)).toEqual(['FPT', 'VCB']);
    expect(f.holdings[0]).toMatchObject({ quantity: 1000, avgCost: 100000, price: 120000, value: 120000000, unrealizedPct: 20 });
    expect(f.unrealizedPct).toBeCloseTo(((138000000 / 120000000) - 1) * 100, 0);
    expect(f.cashPct).toBeCloseTo(30000000 / 168000000 * 100, 0);
    expect(D.buildPortfolio(raw, 'khong-co')).toBeNull();
  });
  it('một mã: vị thế của tôi + của nhóm, không nêu tên người khác', () => {
    const f = D.buildHolding(raw, 'u1', 'FPT');
    expect(f.mine).toMatchObject({ quantity: 1000, value: 120000000 });
    expect(f.group).toMatchObject({ holderCount: 2, quantity: 1500, value: 180000000 });
    expect(f.group.myShareOfSymbolPct).toBeCloseTo(66.7, 1);
    expect(JSON.stringify(f)).not.toMatch(/Bình|binh/);
    expect(D.buildHolding(raw, 'u1', 'HPG').mine).toBeNull();
    expect(D.buildHolding(raw, 'u1', 'HPG').group.holderCount).toBe(1);
    expect(D.buildHolding(raw, 'u1', 'XXX')).toMatchObject({ mine: null, group: null });
  });
  it('nhóm gộp: NAV, mã lớn nhất, mã trùng, thành viên theo NAV', () => {
    const f = D.buildGroup(raw);
    expect(f.memberCount).toBe(2);
    expect(f.nav).toBe(328000000);                       // An 168 tr + Bình (500 FPT x 120.000 + 2.000 HPG x 25.000 + tiền 50 tr) = 160 tr
    expect(f.top[0].symbol).toBe('FPT');
    expect(f.sharedCount).toBe(1);
    expect(f.members.map((m) => m.name)).toEqual(['An', 'Bình']);
  });
});

describe('buildLimits', () => {
  const limits = [
    { id: 'l1', scope: 'member', user_id: null, kind: 'max_symbol_pct', symbol: null, sector: null, value: 40, mode: 'reason', active: true },
    { id: 'l2', scope: 'consolidated', user_id: null, kind: 'max_symbol_pct', symbol: null, sector: null, value: 10, mode: 'warn', active: true },
  ];
  it('dòng của tôi, cả nhóm gộp, và chỉ SỐ thành viên khác (không tên)', () => {
    const f = D.buildLimits(raw, limits, 'u1');
    expect(f.activeLimits).toBe(2);
    expect(f.me.breaches.length).toBeGreaterThan(0);                  // FPT 120/168 = 71% > 40%
    expect(f.me.breaches[0]).toMatchObject({ kind: 'max_symbol_pct', subject: 'FPT', kindLabel: 'Một mã tối đa', modeLabel: 'Phải ghi lý do' });
    expect(f.otherMembers.total).toBe(1);
    expect(JSON.stringify(f)).not.toMatch(/Bình|binh|u2/);
    expect(f.group).not.toBeNull();
  });
  it('không có giới hạn đang bật -> activeLimits 0 và không có dòng', () => {
    const f = D.buildLimits(raw, [{ ...limits[0], active: false }], 'u1');
    expect(f).toMatchObject({ activeLimits: 0, me: null, group: null });
  });
});

describe('buildApprovals', () => {
  const rows = [
    { id: 'a', user_id: 'u2', created_by: 'u2', symbol: 'FPT', side: 'buy', quantity: '1000', value: '120000000', order_pct: '8', status: 'pending', created_at: '2026-10-08T01:00:00Z', valid_until: null },
    { id: 'b', user_id: 'u1', created_by: 'u1', symbol: 'HPG', side: 'sell', quantity: 500, value: 13000000, order_pct: null, status: 'pending', created_at: '2026-10-12T01:00:00Z', valid_until: '2026-10-20' },
    { id: 'c', user_id: 'u1', created_by: 'u1', symbol: 'VCB', side: 'buy', quantity: 1, value: 1, status: 'approved', created_at: '2026-10-01T01:00:00Z' },
  ];
  it('chỉ lệnh pending; lâu nhất trước; đánh dấu lệnh của tôi và tuổi lệnh', () => {
    const f = D.buildApprovals(rows, { u1: 'An', u2: 'Bình' }, 'u1', true, '2026-10-12');
    expect(f).toMatchObject({ manager: true, total: 2, mine: 1 });
    expect(f.pending.map((p) => p.id)).toEqual(['a', 'b']);
    expect(f.pending[0]).toMatchObject({ requester: 'Bình', ageDays: 4, quantity: 1000, value: 120000000, orderPct: 8, mine: false });
    expect(f.pending[1]).toMatchObject({ mine: true, validUntil: '2026-10-20', orderPct: null });
  });
});

// Client giả: ghi lại truy vấn (chỉ phương thức đọc)
function fakeSb(tables) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, filters: [] };
      calls.push(q);
      const chain = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (res) => res({ data: tables[table] || [], error: null });
          if (['insert', 'update', 'delete', 'upsert'].includes(prop)) throw new Error('tool không được ghi: ' + prop);
          return (...args) => { q.filters.push([prop, ...args]); return chain; };
        },
      });
      return chain;
    },
  };
}

describe('công cụ đọc CSDL', () => {
  const me = { id: 'u1', email: 'an@x.vn', nickname: 'An', group: 'finance', admin: false };
  const tables = { users: [{ id: 'u1', email: 'an@x.vn', nickname: 'An', group_key: 'finance', active: true }, { id: 'u2', email: 'binh@x.vn', nickname: 'Bình', group_key: 'finance', active: true }, { id: 'u3', email: 'c@x.vn', nickname: 'C', group_key: 'finance', active: false }], finance_transactions: raw.txns, finance_corporate_actions: [], finance_holdings_price: raw.prices, finance_assets: raw.assets, finance_limits: [], fin_roles: [{ role: 'asset_manager' }], finance_order_requests: [] };
  it('danh mục của tôi chỉ đọc dòng của chính tôi', async () => {
    const sb = fakeSb(tables);
    const f = await D.toolPortfolio(sb, me);
    expect(f.nav).toBe(168000000);
    const txq = sb.calls.find((c) => c.table === 'finance_transactions');
    expect(txq.filters).toContainEqual(['in', 'user_id', ['u1']]);
  });
  it('nhóm: thành viên đang hoạt động của nhóm finance / admin (bỏ tài khoản vô hiệu)', async () => {
    const sb = fakeSb(tables);
    await D.toolGroup(sb);
    const uq = sb.calls.find((c) => c.table === 'users');
    expect(uq.filters).toContainEqual(['in', 'group_key', ['finance', 'admin']]);
    const txq = sb.calls.find((c) => c.table === 'finance_transactions');
    expect(txq.filters.find((x) => x[0] === 'in')[2].sort()).toEqual(['u1', 'u2']);             // tài khoản vô hiệu (u3) bị bỏ
  });
  it('giới hạn: không có giới hạn đang bật thì không đọc sổ lệnh', async () => {
    const sb = fakeSb(tables);
    const f = await D.toolLimits(sb, me);
    expect(f.activeLimits).toBe(0);
    expect(sb.calls.some((c) => c.table === 'finance_transactions')).toBe(false);
  });
  it('duyệt lệnh: biết mình có phải quản lý không (admin hoặc vai trò asset_manager)', async () => {
    const sb = fakeSb(tables);
    expect((await D.toolApprovals(sb, me, Date.parse('2026-10-12T03:00:00Z'))).manager).toBe(true);
    const sb2 = fakeSb({ ...tables, fin_roles: [] });
    expect((await D.toolApprovals(sb2, me, Date.now())).manager).toBe(false);
    expect((await D.toolApprovals(fakeSb({ ...tables, fin_roles: [] }), { ...me, group: 'admin', admin: true }, Date.now())).manager).toBe(true);
  });
  it('canSeeFinance: chỉ finance / admin', () => {
    expect(D.canSeeFinance(me)).toBe(true);
    expect(D.canSeeFinance({ ...me, group: 'science' })).toBe(false);
    expect(D.canSeeFinance({ ...me, group: 'admin', admin: true })).toBe(true);
  });
});

describe('buildSignals / toolSignals', () => {
  const approvals = [{ id: 'a', status: 'pending', created_by: 'u2', user_id: 'u2' }, { id: 'b', status: 'pending', created_by: 'u1', user_id: 'u1' }, { id: 'c', status: 'approved', created_by: 'u1', user_id: 'u1' }];
  const log = [
    { log_date: '2026-10-09', user_id: 'u1', breaches: [{ k: 1 }], warns: [] },
    { log_date: '2026-10-12', user_id: 'u1', breaches: [{ k: 1 }, { k: 2 }], warns: [{ k: 3 }] },
    { log_date: '2026-10-12', user_id: null, breaches: [], warns: [{ k: 4 }, { k: 5 }] },
    { log_date: '2026-10-12', user_id: 'u2', breaches: [{ k: 9 }], warns: [] },
  ];
  it('chỉ lệnh pending; tuân thủ lấy nhật ký NGÀY MỚI NHẤT, của tôi và của cả nhóm (không đếm người khác)', () => {
    const f = D.buildSignals({ approvals, manager: true, meId: 'u1', log, ideasInReview: 2 });
    expect(f.approvals).toEqual({ total: 2, mine: 1, manager: true });
    expect(f.compliance).toEqual({ date: '2026-10-12', mineBreaches: 2, mineWarns: 1, groupBreaches: 0, groupWarns: 2 });
    expect(f.ideasInReview).toBe(2);
  });
  it('chưa có nhật ký -> compliance null', () => {
    expect(D.buildSignals({ approvals: [], manager: false, meId: 'u1', log: [], ideasInReview: 0 })).toEqual({ approvals: { total: 0, mine: 0, manager: false }, compliance: null, ideasInReview: 0 });
  });
  it('toolSignals đọc đúng bảng, chỉ đọc; thiếu bảng nhật ký / ý tưởng không làm hỏng', async () => {
    const me = { id: 'u1', email: 'an@x.vn', nickname: 'An', group: 'finance', admin: false };
    const sb = fakeSb({ fin_roles: [], finance_order_requests: approvals, finance_compliance_log: log, finance_ideas: [{ id: 'i1' }] });
    const f = await D.toolSignals(sb, me);
    expect(f.approvals.total).toBe(2);
    expect(f.ideasInReview).toBe(1);
    expect(sb.calls.map((c) => c.table).sort()).toEqual(['fin_roles', 'finance_compliance_log', 'finance_ideas', 'finance_order_requests']);
    expect(sb.calls.find((c) => c.table === 'finance_ideas').filters).toContainEqual(['eq', 'status', 'review']);
  });
});
