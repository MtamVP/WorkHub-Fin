// Chạy THẬT Edge Function butler (index.ts) trong Vitest với Deno, supabase-js và fetch giả: kiểm luồng đầu-cuối trước khi triển khai
// (xác thực, quy tắc, "hôm nay", công cụ dữ liệu qua butler-data, AI chọn tính năng, hết lượt, lỗi hạ tầng, phản hồi, nhật ký không lưu nội dung câu hỏi).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const GUIDE_DATA = require('../../lib/butler-guide-data.js');
const GUIDE_ROWS = GUIDE_DATA.sections.map((s, i) => ({ id: s.id, ord: i + 1, ver: GUIDE_DATA.version, n: s.n, t: s.t, ct: s.ct, s: s.s, k: s.k, w: s.w, p: s.p || null }));
const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', GEMINI_API_KEY: 'gk' };
let handler = null;
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (fn) => { handler = fn; } };

// ----- supabase-js giả -----
const state = { user: { email: 'An@Example.com' }, users: [{ id: 'u1', email: 'an@example.com', nickname: 'An', group_key: 'finance', active: true }], logs: [], takes: [], rpcRole: 'editor', takeResult: { ok: true, used: 1, cap: 30 }, failTables: {}, rows: {} };
function fakeClient() {
  const mk = (table) => {
    const q = { table, filters: [], op: 'select', payload: null };
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res) => {
          if (state.failTables[table]) return res({ data: null, error: { message: 'boom ' + table } });
          if (q.op === 'insert' && table === 'butler_log') { state.logs.push(q.payload); return res({ data: { id: '11111111-2222-3333-4444-555555555555' }, error: null }); }
          if (q.op === 'update') return res({ data: null, error: null });
          if (table === 'users') return res({ data: state.users, error: null });
          return res({ data: state.rows[table] || [], error: null });
        };
        if (prop === 'single') return () => chain;
        if (prop === 'insert') return (p) => { q.op = 'insert'; q.payload = p; return chain; };
        if (prop === 'update') return (p) => { q.op = 'update'; q.payload = p; return chain; };
        return (...args) => { q.filters.push([prop, ...args]); return chain; };
      },
    });
    return chain;
  };
  return {
    from: mk,
    auth: { getUser: async () => ({ data: { user: state.user }, error: state.user ? null : { message: 'bad' } }) },
    rpc: async (name, args) => {
      if (name === 'current_user_role') return { data: state.rpcRole, error: null };
      if (name === 'fn_butler_take') { state.takes.push(args); return { data: state.takeResult, error: null }; }
      return { data: null, error: { message: 'rpc?' } };
    },
  };
}
vi.mock('https://esm.sh/@supabase/supabase-js@2', () => ({ createClient: () => fakeClient() }));

// ----- fetch giả: butler-data và Gemini -----
const net = { calls: [], data: {}, gemini: null };
globalThis.fetch = vi.fn(async (url, init) => {
  const u = String(url), body = init && init.body ? JSON.parse(init.body) : {};
  net.calls.push({ url: u, body, headers: init && init.headers });
  if (u.includes('/functions/v1/butler-data')) {
    const r = net.data[body.tool];
    if (!r) return { ok: false, status: 502, json: async () => ({ ok: false, code: 'upstream', error: 'no data' }) };
    return { ok: r.ok !== false, status: r.ok === false ? 403 : 200, json: async () => r };
  }
  if (u.includes('generativelanguage.googleapis.com')) {
    if (!net.gemini) return { ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(net.gemini) }] } }] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
});

await import('../../supabase/functions/butler/index.ts');
const call = async (body, headers) => {
  const res = await handler(new Request('https://x.supabase.co/functions/v1/butler', { method: 'POST', headers: Object.assign({ authorization: 'Bearer aaa.bbb.ccc', apikey: 'pk', 'content-type': 'application/json' }, headers || {}), body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
};

beforeEach(() => {
  state.user = { email: 'An@Example.com' }; state.logs.length = 0; state.takes.length = 0; state.rpcRole = 'editor'; state.takeResult = { ok: true, used: 1, cap: 30 }; state.failTables = {};
  state.users = [{ id: 'u1', email: 'an@example.com', nickname: 'An', group_key: 'finance', active: true }];
  state.rows = { projects: [{ id: 'p1', name: 'Đầu tư', group_key: 'finance' }], task_assignees: [{ task_id: 't1' }], tasks: [{ id: 't1', project_id: 'p1', name: 'Duyệt đề xuất', status: 'Not Started', priority: 'High', due_date: new Date(Date.now() - 2 * 86400000).toISOString() }], events: [], project_milestones: [], butler_guide: GUIDE_ROWS };
  net.calls.length = 0; net.data = {}; net.gemini = null; globalThis.fetch.mockClear();
});

describe('xác thực và selftest', () => {
  it('selftest không cần đăng nhập, không lộ khoá', async () => {
    const r = await call({ selftest: true }, { authorization: 'Bearer pk' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, hasKey: true, provider: 'gemini', dailyCap: 30 });
    expect(JSON.stringify(r.json)).not.toMatch(/gk/);
    expect(r.json.tools).toEqual(['today', 'portfolio', 'holding', 'group', 'limits', 'approvals']);
  });
  it('không có JWT người dùng (khoá công khai) -> 401', async () => {
    const r = await call({ q: 'hôm nay có việc gì' }, { authorization: 'Bearer sb_publishable_xxx' });
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ ok: false, code: 'auth' });
  });
  it('JWT hợp lệ nhưng không có hồ sơ / bị vô hiệu -> 403', async () => {
    state.users = [];
    expect((await call({ q: 'xin chào' })).status).toBe(403);
    state.users = [{ id: 'u1', email: 'an@example.com', nickname: 'An', group_key: 'finance', active: false }];
    expect((await call({ q: 'xin chào' })).status).toBe(403);
  });
});

describe('luồng quy tắc (không AI)', () => {
  it('chỉ đường: trả thẻ tính năng, không gọi Gemini, không tốn lượt AI, nhật ký không có nội dung câu hỏi', async () => {
    const r = await call({ q: 'Tôi muốn nhập sao kê' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, mode: 'rule', intent: 'features' });
    expect(r.json.cards[0].items[0].id).toBe('ledger-import');
    expect(net.calls.some((c) => c.url.includes('googleapis'))).toBe(false);
    expect(state.takes).toHaveLength(0);
    expect(state.logs).toHaveLength(1);
    expect(JSON.stringify(state.logs[0])).not.toMatch(/sao kê/i);
    expect(state.logs[0]).toMatchObject({ user_id: 'u1', intent: 'features', mode: 'rule', ok: true });
  });
  it('mục chỉ quản trị: người thường thấy lý do, quản trị viên thấy lối đi', async () => {
    const a = await call({ q: 'ai đã xoá dữ liệu' });
    expect(a.json.cards[0].type).toBe('blocked');
    state.users = [{ id: 'u9', email: 'an@example.com', nickname: 'An', group_key: 'admin', active: true }];
    const b = await call({ q: 'ai đã xoá dữ liệu' });
    expect(b.json.cards[0].type).toBe('features');
  });
  it('câu hỏi rỗng / lời chào -> trợ giúp', async () => {
    expect((await call({ q: '' })).json.intent).toBe('help');
    expect((await call({ q: 'xin chào' })).json.intent).toBe('help');
  });
});

describe('hôm nay', () => {
  it('đọc việc của chính người hỏi (task_assignees theo email viết thường) và ghép tín hiệu đầu tư nếu có', async () => {
    net.data.signals = { ok: true, tool: 'signals', facts: { approvals: { total: 2, mine: 0, manager: true }, compliance: null, ideasInReview: 0 } };
    const r = await call({ q: 'hôm nay có việc gì?' });
    expect(r.json).toMatchObject({ ok: true, intent: 'today', mode: 'rule' });
    expect(r.json.text).toMatch(/1 việc quá hạn/);
    expect(r.json.text).toMatch(/Về đầu tư: 2 lệnh đang chờ duyệt/);
    expect(state.logs[0].tools).toEqual(['today', 'signals']);
    const dataCall = net.calls.find((c) => c.url.includes('butler-data'));
    expect(dataCall.headers.authorization).toBe('Bearer aaa.bbb.ccc');            // chuyển tiếp JWT của người hỏi
  });
  it('tín hiệu lỗi / thiếu quyền không làm hỏng câu trả lời', async () => {
    net.data.signals = { ok: false, code: 'forbidden', error: 'Dữ liệu tài chính chỉ dành cho nhóm Finance.' };
    const r = await call({ q: 'hôm nay có việc gì?' });
    expect(r.json.ok).toBe(true);
    expect(state.logs[0].tools).toEqual(['today']);
  });
  it('lỗi CSDL khi đọc việc -> 502 có thông báo, vẫn ghi nhật ký lỗi', async () => {
    state.failTables.projects = true;
    const r = await call({ q: 'hôm nay có việc gì?' });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ ok: false, code: 'upstream' });
    expect(state.logs[0]).toMatchObject({ ok: false, mode: 'error' });
  });
});

describe('công cụ dữ liệu qua butler-data', () => {
  const portfolio = { name: 'An', nav: 1500000000, cash: 300000000, debt: 0, marketValue: 1200000000, cashPct: 20, unrealizedPct: 8.5, positionCount: 1, noPriceCount: 0, priceDate: '2026-10-12', holdings: [{ symbol: 'FPT', quantity: 5000, avgCost: 100000, price: 120000, value: 600000000, weightPct: 100, navPct: 40, unrealizedPct: 20, noPrice: false }] };
  it('"danh mục của tôi" -> intent data, thẻ KPI + danh sách mã; gọi đúng công cụ', async () => {
    net.data.portfolio = { ok: true, tool: 'portfolio', facts: portfolio };
    const r = await call({ q: 'danh mục của tôi' });
    expect(r.json).toMatchObject({ ok: true, intent: 'data', mode: 'rule' });
    expect(r.json.cards[0].type).toBe('kpis');
    expect(r.json.text).toMatch(/^NAV của bạn khoảng 1,50 tỷ đ/);
    expect(net.calls.find((c) => c.url.includes('butler-data')).body).toEqual({ tool: 'portfolio', args: {} });
    expect(state.logs[0].tools).toEqual(['portfolio']);
  });
  it('"FPT tôi đang giữ bao nhiêu" -> holding với mã', async () => {
    net.data.holding = { ok: true, tool: 'holding', facts: { symbol: 'FPT', mine: portfolio.holdings[0], group: null, priceDate: '2026-10-12' } };
    const r = await call({ q: 'FPT tôi đang giữ bao nhiêu' });
    expect(net.calls.find((c) => c.url.includes('butler-data')).body).toEqual({ tool: 'holding', args: { sym: 'FPT' } });
    expect(r.json.text).toMatch(/Bạn đang nắm 5\.000 cp FPT/);
  });
  it('không thuộc nhóm Finance -> nêu lý do (không bịa số) kèm lối tới màn hình', async () => {
    net.data.portfolio = { ok: false, code: 'forbidden', error: 'Dữ liệu tài chính chỉ dành cho nhóm Finance.' };
    const r = await call({ q: 'danh mục của tôi' });
    expect(r.json.ok).toBe(true);
    expect(r.json.text).toBe('Dữ liệu tài chính chỉ dành cho nhóm Finance.');
    expect(r.json.cards[0].type).toBe('features');
  });
  it('butler-data lỗi hạ tầng -> báo chưa đọc được kèm màn hình tương ứng, không lỗi 5xx', async () => {
    const r = await call({ q: 'giới hạn đầu tư có vượt không' });
    expect(r.status).toBe(200);
    expect(r.json.notices.join(' ')).toMatch(/Chưa đọc được số liệu/);
    expect(r.json.cards[0].items[0].id).toBe('group-limits');
  });
  it('hỏi đường thì KHÔNG đọc dữ liệu', async () => {
    await call({ q: 'xem giới hạn đầu tư ở đâu' });
    expect(net.calls.some((c) => c.url.includes('butler-data'))).toBe(false);
  });
});

describe('hướng dẫn sử dụng (AI chọn mục)', () => {
  it('quy tắc không chắc -> Gemini chọn id mục hướng dẫn (chỉ id), server dựng thẻ từ chỉ mục', async () => {
    net.gemini = { intent: 'guide', guide: ['s5-3', 'khong-co'], features: [], tools: [], sym: '' };
    const q = 'giá trị nội tại tính sao qxzv';
    const r = await call({ q });
    expect(r.json).toMatchObject({ ok: true, mode: 'ai', intent: 'guide' });
    expect(r.json.cards[0].items.map((i) => i.id)).toEqual(['s5-3']);
    expect(state.takes).toHaveLength(1);
    const sent = JSON.stringify(net.calls.find((c) => c.url.includes('googleapis')).body);
    expect(sent).toMatch(/G:s5-3 \| 5\.3 Bốn con số/);
  });
  it('AI trả mục hướng dẫn lạ -> kế hoạch bị loại, rơi về gợi ý theo quy tắc, không bịa', async () => {
    net.gemini = { intent: 'guide', guide: ['bịa-ra'], features: [], tools: [], sym: '' };
    const r = await call({ q: 'monte carlo trong định giá' });
    expect(r.json.ok).toBe(true);
    expect(JSON.stringify(r.json.cards)).not.toMatch(/bịa-ra/);
    expect(r.json.cards.some((c) => c.type === 'guide')).toBe(true);
    expect(r.json.notices.join(' ')).toMatch(/chưa chắc/);
  });
  it('không dùng AI (ai:false) vẫn đưa các mục hướng dẫn khớp nhất kèm lời báo chưa chắc', async () => {
    const r = await call({ q: 'monte carlo trong định giá', ai: false });
    expect(r.json).toMatchObject({ ok: true, mode: 'rule' });
    expect(r.json.cards.some((c) => c.type === 'guide')).toBe(true);
  });
});

describe('AI khi quy tắc không chắc', () => {
  it('Gemini chọn tính năng -> trả thẻ, tốn đúng một lượt, kế hoạch được lưu đệm cho lần sau', async () => {
    net.gemini = { intent: 'features', features: ['journal'], tools: [], sym: '' };
    const q = 'tôi cần ghi lại vì sao mình ra quyết định xyzq';
    const r1 = await call({ q });
    expect(r1.json).toMatchObject({ ok: true, mode: 'ai', intent: 'features' });
    expect(r1.json.cards[0].items[0].id).toBe('journal');
    expect(state.takes).toHaveLength(1);
    const geminiCalls1 = net.calls.filter((c) => c.url.includes('googleapis')).length;
    const r2 = await call({ q });
    expect(r2.json.mode).toBe('ai');
    expect(net.calls.filter((c) => c.url.includes('googleapis')).length).toBe(geminiCalls1);       // đệm: không gọi lại
    expect(state.takes).toHaveLength(1);
  });
  it('lời nhắc gửi Gemini không chứa email / số điện thoại của người dùng', async () => {
    net.gemini = { intent: 'chat', features: [], tools: [], sym: '' };
    await call({ q: 'gửi cho an@example.com số 0912 345 678 hộ mình qwertyu' });
    const g = net.calls.find((c) => c.url.includes('googleapis'));
    const sent = JSON.stringify(g.body);
    expect(sent).not.toMatch(/an@example\.com|0912/);
    expect(sent).toMatch(/‹email›/);
  });
  it('AI chọn công cụ dữ liệu -> chạy butler-data', async () => {
    net.gemini = { intent: 'data', features: [], tools: [{ id: 'approvals', args: {} }], sym: '' };
    net.data.approvals = { ok: true, tool: 'approvals', facts: { manager: false, total: 0, mine: 0, pending: [] } };
    const r = await call({ q: 'xyzabc cho tôi biết tình hình lệnh đang đợi sếp qwe' });
    expect(r.json).toMatchObject({ mode: 'ai', intent: 'data' });
    expect(r.json.text).toBe('Bạn không có lệnh nào đang chờ duyệt.');
  });
  it('AI trả id lạ / sai khuôn -> rơi về quy tắc, không bịa', async () => {
    net.gemini = { intent: 'features', features: ['khong-co'], tools: [], sym: '' };
    const r = await call({ q: 'qwertyuiop asdfghjkl zxcvbnm' });
    expect(r.json.ok).toBe(true);
    expect(r.json.mode).toBe('rule');
    expect(r.json.cards.some((c) => c.type === 'features')).toBe(false);
    expect(r.json.notices.join(' ')).toMatch(/AI tạm không dùng được/);
  });
  it('hết lượt AI trong ngày -> gợi ý theo quy tắc kèm thông báo; không gọi Gemini', async () => {
    state.takeResult = { ok: false, reason: 'cap', used: 30, cap: 30 };
    const r = await call({ q: 'poiuytrewq lkjhgfdsa mnbvcxz' });
    expect(r.json.ok).toBe(true);
    expect(r.json.notices.join(' ')).toMatch(/hết lượt hỏi AI/);
    expect(net.calls.some((c) => c.url.includes('googleapis'))).toBe(false);
  });
  it('Gemini hết hạn mức (429) -> thông báo, vẫn trả lời bằng quy tắc', async () => {
    net.gemini = null;
    const r = await call({ q: 'plmoknijb uhvygctfx rdzeswaq' });
    expect(r.json.ok).toBe(true);
    expect(r.json.notices.join(' ')).toMatch(/hạn mức|không dùng được/);
  });
  it('tắt AI từ phía người dùng (ai:false) -> không gọi Gemini, không trừ lượt', async () => {
    const r = await call({ q: 'thời tiết hôm nay qwertyuiop', ai: false });
    expect(r.json.ok).toBe(true);
    expect(net.calls.some((c) => c.url.includes('googleapis'))).toBe(false);
    expect(state.takes).toHaveLength(0);
  });
});

describe('phản hồi', () => {
  it('chỉ nhận id nhật ký hợp lệ và điểm +1 / -1', async () => {
    expect((await call({ feedback: { id: 'x', rating: 1 } })).status).toBe(400);
    expect((await call({ feedback: { id: '11111111-2222-3333-4444-555555555555', rating: 5 } })).status).toBe(400);
    expect((await call({ feedback: { id: '11111111-2222-3333-4444-555555555555', rating: -1 } })).json.ok).toBe(true);
  });
});

describe('hướng dẫn sử dụng (quy tắc, không AI)', () => {
  it('"biên an toàn là gì": thẻ guide nguyên văn từ chỉ mục, không gọi Gemini, không tốn lượt AI', async () => {
    const r = await call({ q: 'Biên an toàn là gì?' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, mode: 'rule', intent: 'guide' });
    const card = r.json.cards[0];
    expect(card.type).toBe('guide');
    expect(card.items[0]).toMatchObject({ id: 'pc-bien-an-toan', href: '/guide/#pc-bien-an-toan' });
    expect(card.items[0].summary).toMatch(/giá/);
    expect(net.calls.some((c) => c.url.includes('googleapis') || c.url.includes('butler-data'))).toBe(false);
    expect(state.takes).toHaveLength(0);
    expect(state.logs[0]).toMatchObject({ intent: 'guide', mode: 'rule', ok: true });
    expect(JSON.stringify(state.logs[0])).not.toMatch(/biên an toàn/i);
  });
  it('hướng dẫn mở cho mọi nhóm (kể cả không phải Finance); số liệu thì không', async () => {
    state.users = [{ id: 'u2', email: 'an@example.com', nickname: 'An', group_key: 'science', active: true }];
    const r = await call({ q: 'DCF theo động lực dùng thế nào' });
    expect(r.json).toMatchObject({ ok: true, intent: 'guide' });
    expect(r.json.cards[0].items[0].id).toBe('s8-1');
  });
  it('hỏi cách làm: thẻ chức năng trước, kèm thẻ hướng dẫn liên quan phía sau', async () => {
    const r = await call({ q: 'cách kiểm thử chiến lược' });
    expect(r.json).toMatchObject({ ok: true, mode: 'rule', intent: 'features' });
    expect(r.json.cards[0].type).toBe('features');
    expect(r.json.cards.some((c) => c.type === 'guide')).toBe(true);
    expect(net.calls.some((c) => c.url.includes('googleapis'))).toBe(false);
  });
  it('hỏi đường thuần tuý không kèm thẻ hướng dẫn thừa', async () => {
    const r = await call({ q: 'Tôi muốn nhập sao kê' });
    expect(r.json.cards.every((c) => c.type !== 'guide')).toBe(true);
  });
  it('selftest cho biết số mục và phiên bản hướng dẫn', async () => {
    const r = await call({ selftest: true }, { authorization: 'Bearer pk' });
    expect(r.json.guide).toBeGreaterThanOrEqual(80);
    expect(r.json.guideVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
