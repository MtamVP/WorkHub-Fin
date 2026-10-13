// Dựng email BẢN TIN SÁNG của Quản gia từ dữ liệu "hôm nay" (cùng bản dựng với câu trả lời "hôm nay có gì" trong app: ButlerCore.composeToday). Hàm THUẦN: không đụng mạng / CSDL, kiểm thử bằng Vitest.
// Mọi chữ lấy từ CSDL (tên việc, tên dự án, tiêu đề lịch) đều đi qua esc() trước khi vào HTML. Không có việc / lịch / mốc nào thì trả null (không gửi email rỗng).
import "../butler/butler-core.js";

const BC = () => (globalThis as any).ButlerCore;

export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);

export type Brief = { subject: string; html: string; text: string; count: number };

const TONE_COLOR: Record<string, string> = { bad: "#C23B3B", warn: "#9A6B0D", info: "#5B554B" };
const TONE_WORD: Record<string, string> = { bad: "Cần xử lý", warn: "Cần chú ý", info: "" };

export function buildBrief(data: any, me: { nickname?: string }, nowMs: number): Brief | null {
  const C = BC(), r = C.composeToday(data, nowMs, null), c = r.counts;
  const count = c.late + c.due + c.events + c.milestones + c.soon;
  if (!count) return null;
  const day = (data && data.date) || C.vnDate(nowMs);
  const when = C.dayName(day) + " " + C.dm(day);
  const lists = (r.cards as any[]).filter((x) => x.type === "list");
  const name = String(me && me.nickname || "").trim();
  const parts: string[] = [];
  if (c.late) parts.push(c.late + " quá hạn");
  if (c.due) parts.push(c.due + " đến hạn hôm nay");
  if (c.events) parts.push(c.events + " lịch");
  if (c.milestones) parts.push(c.milestones + " mốc dự án");
  if (!parts.length && c.soon) parts.push(c.soon + " việc sắp đến hạn");
  const subject = "Bản tin sáng " + when + ": " + parts.join(", ");

  const sections = lists.map((card) => {
    const rows = (card.rows as any[]).map((row) => {
      const color = TONE_COLOR[row.tone] || TONE_COLOR.info, word = TONE_WORD[row.tone] || "";
      return '<li style="margin:0 0 8px;line-height:1.45"><span style="color:' + color + '">&#9679;</span> <strong>' + esc(row.text) + "</strong>" +
        (word ? ' <span style="font-size:11px;color:' + color + '">(' + esc(word) + ")</span>" : "") +
        (row.sub ? '<br><span style="font-size:12px;color:#5B554B">' + esc(row.sub) + "</span>" : "") + "</li>";
    }).join("");
    return '<h3 style="margin:18px 0 8px;font-size:14px;color:#1C1915">' + esc(card.title) + '</h3><ul style="margin:0;padding-left:18px;list-style:none">' + rows + "</ul>";
  }).join("");
  const html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#1C1915;background:#FFFEFB">' +
    '<h2 style="margin:0 0 4px;font-size:18px">Chào ' + esc(name || "bạn") + ",</h2>" +
    '<p style="margin:0 0 4px;font-size:14px;line-height:1.5">' + esc(r.text) + "</p>" + sections +
    '<p style="margin:22px 0 0;font-size:11px;line-height:1.5;color:#8A8377">Bạn nhận email này vì đã bật bản tin sáng của Quản gia (WorkHub Fin). Tắt: mở Quản gia &rarr; biểu tượng bánh răng &rarr; bỏ chọn bản tin sáng. Bản tin chỉ gồm việc được giao cho bạn, lịch và mốc dự án bạn được phép xem.</p></div>';
  const text = ["Chào " + (name || "bạn") + ",", r.text, ""].concat(lists.flatMap((card) => [card.title].concat((card.rows as any[]).map((row) => "- " + row.text + (row.sub ? " (" + row.sub + ")" : ""))).concat([""])))
    .concat(["Tắt bản tin: Quản gia > biểu tượng bánh răng > bỏ chọn bản tin sáng."]).join("\n");
  return { subject, html, text, count };
}
