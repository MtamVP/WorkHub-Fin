// Logic thuần của Edge Function approval-watch -- không import Deno/Supabase để Vitest chạy được (tests/unit/approval-watch.test.js).
// (1) findUnapproved: lệnh lớn đã ghi vào sổ mà không có đề xuất đã duyệt gắn với nó -- lớp kiểm độc lập vì việc ép duyệt khi ghi lệnh nằm trong code app.
// (2) buildPendingEmail / buildAuditEmail: nội dung email báo quản lý. Dùng ĐÚNG ApprovalCalc của app (truyền vào qua `libs`), nên ngưỡng không thể lệch.
export interface Libs { ApprovalCalc: any }
export interface AuditFlag {
  txn_id: string; user_id: string; symbol: string; side: string; trade_date: string; quantity: number; price: number; value: number;
  nav_ref: number | null; pct: number | null; reasons: string[]; kind: "unapproved" | "reconcile";
}

const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : 0; };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const vnd = (v: number) => Math.round(v).toLocaleString("vi-VN") + " đ";

// Ngày theo giờ Việt Nam (UTC+7) dạng YYYY-MM-DD
export function vnDate(d: Date): string { return new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10); }

// policy: dòng finance_approval_policy (snake_case); txns: finance_transactions; requests: finance_order_requests; navRows: finance_nav_history { user_id, snapshot_date, nav }.
// Chỉ xét lệnh được GHI sau khi quy định bật (active_since), trong `lookbackDays` ngày gần nhất, không phải lệnh nhập từ sao kê, và chưa có đề xuất nào gắn txn_id.
export function findUnapproved(libs: Libs, input: { policy: any; txns: any[]; requests: any[]; navRows: any[]; now: Date; lookbackDays?: number }): AuditFlag[] {
  const { ApprovalCalc } = libs;
  const p = input.policy;
  if (!p || !p.active || !p.active_since) return [];
  const pol = ApprovalCalc.normalizePolicy(p);
  const since = Math.max(Date.parse(p.active_since), input.now.getTime() - (input.lookbackDays ?? 5) * 86400000);
  const covered = new Set((input.requests ?? []).filter((r) => r.txn_id).map((r) => String(r.txn_id)));
  // NAV tham chiếu: bản chụp gần nhất không muộn hơn ngày giao dịch của đúng người đó
  const navBy = new Map<string, { d: string; nav: number }[]>();
  for (const r of input.navRows ?? []) {
    const k = String(r.user_id);
    if (!navBy.has(k)) navBy.set(k, []);
    navBy.get(k)!.push({ d: String(r.snapshot_date).slice(0, 10), nav: num(r.nav) });
  }
  navBy.forEach((v) => v.sort((a, b) => (a.d < b.d ? -1 : 1)));
  const navAt = (uid: string, date: string): number | null => {
    const rows = navBy.get(uid) ?? [];
    let best: number | null = null;
    for (const r of rows) { if (r.d <= date) best = r.nav; else break; }
    return best !== null && best > 0 ? best : null;
  };
  const out: AuditFlag[] = [];
  for (const t of input.txns ?? []) {
    if (t.deleted_at || t.import_batch) continue;                       // lệnh nhập từ sao kê là việc đã xảy ra, không cần duyệt
    if (!t.created_at || Date.parse(t.created_at) < since) continue;
    if (covered.has(String(t.id))) continue;
    const trade = { quantity: num(t.quantity), price: num(t.price) };
    const nav = navAt(String(t.user_id), String(t.trade_date).slice(0, 10));
    const n = ApprovalCalc.needsApproval(pol, nav ?? 0, trade);
    if (!n.needed) continue;
    out.push({
      txn_id: String(t.id), user_id: String(t.user_id), symbol: String(t.symbol).toUpperCase(), side: t.type === "sell" ? "sell" : "buy", trade_date: String(t.trade_date).slice(0, 10),
      quantity: trade.quantity, price: trade.price, value: n.value, nav_ref: nav, pct: n.pct, reasons: [n.byPct ? "pct" : "", n.byVnd ? "vnd" : ""].filter(Boolean),
      kind: String(t.note || "").startsWith("Đối soát") ? "reconcile" : "unapproved",
    });
  }
  return out;
}

const head = (title: string) => `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;color:#1c1c1e"><h2 style="margin:0 0 12px">${title}</h2>`;
const foot = '<p style="color:#6b6b70;font-size:12px;margin-top:18px">Email này gửi vì bạn bật “email cảnh báo” trong WorkHub Fin và có quyền quản lý danh mục. Mở WorkHub Fin → Toàn Nhóm → Duyệt Lệnh để xử lý.</p></div>';

export function buildPendingEmail(rows: { name: string; side: string; symbol: string; quantity: number; price_ref: number; value: number; order_pct: number | null; reason: string }[]): { subject: string; html: string; text: string } {
  const subject = rows.length === 1 ? `WorkHub: đề xuất lệnh ${rows[0].side === "sell" ? "bán" : "mua"} ${rows[0].symbol} chờ bạn duyệt` : `WorkHub: ${rows.length} đề xuất lệnh chờ bạn duyệt`;
  const line = (r: typeof rows[0]) => `${r.name}: ${r.side === "sell" ? "bán" : "mua"} ${r.symbol} ${Math.round(r.quantity).toLocaleString("vi-VN")} × ${Math.round(r.price_ref).toLocaleString("vi-VN")} = ${vnd(r.value)}${r.order_pct === null ? "" : ` (${(Math.round(num(r.order_pct) * 10) / 10).toLocaleString("vi-VN")}% NAV)`}`;
  const html = head("Đề xuất lệnh chờ duyệt") + rows.map((r) => `<div style="border:1px solid #e3e3e6;border-radius:8px;padding:10px 12px;margin:0 0 10px"><b>${esc(line(r))}</b><div style="color:#4a4a4f;margin-top:4px">Lý do: ${esc(r.reason)}</div></div>`).join("") + foot;
  const text = rows.map((r) => `${line(r)}\nLý do: ${r.reason}`).join("\n\n") + "\n\nMở WorkHub Fin → Toàn Nhóm → Duyệt Lệnh để xử lý.";
  return { subject, html, text };
}

export function buildAuditEmail(rows: { name: string; side: string; symbol: string; value: number; pct: number | null; trade_date: string; kind: string }[]): { subject: string; html: string; text: string } {
  const subject = `WorkHub: ${rows.length} lệnh lớn đã ghi mà không qua duyệt`;
  const line = (r: typeof rows[0]) => `${r.name}: ${r.side === "sell" ? "bán" : "mua"} ${r.symbol} ${vnd(r.value)}${r.pct === null ? "" : ` (${(Math.round(num(r.pct) * 10) / 10).toLocaleString("vi-VN")}% NAV)`} ngày ${r.trade_date}${r.kind === "reconcile" ? " — lệnh điều chỉnh đối soát" : ""}`;
  const html = head("Lệnh lớn đã ghi mà không có đề xuất được duyệt") + '<p style="margin:0 0 10px">Kiểm tra độc lập hằng ngày phát hiện:</p>' + rows.map((r) => `<div style="border:1px solid #e3e3e6;border-radius:8px;padding:10px 12px;margin:0 0 10px"><b>${esc(line(r))}</b></div>`).join("") + foot;
  const text = "Kiểm tra độc lập hằng ngày phát hiện lệnh lớn đã ghi mà không có đề xuất được duyệt:\n" + rows.map(line).join("\n") + "\n\nMở WorkHub Fin → Toàn Nhóm → Duyệt Lệnh để xem xét.";
  return { subject, html, text };
}

// Bài tự kiểm cố định (không đụng CSDL): sau khi triển khai gọi {"selftest":true} và so với tests/unit/approval-watch.test.js
export function selfTest(libs: Libs): AuditFlag[] {
  const tx = (id: string, user_id: string, type: string, symbol: string, quantity: number, price: number, trade_date: string, extra: Record<string, unknown> = {}) =>
    ({ id, user_id, type, symbol, quantity, price, trade_date, created_at: trade_date + "T03:00:00Z", deleted_at: null, import_batch: null, note: null, ...extra });
  return findUnapproved(libs, {
    policy: { active: true, threshold_pct: 10, threshold_vnd: null, valid_days: 3, active_since: "2026-09-01T00:00:00Z" },
    txns: [tx("t1", "u1", "buy", "fpt", 1000, 100000, "2026-10-01"), tx("t2", "u1", "buy", "vcb", 100, 90000, "2026-10-01"), tx("t3", "u1", "buy", "hpg", 5000, 27000, "2026-10-01", { import_batch: "b1" }), tx("t4", "u1", "sell", "ssi", 2000, 30000, "2026-10-02", { note: "Đối soát 30/09: điều chỉnh theo sao kê" })],
    requests: [],
    navRows: [{ user_id: "u1", snapshot_date: "2026-09-30", nav: 500000000 }],
    now: new Date("2026-10-03T00:00:00Z"),
  });
}
