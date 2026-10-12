// Chạy THẬT Edge Function butler-data (index.ts) trong Vitest với Deno và supabase-js giả: xác thực, phân nhóm, công cụ hợp lệ, và trả facts đúng.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import FinCalc from '../../lib/finance-calc.js';
import PortfolioCalc from '../../lib/portfolio-calc.js';
import GroupCalc from '../../lib/group-calc.js';
import LimitsCalc from '../../lib/limits-calc.js';

['finance-calc', 'portfolio-calc', 'group-calc', 'limits-calc'].forEach((n) => vi.doMock('../../supabase/functions/butler-data/' + n + '.js', () => ({})));
globalThis.FinCalc = FinCalc; globalThis.PortfolioCalc = PortfolioCalc; globalThis.GroupCalc = GroupCalc; globalThis.LimitsCalc = LimitsCalc;
const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' };
let handler = null;
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (fn) => { handler = fn; } };

const st = { user: { email: 'an@example.com' }, users: [], rows: {} };
vi.mock('https://esm.sh/@supabase/supabase-js@2', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: st.user }, error: st.user ? null : { message: 'bad' } }) },
    from(table) {
      const chain = new Proxy({}, { get(_t, p) {
        if (p === 'then') return (res) => res({ data: table === 'users' ? st.users : (st.rows[table] || []), error: null });
        return () => chain;
      } });
      return chain;
    },
  }),
}));
await import('../../supabase/functions/butler-data/index.ts');
const call = async (body, auth) => {
  const res = await handler(new Request('https://x/functions/v1/butler-data', { method: 'POST', headers: { authorization: auth === undefined ? 'Bearer aaa.bbb.ccc' : auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
};
beforeEach(() => {
  st.user = { email: 'an@example.com' };
  st.users = [{ id: 'u1', email: 'an@example.com', nickname: 'An', group_key: 'finance', active: true }];
  st.rows = {
    finance_transactions: [{ id: '1', user_id: 'u1', type: 'buy', symbol: 'FPT', quantity: 1000, price: 100000, trade_date: '2026-01-02', fee: 0, tax: 0, created_at: '2026-01-02T01:00:00Z', deleted_at: null }],
    finance_holdings_price: [{ user_id: 'u1', symbol: 'FPT', market_price: 120000, price_date: '2026-10-12', updated_at: 'a' }],
    finance_assets: [{ user_id: 'u1', cash: 30000000, debt: 0 }],
  };
});

describe('butler-data (handler)', () => {
  it('selftest: đủ bốn thư viện, không cần đăng nhập', async () => {
    const r = await call({ selftest: true }, 'Bearer pk');
    expect(r.json).toMatchObject({ ok: true, libs: ['FinCalc', 'PortfolioCalc', 'GroupCalc', 'LimitsCalc'] });
    expect(r.json.tools).toEqual(['portfolio', 'group', 'holding', 'limits', 'approvals', 'signals']);
  });
  it('không có JWT người dùng -> 401; phiên hỏng -> 401', async () => {
    expect((await call({ tool: 'portfolio' }, 'Bearer sb_publishable_x')).status).toBe(401);
    expect((await call({ tool: 'portfolio' }, '')).status).toBe(401);
    st.user = null;
    expect((await call({ tool: 'portfolio' })).status).toBe(401);
  });
  it('tài khoản bị vô hiệu hoá hoặc chưa có hồ sơ -> 403', async () => {
    st.users = [];
    expect((await call({ tool: 'portfolio' })).status).toBe(403);
    st.users = [{ id: 'u1', email: 'an@example.com', nickname: 'An', group_key: 'finance', active: false }];
    expect((await call({ tool: 'portfolio' })).status).toBe(403);
  });
  it('công cụ lạ -> 400; nhóm không phải finance / admin -> 403 trước khi đọc dữ liệu', async () => {
    expect((await call({ tool: 'drop_table' })).status).toBe(400);
    st.users = [{ id: 'u2', email: 'an@example.com', nickname: 'An', group_key: 'science', active: true }];
    const r = await call({ tool: 'portfolio' });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/nhóm Finance/);
  });
  it('danh mục của tôi: trả facts đúng (NAV, mã, lãi lỗ)', async () => {
    const r = await call({ tool: 'portfolio' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.facts).toMatchObject({ name: 'An', nav: 150000000, marketValue: 120000000, cash: 30000000, positionCount: 1 });
    expect(r.json.facts.holdings[0]).toMatchObject({ symbol: 'FPT', unrealizedPct: 20 });
  });
  it('một mã: mã không hợp lệ -> 400; hợp lệ -> vị thế', async () => {
    expect((await call({ tool: 'holding', args: { sym: 'a b' } })).status).toBe(400);
    const r = await call({ tool: 'holding', args: { sym: 'fpt' } });
    expect(r.json.facts).toMatchObject({ symbol: 'FPT' });
    expect(r.json.facts.mine).toMatchObject({ quantity: 1000 });
  });
  it('quản trị viên được dùng công cụ dữ liệu', async () => {
    st.users = [{ id: 'u1', email: 'an@example.com', nickname: 'An', group_key: 'admin', active: true }];
    expect((await call({ tool: 'group' })).status).toBe(200);
  });
});
