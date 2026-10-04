// Supabase giả chạy trong bộ nhớ, đủ để chạy CHÍNH api.js trong test (không đụng mạng/DB thật).
// Hỗ trợ đúng phần query builder mà api.js dùng: select/insert/update/upsert/delete + eq/is/in/not/or/gte/lte/order/limit/maybeSingle/single.
// Có mô phỏng ràng buộc: khoá chính/unique (lỗi 23505), cột mặc định (id, created_at, deleted_at, fee, tax...).
let seq = 0;
const uuid = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');

const UNIQUES = {
  finance_watchlist: [['user_id', 'symbol']],
  finance_holdings_price: [['user_id', 'symbol']],
  finance_allocation_targets: [['user_id', 'symbol']],
  finance_event_dismissals: [['user_id', 'event_id']],
  finance_assets: [['user_id']],
  finance_nav_history: [['user_id', 'snapshot_date']],
  finance_benchmark_prices: [['index_code', 'price_date']],
};
const DEFAULTS = {
  finance_transactions: () => ({ id: uuid(), created_at: new Date().toISOString(), deleted_at: null, realized_pnl: null, fee: 0, tax: 0, external_ref: null, import_batch: null, note: null }),
  finance_cash_flows: () => ({ id: uuid(), created_at: new Date().toISOString(), deleted_at: null, symbol: null, note: null }),
  finance_corporate_actions: () => ({ id: uuid(), created_at: new Date().toISOString(), deleted_at: null, note: null }),
  finance_watchlist: () => ({ id: uuid(), created_at: new Date().toISOString(), buy_below: null, target_price: null, note: null, added_price: null }),
  finance_decisions: () => ({ id: uuid(), created_at: new Date().toISOString(), deleted_at: null, tags: [], txn_id: null, price_at_decision: null, quantity: null, reason: null, expected_price: null, stop_price: null, horizon_months: null, confidence: null, valuation: null, review_date: null, review_rating: null, review_note: null, lesson: null }),
  finance_holdings_price: () => ({ locked: false, target_price: null, stop_loss: null, price_date: null, price_source: null, updated_at: new Date().toISOString() }),
};

export function createFakeSupabase(seed = {}, opts = {}) {
  const tables = {};
  Object.keys(seed).forEach(t => { tables[t] = seed[t].map(r => ({ ...r })); });
  const table = (t) => (tables[t] = tables[t] || []);
  const log = [];
  const functionCalls = [];

  function matchRow(row, filters) {
    return filters.every(f => {
      const v = row[f.col];
      switch (f.op) {
        case 'eq': return v === f.val || (v !== null && v !== undefined && String(v) === String(f.val));
        case 'is': return f.val === null ? (v === null || v === undefined) : v === f.val;
        case 'in': return f.val.map(String).includes(String(v));
        case 'notin': return !f.val.map(String).includes(String(v));
        case 'neq': return String(v) !== String(f.val);
        case 'gte': return v >= f.val;
        case 'lte': return v <= f.val;
        case 'or': return f.val.some(c => String(row[c.col]) === String(c.val));
        default: return true;
      }
    });
  }

  function uniqueViolation(t, row, ignoreIndex) {
    const keys = UNIQUES[t] || [];
    for (const cols of keys) {
      const dup = table(t).find((r, i) => i !== ignoreIndex && cols.every(c => r[c] === row[c]));
      if (dup) return { code: '23505', message: 'duplicate key value violates unique constraint (' + cols.join(',') + ')' };
    }
    if (t === 'finance_decisions' && row.txn_id) {
      const dup = table(t).find((r, i) => i !== ignoreIndex && !r.deleted_at && r.txn_id === row.txn_id);
      if (dup) return { code: '23505', message: 'duplicate txn_id' };
    }
    if (t === 'finance_transactions' && row.external_ref) {
      const dup = table(t).find((r, i) => i !== ignoreIndex && !r.deleted_at && r.user_id === row.user_id && r.external_ref === row.external_ref);
      if (dup) return { code: '23505', message: 'duplicate external_ref' };
    }
    return null;
  }

  function builder(t) {
    const q = { t, op: 'select', filters: [], order: null, limit: null, payload: null, single: null, returning: false, onConflict: null, ignoreDuplicates: false };
    const api = {
      select() { if (q.op !== 'select') q.returning = true; return api; },
      insert(p) { q.op = 'insert'; q.payload = p; return api; },
      update(p) { q.op = 'update'; q.payload = p; return api; },
      upsert(p, o) { q.op = 'upsert'; q.payload = p; q.onConflict = o && o.onConflict; q.ignoreDuplicates = !!(o && o.ignoreDuplicates); return api; },
      delete() { q.op = 'delete'; return api; },
      eq(col, val) { q.filters.push({ op: 'eq', col, val }); return api; },
      neq(col, val) { q.filters.push({ op: 'neq', col, val }); return api; },
      is(col, val) { q.filters.push({ op: 'is', col, val }); return api; },
      in(col, val) { q.filters.push({ op: 'in', col, val }); return api; },
      gte(col, val) { q.filters.push({ op: 'gte', col, val }); return api; },
      lte(col, val) { q.filters.push({ op: 'lte', col, val }); return api; },
      not(col, op, val) { if (op === 'in') q.filters.push({ op: 'notin', col, val: String(val).replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, '')) }); return api; },
      or(expr) {
        // "nickname.eq.abc,email.eq.abc"
        q.filters.push({ op: 'or', val: String(expr).split(',').map(p => { const [col, , ...rest] = p.split('.'); return { col, val: rest.join('.') }; }) });
        return api;
      },
      order(col, o) { q.order = { col, asc: !(o && o.ascending === false) }; return api; },
      limit(n) { q.limit = n; return api; },
      range(from, to) { q.range = [from, to]; return api; },
      maybeSingle() { q.single = 'maybe'; return api; },
      single() { q.single = 'one'; return api; },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };

    function run() {
      log.push({ table: t, op: q.op });
      const rows = table(t);
      let result = [];
      let error = null;
      if (opts.failOn && opts.failOn(q)) return { data: null, error: { message: 'giả lập lỗi' } };
      if (q.op === 'select') {
        result = rows.filter(r => matchRow(r, q.filters)).map(r => ({ ...r }));
      } else if (q.op === 'insert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        for (const p of list) {
          const row = { ...(DEFAULTS[t] ? DEFAULTS[t]() : { id: uuid() }), ...p };
          const v = uniqueViolation(t, row, -1);
          if (v) { error = v; break; }
          rows.push(row); result.push({ ...row });
        }
      } else if (q.op === 'upsert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        const cols = (q.onConflict || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const p of list) {
          const idx = cols.length ? rows.findIndex(r => cols.every(c => r[c] === p[c])) : -1;
          if (idx >= 0) {
            if (q.ignoreDuplicates) continue;
            rows[idx] = { ...rows[idx], ...p }; result.push({ ...rows[idx] });
          } else {
            const row = { ...(DEFAULTS[t] ? DEFAULTS[t]() : { id: uuid() }), ...p };
            const v = uniqueViolation(t, row, -1);
            if (v) { error = v; break; }
            rows.push(row); result.push({ ...row });
          }
        }
      } else if (q.op === 'update') {
        rows.forEach((r, i) => { if (matchRow(r, q.filters)) { rows[i] = { ...r, ...q.payload }; result.push({ ...rows[i] }); } });
      } else if (q.op === 'delete') {
        for (let i = rows.length - 1; i >= 0; i--) if (matchRow(rows[i], q.filters)) { result.push({ ...rows[i] }); rows.splice(i, 1); }
      }
      if (q.order) result.sort((a, b) => ((a[q.order.col] > b[q.order.col]) - (a[q.order.col] < b[q.order.col])) * (q.order.asc ? 1 : -1));
      if (q.range) result = result.slice(q.range[0], q.range[1] + 1);
      if (q.limit) result = result.slice(0, q.limit);
      if (error) return { data: null, error };
      if ((q.op === 'insert' || q.op === 'update' || q.op === 'upsert' || q.op === 'delete') && !q.returning) return { data: null, error: null };
      if (q.single === 'maybe') return { data: result[0] || null, error: null };
      if (q.single === 'one') return result.length === 1 ? { data: result[0], error: null } : { data: null, error: { message: 'Expected 1 row, got ' + result.length } };
      return { data: result, error: null };
    }
    return api;
  }

  const client = {
    from: builder,
    auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getUser: async () => ({ data: { user: opts.authUser || null } }) },
    functions: {
      invoke: async (name, o) => {
        functionCalls.push({ name, body: o && o.body });
        if (opts.functions && opts.functions[name]) return opts.functions[name](o && o.body);
        return { data: null, error: { message: 'chưa giả lập hàm ' + name } };
      },
    },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel() {},
  };
  return { client, tables, table, log, functionCalls };
}
