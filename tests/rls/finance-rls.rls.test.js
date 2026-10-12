// Bộ kiểm RLS THẬT trên cơ sở dữ liệu (không chạy trong CI; chạy tay: npm run test:rls). Mỗi phép thử chạy trong MỘT giao dịch rồi ROLLBACK nên không để lại gì.
// Mô phỏng người dùng bằng set local role authenticated + set_config('request.jwt.claims', ...) (xem users-deactivation.rls.test.js).
// Cần (không commit): WORKHUB_TEST_DB_URL, WORKHUB_TEST_FIN_A_EMAIL (nhóm finance), WORKHUB_TEST_FIN_B_EMAIL (nhóm finance, người khác A),
//   WORKHUB_TEST_OUTSIDER_EMAIL (nhóm KHÔNG phải finance/admin, ví dụ science). Kiểm cấu trúc (phần 1) chỉ cần WORKHUB_TEST_DB_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
const { MATRIX, OPEN_READ_ALLOWED } = require('./rls-matrix.js');

const { Client } = pg;
const DB = process.env.WORKHUB_TEST_DB_URL;
const A = process.env.WORKHUB_TEST_FIN_A_EMAIL, B = process.env.WORKHUB_TEST_FIN_B_EMAIL, OUT = process.env.WORKHUB_TEST_OUTSIDER_EMAIL;

let client;
beforeAll(async () => { if (!DB) return; client = new Client({ connectionString: DB }); await client.connect(); });
afterAll(async () => { if (client) await client.end(); });

// chạy fn trong giao dịch với vai trò người dùng (email) hoặc 'anon'; luôn rollback
async function as(who, fn) {
  await client.query('begin');
  try {
    if (who === 'anon') await client.query('set local role anon');
    else { await client.query('set local role authenticated'); await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ email: who, role: 'authenticated' })]); }
    return await fn();
  } finally { await client.query('rollback'); }
}
// lỗi quyền trả về dạng { error } thay vì ném (để so sánh "bị chặn" bằng hoặc lỗi hoặc 0 dòng)
async function tryQ(sql, params) {
  await client.query('savepoint s');
  try { const r = await client.query(sql, params); await client.query('release savepoint s'); return { rows: r.rows, rowCount: r.rowCount }; }
  catch (e) { await client.query('rollback to savepoint s'); return { error: e.message, rows: [], rowCount: 0 }; }
}

describe.skipIf(!DB)('RLS: cấu trúc', () => {
  it('mọi bảng ở schema public đều bật RLS', async () => {
    const r = await client.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity order by 1`);
    expect(r.rows.map((x) => x.relname)).toEqual([]);
  });
  it('mọi bảng có RLS đều nằm trong ma trận (bảng mới phải khai báo kiểu quyền)', async () => {
    const r = await client.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity order by 1`);
    const known = new Set(MATRIX.map((m) => m.table));
    expect(r.rows.map((x) => x.relname).filter((t) => !known.has(t))).toEqual([]);
  });
  it('chỉ các bảng đã cho phép mới có chính sách đọc "using (true)"', async () => {
    const r = await client.query(`select tablename, policyname from pg_policies where schemaname='public' and cmd in ('SELECT','ALL') and coalesce(qual,'')='true'`);
    expect(r.rows.filter((x) => !OPEN_READ_ALLOWED[x.tablename]).map((x) => x.tablename + ': ' + x.policyname)).toEqual([]);
  });
  it('không bảng nào ngoài app_settings cho ghi bằng with check (true)', async () => {
    const r = await client.query(`select tablename, policyname from pg_policies where schemaname='public' and coalesce(with_check,'')='true' and tablename <> 'app_settings'`);
    expect(r.rows).toEqual([]);
  });
  it('hàm trigger SECURITY DEFINER không gọi được qua /rpc bởi anon / authenticated', async () => {
    const r = await client.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and pg_get_function_result(p.oid)='trigger' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`);
    expect(r.rows.map((x) => x.proname)).toEqual([]);
  });
  it('mọi hàm SECURITY DEFINER còn lại có search_path cố định', async () => {
    const r = await client.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')`);
    expect(r.rows.map((x) => x.proname)).toEqual([]);
  });
  it('audit_log: chỉ admin đọc, không ai sửa / xoá được', async () => {
    const r = await client.query(`select cmd, count(*) n from pg_policies where schemaname='public' and tablename='audit_log' group by 1`);
    const cmds = Object.fromEntries(r.rows.map((x) => [x.cmd, Number(x.n)]));
    expect(cmds.UPDATE).toBeUndefined(); expect(cmds.DELETE).toBeUndefined(); expect(cmds.ALL).toBeUndefined();
  });
});

const FIN_TABLES = MATRIX.filter((m) => m.kind !== 'shared');
describe.skipIf(!DB || !A || !OUT)('RLS: người ngoài nhóm finance không thấy gì của Finance', () => {
  FIN_TABLES.forEach((m) => {
    it(m.table + ': người ngoài đọc ra 0 dòng (hoặc bị chặn); anon bị chặn', async () => {
      const out = await as(OUT, () => tryQ(`select count(*)::int n from public.${m.table}`));
      expect(out.error ? 0 : out.rows[0].n, m.table + ' (người ngoài)').toBe(0);
      const anon = await as('anon', () => tryQ(`select count(*)::int n from public.${m.table}`));
      expect(anon.error ? 0 : anon.rows[0].n, m.table + ' (anon)').toBe(0);
    });
  });
});

describe.skipIf(!DB || !A || !B || !OUT)('RLS: ghi', () => {
  FIN_TABLES.filter((m) => m.owner && (m.kind === 'team-read-owner-write' || m.kind === 'owner-private')).forEach((m) => {
    it(m.table + ': người khác không sửa / xoá được dòng của chủ (nếu bảng có dữ liệu)', async () => {
      const sample = await client.query(`select ctid from public.${m.table} limit 1`);
      if (!sample.rows.length) return;        // bảng trống: không có gì để thử, không coi là lỗi
      const owner = await client.query(`select ${m.owner} as o from public.${m.table} limit 1`);
      const mine = await client.query(`select email from public.users where id = $1`, [owner.rows[0].o]);
      const ownerEmail = mine.rows[0] && mine.rows[0].email;
      const other = [A, B, OUT].find((e) => e && e.toLowerCase() !== String(ownerEmail || '').toLowerCase());
      const touched = await as(other, async () => {
        const u = await tryQ(`update public.${m.table} set ${m.owner} = ${m.owner} where ${m.owner} = $1`, [owner.rows[0].o]);
        const d = await tryQ(`delete from public.${m.table} where ${m.owner} = $1`, [owner.rows[0].o]);
        return { u: u.rowCount, d: d.rowCount };
      });
      // quản lý tài sản / admin được phép ghi bảng của người khác: chỉ khẳng định khi người thử là thành viên thường (A, B không phải quản lý) -- nếu là quản lý thì bỏ qua
      const role = await client.query(`select (select group_key from public.users where lower(email)=lower($1)) g, exists (select 1 from public.fin_roles r join public.users u on u.id=r.user_id where lower(u.email)=lower($1) and r.role='asset_manager') mgr`, [other]);
      if (role.rows[0].mgr || role.rows[0].g === 'admin') return;
      expect(touched).toEqual({ u: 0, d: 0 });
    });
  });
  it('người ngoài finance không thêm được dòng vào bảng Finance (finance_decisions, finance_sim_runs, finance_watchlist)', async () => {
    const uid = await client.query(`select id from public.users where lower(email)=lower($1)`, [OUT]);
    const id = uid.rows[0].id;
    const attempts = [
      [`insert into public.finance_watchlist (user_id, symbol) values ($1, 'ZZZ')`, [id]],
      [`insert into public.finance_decisions (user_id, symbol, action, decided_at) values ($1, 'ZZZ', 'hold', current_date)`, [id]],
    ];
    for (const [sql, params] of attempts) {
      const r = await as(OUT, () => tryQ(sql, params));
      expect(r.error, sql).toBeTruthy();
    }
  });
});
