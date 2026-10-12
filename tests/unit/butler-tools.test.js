// supabase/functions/butler/tools.ts: phần THUẦN của công cụ "hôm nay" (buildToday) và phần đọc CSDL (fetchToday) với client giả để kiểm: truy vấn đúng bảng / bộ lọc, chỉ đọc, và phạm vi dự án.
import { describe, it, expect } from 'vitest';
import { buildToday, fetchToday } from '../../supabase/functions/butler/tools.ts';

const projects = [{ id: 'p1', name: 'Báo cáo quý' }, { id: 'p2', name: 'Đầu tư' }];
const base = {
  projects, assignedTaskIds: ['t1', 't2', 't3', 't4', 't5', 't6'],
  tasks: [
    { id: 't1', project_id: 'p1', name: 'Nộp báo cáo', status: 'In Progress', priority: 'High', due_date: '2026-10-09T00:00:00+00:00' },
    { id: 't2', project_id: 'p2', name: 'Duyệt đề xuất', status: 'Not Started', priority: 'Medium', due_date: '2026-10-12T00:00:00+00:00' },
    { id: 't3', project_id: 'p2', name: 'Đã xong rồi', status: 'Done', priority: 'Low', due_date: '2026-10-10T00:00:00+00:00' },
    { id: 't4', project_id: 'p2', name: 'Xa quá', status: 'Not Started', priority: 'Low', due_date: '2026-11-30T00:00:00+00:00' },
    { id: 't5', project_id: 'px', name: 'Dự án không thấy', status: 'Not Started', priority: 'Low', due_date: '2026-10-12T00:00:00+00:00' },
    { id: 't6', project_id: 'p1', name: 'Không hạn', status: 'Not Started', priority: 'Low', due_date: null },
    { id: 'tX', project_id: 'p1', name: 'Không được giao cho tôi', status: 'Not Started', priority: 'Low', due_date: '2026-10-12T00:00:00+00:00' },
  ],
  events: [
    { id: 'e1', title: 'Họp đầu tư', start_time: '2026-10-12T02:30:00Z', end_time: '2026-10-12T03:30:00Z', location: 'Phòng A', is_important: true, recurrence: 'none' },
    { id: 'e2', title: 'Họp tuần', start_time: '2026-10-05T01:00:00Z', end_time: '2026-10-05T02:00:00Z', recurrence: 'weekly' },
    { id: 'e3', title: 'Hôm qua', start_time: '2026-10-11T02:00:00Z', end_time: '2026-10-11T03:00:00Z', recurrence: 'none' },
    { id: 'e4', title: 'Đã xoá', start_time: '2026-10-12T02:00:00Z', deleted_at: '2026-10-01T00:00:00Z', recurrence: 'none' },
  ],
  milestones: [
    { id: 'm1', project_id: 'p1', title: 'Chốt báo cáo', target_date: '2026-10-11', is_done: false },
    { id: 'm2', project_id: 'p1', title: 'Xong rồi', target_date: '2026-10-11', is_done: true },
    { id: 'm3', project_id: 'p2', title: 'Xa', target_date: '2026-12-01', is_done: false },
  ],
};

describe('buildToday', () => {
  const r = buildToday(base, '2026-10-12');
  it('chỉ việc được giao cho tôi, chưa xong, thuộc dự án thấy được, có hạn trong khoảng quá hạn → 3 ngày tới', () => {
    expect(r.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(r.tasks[0]).toMatchObject({ late: 3, project: 'Báo cáo quý', due: '2026-10-09' });
    expect(r.tasks[1].late).toBe(0);
  });
  it('sự kiện: một lần, lặp hằng tuần; bỏ sự kiện ngày khác và đã xoá; giờ theo giờ Việt Nam', () => {
    expect(r.events.map((e) => e.id)).toEqual(['e2', 'e1']);                 // 08:00 (họp tuần) trước 09:30
    expect(r.events[1]).toMatchObject({ start: '09:30', end: '10:30', location: 'Phòng A', important: true });
  });
  it('mốc dự án: chưa xong, trong khoảng trễ → 7 ngày tới', () => {
    expect(r.milestones.map((m) => m.id)).toEqual(['m1']);
    expect(r.milestones[0].late).toBe(1);
  });
  it('đầu vào rỗng không lỗi', () => {
    expect(buildToday({ projects: [], assignedTaskIds: [], tasks: [], events: [], milestones: [] }, '2026-10-12')).toEqual({ date: '2026-10-12', tasks: [], events: [], milestones: [] });
  });
  it('sắp xếp: trễ nhiều trước, cùng mức thì ưu tiên cao trước', () => {
    const x = buildToday({ ...base, tasks: [
      { id: 't1', project_id: 'p1', name: 'B thấp', status: 'x', priority: 'Low', due_date: '2026-10-12' },
      { id: 't2', project_id: 'p1', name: 'A cao', status: 'x', priority: 'High', due_date: '2026-10-12' },
      { id: 't3', project_id: 'p1', name: 'Trễ', status: 'x', priority: 'Low', due_date: '2026-10-10' },
    ] }, '2026-10-12');
    expect(x.tasks.map((t) => t.id)).toEqual(['t3', 't2', 't1']);
  });
});

// Client giả: ghi lại mọi truy vấn để kiểm bảng / bộ lọc; chỉ có các phương thức ĐỌC (nếu mã gọi insert/update/delete sẽ ném lỗi)
function fakeSb(tables) {
  const calls = [];
  const sb = {
    calls,
    from(table) {
      const q = { table, filters: [] };
      calls.push(q);
      const chain = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (res) => res({ data: tables[table] || [], error: null });
          if (['insert', 'update', 'delete', 'upsert'].includes(prop)) throw new Error('tool không được ghi: ' + prop);
          return (...args) => { q.filters.push([prop, ...args]); return chain; };
        },
      });
      return chain;
    },
  };
  return sb;
}

describe('fetchToday', () => {
  const me = { id: 'u1', email: 'An@Example.com', nickname: 'An', group: 'finance', admin: false };
  const tables = {
    projects: [{ id: 'p1', name: 'A', group_key: 'finance' }, { id: 'p2', name: 'B', group_key: 'science' }, { id: 'p3', name: 'C', group_key: 'all' }],
    task_assignees: [{ task_id: 't1' }],
    tasks: [{ id: 't1', project_id: 'p1', name: 'X', status: 'Not Started', priority: 'High', due_date: '2026-10-12T00:00:00+00:00' }],
    events: [], project_milestones: [],
  };
  it('lọc dự án theo nhóm của người hỏi (nhóm khác bị loại, nhóm all được giữ), tra việc theo email viết thường, chỉ đọc', async () => {
    const sb = fakeSb(tables);
    const r = await fetchToday(sb, me, Date.parse('2026-10-12T03:00:00Z'));
    expect(r.date).toBe('2026-10-12');
    expect(r.tasks.map((t) => t.id)).toEqual(['t1']);
    const assign = sb.calls.find((c) => c.table === 'task_assignees');
    expect(assign.filters).toContainEqual(['eq', 'user_email', 'an@example.com']);
    const ms = sb.calls.find((c) => c.table === 'project_milestones');
    expect(ms.filters.find((f) => f[0] === 'in')[2].sort()).toEqual(['p1', 'p3']);
    expect(sb.calls.map((c) => c.table).sort()).toEqual(['events', 'project_milestones', 'projects', 'task_assignees', 'tasks']);
  });
  it('quản trị viên thấy dự án của mọi nhóm', async () => {
    const sb = fakeSb(tables);
    await fetchToday(sb, { ...me, group: 'admin', admin: true }, Date.parse('2026-10-12T03:00:00Z'));
    expect(sb.calls.find((c) => c.table === 'project_milestones').filters.find((f) => f[0] === 'in')[2].sort()).toEqual(['p1', 'p2', 'p3']);
  });
  it('lỗi CSDL được ném ra để hàm trả mã lỗi (không nuốt)', async () => {
    const sb = { from() { const c = new Proxy({}, { get(_t, p) { if (p === 'then') return (res) => res({ data: null, error: { message: 'boom' } }); return () => c; } }); return c; } };
    await expect(fetchToday(sb, me, Date.now())).rejects.toThrow(/projects: boom/);
  });
});
