// Edge Function: valuation-watch -- mỗi ngày làm việc (sau ảnh chụp thị trường) tính CẢNH BÁO ĐỊNH GIÁ và email cho quản lý khi có cảnh báo MỚI:
// thị trường hoặc ngành mà nhóm đang nắm (tỷ trọng từ 10%) đắt/rẻ so với chính lịch sử 5 năm của nó, dịch chuyển nhanh, tập trung danh mục vào ngành đắt/rẻ.
// Chạy cả khi không ai mở app. Bảng finance_valuation_alert_state nhớ cảnh báo nào đã báo để không gửi lặp (chờ tối thiểu 7 ngày giữa hai lần gửi cùng một cảnh báo).
// Gọi bởi pg_cron (Bearer = publishable key, verify_jwt giữ true) như check-limits. Phản hồi chỉ có SỐ LƯỢNG, không lộ cảnh báo hay tỷ trọng. {"dry":true} tính nhưng không ghi gì và không gửi;
// {"selftest":true} chạy bài tự kiểm không đụng CSDL. Tính toán dùng ĐÚNG lib/ của app (bản sao nguyên văn trong thư mục này, có test so khớp). Secrets: RESEND_API_KEY, ALERT_FROM_EMAIL.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "./finance-calc.js";
import "./portfolio-calc.js";
import "./group-calc.js";
import "./sector-map.js";
import "./valuation-history.js";
import "./valuation-alerts.js";
import { buildEmail, currentAlerts, planNotify, sectorWeights, selfTest, vnDate } from "./watch.ts";

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
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.error("valuation-watch: Resend HTTP", res.status);
    return res.ok;
  } catch (e) { console.error("valuation-watch: gửi email lỗi:", String((e as Error).message || e)); return false; }
}

// Quản lý (asset_manager hoặc nhóm admin) đang hoạt động và đã bật email cảnh báo -- cùng quy tắc với approval-watch
async function emailManagers(supabase: any): Promise<{ id: string; email: string }[]> {
  const [{ data: users }, { data: roles }, { data: prefs }] = await Promise.all([
    supabase.from("users").select("id, email, group_key, active").in("group_key", ["finance", "admin"]),
    supabase.from("fin_roles").select("user_id").eq("role", "asset_manager"),
    supabase.from("finance_alert_prefs").select("user_id").eq("email_enabled", true),
  ]);
  const mgr = new Set((roles ?? []).map((r: any) => r.user_id)), optIn = new Set((prefs ?? []).map((p: any) => p.user_id));
  return (users ?? []).filter((u: any) => u.email && u.active !== false && (u.group_key === "admin" || mgr.has(u.id)) && optIn.has(u.id)).map((u: any) => ({ id: u.id, email: u.email }));
}

// PostgREST trả tối đa 1.000 dòng mỗi lần: đọc từng trang cho tới khi hết
async function fetchAll(build: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng từ cron */ }
  const libs = { GroupCalc: g.GroupCalc, ValuationAlerts: g.ValuationAlerts, SectorMap: g.SectorMap };
  if (body && body.selftest === true) return json({ ok: true, result: selfTest(libs) });
  const dry = !!(body && body.dry === true);
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("ALERT_FROM_EMAIL") || "WorkHub <onboarding@resend.dev>";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const now = new Date(), today = vnDate(now);
    const since = new Date(now.getTime() - 6 * 366 * 86400000).toISOString().slice(0, 10);
    const histRows = await fetchAll(() => supabase.from("finance_valuation_history").select("as_of, scope, pe_median, pb_median, pe_agg, pb_agg").gte("as_of", since).order("as_of").order("scope"));
    if (!histRows.length) return json({ ok: true, history: 0, alerts: 0, notified: 0 });
    const { data: rate } = await supabase.from("finance_rates").select("yield_pct, rate_date").eq("tenor", "10Y").order("rate_date", { ascending: false }).limit(1);
    const bond = rate && rate.length ? Number(rate[0].yield_pct) : null;

    // Ngành mà nhóm đang nắm
    const { data: users, error: uErr } = await supabase.from("users").select("id, email, nickname, group_key, active").in("group_key", ["finance", "admin"]);
    if (uErr) throw new Error(uErr.message);
    const members = (users ?? []).filter((u: any) => u.active !== false).map((u: any) => ({ id: u.id, email: u.email, nickname: u.nickname ?? null }));
    let sectors: { code: string; name: string; weightPct: number }[] = [];
    if (members.length) {
      const ids = members.map((m: any) => m.id);
      const [txns, actions, prices, assets] = await Promise.all([
        fetchAll(() => supabase.from("finance_transactions").select("*").in("user_id", ids).is("deleted_at", null).order("trade_date", { ascending: true }).order("id")),
        fetchAll(() => supabase.from("finance_corporate_actions").select("*").in("user_id", ids).is("deleted_at", null).order("ex_date", { ascending: true }).order("id")),
        fetchAll(() => supabase.from("finance_holdings_price").select("user_id, symbol, market_price, price_date, updated_at").in("user_id", ids).order("user_id").order("symbol")),
        fetchAll(() => supabase.from("finance_assets").select("user_id, cash, debt, nav").in("user_id", ids).order("user_id")),
      ]);
      const syms = [...new Set((txns as any[]).map((t) => String(t.symbol).toUpperCase()))];
      const icb: Record<string, string | null> = {};
      for (let i = 0; i < syms.length; i += 200) {
        const { data, error } = await supabase.from("finance_market_snapshot").select("symbol, icb2_code").in("symbol", syms.slice(i, i + 200));
        if (error) throw new Error(error.message);
        for (const r of data ?? []) icb[r.symbol] = r.icb2_code;
      }
      sectors = sectorWeights(libs, { members, txns, actions, prices, assets }, icb);
    }

    const cur = currentAlerts(libs, histRows, sectors, bond);
    if (!cur.enough) return json({ ok: true, history: histRows.length, enough: false, alerts: 0, notified: 0 });
    const { data: stateRows, error: sErr } = await supabase.from("finance_valuation_alert_state").select("*");
    if (sErr) throw new Error(sErr.message);
    const plan = planNotify(cur.alerts, stateRows ?? [], today, now);
    if (dry) return json({ ok: true, dry: true, alerts: cur.alerts.length, wouldNotify: plan.notify.length, deactivate: plan.deactivate.length });

    // Cảnh báo MỚI chỉ được ghi nhớ khi đã gửi được ít nhất một email: chưa cấu hình email, không có người nhận hoặc gửi lỗi thì lần sau vẫn coi là mới và thử lại
    const notifyKeys = new Set(plan.notify.map((a) => a.key));
    const stamp = now.toISOString();
    const upsert = async (rows: any[]) => {
      if (!rows.length) return;
      const { error } = await supabase.from("finance_valuation_alert_state").upsert(rows.map((r) => ({ ...r, updated_at: stamp })), { onConflict: "alert_key" });
      if (error) throw new Error(error.message);
    };
    await upsert(plan.upserts.filter((r) => !notifyKeys.has(r.alert_key)));
    if (plan.deactivate.length) {
      const { error } = await supabase.from("finance_valuation_alert_state").update({ active: false, updated_at: stamp }).in("alert_key", plan.deactivate);
      if (error) throw new Error(error.message);
    }
    let sent = 0, failed = 0, recipients = 0;
    if (plan.notify.length && apiKey) {
      const rcps = await emailManagers(supabase);
      recipients = rcps.length;
      if (rcps.length) {
        const mail = buildEmail(plan.notify, cur.alerts.length, cur.asOf);
        for (const r of rcps) { (await sendEmail(apiKey, from, r.email, mail.subject, mail.html, mail.text)) ? sent++ : failed++; }
      }
    }
    if (sent > 0) await upsert(plan.upserts.filter((r) => notifyKeys.has(r.alert_key)).map((r) => ({ ...r, last_notified_at: stamp })));
    return json({ ok: true, alerts: cur.alerts.length, fresh: plan.notify.length, resolved: plan.deactivate.length, configured: !!apiKey, recipients, sent, failed });
  } catch (e) {
    console.error("valuation-watch:", String((e as Error).message || e));
    return json({ ok: false, error: "Không chấm được cảnh báo định giá." }, 500);
  }
});
