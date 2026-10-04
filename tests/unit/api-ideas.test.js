// API.ideas: tạo/sửa ý tưởng, chuyển trạng thái theo quy tắc, phản biện, bỏ phiếu -- chạy CHÍNH api.js trên Supabase giả.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/portfolio-calc.js', 'lib/limits-calc.js', 'lib/ideas.js', 'lib/corporate-events.js', 'lib/statement-import.js', 'lib/xlsx-writer.js', 'lib/decision-journal.js', 'lib/monthly-report.js'];

const A = { id: 'u-a', email: 'an@x.vn', nickname: 'An', group_key: 'finance', active: true };
const B = { id: 'u-b', email: 'binh@x.vn', nickname: 'Bình', group_key: 'finance', active: true };
const M = { id: 'u-m', email: 'sep@x.vn', nickname: 'Sếp', group_key: 'finance', active: true };
const today = new Date().toISOString().slice(0, 10);

// Một cơ sở dữ liệu giả duy nhất; as(user) đổi người đang đăng nhập rồi trả về API
function boot(seed = {}) {
  const fakeOpts = {
    authUser: { email: A.email },
    functions: { 'stock-history': async () => ({ data: { ok: true, series: { VNINDEX: [[today, 1250]] } }, error: null }) },
  };
  const fake = createFakeSupabase(Object.assign({
    users: [A, B, M], fin_roles: [{ user_id: 'u-m', role: 'asset_manager' }],
    finance_holdings_price: [{ user_id: 'u-a', symbol: 'FPT', market_price: 100000, price_date: today, price_source: 'x', updated_at: new Date().toISOString(), locked: false }],
  }, seed), fakeOpts);
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, Blob, Buffer, URL, TextEncoder, TextDecoder, atob, btoa,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {}, document: { addEventListener() {}, getElementById: () => null, readyState: 'complete' },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  };
  sandbox.window = sandbox;
  sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  sandbox.window.supabase = { createClient: () => fake.client };
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  LIBS.forEach(lib => vm.runInContext(read(lib).replace(/^const (\w+) = \(function/m, 'var $1 = (function'), sandbox));
  vm.runInContext(read('api.js') + '\n;this.API = API; this.callGAS = window.callGAS;', sandbox);
  const as = (u) => { fakeOpts.authUser = { email: u.email }; return sandbox.API; };
  return { fake, API: sandbox.API, callGAS: sandbox.callGAS, as };
}

const THESIS = 'Doanh thu xuất khẩu phần mềm tăng đều hai chữ số, biên lợi nhuận mở rộng nhờ AI, định giá thấp hơn trung bình 5 năm.';
const RISKS = 'Tăng trưởng chậm lại nếu nhu cầu công nghệ toàn cầu suy giảm; rủi ro tỷ giá.';
const IDEA = (o = {}) => Object.assign({ symbol: 'FPT', title: 'FPT hưởng lợi từ AI', thesis: THESIS, risks: RISKS, catalysts: 'Báo cáo quý 3 và hợp đồng lớn', target: 130000, stop: 90000, horizonMonths: 12, conviction: 4, valuation: { fair: 120000 } }, o);
const row = (fake) => fake.table('finance_ideas')[0];

describe('save', () => {
  it('tạo mới: tác giả là người đăng nhập; ghi nhận giá hiện tại và điểm VN-Index', async () => {
    const { as, fake } = boot();
    const r = await as(A).ideas.save(A.email, IDEA());
    expect(r.id).toBeTruthy();
    expect(row(fake)).toMatchObject({ user_id: 'u-a', symbol: 'FPT', status: 'idea', entry_price: 100000, index_at_entry: 1250, target_price: 130000, stop_price: 90000, direction: 'long' });
  });
  it('quản lý nhập hộ vẫn ghi tác giả là người đăng nhập (không phải chủ danh mục được truyền email)', async () => {
    const { as, fake } = boot();
    await as(M).ideas.save(A.email, IDEA());
    expect(row(fake).user_id).toBe('u-m');
  });
  it('kiểm lại mục tiêu/cắt lỗ theo giá hiện tại thật; dữ liệu xấu bị từ chối', async () => {
    const { as } = boot();
    await expect(as(A).ideas.save(A.email, IDEA({ target: 95000 }))).rejects.toThrow(/cao hơn giá hiện tại/);
    await expect(as(A).ideas.save(A.email, IDEA({ stop: 105000 }))).rejects.toThrow(/thấp hơn giá hiện tại/);
    await expect(as(A).ideas.save(A.email, IDEA({ title: 'x' }))).rejects.toThrow(/tiêu đề/);
  });
  it('sửa: chỉ tác giả, chỉ khi ở Ý tưởng/Đang nghiên cứu/Bị bác', async () => {
    const { as, fake } = boot();
    const { id } = await as(A).ideas.save(A.email, IDEA());
    await as(A).ideas.save(A.email, IDEA({ id, title: 'Tiêu đề mới cho FPT' }));
    expect(row(fake).title).toBe('Tiêu đề mới cho FPT');
    await expect(as(B).ideas.save(B.email, IDEA({ id }))).rejects.toThrow(/Chỉ tác giả/);
    row(fake).status = 'review';
    await expect(as(A).ideas.save(A.email, IDEA({ id }))).rejects.toThrow(/chờ phản biện/);
  });
});

describe('setStatus: quy trình', () => {
  async function setup() {
    const ctx = boot();
    const { id } = await ctx.as(A).ideas.save(A.email, IDEA());
    return Object.assign(ctx, { id });
  }
  it('tác giả đưa đến chờ phản biện; quản lý duyệt; tác giả đưa vào danh mục; rồi đóng với giá/chỉ số lúc đóng', async () => {
    const { as, fake, id } = await setup();
    await as(A).ideas.setStatus(A.email, id, 'research');
    await as(A).ideas.setStatus(A.email, id, 'review');
    expect(row(fake).submitted_at).toBeTruthy();
    await as(M).ideas.setStatus(M.email, id, 'approved', { note: 'Đủ cơ sở, có 2 phiếu ủng hộ' });
    expect(row(fake)).toMatchObject({ status: 'approved', decided_by: 'u-m' });
    await as(A).ideas.setStatus(A.email, id, 'in_portfolio');
    await as(A).ideas.setStatus(A.email, id, 'closed', { reason: 'target', note: 'Đạt mục tiêu' });
    expect(row(fake)).toMatchObject({ status: 'closed', close_reason: 'target', close_price: 100000, index_at_close: 1250 });
    await expect(as(A).ideas.setStatus(A.email, id, 'research')).rejects.toThrow(/Không thể chuyển/);
  });
  it('thành viên khác không duyệt được; thiếu hồ sơ không gửi được; bác phải có lý do', async () => {
    const { as, fake, id } = await setup();
    await as(A).ideas.setStatus(A.email, id, 'research');
    row(fake).thesis = '';
    await expect(as(A).ideas.setStatus(A.email, id, 'review')).rejects.toThrow(/luận điểm/);
    row(fake).thesis = THESIS;
    await as(A).ideas.setStatus(A.email, id, 'review');
    await expect(as(B).ideas.setStatus(B.email, id, 'approved', { note: 'ok' })).rejects.toThrow(/quản lý/);
    await expect(as(M).ideas.setStatus(M.email, id, 'rejected', {})).rejects.toThrow(/lý do/);
    await as(M).ideas.setStatus(M.email, id, 'rejected', { note: 'Định giá chưa hấp dẫn' });
    expect(row(fake).status).toBe('rejected');
    expect(row(fake).decision_note).toBe('Định giá chưa hấp dẫn');
  });
});

describe('phản biện và bỏ phiếu', () => {
  async function inReview() {
    const ctx = boot();
    const { id } = await ctx.as(A).ideas.save(A.email, IDEA());
    await ctx.as(A).ideas.setStatus(A.email, id, 'research');
    await ctx.as(A).ideas.setStatus(A.email, id, 'review');
    return Object.assign(ctx, { id });
  }
  it('thành viên khác phản biện, tác giả trả lời; không tự phản biện; người khác không trả lời thay', async () => {
    const { as, id } = await inReview();
    await as(B).ideas.addComment(B.email, id, 'challenge', 'P/E đã cao hơn trung bình ngành, vì sao vẫn rẻ?');
    await expect(as(A).ideas.addComment(A.email, id, 'challenge', 'tự hỏi')).rejects.toThrow(/Không tự phản biện/);
    await expect(as(B).ideas.addComment(B.email, id, 'answer', 'trả lời thay')).rejects.toThrow(/Chỉ tác giả/);
    await as(A).ideas.addComment(A.email, id, 'answer', 'P/E so với chính FPT 5 năm vẫn thấp hơn 20%.');
    const got = await as(A).ideas.get(id);
    expect(got.comments.map(c => [c.user_id, c.kind])).toEqual([['u-b', 'challenge'], ['u-a', 'answer']]);
    await expect(as(A).ideas.addComment(A.email, id, 'comment', '   ')).rejects.toThrow(/Nhập nội dung/);
    await expect(as(A).ideas.addComment(A.email, id, 'xxx', 'a')).rejects.toThrow(/không hợp lệ/);
  });
  it('không bình luận ý tưởng đã đóng', async () => {
    const { as, fake, id } = await inReview();
    row(fake).status = 'closed';
    await expect(as(B).ideas.addComment(B.email, id, 'comment', 'muộn rồi')).rejects.toThrow(/đã đóng/);
  });
  it('bỏ phiếu: không bỏ cho ý tưởng của mình; chỉ khi chờ phản biện; phản đối cần lý do; đổi phiếu không nhân đôi', async () => {
    const { as, fake, id } = await inReview();
    await expect(as(A).ideas.vote(A.email, id, 'for')).rejects.toThrow(/Tác giả không/);
    await expect(as(B).ideas.vote(B.email, id, 'against', '')).rejects.toThrow(/lý do/);
    await as(B).ideas.vote(B.email, id, 'for', 'Đồng ý với luận điểm');
    await as(B).ideas.vote(B.email, id, 'against', 'Đổi ý: biên lợi nhuận đã đạt đỉnh');
    expect(fake.table('finance_idea_votes')).toHaveLength(1);
    expect(fake.table('finance_idea_votes')[0]).toMatchObject({ vote: 'against', user_id: 'u-b' });
    row(fake).status = 'approved';
    await expect(as(B).ideas.vote(B.email, id, 'for')).rejects.toThrow(/chờ phản biện/);
    await expect(as(B).ideas.vote(B.email, id, 'maybe')).rejects.toThrow(/không hợp lệ/);
  });
  it('xoá bình luận: chính chủ hoặc quản lý', async () => {
    const { as, fake, id } = await inReview();
    await as(B).ideas.addComment(B.email, id, 'comment', 'ghi chú');
    const cid = fake.table('finance_idea_comments')[0].id;
    await expect(as(A).ideas.deleteComment(A.email, cid)).rejects.toThrow(/chính mình/);
    await as(B).ideas.deleteComment(B.email, cid);
    expect(fake.table('finance_idea_comments')).toHaveLength(0);
    await as(B).ideas.addComment(B.email, id, 'comment', 'ghi chú 2');
    await as(M).ideas.deleteComment(M.email, fake.table('finance_idea_comments')[0].id);      // quản lý xoá được
    expect(fake.table('finance_idea_comments')).toHaveLength(0);
  });
});

describe('list / get / remove / marks / callGAS', () => {
  it('list trả ý tưởng, phiếu, bình luận và tên thành viên', async () => {
    const { as, fake } = boot();
    const { id } = await as(A).ideas.save(A.email, IDEA());
    fake.table('finance_idea_comments').push({ id: 'c1', idea_id: id, user_id: 'u-b', kind: 'comment', text: 'ghi chú', created_at: '2026-01-01T00:00:00Z' });
    fake.table('finance_idea_votes').push({ idea_id: id, user_id: 'u-b', vote: 'for' });
    const r = await as(A).ideas.list();
    expect(r.ideas).toHaveLength(1); expect(r.votes).toHaveLength(1); expect(r.comments).toHaveLength(1);
    expect(r.members['u-a']).toBe('An');
    expect(r.members['u-b']).toBe('Bình');
  });
  it('xoá: tác giả khi còn ở bước đầu; sau đó chỉ quản lý', async () => {
    const { as, fake } = boot();
    const { id } = await as(A).ideas.save(A.email, IDEA());
    row(fake).status = 'approved';
    await expect(as(A).ideas.remove(A.email, id)).rejects.toThrow(/đóng thay vì xoá/);
    await as(M).ideas.remove(M.email, id);
    expect(fake.table('finance_ideas')).toHaveLength(0);
    const again = await as(A).ideas.save(A.email, IDEA());
    await as(A).ideas.remove(A.email, again.id);                                // tác giả xoá được khi còn ở bước Ý tưởng
    expect(fake.table('finance_ideas')).toHaveLength(0);
  });
  it('marks: giá hiện tại + điểm VN-Index; mã lạ bị bỏ', async () => {
    const { as } = boot();
    const m = await as(A).ideas.marks(A.email, ['fpt', 'A;B']);
    expect(m.prices.FPT.price).toBe(100000);
    expect(m.index).toBe(1250);
  });
  it('callGAS đi đúng nhánh; lệnh ghi thuộc danh sách thay đổi dữ liệu', async () => {
    const { callGAS } = boot();
    const r = await callGAS('saveIdea', { email: A.email, idea: IDEA() });
    expect(r.status).toBe('success');
    expect((await callGAS('listIdeas', {})).data.ideas).toHaveLength(1);
    const src = read('api.js');
    ['saveIdea', 'setIdeaStatus', 'addIdeaComment', 'deleteIdeaComment', 'voteIdea', 'removeIdea'].forEach(a => expect(src).toContain(`'${a}'`));
  });
});
