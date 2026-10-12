// CI: ma trận quyền (tests/rls/rls-matrix.js) phải theo kịp migration. Bảng nào được tạo ở một tệp .sql ở gốc repo (và bật RLS) mà chưa khai báo kiểu quyền ở ma trận thì báo đỏ,
// để bảng mới không lọt khỏi bộ kiểm RLS thật (tests/rls, chạy tay với WORKHUB_TEST_DB_URL).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '../..');
const { MATRIX, OPEN_READ_ALLOWED } = require('../rls/rls-matrix.js');
const KINDS = ['team-read-owner-write', 'owner-private', 'team-read-server-write', 'manager-write', 'server-only', 'shared'];
const sqlFiles = readdirSync(ROOT).filter((f) => /\.sql$/.test(f));
const all = sqlFiles.map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

describe('ma trận RLS', () => {
  it('kiểu quyền hợp lệ, không trùng bảng, bảng riêng tư thì có cột chủ', () => {
    const names = MATRIX.map((m) => m.table);
    expect(new Set(names).size).toBe(names.length);
    MATRIX.forEach((m) => { expect(KINDS, m.table).toContain(m.kind); if (m.kind === 'owner-private') expect(m.owner, m.table).toBeTruthy(); });      // team-read-owner-write có thể không có cột chủ riêng (quyền theo bảng cha, vd điều kiện luận điểm theo ý tưởng)
  });
  it('mọi bảng được tạo trong migration (public.*, bật RLS) đều có trong ma trận', () => {
    const created = new Set([...all.matchAll(/create table(?: if not exists)?\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)].map((m) => m[1].toLowerCase()));
    const rls = new Set([...all.matchAll(/alter table\s+(?:if exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+enable row level security/gi)].map((m) => m[1].toLowerCase()));
    const known = new Set(MATRIX.map((m) => m.table));
    const missing = [...created].filter((t) => rls.has(t) && !known.has(t));
    expect(missing).toEqual([]);
  });
  it('bảng nhật ký kiểm toán và dữ liệu chỉ máy chủ ghi không có kiểu cho phép client ghi', () => {
    const byKind = (k) => MATRIX.filter((m) => m.kind === k).map((m) => m.table);
    ['finance_price_days', 'finance_bt_index', 'finance_news_events', 'finance_function_runs'].forEach((t) => expect(byKind('team-read-server-write')).toContain(t));
    expect(byKind('server-only')).toContain('finance_alert_log');
  });
  it('danh sách chính sách đọc mở có chủ ý đều có lý do', () => {
    Object.entries(OPEN_READ_ALLOWED).forEach(([t, why]) => { expect(why.length, t).toBeGreaterThan(10); });
  });
});
