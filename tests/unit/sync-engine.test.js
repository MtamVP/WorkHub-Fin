// Chạy NGUYÊN FILE sync-engine.js (giống hệt cả 3 app) với SQLite giả của Tauri: bộ nhớ đệm ngoại tuyến và hàng đợi ghi.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '../../sync-engine.js'), 'utf8');

// SQLite giả: chỉ hiểu đúng các câu lệnh sync-engine.js dùng
function fakeDb() {
  const t = { cache_responses: new Map(), sync_queue: [], sync_conflicts: [] };
  return {
    t,
    async execute(sql, args) {
      if (sql.startsWith('INSERT OR REPLACE INTO cache_responses')) t.cache_responses.set(args[0] + '|' + args[1], { response_json: args[2] });
      else if (sql.startsWith('INSERT INTO sync_queue')) t.sync_queue.push({ id: args[0], action: args[1], params_json: args[2], created_at: args[3], status: args[4] });
      else if (sql.startsWith('DELETE FROM sync_queue')) t.sync_queue = t.sync_queue.filter((r) => r.id !== args[0]);
      else if (sql.startsWith('INSERT INTO sync_conflicts')) t.sync_conflicts.push({ id: args[0], action: args[2], error_message: args[4] });
      else if (sql.startsWith('DELETE FROM sync_conflicts')) t.sync_conflicts = t.sync_conflicts.filter((r) => r.id !== args[0]);
    },
    async select(sql, args) {
      if (sql.includes('FROM cache_responses WHERE')) { const r = t.cache_responses.get(args[0] + '|' + args[1]); return r ? [r] : []; }
      if (sql.includes("FROM sync_queue WHERE status = 'pending'")) return t.sync_queue.filter((r) => r.status === 'pending').slice().sort((a, b) => a.created_at - b.created_at);
      if (sql.includes('FROM sync_conflicts')) return t.sync_conflicts.slice();
      if (sql.includes('FROM sync_queue')) return t.sync_queue.slice();
      return [];
    },
  };
}

function boot(opts) {
  const o = Object.assign({ onLine: true }, opts);
  const db = o.db || fakeDb(), listeners = {}, timers = [], dispatched = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, JSON, Math, Date, Promise, String, Object, btoa, unescape, encodeURIComponent,
    navigator: { onLine: o.onLine },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    CustomEvent: class { constructor(n) { this.type = n; } },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); };
  sandbox.window.dispatchEvent = () => true;
  sandbox.window.__TAURI__ = { sql: { Database: { load: async () => db } } };
  sandbox.window.WORKHUB_SYNC_CONFIG = { dbFile: 'sqlite:test.db' };
  sandbox.window.MUTATING_ACTIONS = new Set(['addTransaction', 'saveDecision']);
  sandbox.window._dispatchAction = async (action, params) => { dispatched.push({ action, params }); return o.dispatch ? o.dispatch(action, params) : { status: 'success', data: null }; };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { S: sandbox.WorkHubSync, db, listeners, timers, dispatched, fire: (n) => (listeners[n] || []).forEach((fn) => fn()) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('khoá bộ nhớ đệm ngoại tuyến', () => {
  it('LỖI CŨ: tham số chỉ khác nhau sau ~48 byte đầu (email dài rồi mới tới mã) không còn ra cùng khoá', () => {
    const { S } = boot();
    const email = 'nguoi.dung.co.email.rat.dai.de.thu@congty-vi-du.com.vn';
    const a = S._hash({ email, symbol: 'FPT' }), b = S._hash({ email, symbol: 'VNM' });
    expect(a).not.toBe(b);
    // bản cũ: base64 cắt 64 ký tự -> trùng
    const old = (p) => btoa(unescape(encodeURIComponent(JSON.stringify(p)))).slice(0, 64);
    expect(old({ email, symbol: 'FPT' })).toBe(old({ email, symbol: 'VNM' }));
    expect(S._hash({ email, symbol: 'FPT' })).toBe(a);                                   // ổn định
  });
  it('đọc lúc mất mạng trả đúng dữ liệu đã lưu của CHÍNH lệnh đó', async () => {
    const t = boot();
    const email = 'nguoi.dung.co.email.rat.dai.de.thu@congty-vi-du.com.vn', online = (a, p) => ({ status: 'success', data: 'giá ' + p.symbol });
    await t.S.handle('getStockHistory', { email, symbol: 'FPT' }, online);
    await t.S.handle('getStockHistory', { email, symbol: 'VNM' }, online);                 // bản cũ: ghi đè cùng khoá với FPT
    await tick();
    t.fire('offline');
    const r = await t.S.handle('getStockHistory', { email, symbol: 'FPT' }, () => { throw new Error('không được gọi mạng'); });
    expect(r.status).toBe('success'); expect(r.data).toBe('giá FPT');
  });
});

describe('hàng đợi ghi ngoại tuyến', () => {
  async function queued(t, n) {
    t.fire('offline');
    for (let i = 0; i < n; i++) { await t.S.handle('addTransaction', { i }, () => { throw new Error('không được gọi mạng'); }); await new Promise((r) => setTimeout(r, 2)); }
  }
  it('LỖI CŨ: sự kiện online và Realtime SUBSCRIBED đến cùng lúc chỉ gửi MỖI thao tác MỘT lần', async () => {
    const t = boot();
    await queued(t, 3);
    t.fire('online'); t.S.onRealtimeStatus('SUBSCRIBED');
    await t.S.flushQueue(); await tick();
    expect(t.dispatched.map((d) => d.params.i)).toEqual([0, 1, 2]);
    expect(t.db.t.sync_queue).toHaveLength(0);
  });
  it('LỖI CŨ: lỗi mạng giữ thao tác trong hàng đợi (đúng thứ tự) để thử lại, không biến thành xung đột', async () => {
    let down = true;
    const t = boot({ dispatch: () => (down ? { status: 'error', message: 'TypeError: Failed to fetch' } : { status: 'success' }) });
    await queued(t, 2);
    t.fire('online'); await t.S.flushQueue();
    expect(t.db.t.sync_queue).toHaveLength(2); expect(t.db.t.sync_conflicts).toHaveLength(0);
    down = false;
    t.S.onRealtimeStatus('SUBSCRIBED'); await t.S.flushQueue();
    expect(t.db.t.sync_queue).toHaveLength(0);
  });
  it('lỗi thật từ máy chủ (vd bán vượt số đang có) vẫn chuyển sang danh sách xung đột như cũ', async () => {
    const t = boot({ dispatch: (a, p) => (p.i === 0 ? { status: 'error', message: 'Bán vượt số cổ phiếu đang có' } : { status: 'success' }) });
    await queued(t, 2);
    t.fire('online'); await t.S.flushQueue();
    expect(t.db.t.sync_conflicts.map((c) => c.error_message)).toEqual(['Bán vượt số cổ phiếu đang có']);
    expect(t.db.t.sync_queue).toHaveLength(0);
  });
  it('LỖI CŨ: hàng đợi còn từ phiên trước được gửi khi mở app lúc ĐÃ có mạng (không cần chuyển trạng thái)', async () => {
    const db = fakeDb();
    db.t.sync_queue.push({ id: 'Q_old', action: 'saveDecision', params_json: '{"x":1}', created_at: 1, status: 'pending' });
    const t = boot({ db, onLine: true });
    const startup = t.timers.find((x) => x.ms === 8000);
    expect(startup).toBeTruthy();
    await startup.fn(); await t.S.flushQueue();
    expect(t.dispatched.map((d) => d.action)).toEqual(['saveDecision']);
    expect(db.t.sync_queue).toHaveLength(0);
  });
});
