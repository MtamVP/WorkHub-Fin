// Edge Function: insight-sync -- bốn việc định kỳ của khu Insight (chỉ ĐỌC từ nguồn công khai, ghi vào cơ sở dữ liệu bằng service role):
//   mode "news"      (pg_cron mỗi 3 giờ): đọc RSS các báo (cùng nguồn với market-news), gắn mã cổ phiếu có trong tiêu đề, LƯU vào finance_pit_news (kho theo thời điểm; không trùng, giữ lúc thấy đầu tiên).
//   mode "ownership" (pg_cron 19:15 VN ngày làm việc, hoặc gọi từ app kèm body.symbols <= 10 mã): cổ đông lớn và giao dịch nội bộ từ Vietcap iq-insight cho các mã đang giữ / theo dõi / có ý tưởng mở
//                    -> finance_shareholders, finance_insider_trades, finance_ownership_sync. Gọi từ app thì bỏ qua mã vừa đồng bộ trong 60 phút (chống lạm dụng).
//   mode "thesis"    (pg_cron 19:35 VN ngày làm việc): kiểm mọi điều kiện luận điểm của ý tưởng đang mở (lib/thesis-calc.js, cùng bản với trang), ghi trạng thái và nhật ký chuyển trạng thái,
//                    email cho chủ ý tưởng (đã bật email cảnh báo) khi một điều kiện QUAN TRỌNG bị phá vỡ; chỉ báo một lần cho mỗi lần sai.
//   mode "events"    (chạy tay, hoặc tự chạy sau mode news): trích SỰ KIỆN (lợi nhuận, cổ tức, giải chấp, đình chỉ, giao dịch nội bộ...) từ tiêu đề các tin đã gắn mã (lib/news-events.js) -> finance_news_events;
//                    chạy tay thì quét lại tin 120 ngày gần nhất (sửa luật xong chạy lại; id cố định nên không nhân đôi).
//   mode "digest"    (pg_cron 08:30 VN ngày làm việc): HỘP VIỆC CẦN LÀM -- gom luận điểm bị phá, tin xấu nghiêm trọng của mã đang nắm / theo dõi, nội bộ mua bán đồng loạt, vượt giới hạn, lệnh chờ duyệt, lỗi dữ liệu và hàm
//                    (lib/action-inbox.js, cùng bản với trang) rồi email cho người đã bật email cảnh báo, CHỈ khi có mục MỚI mức nghiêm trọng / cao so với email trước (finance_digest_state); không gửi email chỉ có việc mức vừa.
//   mode "pit"       : chạy tay hàm chụp kho dữ liệu theo thời điểm (fn_pit_capture; cron SQL 19:05 VN đã tự chạy hằng ngày).
// Nguồn không có cam kết dịch vụ: lỗi một mã / một báo không làm hỏng phần còn lại; mỗi lần chạy ghi finance_function_runs (app cảnh báo khi hàm quá hạn). Phản hồi chỉ có SỐ LƯỢNG.
// verify_jwt = true. {"selftest":true} chạy không đụng mạng / CSDL. {"mode":"thesis","dry":true} tính nhưng không ghi, không gửi email.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "./thesis-calc.js";
import "./ownership-calc.js";
import "./news-events.js";
import "./action-inbox.js";
import { FEEDS, merge, parseRss, type NewsItem } from "./news-parse.ts";
import { evaluateAll, eventRows, heldByUser, inboxForUser, insiderRows, newsRows, shareholderRows, tagSymbols, thesisEmail, trackedSymbols } from "./logic.ts";
import { cronGuard } from "./cron-guard.ts";

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
  // sự kiện của các tin vừa đọc (tin đã có thì id sự kiện trùng, bỏ qua); lỗi phần này không làm hỏng việc lưu tin
  let events = 0;
  try { events = await storeEvents(supabase, eventRows(rows.filter((r) => r.symbols.length))); } catch (e) { console.error("insight-sync: ghi sự kiện lỗi", String((e as Error).message || e)); }
  return { ok: okFeeds > 0, feeds: FEEDS.length, feedsOk: okFeeds, items: items.length, tagged: rows.filter((r) => r.symbols.length).length, submitted: stored, events };
}

// ---------- events ----------
async function storeEvents(supabase: any, rows: any[]): Promise<number> {
  let n = 0;
  for (const part of chunk(rows, 200)) {
    const { error } = await supabase.from("finance_news_events").upsert(part, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error(error.message); n += part.length;
  }
  return n;
}
// Quét lại các tin đã lưu (luật mới / lần đầu): mọi tin có mã trong `days` ngày gần nhất
async function runEvents(supabase: any, days: number) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const news: any[] = [];
  for (let from = 0; from < 5000; from += 1000) {
    const { data, error } = await supabase.from("finance_pit_news").select("id, title, summary, symbols, published_at, link, source").gte("first_seen", since).order("first_seen", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(error.message);
    news.push(...(data ?? []).filter((r: any) => r.symbols && r.symbols.length));
    if (!data || data.length < 1000) break;
  }
  const rows = eventRows(news);
  const stored = await storeEvents(supabase, rows);
  const byType: Record<string, number> = {}; rows.forEach((r) => { byType[r.event_type] = (byType[r.event_type] ?? 0) + 1; });
  return { ok: true, news: news.length, events: stored, byType };
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
  const [snapRes, ratioRes, insRes, syncRes, evRes, newsRes] = await Promise.all([
    supabase.from("finance_market_snapshot").select("symbol, metrics").in("symbol", symbols),
    supabase.from("finance_stock_ratios").select("symbol, metrics").in("symbol", symbols),
    supabase.from("finance_insider_trades").select("id, symbol, trader, action, status, shares_before, shares_after, registered, acquired, start_date, end_date, public_date").in("symbol", symbols).gte("public_date", new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10)),
    supabase.from("finance_ownership_sync").select("symbol").eq("ok", true).in("symbol", symbols),
    supabase.from("finance_news_events").select("symbol, event_type, direction, severity, published_at").in("symbol", symbols).gte("published_at", new Date(Date.now() - 100 * 86400000).toISOString()).limit(5000),
    supabase.from("finance_pit_news").select("id", { count: "exact", head: true }).gte("first_seen", new Date(Date.now() - 48 * 3600000).toISOString()),
  ]);
  const snapshots: Record<string, any> = {}, ratios: Record<string, any> = {}, insider: Record<string, any[]> = {};
  (snapRes.data ?? []).forEach((r: any) => { snapshots[r.symbol] = r.metrics; });
  (ratioRes.data ?? []).forEach((r: any) => { ratios[r.symbol] = r.metrics; });
  (insRes.data ?? []).forEach((r: any) => { (insider[r.symbol] = insider[r.symbol] || []).push(r); });
  const synced = new Set((syncRes.data ?? []).map((r: any) => r.symbol));
  const nowIso = new Date().toISOString();
  const evBySymbol: Record<string, any[]> = {};
  (evRes.data ?? []).forEach((e: any) => { (evBySymbol[e.symbol] = evBySymbol[e.symbol] || []).push(e); });
  const r = evaluateAll(ideas, conds, snapshots, ratios, insider, synced, nowIso.slice(0, 10), nowIso, { ready: !evRes.error && (newsRes.count ?? 0) > 0, bySymbol: evBySymbol });
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

// ---------- digest ----------
async function fetchPages(build: () => any, cap = 20000): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function runDigest(supabase: any, dry: boolean) {
  const AI = g.ActionInbox;
  const nowIso = new Date().toISOString(), since3 = new Date(Date.now() - 3 * 86400000).toISOString(), since36h = new Date(Date.now() - 36 * 3600000).toISOString();
  const since2d = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10), since100 = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
  const [{ data: users }, { data: prefs }, { data: mgrs }] = await Promise.all([
    supabase.from("users").select("id, email, nickname, group_key, active").in("group_key", ["finance", "admin"]),
    supabase.from("finance_alert_prefs").select("user_id").eq("email_enabled", true),
    supabase.from("fin_roles").select("user_id").eq("role", "asset_manager"),
  ]);
  const optIn = new Set((prefs ?? []).map((p: any) => p.user_id)), mgrSet = new Set((mgrs ?? []).map((p: any) => p.user_id));
  const targets = (users ?? []).filter((u: any) => u.active !== false && u.email && optIn.has(u.id)).map((u: any) => ({ id: u.id as string, email: u.email as string, nickname: u.nickname ?? null, manager: mgrSet.has(u.id) || u.group_key === "admin" }));
  if (!targets.length) return { ok: true, recipients: 0, sent: 0, note: "Chưa ai bật email cảnh báo." };
  const ids = targets.map((t) => t.id);
  const [txns, watch, ideas, events, compliance, approvals, health, runs, state] = await Promise.all([
    fetchPages(() => supabase.from("finance_transactions").select("user_id, symbol, type, quantity").in("user_id", ids).is("deleted_at", null).order("id")),
    fetchPages(() => supabase.from("finance_watchlist").select("user_id, symbol").in("user_id", ids).order("id")),
    fetchPages(() => supabase.from("finance_ideas").select("id, user_id, symbol, title").in("user_id", ids).in("status", OPEN_STATUSES).order("id")),
    fetchPages(() => supabase.from("finance_news_events").select("news_id, symbol, event_type, direction, severity, published_at, title, link").gte("published_at", since3).in("severity", ["alert", "watch"]).order("published_at", { ascending: false })),
    fetchPages(() => supabase.from("finance_compliance_log").select("log_date, user_id, breaches, warns").gte("log_date", since2d).order("log_date", { ascending: false })),
    fetchPages(() => supabase.from("finance_order_requests").select("id, symbol, side, created_by, created_at").eq("status", "pending").order("created_at")),
    fetchPages(() => supabase.from("finance_data_health").select("kind, symbol, severity, ref_date, dedupe_key, detail").eq("resolved", false).in("severity", ["warn", "error"]).gte("detected_at", since3)),
    fetchPages(() => supabase.from("finance_function_runs").select("fn, mode, ok, run_at").eq("ok", false).gte("run_at", since36h)),
    fetchPages(() => supabase.from("finance_digest_state").select("user_id, item_ids, sent_at").in("user_id", ids)),
  ]);
  // mỗi người / nhóm chỉ lấy bản tuân thủ MỚI NHẤT
  const latestLog = new Map<string, any>(); compliance.forEach((r: any) => { const k = r.user_id ?? "group"; if (!latestLog.has(k)) latestLog.set(k, r); });
  const heldMap = heldByUser(txns), watchMap = new Map<string, Set<string>>();
  watch.forEach((w: any) => { const s = watchMap.get(w.user_id) ?? new Set<string>(); s.add(String(w.symbol).toUpperCase()); watchMap.set(w.user_id, s); });
  const tracked = new Set<string>(); heldMap.forEach((s) => s.forEach((x) => tracked.add(x))); watchMap.forEach((s) => s.forEach((x) => tracked.add(x))); ideas.forEach((i: any) => tracked.add(String(i.symbol).toUpperCase()));
  const trades: any[] = [];
  for (const part of chunk([...tracked].slice(0, 300), 60)) { const { data } = await supabase.from("finance_insider_trades").select("id, symbol, trader, action, status, shares_before, shares_after, registered, acquired, start_date, end_date, public_date").in("symbol", part).gte("public_date", since100).limit(5000); trades.push(...(data ?? [])); }
  const insiderBySymbol = new Map<string, any[]>(); trades.forEach((t) => { const a = insiderBySymbol.get(t.symbol) ?? []; a.push(t); insiderBySymbol.set(t.symbol, a); });
  const conds = ideas.length ? await fetchPages(() => supabase.from("finance_thesis_conditions").select("idea_id, metric, op, threshold, severity, label, last_state, state_since").in("idea_id", ideas.map((i: any) => i.id)).order("id")) : [];
  const nameOf = new Map<string, string>((users ?? []).map((u: any) => [u.id, u.nickname || String(u.email || "").split("@")[0]]));
  const data = {
    heldByUser: heldMap, watchByUser: watchMap, ideas, conds, events, insiderBySymbol, compliance: [...latestLog.values()],
    approvals: approvals.map((a: any) => ({ id: a.id, symbol: a.symbol, side: a.side, requester: nameOf.get(a.created_by) ?? null, created_at: a.created_at })),
    health: health.map((h: any) => ({ kind: h.kind, severity: h.severity, symbol: h.symbol, ref_date: h.ref_date, dedupe_key: h.dedupe_key, label: h.kind })),
    runs,
  };
  const prev = new Map<string, string[]>(state.map((s: any) => [s.user_id, s.item_ids ?? []]));
  const apiKey = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("ALERT_FROM_EMAIL") || "WorkHub <onboarding@resend.dev>";
  let sent = 0, failed = 0, skipped = 0, withItems = 0;
  for (const u of targets) {
    const items = inboxForUser(data, u, nowIso), list = items.filter((x: any) => x.sev <= 3);
    if (list.length) withItems++;
    const fresh = AI.fresh(list, prev.get(u.id) ?? []), urgentNew = fresh.some((x: any) => x.sev <= 2);
    if (!urgentNew) { skipped++; continue; }
    if (dry) { sent++; continue; }
    if (!apiKey) { failed++; continue; }
    const mail = AI.digest(list, { newIds: fresh.map((x: any) => x.id) });
    const ok = await sendEmail(apiKey, from, u.email, mail.subject, mail.html, mail.text);
    if (ok) { sent++; await supabase.from("finance_digest_state").upsert({ user_id: u.id, item_ids: list.map((x: any) => x.id), sent_at: nowIso }, { onConflict: "user_id" }); } else failed++;
  }
  return { ok: true, recipients: targets.length, withItems, sent, failed, skipped, configured: !!apiKey, dry: dry || undefined };
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
  // Chốt chặn: chỉ lịch hệ thống (x-cron-secret) hoặc người dùng đăng nhập được gọi (xem cron-guard.ts, finance-cron-secret-migration.sql)
  { const blocked = await cronGuard(req, { fn: "insight-sync", allowUser: !!(body && body.mode === "ownership" && Array.isArray(body.symbols)) }); if (blocked) return blocked; }
  const mode = String(body?.mode || "");
  if (!["news", "ownership", "thesis", "events", "digest", "pit"].includes(mode)) return json({ ok: false, error: "mode không hợp lệ" }, 400);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const t0 = Date.now();
  let result: any, ok = true;
  try {
    if (mode === "news") result = await runNews(supabase);
    else if (mode === "ownership") result = await runOwnership(supabase, body.symbols);
    else if (mode === "thesis") result = await runThesis(supabase, !!body.dry);
    else if (mode === "digest") result = await runDigest(supabase, !!body.dry);
    else if (mode === "events") result = await runEvents(supabase, Math.min(Math.max(Number(body.days) || 120, 1), 400));
    else { const { data, error } = await supabase.rpc("fn_pit_capture"); if (error) throw new Error(error.message); result = data; }
    ok = result?.ok !== false;
  } catch (e) {
    console.error("insight-sync", mode, String((e as Error).message || e));
    ok = false; result = { ok: false, error: "Không chạy được." };
  }
  if (!body.dry && mode !== "pit") await supabase.from("finance_function_runs").insert({ fn: "insight-sync", mode, ok, duration_ms: Date.now() - t0, detail: result }).then(() => {}, () => {});
  return json(result, ok ? 200 : 502);
});
