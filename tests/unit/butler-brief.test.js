// Quản gia giai đoạn C: bản tin sáng qua email. Dựng email (thuần), lọc dữ liệu theo từng người khi dùng service role, cấu trúc hàm Edge, migration (tuỳ chọn mặc định tắt, không đọc / ghi trực tiếp) và giao diện tuỳ chọn.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildBrief, esc } from '../../supabase/functions/butler-brief/brief.ts';
import { fetchToday } from '../../supabase/functions/butler/tools.ts';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-13T00:45:00Z');          // 07:45 giờ VN, thứ ba 13/10/2026
const data = {
  date: '2026-10-13',
  tasks: [
    { id: 't1', name: 'Nộp báo cáo <b>tháng</b> 9', status: 'In Progress', priority: 'High', due: '2026-10-10', project: 'Báo cáo & kiểm toán', late: 3 },
    { id: 't2', name: 'Duyệt đề xuất FPT', status: 'Not Started', priority: 'Medium', due: '2026-10-13', project: 'Đầu tư', late: 0 },
  ],
  events: [{ id: 'e1', title: 'Họp đầu tư', start: '09:30', end: '10:30', location: 'Phòng A', important: true }],
  milestones: [{ id: 'm1', title: 'Chốt báo cáo quý', target: '2026-10-12', project: 'Báo cáo', late: 1 }],
};

describe('buildBrief: email bản tin sáng', () => {
  it('có tiêu đề theo ngày và số liệu; HTML và văn bản thuần đều liệt kê đủ mục', () => {
    const b = buildBrief(data, { nickname: 'An' }, NOW);
    expect(b.subject).toBe('Bản tin sáng Thứ ba 13/10: 1 quá hạn, 1 đến hạn hôm nay, 1 lịch, 1 mốc dự án');
    expect(b.count).toBe(4);
    expect(b.html).toMatch(/Chào An,/);
    expect(b.html).toMatch(/Quá hạn \(1\)/); expect(b.html).toMatch(/Lịch hôm nay \(1\)/); expect(b.html).toMatch(/Mốc dự án \(1\)/);
    expect(b.text).toMatch(/- Họp đầu tư \(09:30–10:30 · Phòng A\)/);
    expect(b.text).toMatch(/Tắt bản tin/);
  });
  it('mọi chữ lấy từ CSDL đều được thoát HTML (không chèn được thẻ), tên trống thành "bạn"', () => {
    const b = buildBrief(data, { nickname: '<script>x</script>' }, NOW);
    expect(b.html).not.toMatch(/<script>|<b>tháng/);
    expect(b.html).toMatch(/&lt;b&gt;tháng&lt;\/b&gt;/);
    expect(b.html).toMatch(/Báo cáo &amp; kiểm toán/);
    expect(buildBrief(data, { nickname: '  ' }, NOW).html).toMatch(/Chào bạn,/);
    expect(esc('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
  it('không có việc, lịch, mốc hay việc sắp đến hạn thì không dựng email (không gửi thư rỗng)', () => {
    expect(buildBrief({ date: '2026-10-13', tasks: [], events: [], milestones: [] }, { nickname: 'An' }, NOW)).toBeNull();
  });
  it('chỉ có việc sắp đến hạn vẫn gửi, tiêu đề nói rõ', () => {
    const b = buildBrief({ date: '2026-10-13', tasks: [{ id: 't', name: 'Việc xa', status: 'Not Started', priority: 'Low', due: '2026-10-15', project: 'P', late: -2 }], events: [], milestones: [] }, { nickname: 'An' }, NOW);
    expect(b.subject).toBe('Bản tin sáng Thứ ba 13/10: 1 việc sắp đến hạn');
  });
});

describe('fetchToday ở chế độ explicit (client service role, không có RLS)', () => {
  const me = { id: 'u1', email: 'An@Example.com', nickname: 'An', group: 'finance', admin: false };
  const mkSb = (events) => {
    const calls = [];
    const tables = { projects: [{ id: 'p1', name: 'A', group_key: 'finance' }], task_assignees: [], tasks: [], project_milestones: [], events };
    const sb = { calls, from(table) { const q = { table, filters: [] }; calls.push(q); const chain = new Proxy({}, { get(_t, prop) { if (prop === 'then') return (res) => res({ data: tables[table] || [], error: null }); return (...a) => { q.filters.push([prop, ...a]); return chain; }; } }); return chain; } };
    return sb;
  };
  const ev = (id, group, type, by) => ({ id, title: 'Sự kiện ' + id, start_time: '2026-10-13T02:00:00Z', end_time: '2026-10-13T03:00:00Z', recurrence: 'none', group_key: group, calendar_type: type, created_by: by });
  const rows = [ev('own-group', 'finance', 'group', 'b@x.com'), ev('other-group', 'science', 'group', 'c@x.com'), ev('mine-personal', 'finance', 'personal', 'An@example.com'), ev('their-personal', 'finance', 'personal', 'b@x.com'), ev('no-type', 'finance', null, 'b@x.com')];
  it('chỉ giữ sự kiện cùng nhóm; lịch cá nhân chỉ của chính người đó (đúng chính sách RLS của bảng events)', async () => {
    const sb = mkSb(rows);
    const r = await fetchToday(sb, me, NOW, { explicit: true });
    expect(r.events.map((e) => e.id).sort()).toEqual(['mine-personal', 'no-type', 'own-group']);
    const q = sb.calls.find((c) => c.table === 'events');
    expect(q.filters).toContainEqual(['eq', 'group_key', 'finance']);
    expect(q.filters.some((f) => f[0] === 'or' && /created_by\.eq\.an@example\.com/.test(f[1]))).toBe(true);
  });
  it('quản trị viên thấy mọi nhóm nhưng lịch cá nhân của người khác vẫn bị loại; địa chỉ email có ký tự lạ không chèn được vào bộ lọc', async () => {
    const sb = mkSb(rows);
    const r = await fetchToday(sb, { ...me, group: 'admin', admin: true }, NOW, { explicit: true });
    expect(r.events.map((e) => e.id).sort()).toEqual(['mine-personal', 'no-type', 'other-group', 'own-group']);
    expect(sb.calls.find((c) => c.table === 'events').filters.some((f) => f[0] === 'eq' && f[1] === 'group_key')).toBe(false);
    const sb2 = mkSb(rows);
    await fetchToday(sb2, { ...me, email: 'a,b)@x.com' }, NOW, { explicit: true });
    expect(sb2.calls.find((c) => c.table === 'events').filters.filter((f) => f[0] === 'or').every((f) => !/created_by\.eq\./.test(f[1]))).toBe(true);
  });
  it('không có explicit thì không đổi hành vi cũ: không lọc thêm, không thêm điều kiện nhóm', async () => {
    const sb = mkSb(rows);
    const r = await fetchToday(sb, me, NOW);
    expect(r.events.length).toBe(rows.length);
    expect(sb.calls.find((c) => c.table === 'events').filters.some((f) => f[0] === 'eq')).toBe(false);
  });
});

describe('hàm Edge butler-brief', () => {
  const idx = read('supabase/functions/butler-brief/index.ts');
  it('chốt chặn cron: bản sao khớp bản gốc; chỉ mode "me" cho người dùng đăng nhập; selftest và OPTIONS chạy trước chốt chặn', () => {
    expect(read('supabase/functions/butler-brief/cron-guard.ts')).toBe(read('supabase/functions/_shared/cron-guard.ts'));
    expect(idx).toContain('import { cronGuard } from "./cron-guard.ts";');
    expect(idx).toContain('cronGuard(req, { fn: "butler-brief", allowUser: mode === "me" })');
    const g = idx.indexOf('cronGuard(req');
    expect(idx.indexOf('body.selftest === true')).toBeLessThan(g);
    expect(idx.indexOf('req.method === "OPTIONS"')).toBeLessThan(g);
  });
  it('mode "me" lấy người từ JWT, không từ body; gửi tới chính email đó; tối đa 1 lần / 10 phút', () => {
    expect(idx).toMatch(/sb\.auth\.getUser\(token\)/);
    expect(idx).not.toMatch(/body\.(user|email|to|userId|user_id)\b/);
    expect(idx).toMatch(/TEST_GAP_MS = 10 \* 60000/);
    expect(idx).toMatch(/sendEmail\(apiKey, from, me\.email,/);
  });
  it('mode "run": chỉ người đã bật (brief_email = true), mỗi ngày một lần, truy vấn việc / lịch dùng chế độ explicit, không gửi thư rỗng', () => {
    expect(idx).toMatch(/\.eq\("brief_email", true\)/);
    expect(idx).toMatch(/p\.brief_sent_on !== today/);
    expect(idx.match(/fetchToday\(sb, me, now, \{ explicit: true \}\)/g).length).toBe(2);
    expect(idx).toMatch(/if \(!brief\) \{ empty\+\+; continue; \}/);
  });
  it('phản hồi chỉ có số lượng: không trả tên việc, email hay tiêu đề', () => {
    const run = idx.slice(idx.indexOf('async function runAll'), idx.indexOf('async function runMe'));
    const returns = [...run.matchAll(/return \{[^}]*\};?/g)].map((m) => m[0]);
    expect(returns.length).toBeGreaterThanOrEqual(2);
    returns.forEach((r) => expect(r).not.toMatch(/brief|email|users|title|subject|html|text/));
    expect(idx.slice(idx.indexOf('async function runMe'), idx.indexOf('Deno.serve'))).not.toMatch(/json\(\{[^}]*(brief\.(subject|html|text)|me\.email)/);
  });
});

describe('migration finance-butler-brief-migration.sql', () => {
  const sql = read('finance-butler-brief-migration.sql');
  it('bảng butler_prefs bật RLS, không chính sách nào và thu hồi quyền của anon / authenticated; mặc định tắt', () => {
    expect(sql).toMatch(/create table if not exists public\.butler_prefs/);
    expect(sql).toMatch(/brief_email boolean not null default false/);
    expect(sql).toMatch(/alter table public\.butler_prefs enable row level security/);
    expect(sql).toMatch(/revoke all on public\.butler_prefs from anon, authenticated/);
    expect(sql).not.toMatch(/create policy[^;]*butler_prefs/);
  });
  it('hai hàm đọc / đổi tuỳ chọn dùng current_user_id() của người gọi, chỉ authenticated gọi được', () => {
    expect(sql.match(/v_uid uuid := public\.current_user_id\(\)/g).length).toBe(2);
    expect(sql).toMatch(/revoke all on function public\.fn_butler_brief_get\(\) from public, anon/);
    expect(sql).toMatch(/grant execute on function public\.fn_butler_brief_set\(boolean\) to authenticated/);
    expect(sql).not.toMatch(/p_user|p_uid/);        // không nhận mã người từ tham số
  });
  it('lịch 07:45 giờ VN (00:45 UTC) thứ hai tới thứ sáu, gửi bí mật cron từ Vault, có trong tệp lịch chung của repo', () => {
    expect(sql).toMatch(/'45 0 \* \* 1-5'/);
    expect(sql).toMatch(/vault\.decrypted_secrets where name = 'cron_secret'/);
    expect(read('finance-cron-schedule-migration.sql')).toMatch(/'butler-brief-morning',\s+'45 0 \* \* 1-5',\s+'butler-brief'/);
  });
});

describe('giao diện tuỳ chọn Quản gia', () => {
  const ui = read('lib/butler-ui.js');
  it('nút bánh răng có nhãn; hộp đánh dấu bản tin sáng gọi đúng hai hàm SQL; gửi thử gọi butler-brief mode me', () => {
    expect(ui).toMatch(/'aria-label': 'Tuỳ chọn Quản gia'/);
    expect(ui).toMatch(/briefRpc\('fn_butler_brief_get'\)/);
    expect(ui).toMatch(/briefRpc\('fn_butler_brief_set', \{ p_on: want \}\)/);
    expect(ui).toMatch(/functions\.invoke\('butler-brief', \{ body: \{ mode: 'me' \} \}\)/);
  });
});
