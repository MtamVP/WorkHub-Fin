// api.js: dải báo hết phiên trên trang con (whSessionGuard) + nhật ký hệ thống (chỉ ghi thao tác thay đổi, đúng nhóm của người dùng).
// Chạy CHÍNH api.js trong vm với client Supabase giả điều khiển được.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = readFileSync(path.join(here, '../../api.js'), 'utf8');
const tick = () => new Promise(r => setTimeout(r, 0));

function boot({ authModal = false, pathname = '/market/', session = { access_token: 't' }, sessionError = null, refreshError = null, group = 'finance', groupError = null, fetchStatus = 200 } = {}) {
  const calls = { refresh: 0, rpc: 0, inserts: [], cbs: [], fetches: 0 };
  calls.authCb = (ev, s) => calls.cbs.forEach(cb => cb(ev, s));
  const body = { children: [], appendChild(el) { this.children.push(el); } };
  const mkEl = (tag) => ({ tag, style: {}, attrs: {}, kids: [], textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, append(...k) { this.kids.push(...k); } });
  const client = {
    auth: {
      getSession: async () => ({ data: { session }, error: sessionError }),
      refreshSession: async () => { calls.refresh++; return { data: {}, error: refreshError }; },
      onAuthStateChange: (cb) => { calls.cbs.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      getUser: async () => ({ data: { user: null } }),
    },
    rpc: async (name) => { calls.rpc++; return name === 'current_user_group' ? { data: groupError ? null : group, error: groupError } : { data: null, error: null }; },
    from: (t) => ({ insert: async (row) => { calls.inserts.push({ table: t, row }); return { error: null }; } }),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
  };
  let opts = null;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, URL, Blob, TextEncoder, TextDecoder,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {}, location: { pathname, href: pathname },
    document: { addEventListener() {}, getElementById: (id) => (authModal && id === 'auth-modal') ? {} : null, readyState: 'complete', body, createElement: mkEl },
    fetch: async () => { calls.fetches++; return { status: fetchStatus, ok: fetchStatus < 400, json: async () => ({}) }; },
  };
  sandbox.window = sandbox;
  sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  sandbox.window.supabase = { createClient: (u, k, o) => { opts = o; return client; } };
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(API_SRC + '\n;this.API = API; this.callGAS = window.callGAS;', sandbox);
  const banner = () => body.children.find(c => c.attrs && c.attrs.role === 'alert' && c.tag === 'div');
  return { sandbox, calls, opts: () => opts, banner, guard: sandbox.whSessionGuard, API: sandbox.API, callGAS: sandbox.callGAS };
}

describe('whSessionGuard: trang con báo hết phiên', () => {
  it('trang con không có phiên -> hiện dải báo có nút về trang đăng nhập', async () => {
    const b = boot({ pathname: '/mastersheet/assets/index.html', session: null });
    await tick(); await tick();
    const bar = b.banner();
    expect(bar).toBeTruthy();
    expect(bar.kids[0].textContent).toMatch(/hết hạn|chưa đăng nhập/);
    expect(bar.kids[1].textContent).toBe('Đăng nhập lại');
    bar.kids[1].onclick();
    expect(b.sandbox.location.href).toBe('/');
  });
  it('có phiên -> không báo; lỗi mạng khi hỏi phiên -> không báo (ngoại tuyến không phải hết phiên)', async () => {
    const a = boot({ pathname: '/market/' });
    await tick(); await tick();
    expect(a.banner()).toBeUndefined();
    const b = boot({ pathname: '/market/', session: null, sessionError: { message: 'Failed to fetch' } });
    await tick(); await tick();
    expect(b.banner()).toBeUndefined();
  });
  it('trang chính, quên/đặt lại mật khẩu, đổi tên, ghi nhanh: không bao giờ báo (có màn đăng nhập riêng)', async () => {
    for (const p of ['/', '/index.html', '/forgot/', '/reset/index.html', '/change_nickname/', '/quick-capture.html']) {
      const b = boot({ pathname: p, session: null });
      await tick(); await tick();
      expect(b.guard.isExempt(), p).toBe(true);
      b.calls.authCb && b.calls.authCb('SIGNED_OUT', null);
      expect(b.banner(), p).toBeUndefined();
    }
    expect(boot({ pathname: '/valuation/' }).guard.isExempt()).toBe(false);
  });
  it('trang có màn đăng nhập riêng (#auth-modal) không báo dù nằm ở thư mục con (vd. /wh-fin/index.html)', async () => {
    const b = boot({ pathname: '/wh-fin/index.html', session: null, authModal: true });
    await tick(); await tick();
    b.calls.authCb('SIGNED_OUT', null);
    expect(b.banner()).toBeUndefined();
  });
  it('sự kiện SIGNED_OUT trên trang con -> báo ngay, chỉ một dải', async () => {
    const b = boot({ pathname: '/valuation/' });
    await tick(); await tick();
    expect(b.banner()).toBeUndefined();
    b.calls.authCb('SIGNED_OUT', null);
    b.calls.authCb('SIGNED_OUT', null);
    expect(b.sandbox.document.body.children.filter(c => c.attrs.role === 'alert')).toHaveLength(1);
  });
  it('fetch của client trả 401 -> thử làm mới phiên; làm mới bị từ chối (400) -> báo; nhiều 401 liền chỉ làm mới một lần', async () => {
    const b = boot({ pathname: '/market/', refreshError: { status: 400, message: 'Invalid Refresh Token' }, fetchStatus: 401 });
    await tick(); await tick();
    const f = b.opts().global.fetch;
    const res = await f('https://x/rest/v1/t');
    expect(res.status).toBe(401);                       // trả nguyên phản hồi cho supabase-js
    await f('https://x/rest/v1/t'); await f('https://x/rest/v1/t');
    await tick(); await tick(); await tick();
    expect(b.calls.refresh).toBe(1);
    expect(b.banner()).toBeTruthy();
  });
  it('401 nhưng làm mới thành công, hoặc làm mới lỗi mạng (không có status 4xx) -> không báo', async () => {
    const ok = boot({ pathname: '/market/', fetchStatus: 401 });
    await tick();
    await ok.opts().global.fetch('u'); await tick(); await tick(); await tick();
    expect(ok.calls.refresh).toBe(1);
    expect(ok.banner()).toBeUndefined();
    const net = boot({ pathname: '/market/', fetchStatus: 401, refreshError: { status: 0, message: 'Failed to fetch' } });
    await tick();
    await net.opts().global.fetch('u'); await tick(); await tick(); await tick();
    expect(net.banner()).toBeUndefined();
  });
  it('phản hồi 200 không kích hoạt kiểm tra', async () => {
    const b = boot({ pathname: '/market/', fetchStatus: 200 });
    await tick();
    await b.opts().global.fetch('u'); await tick(); await tick();
    expect(b.calls.refresh).toBe(0);
  });
});

describe('nhật ký hệ thống', () => {
  it('logAction không có groupKey -> ghi nhóm thật của người dùng (hỏi máy chủ một lần), không còn "general" bị chính sách chặn', async () => {
    const b = boot({ group: 'finance' });
    await b.API.system.logAction('t1', 'saveIdea', 'x', 'success', 'a@x.vn', undefined, null);
    await b.API.system.logAction('t2', 'saveIdea', 'x', 'success', 'a@x.vn', null, null);
    expect(b.calls.inserts.map(i => i.row.group_key)).toEqual(['finance', 'finance']);
    expect(b.calls.rpc).toBe(1);
    await b.API.system.logAction('t3', 'x', 'x', 'success', 'a@x.vn', 'admin', null);
    expect(b.calls.inserts[2].row.group_key).toBe('admin');           // truyền rõ thì giữ nguyên
    await b.API.system.logAction('t4', 'x', 'x', 'success', 'a@x.vn', 'all', null);
    expect(b.calls.inserts[3].row.group_key).toBe('finance');         // 'all' (chế độ xem mọi nhóm) không phải nhóm thật
  });
  it('hỏi nhóm lỗi -> dùng "general" và lần sau hỏi lại', async () => {
    const b = boot({ groupError: { message: 'x' } });
    await b.API.system.logAction('t1', 'a', 'x', 'success', 'e', undefined, null);
    await b.API.system.logAction('t2', 'a', 'x', 'success', 'e', undefined, null);
    expect(b.calls.inserts.map(i => i.row.group_key)).toEqual(['general', 'general']);
    expect(b.calls.rpc).toBe(2);
  });
  it('callGAS: lượt đọc thành công không ghi nhật ký; thao tác thay đổi dữ liệu và lỗi thì ghi', async () => {
    const b = boot();
    b.API.asset = Object.assign(b.API.asset || {}, {});
    b.API.reporting = { summary: async () => ({ a: 1 }) };
    await b.callGAS('getReportSummary', {});
    b.API.calendarConnection = { touchSync: async () => 'ok' };
    b.API.orgUnits = { listAll: async () => [1] };
    await b.callGAS('listOrgUnits', {});
    await tick(); await tick();
    expect(b.calls.inserts).toHaveLength(0);
    await b.callGAS('touchCalendarSync', {});
    await tick(); await tick();
    expect(b.calls.inserts.map(i => i.row.action)).toEqual(['touchCalendarSync']);
    b.API.orgUnits.listAll = async () => { throw new Error('hỏng'); };
    await b.callGAS('listOrgUnits', {});
    await tick(); await tick();
    expect(b.calls.inserts.map(i => [i.row.action, i.row.status])).toEqual([['touchCalendarSync', 'success'], ['listOrgUnits', 'error']]);
  });
});
