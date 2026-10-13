// Edge Function: butler-brief -- BẢN TIN SÁNG của Quản gia qua email (giai đoạn C). Chạy theo lịch pg_cron 07:45 giờ VN các ngày làm việc (mode "run"), hoặc người dùng bấm "Gửi thử cho tôi" trong Quản gia (mode "me").
//   mode "run": với mỗi người ĐÃ TỰ BẬT (butler_prefs.brief_email = true, mặc định tắt), dựng "hôm nay" (việc được giao cho họ, lịch họ được thấy, mốc dự án họ được thấy) bằng đúng bản dựng của Quản gia
//               (../butler/tools.ts fetchToday, chế độ explicit) rồi gửi email qua Resend. Không có gì để báo thì không gửi. Mỗi người tối đa một bản tin mỗi ngày (butler_prefs.brief_sent_on, giờ VN).
//   mode "me":  chỉ người gọi (xác định từ JWT, KHÔNG nhận mã người từ body), tối đa một lần / 10 phút, gửi tới chính email của họ kể cả khi họ chưa bật bản tin.
// BẢO MẬT: hàm dùng SERVICE ROLE nên không có RLS: mọi truy vấn phải tự lọc theo đúng người (xem fetchToday: lọc việc theo email, dự án theo nhóm, sự kiện theo nhóm + lịch cá nhân chỉ của chủ). Phản hồi chỉ có SỐ LƯỢNG, không có nội dung.
// verify_jwt = true; thêm cronGuard (bí mật cron của Vault, hoặc JWT người dùng cho mode "me"). {"selftest":true} không đụng mạng / CSDL. {"mode":"run","dry":true} tính nhưng không gửi, không ghi.
// Biến môi trường: RESEND_API_KEY, ALERT_FROM_EMAIL (dùng chung với insight-sync).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "../butler/butler-core.js";
import { fetchToday, type Me } from "../butler/tools.ts";
import { buildBrief } from "./brief.ts";
import { cronGuard } from "./cron-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
const BC = () => (globalThis as any).ButlerCore;
const MAX_PER_RUN = 200, TEST_GAP_MS = 10 * 60000;

async function sendEmail(apiKey: string, from: string, to: string, subject: string, html: string, text: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, html, text }), signal: AbortSignal.timeout(15000) });
    if (!res.ok) console.error("butler-brief: Resend HTTP", res.status);
    return res.ok;
  } catch (e) { console.error("butler-brief: gửi email lỗi:", String((e as Error).message || e)); return false; }
}
const meOf = (u: any): Me => ({ id: u.id, email: String(u.email || "").trim().toLowerCase(), nickname: String(u.nickname || String(u.email || "").split("@")[0]), group: String(u.group_key || "guest"), admin: String(u.group_key || "") === "admin" });

async function runAll(sb: any, dry: boolean) {
  const C = BC(), now = Date.now(), today = C.vnDate(now);
  const { data: prefs, error } = await sb.from("butler_prefs").select("user_id, brief_sent_on").eq("brief_email", true).limit(2000);
  if (error) throw new Error("butler_prefs: " + error.message);
  const ids = (prefs ?? []).filter((p: any) => p.brief_sent_on !== today).map((p: any) => p.user_id as string).slice(0, MAX_PER_RUN);
  if (!ids.length) return { ok: true, optedIn: (prefs ?? []).length, due: 0, sent: 0, failed: 0, empty: 0, note: "Không có ai cần gửi." };
  const { data: users } = await sb.from("users").select("id, email, nickname, group_key, active").in("id", ids);
  const apiKey = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("ALERT_FROM_EMAIL") || "WorkHub <onboarding@resend.dev>";
  let sent = 0, failed = 0, empty = 0;
  for (const u of (users ?? []).filter((x: any) => x.active !== false && x.email)) {
    try {
      const me = meOf(u);
      const brief = buildBrief(await fetchToday(sb, me, now, { explicit: true }), me, now);
      if (!brief) { empty++; continue; }
      if (dry) { sent++; continue; }
      if (!apiKey) { failed++; continue; }
      const ok = await sendEmail(apiKey, from, me.email, brief.subject, brief.html, brief.text);
      if (ok) { sent++; await sb.from("butler_prefs").update({ brief_sent_on: today, updated_at: new Date().toISOString() }).eq("user_id", u.id); } else failed++;
    } catch (e) { failed++; console.error("butler-brief: lỗi một người:", String((e as Error).message || e).slice(0, 160)); }
  }
  return { ok: true, optedIn: (prefs ?? []).length, due: ids.length, sent, failed, empty, configured: !!apiKey, dry: dry || undefined };
}

async function runMe(sb: any, req: Request) {
  const C = BC(), now = Date.now();
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token.split(".").length !== 3) return json({ ok: false, code: "auth", error: "Cần đăng nhập để gửi thử." }, 401);
  const { data: au, error: ae } = await sb.auth.getUser(token);
  const email = String(au?.user?.email || "").trim().toLowerCase();
  if (ae || !email) return json({ ok: false, code: "auth", error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn." }, 401);
  const { data: rows } = await sb.from("users").select("id, email, nickname, group_key, active").ilike("email", email).limit(5);
  const u = (rows ?? []).find((r: any) => String(r.email || "").toLowerCase() === email);
  if (!u || u.active === false) return json({ ok: false, code: "auth", error: "Tài khoản không dùng được." }, 403);
  const { data: pref } = await sb.from("butler_prefs").select("test_sent_at").eq("user_id", u.id).maybeSingle();
  if (pref && pref.test_sent_at && now - Date.parse(pref.test_sent_at) < TEST_GAP_MS) return json({ ok: false, code: "cap", error: "Gửi thử chỉ được một lần mỗi 10 phút." }, 429);
  const apiKey = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("ALERT_FROM_EMAIL") || "WorkHub <onboarding@resend.dev>";
  if (!apiKey) return json({ ok: false, code: "no_key", error: "Máy chủ chưa cấu hình gửi email." }, 503);
  const me = meOf(u);
  const brief = buildBrief(await fetchToday(sb, me, now, { explicit: true }), me, now);
  if (!brief) return json({ ok: true, sent: false, note: "Hôm nay chưa có việc, lịch hay mốc dự án nào nên chưa có gì để gửi." });
  const ok = await sendEmail(apiKey, from, me.email, brief.subject, brief.html, brief.text);
  if (!ok) return json({ ok: false, code: "upstream", error: "Dịch vụ gửi email không nhận thư lúc này, thử lại sau." }, 502);
  await sb.from("butler_prefs").upsert({ user_id: u.id, test_sent_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }, { onConflict: "user_id" });
  return json({ ok: true, sent: true, items: brief.count, day: C.vnDate(now) });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng */ }
  if (body && body.selftest === true) {
    const C = BC();
    return json({ ok: true, hasResend: !!Deno.env.get("RESEND_API_KEY"), core: C.VERSION, today: C.vnDate(Date.now()) });
  }
  const mode = String(body?.mode || "");
  if (mode !== "run" && mode !== "me") return json({ ok: false, error: "mode không hợp lệ" }, 400);
  { const blocked = await cronGuard(req, { fn: "butler-brief", allowUser: mode === "me" }); if (blocked) return blocked; }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  const t0 = Date.now();
  try {
    if (mode === "me") return await runMe(sb, req);
    const result = await runAll(sb, !!body.dry);
    if (!body.dry) await sb.from("finance_function_runs").insert({ fn: "butler-brief", mode, ok: result.ok !== false && result.failed === 0, duration_ms: Date.now() - t0, detail: result }).then(() => {}, () => {});
    return json(result, result.failed ? 502 : 200);
  } catch (e) {
    console.error("butler-brief", mode, String((e as Error).message || e).slice(0, 200));
    if (mode === "run" && !body.dry) await sb.from("finance_function_runs").insert({ fn: "butler-brief", mode, ok: false, duration_ms: Date.now() - t0, detail: { ok: false } }).then(() => {}, () => {});
    return json({ ok: false, error: "Không chạy được." }, 502);
  }
});
