// Edge Function: approval-watch -- giám sát quy trình duyệt lệnh lớn, chạy cả khi không ai mở app. Hai chế độ (body {"mode": ...}):
//  "notify" (pg_cron mỗi 10 phút): đề xuất lệnh MỚI chờ duyệt -> gửi email cho quản lý đã bật "email cảnh báo" (trừ chính người đề xuất). Mỗi đề xuất báo 1 lần:
//     "chiếm chỗ" bằng cột notified_at trước khi gửi, gửi lỗi toàn bộ thì nhả chỗ để lần sau thử lại. Chưa có RESEND_API_KEY thì không làm gì.
//  "audit" (pg_cron 16:00 giờ VN các ngày làm việc): KIỂM TRA ĐỘC LẬP -- lệnh lớn đã ghi vào sổ mà không có đề xuất đã duyệt gắn với nó, ghi vào finance_approval_audit
//     (txn_id duy nhất nên không báo trùng) và email quản lý. Cần vì việc ép duyệt khi ghi lệnh nằm trong code app, còn đây là kiểm ở máy chủ.
// Gọi bởi pg_cron (Bearer = publishable key, verify_jwt giữ true) như check-limits. Phản hồi chỉ có SỐ LƯỢNG. {"selftest":true} chạy bài tự kiểm không đụng CSDL.
// Tính toán dùng ĐÚNG lib/approval-calc.js (approval-calc.js ở thư mục này là bản sao nguyên văn, có test so khớp). Secrets: RESEND_API_KEY, ALERT_FROM_EMAIL (như send-price-alerts).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "./approval-calc.js";
import { buildAuditEmail, buildPendingEmail, findUnapproved, selfTest, vnDate } from "./audit.ts";

const g = globalThis as any;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

async function sendEmail(apiKey: string, from: string, to: string, subject: string, html: string, text: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.error("approval-watch: Resend HTTP", res.status);
    return res.ok;
  } catch (e) {
    console.error("approval-watch: gửi email lỗi:", String((e as Error).message || e));
    return false;
  }
}

// Quản lý (asset_manager hoặc nhóm admin) đang hoạt động và đã bật email cảnh báo
async function emailManagers(supabase: any): Promise<{ id: string; email: string; nickname: string | null }[]> {
  const [{ data: users }, { data: roles }, { data: prefs }] = await Promise.all([
    supabase.from("users").select("id, email, nickname, group_key, active").in("group_key", ["finance", "admin"]),
    supabase.from("fin_roles").select("user_id").eq("role", "asset_manager"),
    supabase.from("finance_alert_prefs").select("user_id").eq("email_enabled", true),
  ]);
  const mgrIds = new Set((roles ?? []).map((r: any) => r.user_id));
  const optIn = new Set((prefs ?? []).map((p: any) => p.user_id));
  return (users ?? []).filter((u: any) => u.email && u.active !== false && (u.group_key === "admin" || mgrIds.has(u.id)) && optIn.has(u.id))
    .map((u: any) => ({ id: u.id, email: u.email, nickname: u.nickname ?? null }));
}

async function allUsers(supabase: any): Promise<Map<string, string>> {
  const { data } = await supabase.from("users").select("id, email, nickname");
  return new Map((data ?? []).map((u: any) => [u.id, u.nickname || String(u.email || "").split("@")[0]]));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng */ }
  const libs = { ApprovalCalc: g.ApprovalCalc };
  if (body && body.selftest === true) return json({ ok: true, flags: selfTest(libs) });
  const mode = body && body.mode === "audit" ? "audit" : "notify";
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("ALERT_FROM_EMAIL") || "WorkHub <onboarding@resend.dev>";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const now = new Date();

    if (mode === "notify") {
      if (!apiKey) return json({ ok: true, configured: false, message: "RESEND_API_KEY chưa được cấu hình — không gửi gì." });
      const since = new Date(now.getTime() - 3 * 86400000).toISOString();
      const { data: fresh, error } = await supabase.from("finance_order_requests").select("id").eq("status", "pending").is("notified_at", null).gte("created_at", since);
      if (error) throw new Error(error.message);
      if (!(fresh ?? []).length) return json({ ok: true, mode, pending: 0, sent: 0 });
      const recipients = await emailManagers(supabase);
      if (!recipients.length) return json({ ok: true, mode, pending: fresh.length, recipients: 0, sent: 0 });
      // Chiếm chỗ nguyên tử: chỉ những dòng THỰC SỰ vừa được đánh dấu mới là đề xuất mới
      const { data: claimed, error: cErr } = await supabase.from("finance_order_requests").update({ notified_at: now.toISOString() })
        .in("id", fresh.map((r: any) => r.id)).is("notified_at", null).eq("status", "pending").select("*");
      if (cErr) throw new Error(cErr.message);
      if (!(claimed ?? []).length) return json({ ok: true, mode, pending: 0, sent: 0 });
      const names = await allUsers(supabase);
      let sent = 0, failed = 0;
      for (const rcp of recipients) {
        const mine = (claimed ?? []).filter((r: any) => r.user_id !== rcp.id && r.created_by !== rcp.id);
        if (!mine.length) continue;
        const mail = buildPendingEmail(mine.map((r: any) => ({ name: names.get(r.user_id) || "Thành viên", side: r.side, symbol: r.symbol, quantity: Number(r.quantity), price_ref: Number(r.price_ref), value: Number(r.value), order_pct: r.order_pct === null ? null : Number(r.order_pct), reason: r.reason })));
        (await sendEmail(apiKey, from, rcp.email, mail.subject, mail.html, mail.text)) ? sent++ : failed++;
      }
      if (sent === 0 && failed > 0) await supabase.from("finance_order_requests").update({ notified_at: null }).in("id", claimed.map((r: any) => r.id));   // nhả chỗ, lần sau thử lại
      return json({ ok: true, mode, pending: claimed.length, recipients: recipients.length, sent, failed });
    }

    // ---- audit ----
    const { data: policy, error: pErr } = await supabase.from("finance_approval_policy").select("*").eq("id", 1).maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!policy || !policy.active || !policy.active_since) return json({ ok: true, mode, active: false, flagged: 0 });
    const lookback = 5;
    const sinceIso = new Date(Math.max(Date.parse(policy.active_since), now.getTime() - lookback * 86400000)).toISOString();
    const { data: txns, error: tErr } = await supabase.from("finance_transactions").select("id, user_id, symbol, type, quantity, price, trade_date, created_at, deleted_at, import_batch, note").is("deleted_at", null).gte("created_at", sinceIso).limit(2000);
    if (tErr) throw new Error(tErr.message);
    if (!(txns ?? []).length) return json({ ok: true, mode, active: true, checked: 0, flagged: 0 });
    const userIds = [...new Set((txns ?? []).map((t: any) => t.user_id))];
    const [{ data: requests }, { data: navRows }] = await Promise.all([
      supabase.from("finance_order_requests").select("txn_id").not("txn_id", "is", null),
      supabase.from("finance_nav_history").select("user_id, snapshot_date, nav").in("user_id", userIds).gte("snapshot_date", vnDate(new Date(now.getTime() - 90 * 86400000))).order("snapshot_date", { ascending: true }).limit(5000),
    ]);
    const flags = findUnapproved(libs, { policy, txns: txns ?? [], requests: requests ?? [], navRows: navRows ?? [], now, lookbackDays: lookback });
    if (!flags.length) return json({ ok: true, mode, active: true, checked: (txns ?? []).length, flagged: 0 });
    const { data: inserted, error: iErr } = await supabase.from("finance_approval_audit").upsert(flags, { onConflict: "txn_id", ignoreDuplicates: true }).select("txn_id, user_id, symbol, side, value, pct, trade_date, kind");
    if (iErr) throw new Error(iErr.message);
    let sent = 0;
    if ((inserted ?? []).length && apiKey) {
      const names = await allUsers(supabase);
      const mail = buildAuditEmail((inserted ?? []).map((r: any) => ({ name: names.get(r.user_id) || "Thành viên", side: r.side, symbol: r.symbol, value: Number(r.value), pct: r.pct === null ? null : Number(r.pct), trade_date: r.trade_date, kind: r.kind })));
      for (const rcp of await emailManagers(supabase)) { if (await sendEmail(apiKey, from, rcp.email, mail.subject, mail.html, mail.text)) sent++; }
    }
    return json({ ok: true, mode, active: true, checked: (txns ?? []).length, flagged: (inserted ?? []).length, sent });
  } catch (e) {
    console.error("approval-watch:", String((e as Error).message || e));
    return json({ ok: false, error: "Lỗi khi chạy giám sát duyệt lệnh." }, 500);
  }
});
