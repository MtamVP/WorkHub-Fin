// Edge Function: source-watch -- GIÁM SÁT NGUỒN DỮ LIỆU miễn phí mà app phụ thuộc (không có cam kết dịch vụ: có thể đổi hoặc chặn bất cứ lúc nào). Hai chế độ (body {"mode": ...}):
//  "probe" (pg_cron mỗi 30 phút, 9:00-14:30 giờ VN ngày làm việc): thăm dò bảng giá VCI, VNDirect finfo và dchart; ghi mỗi nguồn một dòng finance_function_runs (fn "source-watch", mode "probe:<nguồn>");
//     lỗi 4 lần liên tiếp thì mở cảnh báo mức "cảnh báo" trong finance_data_health (kind "source_probe"), không email.
//  "daily" (pg_cron 18:50 giờ VN ngày làm việc, sau ảnh chụp thị trường 18:20): kiểm ảnh chụp thị trường có cập nhật đúng ngày không (kind "snapshot_stale"), kiểm nguồn lỗi quá nửa trong 2 ngày giao dịch liên tiếp
//     (mức "lỗi"), email quản lý về cảnh báo MỚI mức lỗi (cùng cách market-data-sync), dọn dòng thăm dò cũ hơn 45 ngày (chỉ dòng của chính hàm này).
// Ngày lễ: bỏ qua cả hai chế độ (lib/vn-holidays.js, bản sao nguyên văn). Chỉ ĐỌC từ nguồn ngoài; ghi duy nhất finance_function_runs và finance_data_health bằng service role. Phản hồi chỉ có số lượng.
// Gọi bởi pg_cron (Bearer = publishable key, verify_jwt giữ true). {"selftest":true} chạy không đụng mạng/CSDL. Secrets: RESEND_API_KEY, ALERT_FROM_EMAIL (như approval-watch); thiếu RESEND_API_KEY thì vẫn ghi cảnh báo, chỉ không gửi email.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "./vn-holidays.js";
import { buildEmail, evaluateProbes, evaluateSnapshot, judgeDchart, judgeFinfo, judgeVci, vnDate, type Flag, type Source } from "./logic.ts";

const g = globalThis as any;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
const isHoliday = (iso: string) => !!(g.VnHolidays && g.VnHolidays.isHoliday(iso));
const FN = "source-watch";

const VCI_URL = "https://trading.vietcap.com.vn/api/price/v1/w/priceboard/tickers/price/group";
const VCI_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; WorkHubPriceSync/1.0)", "Accept": "application/json", "Content-Type": "application/json",
  "Origin": "https://trading.vietcap.com.vn", "Referer": "https://trading.vietcap.com.vn/",
};

async function timed<T>(f: () => Promise<T>): Promise<{ v: T | null; ms: number; error?: string }> {
  const t0 = Date.now();
  try { return { v: await f(), ms: Date.now() - t0 }; } catch (e) { return { v: null, ms: Date.now() - t0, error: String((e as Error).message || e).slice(0, 160) }; }
}

async function probeAll(now: Date, today: string): Promise<{ source: Source; ok: boolean; ms: number; detail: Record<string, unknown> }[]> {
  const sec = Math.floor(now.getTime() / 1000);
  const [vci, finfo, dchart] = await Promise.all([
    timed(async () => { const r = await fetch(VCI_URL, { method: "POST", headers: VCI_HEADERS, body: JSON.stringify({ group: "HOSE" }), signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error("HTTP " + r.status); return judgeVci(await r.json()); }),
    timed(async () => { const r = await fetch(`https://api-finfo.vndirect.com.vn/v4/stock_prices?q=code:FPT~date:${today}&size=2`, { signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error("HTTP " + r.status); return judgeFinfo(await r.json(), today); }),
    timed(async () => { const r = await fetch(`https://dchart-api.vndirect.com.vn/dchart/history?resolution=1&symbol=VNINDEX&from=${sec - 4 * 3600}&to=${sec + 600}`, { signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error("HTTP " + r.status); return judgeDchart(await r.json()); }),
  ]);
  const out = (source: Source, x: { v: { ok: boolean; detail: Record<string, unknown> } | null; ms: number; error?: string }) => ({ source, ok: !!(x.v && x.v.ok), ms: x.ms, detail: x.v ? x.v.detail : { error: x.error } });
  return [out("vci", vci), out("finfo", finfo), out("dchart", dchart)];
}

async function sendEmail(apiKey: string, from: string, to: string, subject: string, html: string, text: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, html, text }), signal: AbortSignal.timeout(15000) });
    if (!res.ok) console.error("source-watch: Resend HTTP", res.status);
    return res.ok;
  } catch (e) { console.error("source-watch: gửi email lỗi:", String((e as Error).message || e)); return false; }
}
// Quản lý (asset_manager hoặc nhóm admin) đang hoạt động và đã bật email cảnh báo
async function emailManagers(supabase: any): Promise<{ id: string; email: string }[]> {
  const [{ data: users }, { data: roles }, { data: prefs }] = await Promise.all([
    supabase.from("users").select("id, email, group_key, active").in("group_key", ["finance", "admin"]),
    supabase.from("fin_roles").select("user_id").eq("role", "asset_manager"),
    supabase.from("finance_alert_prefs").select("user_id").eq("email_enabled", true),
  ]);
  const mgr = new Set((roles ?? []).map((r: any) => r.user_id)), opt = new Set((prefs ?? []).map((p: any) => p.user_id));
  return (users ?? []).filter((u: any) => u.email && u.active !== false && (u.group_key === "admin" || mgr.has(u.id)) && opt.has(u.id)).map((u: any) => ({ id: u.id, email: u.email }));
}

async function writeFlags(supabase: any, flags: Flag[]): Promise<any[]> {
  if (!flags.length) return [];
  const { data, error } = await supabase.from("finance_data_health").upsert(flags, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id, kind, severity, ref_date, detail");
  if (error) throw new Error(error.message);
  return data ?? [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng từ cron */ }
  if (body && body.selftest === true) return json({ ok: true, holidays: !!g.VnHolidays, sample: { holiday: isHoliday("2026-09-02"), trading: !isHoliday("2026-10-07") } });
  const mode = body && body.mode === "daily" ? "daily" : "probe";
  const now = new Date(), today = vnDate(now), supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const t0 = Date.now();
  try {
    if (isHoliday(today) || [0, 6].includes(new Date(today + "T00:00:00Z").getUTCDay())) return json({ ok: true, mode, skipped: "không phải ngày giao dịch" });

    if (mode === "probe") {
      const results = await probeAll(now, today);
      const rows = results.map((r) => ({ fn: FN, mode: "probe:" + r.source, ok: r.ok, duration_ms: r.ms, detail: r.detail }));
      const { error: iErr } = await supabase.from("finance_function_runs").insert(rows);
      if (iErr) throw new Error(iErr.message);
      const { data: recent } = await supabase.from("finance_function_runs").select("mode, run_at, ok").eq("fn", FN).like("mode", "probe:%").order("run_at", { ascending: false }).limit(160);
      const flags = evaluateProbes((recent ?? []) as any, today, isHoliday).filter((f) => f.severity === "warn");        // mức lỗi do bản "daily" quyết (cần 2 ngày) và email
      const opened = await writeFlags(supabase, flags);
      return json({ ok: true, mode, probes: results.map((r) => ({ source: r.source, ok: r.ok, ms: r.ms })), opened: opened.length });
    }

    // ---- daily ----
    const { data: stats } = await supabase.from("finance_sector_stats").select("as_of").order("as_of", { ascending: false }).limit(1);
    const asOf = stats && stats[0] ? String(stats[0].as_of).slice(0, 10) : null;
    const { data: recent } = await supabase.from("finance_function_runs").select("mode, run_at, ok").eq("fn", FN).like("mode", "probe:%").order("run_at", { ascending: false }).limit(220);
    const flags = [...evaluateSnapshot(asOf, today, isHoliday), ...evaluateProbes((recent ?? []) as any, today, isHoliday).filter((f) => f.severity === "error")];
    const inserted = await writeFlags(supabase, flags);
    const alertRows = inserted.filter((r: any) => r.severity === "error");
    let sent = 0;
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (alertRows.length && apiKey) {
      const mail = buildEmail(alertRows), from = Deno.env.get("ALERT_FROM_EMAIL") || "WorkHub <onboarding@resend.dev>";
      for (const rcp of await emailManagers(supabase)) { if (await sendEmail(apiKey, from, rcp.email, mail.subject, mail.html, mail.text)) sent++; }
    }
    const cutoff = new Date(now.getTime() - 45 * 86400000).toISOString();
    await supabase.from("finance_function_runs").delete().eq("fn", FN).lt("run_at", cutoff).then(() => {}, () => {});   // chỉ dọn dòng thăm dò của chính hàm này
    await supabase.from("finance_function_runs").insert({ fn: FN, mode: "daily", ok: true, duration_ms: Date.now() - t0, detail: { asOf, flags: flags.length, inserted: inserted.length, sent } }).then(() => {}, () => {});
    return json({ ok: true, mode, asOf, flagged: flags.length, inserted: inserted.length, sent });
  } catch (e) {
    console.error("source-watch:", String((e as Error).message || e));
    await supabase.from("finance_function_runs").insert({ fn: FN, mode, ok: false, duration_ms: Date.now() - t0, detail: { error: String((e as Error).message || e).slice(0, 300) } }).then(() => {}, () => {});
    return json({ ok: false, error: "Lỗi nội bộ khi giám sát nguồn dữ liệu." }, 500);
  }
});
