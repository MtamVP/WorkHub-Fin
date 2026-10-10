// Edge Function: sim-watch -- THEO DÕI NHẬT KÝ MÔ PHỎNG (Market Simulation đợt 4). Chạy bằng pg_cron mỗi ngày làm việc, cả khi không ai mở app:
//   1. Chấm điểm mọi lần chạy đã lưu (finance_sim_runs, 200 ngày gần nhất) với VN-Index thật từ VNDirect dchart: mốc nào đã tới, nhánh thực tế, cây sống
//      -> ghi vào cột watch (lib/sim-watch.js digest; cùng SimScore của trang, bản sao nguyên văn trong thư mục này, có test so khớp).
//   2. Lượt có {"news":true}: gom các sự kiện của bối cảnh lúc chạy còn chưa rõ, nhờ market-news-ai (chế độ signposts) đọc tin xem đã xảy ra chưa -> ghi GỢI Ý vào watch.hints.
//      AI không sửa marks của người dùng; trang hiện gợi ý kèm tin dẫn để người dùng xác nhận.
//   3. Email nhắc chủ lần chạy (đã bật email cảnh báo trong finance_alert_prefs) khi có mốc mới tới hoặc gợi ý mới; mốc chỉ được ghi "đã báo" khi gửi được,
//      người dùng không bật email hoặc chưa cấu hình Resend (khi đó trang vẫn hiện nhãn mới).
// verify_jwt = true (cron gửi Bearer = publishable key như các hàm khác). Phản hồi chỉ có SỐ LƯỢNG. {"dry":true} tính nhưng không ghi, không gửi, không gọi AI;
// {"selftest":true} chạy bài tự kiểm không đụng CSDL/mạng. Secrets: RESEND_API_KEY, ALERT_FROM_EMAIL (dùng chung với các hàm cảnh báo khác).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "./sim-score.js";
import "./sim-watch.js";

const g = globalThis as any;
const UA = { "User-Agent": "Mozilla/5.0 (compatible; WorkHubPriceSync/1.0)" };
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });

async function sendEmail(apiKey: string, from: string, to: string, subject: string, html: string, text: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.error("sim-watch: Resend HTTP", res.status);
    return res.ok;
  } catch (e) { console.error("sim-watch: gửi email lỗi:", String((e as Error).message || e)); return false; }
}

async function indexSeries(from: string): Promise<{ dates: string[]; index: number[] }> {
  const fromSec = Math.floor(Date.parse(from + "T00:00:00Z") / 1000), toSec = Math.floor(Date.now() / 1000) + 2 * 86400;
  try {
    const res = await fetch(`https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=VNINDEX&from=${fromSec}&to=${toSec}`, { headers: UA, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { dates: [], index: [] };
    return g.SimWatch.parseDchart(await res.json());
  } catch (_e) { return { dates: [], index: [] }; }
}

async function askAi(req: Request, events: any[]): Promise<{ ok: boolean; checks: any[]; model?: string; code?: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const a = req.headers.get("authorization"), k = req.headers.get("apikey");
  if (a) headers["authorization"] = a;
  if (k) headers["apikey"] = k;
  try {
    const res = await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/market-news-ai", {
      method: "POST", headers, signal: AbortSignal.timeout(110000),
      body: JSON.stringify({ mode: "signposts", events: events.map((e) => ({ id: e.id, title: e.title, signposts: e.signposts, since: e.since })) }),
    });
    const j = await res.json().catch(() => null);
    return j && j.ok && Array.isArray(j.checks) ? { ok: true, checks: j.checks, model: j.model } : { ok: false, checks: [], code: (j && j.code) || "http_" + res.status };
  } catch (_e) { return { ok: false, checks: [], code: "network" }; }
}

function selfTest() {
  const S = g.SimScore, W = g.SimWatch;
  const dates: string[] = [], index: number[] = [];
  for (let i = 0; i < 2000; i++) { dates.push(new Date(Date.UTC(2019, 0, 1) + i * 86400000).toISOString().slice(0, 10)); index.push(1000 * Math.exp(0.0002 * i + 0.01 * Math.sin(i / 7))); }
  const L = Array.from({ length: 39 }, (_v, i) => Math.round((i + 1) * 25) / 1000), grid = (s: number) => L.map((q) => (q - 0.5) * s);
  const snap = { v: 1, asOf: dates[1900], horizons: [5, 21, 63], bands: [0.02, 0.04, 0.06], levels: L, grid: { index: [grid(0.06), grid(0.12), grid(0.2)] }, branchProb: [[0.3, 0.4, 0.3], [0.3, 0.4, 0.3], [0.3, 0.4, 0.3]], tree: [], eventTrees: [], events: [{ id: "a", title: "Thử", win: 21, signposts: [] }] };
  const sc = S.scoreRun(snap, { dates, index });
  const w = W.digest(snap, {}, sc, null, "2026-01-01T00:00:00Z");
  return { due: W.newlyDue(w).map((h: any) => h.h), pending: W.pendingEvents(snap, {}, w, Date.parse("2026-01-01")).length, elapsed: w.elapsed };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng từ cron */ }
  if (body && body.selftest === true) return json({ ok: true, result: selfTest() });
  const dry = !!(body && body.dry === true), withNews = !!(body && body.news === true) && !dry;
  const S = g.SimScore, W = g.SimWatch;
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("ALERT_FROM_EMAIL") || "WorkHub <onboarding@resend.dev>";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const since = new Date(Date.now() - 200 * 86400000).toISOString();
    const { data: runs, error } = await supabase.from("finance_sim_runs").select("id, user_id, as_of, label, snapshot, marks, watch").is("deleted_at", null).gte("created_at", since).order("created_at").limit(500);
    if (error) throw new Error(error.message);
    if (!runs || !runs.length) return json({ ok: true, runs: 0 });
    const minAsOf = runs.reduce((m: string, r: any) => (r.as_of < m ? r.as_of : m), runs[0].as_of);
    const series = await indexSeries(new Date(Date.parse(minAsOf) - 2650 * 86400000).toISOString().slice(0, 10));
    if (series.index.length < 100) return json({ ok: false, error: "Không lấy được VN-Index." }, 502);
    const nowIso = new Date().toISOString();
    const state = runs.map((r: any) => {
      const sc = S.scoreRun(r.snapshot, series);
      return { r, prev: r.watch || {}, w: W.digest(r.snapshot, r.marks, sc, r.watch, nowIso) };
    });

    // Gợi ý sự kiện từ tin (một lượt AI cho mọi lần chạy)
    let asked = 0, checked = 0, aiCode: string | null = null;
    if (withNews) {
      const pend = state.flatMap((x: any) => W.pendingEvents(x.r.snapshot, x.r.marks, x.w, Date.now()));
      const merged = W.mergeEvents(pend);
      asked = merged.length;
      if (merged.length) {
        const ai = await askAi(req, merged);
        if (ai.ok) { checked = ai.checks.length; state.forEach((x: any) => { x.w = W.applyChecks(x.r.snapshot, x.w, merged, ai.checks, nowIso, ai.model); }); } else aiCode = ai.code || "error";
      }
    }
    if (dry) return json({ ok: true, dry: true, runs: runs.length, due: state.reduce((s: number, x: any) => s + W.newlyDue(x.w).length, 0) });

    // Email cho từng chủ lần chạy đã bật email
    const owners = [...new Set(state.map((x: any) => x.r.user_id))];
    const [{ data: users }, { data: prefs }] = await Promise.all([
      supabase.from("users").select("id, email, active").in("id", owners),
      supabase.from("finance_alert_prefs").select("user_id").eq("email_enabled", true).in("user_id", owners),
    ]);
    const optIn = new Set((prefs ?? []).map((p: any) => p.user_id)), emailOf: Record<string, string> = {};
    (users ?? []).forEach((u: any) => { if (u.email && u.active !== false) emailOf[u.id] = u.email; });
    let sent = 0, failed = 0;
    for (const uid of owners) {
      const mine = state.filter((x: any) => x.r.user_id === uid);
      const items = mine.map((x: any) => ({
        label: x.r.label, asOf: x.r.as_of, due: W.newlyDue(x.w),
        events: W.freshHappened(x.prev.hints, x.w.hints).map((id: string) => { const e = (x.r.snapshot.events || []).find((v: any) => v.id === id) || {}; return { title: e.title || id, status: x.w.hints[id].status, refs: x.w.hints[id].refs }; })
          .filter((e: any, i: number, arr: any[]) => arr.findIndex((v) => v.title === e.title) === i),
      })).filter((it: any) => it.due.length || it.events.length);
      if (!items.length) continue;
      let ok = true;
      if (apiKey && optIn.has(uid) && emailOf[uid]) {
        const mail = W.buildEmail(items);
        ok = await sendEmail(apiKey, from, emailOf[uid], mail.subject, mail.html, mail.text);
        ok ? sent++ : failed++;
      }
      // gửi lỗi thì lần sau thử lại: giữ nguyên danh sách đã báo và gợi ý cũ cho phần "mới"
      if (ok) mine.forEach((x: any) => { x.w.notified = [...new Set([...x.w.notified, ...W.newlyDue(x.w).map((h: any) => h.h)])]; });
      else mine.forEach((x: any) => { x.retryHints = true; });
    }
    let written = 0;
    for (const x of state) {
      const w = x.retryHints ? W.revertFresh(x.prev.hints, x.w) : x.w;
      const { error: uErr } = await supabase.from("finance_sim_runs").update({ watch: w, watched_at: nowIso }).eq("id", x.r.id);
      if (uErr) console.error("sim-watch: ghi lỗi", uErr.message); else written++;
    }
    return json({ ok: true, runs: runs.length, written, due: state.reduce((s: number, x: any) => s + W.newlyDue(x.w).length, 0), asked, checked, aiError: aiCode, configured: !!apiKey, sent, failed });
  } catch (e) {
    console.error("sim-watch:", String((e as Error).message || e));
    return json({ ok: false, error: "Không theo dõi được nhật ký mô phỏng." }, 500);
  }
});
