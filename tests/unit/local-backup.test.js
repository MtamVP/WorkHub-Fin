// Chạy NGUYÊN FILE local-backup.js (giống hệt cả 3 app) với fs của Tauri và Supabase giả.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '../../local-backup.js'), 'utf8');

// Supabase giả: KHÔNG có ORDER BY thì trả các trang theo thứ tự "tuỳ hứng" (đảo vị trí giữa các lần đọc) như PostgreSQL có thể làm
function fakeSupabase(tables, opts) {
  const o = opts || {};
  let calls = 0;
  return {
    auth: { getSession: async () => ({ data: { session: o.loggedOut ? null : { user: { id: 'u' } } } }) },
    from(t) {
      const q = { orders: [], range: null };
      const api = {
        select() { return api; },
        order(c) { q.orders.push(c); return api; },
        range(a, b) { q.range = [a, b]; return api; },
        then(res, rej) {
          calls++;
          let rows = (o.rlsEmpty ? [] : (tables[t] || [])).slice();
          if (q.orders.length) rows.sort((x, y) => { for (const c of q.orders) { if (x[c] < y[c]) return -1; if (x[c] > y[c]) return 1; } return 0; });
          else if (calls % 2 === 0) rows.reverse();                     // thứ tự không ổn định giữa các trang
          return Promise.resolve({ data: rows.slice(q.range[0], q.range[1] + 1), error: null }).then(res, rej);
        },
      };
      return api;
    },
  };
}

function boot(tables, opts) {
  const files = {}, removed = [], store = new Map();
  const fs = {
    BaseDirectory: { AppLocalData: 1 },
    exists: async () => true, mkdir: async () => {},
    writeTextFile: async (name, text) => { files[name] = text; },
    readDir: async () => Object.keys(files).map((k) => ({ name: k.split('/').pop() })),
    remove: async (name) => { removed.push(name); delete files[name]; },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, JSON, Math, Date, Promise, Object, String, TextEncoder, btoa,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    setInterval: () => 0, document: { readyState: 'loading', addEventListener() {} },
  };
  sandbox.window = sandbox;
  sandbox.__TAURI__ = { fs };
  sandbox.supabaseClient = fakeSupabase(tables, opts);
  sandbox.WORKHUB_BACKUP_TABLES = Object.keys(tables);
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { B: sandbox.WorkHubBackup, files, removed, store };
}

const many = (n) => Array.from({ length: n }, (_, i) => ({ id: 'r' + String(i).padStart(5, '0'), v: i }));

describe('sao lưu cục bộ', () => {
  it('LỖI CŨ: bảng trên 1.000 dòng được sao lưu ĐỦ và KHÔNG trùng (đọc theo trang có sắp xếp theo khoá chính)', async () => {
    const t = boot({ finance_transactions: many(2500), finance_holdings_price: Array.from({ length: 1200 }, (_, i) => ({ user_id: 'u' + (i % 7), symbol: 'S' + i, market_price: i })) });
    const name = await t.B.runNow();
    const snap = JSON.parse(t.files[name]);
    expect(snap.finance_transactions).toHaveLength(2500);
    expect(new Set(snap.finance_transactions.map((r) => r.id)).size).toBe(2500);
    expect(new Set(snap.finance_holdings_price.map((r) => r.user_id + ':' + r.symbol)).size).toBe(1200);
  });
  it('LỖI CŨ: chưa đăng nhập thì không ghi bản sao lưu nào và không xoá bản cũ', async () => {
    const t = boot({ finance_transactions: many(10) }, { loggedOut: true });
    expect(await t.B.runNow()).toBeUndefined();
    expect(Object.keys(t.files)).toHaveLength(0);
    expect(t.store.get('wh_last_local_backup_at')).toBeUndefined();          // lần kiểm sau còn thử lại
  });
  it('LỖI CŨ: bản sao lưu không có dòng nào (RLS trả rỗng) không được ghi và không đẩy bản tốt ra khỏi 14 bản giữ lại', async () => {
    const t = boot({ finance_transactions: many(10) }, { rlsEmpty: true });
    expect(await t.B.runNow()).toBeNull();
    expect(Object.keys(t.files)).toHaveLength(0); expect(t.removed).toHaveLength(0);
  });
  it('vẫn bỏ token Google khỏi bản sao lưu', async () => {
    const t = boot({ calendar_connections: [{ id: 'c1', user_id: 'u', access_token: 'bi-mat', refresh_token: 'bi-mat-2', scope: 'x' }] });
    const snap = JSON.parse(t.files[await t.B.runNow()]);
    expect(snap.calendar_connections[0]).toEqual({ id: 'c1', user_id: 'u', scope: 'x' });
  });
});
