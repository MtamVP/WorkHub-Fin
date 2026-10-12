// Công cụ của Quản gia (CHỈ ĐỌC). Mỗi công cụ gồm hai nửa: một hàm THUẦN dựng kết quả từ các dòng đã đọc (kiểm thử bằng Vitest, không cần CSDL) và một hàm đọc CSDL nhận client `sb`.
// `sb` LUÔN là client dựng từ khoá công khai + tiêu đề Authorization của NGƯỜI HỎI (xem index.ts), nên mọi truy vấn chịu RLS của chính người đó: Quản gia không thể thấy gì người đó không được thấy.
// KHÔNG import Deno / supabase ở đây (để Vitest nạp được). Không tool nào ghi dữ liệu.
import "./butler-core.js";

const BC = () => (globalThis as any).ButlerCore;

export type Me = { id: string; email: string; nickname: string; group: string; admin: boolean };
export type TodayData = {
  date: string;
  tasks: { id: string; name: string; status: string; priority: string; due: string; project: string; late: number }[];
  events: { id: string; title: string; start: string; end: string; location: string; important: boolean }[];
  milestones: { id: string; title: string; target: string; project: string; late: number }[];
};

const DONE = new Set(["done", "completed", "complete", "cancelled", "canceled", "hoàn thành", "hoan thanh"]);
const PRIO_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const clip = (s: unknown, n: number) => BC().clip(String(s ?? ""), n);

// Dựng dữ liệu "hôm nay" từ các dòng đã đọc (đã qua RLS). Ngày hạn lấy 10 ký tự đầu của due_date đúng như giao diện hiện ngày hạn (api.js listMine).
export function buildToday(input: {
  projects: { id: string; name: string }[]; assignedTaskIds: string[];
  tasks: { id: string; project_id: string; name: string; status: string; priority: string; due_date: string | null }[];
  events: any[]; milestones: { id: string; project_id: string; title: string; target_date: string | null; is_done: boolean }[];
}, today: string): TodayData {
  const C = BC(), proj = new Map(input.projects.map((p) => [p.id, p.name])), mine = new Set(input.assignedTaskIds);
  const tasks = input.tasks
    .filter((t) => mine.has(t.id) && proj.has(t.project_id) && t.due_date && !DONE.has(String(t.status || "").trim().toLowerCase()))
    .map((t) => { const due = String(t.due_date).slice(0, 10); return { id: t.id, name: clip(t.name, 90), status: String(t.status || ""), priority: String(t.priority || ""), due, project: clip(proj.get(t.project_id), 40), late: C.daysBetween(due, today) }; })
    .filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.due) && t.late >= -3)             // quá hạn, hôm nay và 3 ngày tới
    .sort((a, b) => b.late - a.late || (PRIO_RANK[a.priority.toLowerCase()] ?? 9) - (PRIO_RANK[b.priority.toLowerCase()] ?? 9) || a.name.localeCompare(b.name))
    .slice(0, 30);
  const events = input.events
    .filter((e) => e && !e.deleted_at && C.occursOn(e, today))
    .map((e) => ({ id: String(e.id), title: clip(e.title, 80), start: e.start_time ? C.vnHm(e.start_time) : "", end: e.end_time ? C.vnHm(e.end_time) : "", location: clip(e.location || "", 40), important: !!e.is_important, _s: Date.parse(e.start_time) || 0 }))
    .sort((a, b) => a._s - b._s).slice(0, 20)
    .map(({ _s, ...rest }) => rest);
  const milestones = input.milestones
    .filter((m) => !m.is_done && m.target_date && proj.has(m.project_id))
    .map((m) => { const target = String(m.target_date).slice(0, 10); return { id: m.id, title: clip(m.title, 80), target, project: clip(proj.get(m.project_id), 40), late: C.daysBetween(target, today) }; })
    .filter((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.target) && m.late >= -7)           // trễ, hôm nay và 7 ngày tới
    .sort((a, b) => b.late - a.late).slice(0, 10);
  return { date: today, tasks, events, milestones };
}

const chunk = <T>(a: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// Đọc CSDL cho "hôm nay". Dự án: giống api.js listMine (admin thấy tất cả; người khác thấy dự án của nhóm mình và nhóm 'all'); việc: bảng task_assignees theo email của chính người hỏi.
export async function fetchToday(sb: any, me: Me, nowMs: number): Promise<TodayData> {
  const C = BC(), today = C.vnDate(nowMs), email = me.email.trim().toLowerCase();
  const from = new Date(Date.parse(today + "T00:00:00+07:00")).toISOString(), to = new Date(Date.parse(today + "T00:00:00+07:00") + 86400000).toISOString();
  const pq = await sb.from("projects").select("id, name, group_key").is("deleted_at", null).is("archived_at", null).limit(1000);
  if (pq.error) throw new Error("projects: " + pq.error.message);
  const projects = (pq.data || []).filter((p: any) => me.admin || p.group_key === me.group || p.group_key === "all").map((p: any) => ({ id: p.id, name: p.name }));
  const aq = await sb.from("task_assignees").select("task_id").eq("user_email", email).limit(2000);
  if (aq.error) throw new Error("task_assignees: " + aq.error.message);
  const assignedTaskIds = (aq.data || []).map((r: any) => String(r.task_id));
  const tasks: any[] = [];
  for (const ids of chunk(assignedTaskIds, 150)) {
    const tq = await sb.from("tasks").select("id, project_id, name, status, priority, due_date").is("deleted_at", null).in("id", ids);
    if (tq.error) throw new Error("tasks: " + tq.error.message);
    tasks.push(...(tq.data || []));
  }
  // Sự kiện: bắt đầu trước hết ngày hôm nay và (kết thúc từ đầu hôm nay trở đi, hoặc là sự kiện lặp, hoặc chưa có giờ kết thúc); lọc chính xác bằng occursOn
  const eq = await sb.from("events").select("id, title, start_time, end_time, location, is_important, recurrence, recurrence_end, deleted_at, group_key, calendar_type")
    .is("deleted_at", null).lt("start_time", to).or("end_time.gte." + from + ",recurrence.neq.none,end_time.is.null").limit(500);
  if (eq.error) throw new Error("events: " + eq.error.message);
  const pids = projects.map((p: any) => p.id);
  const milestones: any[] = [];
  for (const ids of chunk(pids, 150)) {
    const mq = await sb.from("project_milestones").select("id, project_id, title, target_date, is_done").eq("is_done", false).in("project_id", ids).lte("target_date", C.addDays(today, 7));
    if (mq.error) throw new Error("project_milestones: " + mq.error.message);
    milestones.push(...(mq.data || []));
  }
  return buildToday({ projects, assignedTaskIds, tasks, events: eq.data || [], milestones }, today);
}
