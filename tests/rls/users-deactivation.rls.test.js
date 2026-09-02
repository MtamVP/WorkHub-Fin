// Enterprise-readiness mục 4 -- test RLS thật trên DB thật, mô phỏng JWT claims trong 1
// transaction rồi rollback (mẫu set local role/set_config('request.jwt.claims', ...) đã
// dùng tay xuyên suốt dự án này để xác minh RLS). CHỦ Ý không chạy trong CI (không có
// WORKHUB_TEST_DB_URL ở đó) -- chạy tay: npm run test:rls.
//
// Dùng `pg` (không dùng @supabase/supabase-js): cần điều khiển transaction để
// set local role/set_config bên trong, PostgREST (nền của supabase-js) không làm được
// việc này -- chỉ đổi được bearer token của 1 request, không mô phỏng claims tuỳ ý.
//
// Trước khi chạy, set biến môi trường cục bộ (không commit):
//   WORKHUB_TEST_DB_URL=postgresql://postgres:<mật khẩu>@db.<ref>.supabase.co:5432/postgres
// (Settings → Database → Connection string trên dashboard Supabase của project
// gqsbsqaxzpzcloaopzvv.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const { Client } = pg;
const DB_URL = process.env.WORKHUB_TEST_DB_URL;

// 2 email dùng để test PHẢI đã tồn tại thật trong public.users trên DB đích trước khi chạy
// (1 tài khoản group_key != 'admin', 1 tài khoản group_key = 'admin') -- test này không tự
// tạo dữ liệu, chỉ đọc/ghi rồi rollback, để không phụ thuộc quyền INSERT/DELETE ngoài scope
// đang test.
const NON_ADMIN_EMAIL = process.env.WORKHUB_TEST_NON_ADMIN_EMAIL;
const ADMIN_EMAIL = process.env.WORKHUB_TEST_ADMIN_EMAIL;

describe.skipIf(!DB_URL || !NON_ADMIN_EMAIL || !ADMIN_EMAIL)('users.active RLS + trigger', () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function asUser(email, fn) {
    await client.query('begin');
    try {
      await client.query('set local role authenticated');
      await client.query(
        `select set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ email, role: 'authenticated' })]
      );
      return await fn();
    } finally {
      await client.query('rollback'); // không bao giờ để lại thay đổi thật
    }
  }

  it('non-admin không tự đổi được cột active của chính mình', async () => {
    await asUser(NON_ADMIN_EMAIL, async () => {
      await expect(
        client.query('update public.users set active = false where email = $1', [NON_ADMIN_EMAIL])
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });

  it('non-admin vẫn tự sửa được nickname của chính mình (không bị chặn nhầm)', async () => {
    await asUser(NON_ADMIN_EMAIL, async () => {
      const res = await client.query(
        `update public.users set nickname = nickname where email = $1 returning email`,
        [NON_ADMIN_EMAIL]
      );
      expect(res.rowCount).toBe(1);
    });
  });

  it('admin đổi được active của người khác', async () => {
    await asUser(ADMIN_EMAIL, async () => {
      const res = await client.query(
        'update public.users set active = false where email = $1 returning active',
        [NON_ADMIN_EMAIL]
      );
      expect(res.rows[0].active).toBe(false);
    });
  });
});
