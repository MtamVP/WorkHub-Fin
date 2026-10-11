// Edge Function: insight-sync -- bốn việc định kỳ của khu Insight (chỉ ĐỌC từ nguồn công khai, ghi vào cơ sở dữ liệu bằng service role):
//   mode "news"      (pg_cron mỗi 3 giờ): đọc RSS các báo (cùng nguồn với market-news), gắn mã cổ phiếu có trong tiêu đề, LƯU vào finance_pit_news (kho theo thời điểm; không trùng, giữ lúc thấy đầu tiên).
//   mode "ownership" (pg_cron 19:15 VN ngày làm việc, hoặc gọi từ app kèm body.symbols <= 10 mã): cổ đông lớn và giao dịch nội bộ từ Vietcap iq-insight cho các mã đang giữ / theo dõi / có ý tưởng mở
//                    -> finance_shareholders, finance_insider_trades, finance_ownership_sync. Gọi từ app thì bỏ qua mã vừa đồng bộ trong 60 phút (chống lạm dụng).
//   mode "thesis"    (pg_cron 19:35 VN ngày làm việc): kiểm mọi điều kiện luận điểm của ý tưởng đang mở (lib/thesis-calc.js, cùng bản với trang), ghi trạng thái và nhật ký chuyển trạng thái,
//                    email cho chủ ý tưởng (đã bật email cảnh báo) khi một điều kiện QUAN TRỌNG bị phá vỡ; chỉ báo một lần cho mỗi lần sai.
//   mode "pit"       : chạy tay hàm chụp kho dữ liệu theo thời điểm (fn_pit_capture; cron SQL 19:05 VN đã tự chạy hằng ngày).
// Nguồn không có cam kết dịch vụ: lỗi một mã / một báo không làm hỏng phần còn lại; mỗi lần chạy ghi finance_function_runs (app cảnh báo khi hàm quá hạn). Phản hồi chỉ có SỐ LƯỢNG.
// verify_jwt = true. {"selftest":true} chạy không đụng mạng / CSDL. {"mode":"thesis","dry":true} tính nhưng không ghi, không gửi email.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "./thesis-calc.js";
import "./ownership-calc.js";
import { FEEDS, merge, parseRss, type NewsItem } from "./news-parse.ts";
import { evaluateAll, insiderRows, newsRows, shareholderRows, tagSymbols, thesisEmail, trackedSymbols } from "./logic.ts";

const g = globalThis as any;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
const UA = { "User-Agent": "Mozilla/5.0 (compatible; WorkHubInsight/1.0)" };
const VCI = "https://iq.vietcap.com.vn/api/iq-insight-service/v1";
const VCI_HEADERS = { ...UA, "Accept": "application/json", "Origin": "https://trading.vietcap.com.vn", "Referer": "https://trading.vietcap.com.vn/" };
const OPEN_STATUSES = ["idea", "research", "review", "approved", "in_portfolio"];

async function getJson(url: string, headers: Record<string, string>, ms = 15000): Promise<any | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    const j = await res.json();
    return j && (j.successful === false || (j.status && Number(j.status) >= 400)) ? null : j;
  } catch (_e) { return null; }
}
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
async function sendEmail(apiKey: string, from: string, to: string, subject: string, html: string, text: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, html, text }), signal: AbortSignal.timeout(15000) });
    if (!res.ok) console.error("insight-sync: Resend HTTP", res.status);
    return res.ok;
  } catch (e) { console.error("insight-sync: gửi email lỗi:", String((e as Error).message || e)); return false; }
}
const chunk = <T,>(a: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

async function listedSymbols(supabase: any): Promise<Set<string>> {
  const { data } = await supabase.from("finance_market_snapshot").select("symbol").limit(4000);
  return new Set((data ?? []).map((r: any) => String(r.symbol).toUpperCase()));
}

// ---------- news ----------
async function runNews(supabase: any) {
  const now = Date.now();
  const lists: NewsItem[][] = await Promise.all(FEEDS.map(async (f) => {
    try {
      const res = await fetch(f.url, { headers: { ...UA, "Accept": "application/rss+xml, application/xml, text/xml, */*" }, redirect: "follow", signal: AbortSignal.timeout(9000) });
      if (!res.ok) return [];
      const xml = await res.text();
      return xml.length > 1_500_000 ? [] : parseRss(xml, f, now);
    } catch (_e) { return []; }
  }));
  const okFeeds = lists.filter((l) => l.length).length;
  const items = merge(lists, 200);
  const rows = newsRows(items, await listedSymbols(supabase));
  let stored = 0;
  for (const part of chunk(rows, 100)) {
    const { error } = await supabase.from("finance_pit_news").upsert(part, { onConflict: "id", ignoreDuplicates: true });
    if (error) console.error("insight-sync: ghi tin lỗi", error.message); else stored += part.length;
  }
  return { ok: okFeeds > 0, feeds: FEEDS.length, feedsOk: okFeeds, items: items.length, tagged: rows.filter((r) => r.symbols.length).length, submitted: stored };
}

// ---------- ownership ----------
async function trackedFromDb(supabase: any): Promise<string[]> {
  const [tx, wl, ideas] = await Promise.all([
    supabase.from("finance_transactions").select("symbol").is("deleted_at", null).limit(5000),
    supabase.from("finance_watchlist").select("symbol").limit(2000),
    supabase.from("finance_ideas").select("symbol").in("status", OPEN_STATUSES).limit(1000),
  ]);
  const col = (r: any) => (r.data ?? []).map((x: any) => x.symbol);
  return trackedSymbols([col(tx), col(wl), col(ideas)], 120);
}
async function runOwnership(supabase: any, bodySymbols: unknown) {
  const O = g.OwnershipCalc;
  const asked = Array.isArray(bodySymbols) ? trackedSymbols([bodySymbols as string[]], 10) : null;
  let symbols = asked ?? await trackedFromDb(supabase);
  let skipped = 0;
  if (asked) {
    const { data } = await supabase.from("finance_ownership_sync").select("symbol, synced_at, ok").in("symbol", symbols);
    const fresh = new Set((data ?? []).filter((r: any) => r.ok && Date.now() - Date.parse(r.synced_at) < 60 * 60000).map((r: any) => r.symbol));
    skipped = symbols.filter((s) => fresh.has(s)).length; symbols = symbols.filter((s) => !fresh.has(s));
  }
  const started = new Date().toISOString();
  const results = await pool(symbols, 4, async (sym) => {
    const [sh, ins] = await Promise.all([getJson(`${VCI}/company/${sym}/shareholder`, VCI_HEADERS), getJson(`${VCI}/company/${sym}/insider-transaction?page=0&size=100`, VCI_HEADERS)]);
    if (!sh && !ins) return { sym, ok: false, holders: 0, trades: 0, note: "Nguồn không trả dữ liệu" };
    const holders = sh ? O.parseShareholders(sh, sym) : [], trades = ins ? O.parseInsider(ins).filter((t: any) => t.symbol === sym) : [];
    try {
      if (holders.length) {
        const { error } = await supabase.from("finance_shareholders").upsert(shareholderRows(holders), { onConflict: "symbol,owner_key" });
        if (error) throw new Error(error.message);
        await supabase.from("finance_shareholders").delete().eq("symbol", sym).lt("updated_at", started);        // người không còn trong danh sách mới
      }
      if (trades.length) {
        const { error } = await supabase.from("finance_insider_trades").upsert(insiderRows(trades), { onConflict: "id" });
        if (error) throw new Error(error.message);
      }
    } catch (e) { return { sym, ok: false, holders: holders.length, trades: trades.length, note: String((e as Error).message || e).slice(0, 120) }; }
    return { sym, ok: true, holders: holders.length, trades: trades.length, note: sh && ins ? null : "Chỉ lấy được một phần" };
  });
  if (results.length) await supabase.from("finance_ownership_sync").upsert(results.map((r) => ({ symbol: r.sym, synced_at: new Date().toISOString(), ok: r.ok, holders: r.holders, trades: r.trades, note: r.note })), { onConflict: "symbol" });
  return { ok: results.length === 0 || results.some((r) => r.ok), symbols: symbols.length, skipped: skipped, synced: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, holders: results.reduce((s, r) => s + r.holders, 0), trades: results.reduce((s, r) => s + r.trades, 0) };
}

// ---------- thesis ----------
async function runThesis(supabase: any, dry: boolean) {
  const { data: conds, error } = await supabase.from("finance_thesis_conditions").select("id, idea_id, metric, op, threshold, severity, label, manual_met, last_state, state_since, notified_state").limit(5000);
  if (error) throw new Error(error.message);
  if (!conds || !conds.length) return { ok: true, conditions: 0 };
  const ideaIds = [...new Set(conds.map((c: any) => c.idea_id))] as string[];
  const ideas: any[] = [];
  for (const part of chunk(ideaIds, 100)) {
    const { data } = await supabase.from("finance_ideas").select("id, user_id, symbol, title, target_price").in("id", part).in("status", OPEN_STATUSES);
    ideas.push(...(data ?? []));
  }
  const symbols = [...new Set(ideas.map((i) => String(i.symbol).toUpperCase()))];
  const [snapRes, ratioRes, insRes, syncRes] = await Promise.all([
    supabase.from("finance_market_snapshot").select("symbol, metrics").in("symbol", symbols),
    supabase.from("finance_stock_ratios").select("symbol, metrics").in("symbol", symbols),
    supabase.from("finance_insider_trades").select("id, symbol, trader, action, status, shares_before, shares_after, registered, acquired, start_date, end_date, public_date").in("symbol", symbols).gte("public_date", new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10)),
    supabase.from("finance_ownership_sync").select("symbol").eq("ok", true).in("symbol", symbols),
  ]);
  const snapshots: Record<string, any> = {}, ratios: Record<string, any> = {}, insider: Record<string, any[]> = {};
  (snapRes.data ?? []).forEach((r: any) => { snapshots[r.symbol] = r.metrics; });
  (ratioRes.data ?? []).forEach((r: any) => { ratios[r.symbol] = r.metrics; });
  (insRes.data ?? []).forEach((r: any) => { (insider[r.symbol] = insider[r.symbol] || []).push(r); });
  const synced = new Set((syncRes.data ?? []).map((r: any) => r.symbol));
  const nowIso = new Date().toISOString();
  const r = evaluateAll(ideas, conds, snapshots, ratios, insider, synced, nowIso.slice(0, 10), nowIso);
  const stats = { ok: true, conditions: conds.length, ideas: r.ideas.length, broken: r.ideas.filter((x) => x.status === "broken").length, warning: r.ideas.filter((x) => x.status === "warning").length, changes: r.logs.length, alerts: r.alerts.length };
  if (dry) return Object.assign({ dry: true }, stats);
  for (const part of chunk(r.updates, 20)) await Promise.all(part.map((u) => supabase.from("finance_thesis_conditions").update(u.patch).eq("id", u.id)));
  if (r.logs.length) { const { error: lErr } = await supabase.from("finance_thesis_log").insert(r.logs); if (lErr) console.error("insight-sync: ghi nhật ký lỗi", lErr.message); }

  // Email cho chủ ý tưởng đã bật email cảnh báo. Gửi lỗi thì KHÔNG đánh dấu đã báo (lần sau thử lại).
  let sent = 0, failed = 0;
  if (r.alerts.length) {
    const apiKey = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("ALERT_FROM_EMAIL") || "WorkHub <onboarding@resend.dev>";
    const owners = [...new Set(r.alerts.map((a: any) => a.userId))] as string[];
    const [{ data: users }, { data: prefs }] = await Promise.all([supabase.from("users").select("id, email, active").in("id", owners), supabase.from("finance_alert_prefs").select("user_id").eq("email_enabled", true).in("user_id", owners)]);
    const optIn = new Set((prefs ?? []).map((p: any) => p.user_id)), emailOf: Record<string, string> = {};
    (users ?? []).forEach((u: any) => { if (u.email && u.active !== false) emailOf[u.id] = u.email; });
    const handled: string[] = [];
    for (const uid of owners) {
      const mine = r.alerts.filter((a: any) => a.userId === uid);
      let ok = true;
      if (apiKey && optIn.has(uid) && emailOf[uid]) { const mail = thesisEmail(mine); ok = await sendEmail(apiKey, from, emailOf[uid], mail.subject, mail.html, mail.text); ok ? sent++ : failed++; }
      if (ok) handled.push(...mine.map((a: any) => a.condId));
    }
    for (const part of chunk(handled, 50)) await supabase.from("finance_thesis_conditions").update({ notified_state: "fail" }).in("id", part);
  }
  return Object.assign(stats, { configured: !!Deno.env.get("RESEND_API_KEY"), sent, failed });
}

// ---------- tự kiểm ----------
function selfTest() {
  const O = g.OwnershipCalc, T = g.ThesisCalc;
  const insider = O.parseInsider({ data: { content: [{ id: "a", ticker: "AAA", actionTypeCode: "B", publicDate: "2026-09-01T00:00:00", tradeStatusEn: "Done", shareAcquire: 1000, traderNameVi: "X" }] } });
  const ev = T.evaluateIdea([{ id: "c", metric: "roae", op: ">=", threshold: 15, severity: "critical" }], { metrics: { roae: 0.1 } });
  const r = evaluateAll([{ id: "i", user_id: "u", symbol: "AAA", title: "t" }], [{ id: "c", idea_id: "i", metric: "roae", op: ">=", threshold: 15, severity: "critical", label: null, manual_met: null, last_state: "ok", state_since: null, notified_state: null }],
    { AAA: { roae: 0.1, marketcap: 1e12, shares: 1e7 } }, {}, {}, new Set(), "2026-10-11", "2026-10-11T00:00:00Z");
  return { tag: tagSymbols("FPT và HPG tăng, GDP quý III", new Set(["FPT", "HPG", "GDP"])).join(","), insiderNet: O.summarize(insider, "2026-10-01", 90).netQty, status: ev.status, alerts: r.alerts.length, logs: r.logs.length, patchState: r.updates[0].patch.last_state };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng */ }
  if (body && body.selftest === true) return json({ ok: true, result: selfTest() });
  const mode = String(body?.mode || "");
  if (!["news", "ownership", "thesis", "pit"].includes(mode)) return json({ ok: false, error: "mode không hợp lệ" }, 400);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const t0 = Date.now();
  let result: any, ok = true;
  try {
    if (mode === "news") result = await runNews(supabase);
    else if (mode === "ownership") result = await runOwnership(supabase, body.symbols);
    else if (mode === "thesis") result = await runThesis(supabase, !!body.dry);
    else { const { data, error } = await supabase.rpc("fn_pit_capture"); if (error) throw new Error(error.message); result = data; }
    ok = result?.ok !== false;
  } catch (e) {
    console.error("insight-sync", mode, String((e as Error).message || e));
    ok = false; result = { ok: false, error: "Không chạy được." };
  }
  if (!body.dry && mode !== "pit") await supabase.from("finance_function_runs").insert({ fn: "insight-sync", mode, ok, duration_ms: Date.now() - t0, detail: result }).then(() => {}, () => {});
  return json(result, ok ? 200 : 502);
});
