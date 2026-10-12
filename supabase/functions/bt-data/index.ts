// Edge Function: bt-data -- kho dữ liệu cho KIỂM THỬ CHIẾN LƯỢC (Insight > Kiểm thử). Chỉ ĐỌC nguồn công khai (VNDirect), ghi vào cơ sở dữ liệu bằng service role. Các chế độ (body {"mode": ...}):
//   "fill"    (pg_cron 19:30 VN ngày làm việc; chạy tay để dựng lại quá khứ): lấy giá TOÀN THỊ TRƯỜNG của từng ngày giao dịch còn thiếu (VNDirect finfo stock_prices?q=date:D, một lần gọi cho cả thị trường)
//             -> finance_price_days; làm mới các chuỗi chỉ số (dchart) -> finance_bt_index. body.limit (mặc định 30, tối đa 200) = số ngày tối đa mỗi lần; mới nhất trước.
//             body.refillBefore = "ISO": ghi đè các ngày đã lưu trước thời điểm đó (dùng sau khi sửa cách đọc dữ liệu; upsert, không xoá).
//   "factors" (chạy tay một lần cho quá khứ): dựng NGƯỢC bảng số liệu theo thời điểm (P/E, P/B, ROE, tăng trưởng...) cho các ngày cuối tháng từ 12/2020 vào finance_pit_market_daily (source = 'backfill').
//             P/E, P/B, vốn hoá là chỉ số TÍNH THEO NGÀY của VNDirect (đã đo: số EPS ngầm đổi đúng ngày công bố báo cáo, không phải ngày cuối quý); chỉ số theo quý chỉ lấy quý đã qua hạn công bố bảo thủ (+45 ngày, quý 4 +90 ngày).
//             body.dates = ["YYYY-MM-DD"...] (tối đa 8) hoặc để trống để tự chọn các cuối tháng còn thiếu.
//   "status"  : số ngày đã có, ngày đầu / cuối, số ngày còn thiếu so với lịch VN-Index.
// Nguồn không có cam kết dịch vụ: ngày nào nguồn trả quá ít mã thì KHÔNG lưu (lần sau tự thử lại). Mỗi lần chạy ghi finance_function_runs. Phản hồi chỉ có số liệu tổng, không lộ khoá.
// verify_jwt = true. {"selftest":true} chạy không đụng mạng / CSDL.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { BACKFILL_DAILY, BACKFILL_QUARTER, DAY0, INDEX_CODES, MIN_STOCKS_PER_DAY, buildPitDay, missingDays, monthEndTradingDays, parseDay, parseIndex, quarterWindow } from "./bt-logic.ts";
import { cronGuard } from "./cron-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
const UA = { "User-Agent": "Mozilla/5.0 (compatible; WorkHubBacktest/1.0)" };      // dchart trả 406 nếu gửi Accept: application/json -> chỉ gửi User-Agent
const FINFO = "https://api-finfo.vndirect.com.vn/v4";
const BUDGET_MS = 115000;

async function getJson(url: string, ms = 25000): Promise<any | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
      if (res.ok) { const text = await res.text(); return text ? JSON.parse(text) : null; }
    } catch (_e) { /* thử lại một lần */ }
  }
  return null;
}
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
const todayVn = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

// ---------- chuỗi chỉ số ----------
async function refreshIndexes(supabase: any, force: boolean): Promise<{ ok: boolean; updated: number; failed: string[]; last: string | null }> {
  const { data: have } = await supabase.from("finance_bt_index").select("symbol, fetched_at, last_date");
  const fresh = new Map<string, number>((have ?? []).map((r: any) => [r.symbol, Date.parse(r.fetched_at)]));
  const todo = INDEX_CODES.filter((c) => force || !fresh.has(c) || Date.now() - (fresh.get(c) ?? 0) > 30 * 60000);
  const failed: string[] = []; let updated = 0, last: string | null = null;
  const from = Math.floor(Date.parse(DAY0 + "T00:00:00Z") / 1000) - 5 * 86400, to = Math.floor(Date.now() / 1000) + 86400;
  await pool(todo, 4, async (code) => {
    const idx = parseIndex(await getJson(`https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=${code}&from=${from}&to=${to}`));
    if (idx.d.length < 100) { failed.push(code); return; }
    const { error } = await supabase.from("finance_bt_index").upsert({ symbol: code, first_date: idx.d[0], last_date: idx.d[idx.d.length - 1], data: idx, fetched_at: new Date().toISOString() }, { onConflict: "symbol" });
    if (error) { failed.push(code); return; }
    updated++; if (code === "VNINDEX") last = idx.d[idx.d.length - 1];
  });
  return { ok: !failed.includes("VNINDEX"), updated, failed, last };
}
async function tradingDays(supabase: any): Promise<string[]> {
  const { data } = await supabase.from("finance_bt_index").select("data").eq("symbol", "VNINDEX").maybeSingle();
  const d: string[] = data && data.data && Array.isArray(data.data.d) ? data.data.d : [];
  return d.filter((x) => x >= DAY0);
}
async function haveDays(supabase: any): Promise<Set<string>> {
  const out = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("finance_price_days").select("day").order("day").range(from, from + 999);
    if (error) throw new Error(error.message);
    (data ?? []).forEach((r: any) => out.add(String(r.day)));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ---------- fill ----------
async function runFill(supabase: any, limit: number, refillBefore: string | null) {
  const t0 = Date.now();
  const idx = await refreshIndexes(supabase, false);
  const days = await tradingDays(supabase);
  if (!days.length) return { ok: false, error: "Chưa có lịch giao dịch (chuỗi VN-Index).", index: idx };
  const have = await haveDays(supabase);
  // refillBefore (ISO): GHI ĐÈ các ngày đã lưu TRƯỚC thời điểm đó (sau khi sửa luật đọc: mỗi lượt xử lý tối đa limit ngày, gọi lại tới khi hết). Không xoá dòng nào: upsert từng ngày.
  let todo: string[];
  if (refillBefore) {
    const { data } = await supabase.from("finance_price_days").select("day").lt("fetched_at", refillBefore).order("day", { ascending: false }).limit(limit);
    todo = (data ?? []).map((r: any) => String(r.day));
  } else todo = missingDays(days, have, limit);
  const stored: string[] = [], skipped: { day: string; stocks: number }[] = [];
  let bytes = 0;
  await pool(todo, 4, async (day) => {
    if (Date.now() - t0 > BUDGET_MS) return;
    const pi = days.indexOf(day), prev = pi > 0 ? days[pi - 1] : day;                  // ngày liền trước cùng lần gọi: cùng mốc điều chỉnh giá -> lợi suất không bao giờ đổi
    const j = await getJson(`${FINFO}/stock_prices?q=date:gte:${prev}~date:lte:${day}~type:STOCK&size=8000`);
    const p = parseDay(j, day, pi > 0 ? prev : undefined);
    if (p.stocks < MIN_STOCKS_PER_DAY) { skipped.push({ day, stocks: p.stocks }); return; }
    const { error } = await supabase.from("finance_price_days").upsert({ day, n: p.kept, data: p.data, fetched_at: new Date().toISOString() }, { onConflict: "day" });
    if (error) { console.error("bt-data: ghi ngày", day, error.message); skipped.push({ day, stocks: -1 }); return; }
    stored.push(day); bytes += JSON.stringify(p.data).length;
  });
  const left = Math.max(0, todo.length - stored.length - skipped.length);
  let missingAfter = days.filter((d) => !have.has(d)).length - stored.length;
  if (refillBefore) { const { count } = await supabase.from("finance_price_days").select("day", { count: "exact", head: true }).lt("fetched_at", refillBefore); missingAfter = count ?? 0; }
  return { ok: idx.ok, refill: !!refillBefore, index: idx, tradingDays: days.length, had: have.size, requested: todo.length, stored: stored.length, skipped, untried: left, missingAfter: Math.max(0, missingAfter), bytes, last: days[days.length - 1] };
}

// ---------- factors ----------
async function ratios(code: string, query: string): Promise<any[]> {
  const j = await getJson(`${FINFO}/ratios?q=ratioCode:${code}~${query}&size=4000`);
  return j && Array.isArray(j.data) ? j.data : [];
}
async function runFactors(supabase: any, wanted: unknown) {
  const t0 = Date.now();
  const days = await tradingDays(supabase);
  if (!days.length) return { ok: false, error: "Chưa có lịch giao dịch." };
  let targets: string[] = Array.isArray(wanted) ? (wanted as unknown[]).map(String).filter((d) => days.includes(d)).slice(0, 8) : [];
  if (!targets.length) {
    const monthEnds = monthEndTradingDays(days, "2020-12-01", new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10));
    const { data } = await supabase.from("finance_pit_market_daily").select("as_of");
    const have = new Set<string>((data ?? []).map((r: any) => String(r.as_of)));
    const near = (d: string) => [...have].some((h) => h <= d && Date.parse(d) - Date.parse(h) <= 7 * 86400000);      // đã dựng bằng phiên liền trước (khi ngày cuối tháng thiếu dữ liệu) thì không thử lại mãi
    targets = monthEnds.filter((d) => !near(d)).reverse().slice(0, 4);
  }
  const meta: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from("finance_stock_meta").select("symbol, icb2_code").order("symbol").range(from, from + 999);
    meta.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const icb = new Map<string, string | null>(meta.map((m: any) => [m.symbol, m.icb2_code ?? null]));
  const done: { as_of: string; symbols: number }[] = [], failed: string[] = [];
  // Dựng bảng của một ngày từ các chỉ số ratios; nguồn đôi khi chưa đủ dữ liệu cho một ngày (đã gặp 28-29/03/2024: < 500 mã có P/E) -> trả null để thử phiên liền trước
  const buildDay = async (d: string) => {
    const w = quarterWindow(d);
    const daily: Record<string, any[]> = {}, quarter: Record<string, any[]> = {};
    await pool([...BACKFILL_DAILY].map((c) => ({ c, q: "d" })).concat([...BACKFILL_QUARTER].map((c) => ({ c, q: "q" }))), 6, async (x) => {
      if (x.q === "d") daily[x.c] = await ratios(x.c, `reportDate:${d}`);
      else quarter[x.c] = await ratios(x.c, `reportDate:gte:${w.from}~reportDate:lte:${w.to}`);
    });
    if ((daily["PRICE_TO_EARNINGS"] ?? []).length < 500) return null;
    const packed = buildPitDay(d, daily, quarter, (s) => icb.get(s) ?? null);
    return packed.n >= 500 ? packed : null;
  };
  for (const d0 of targets) {
    const cand = [d0, ...days.filter((x) => x < d0).slice(-4).reverse()];
    let packed: any = null, used = d0;
    for (const d of cand) {
      if (Date.now() - t0 > BUDGET_MS - 25000) break;
      packed = await buildDay(d); used = d;
      if (packed) break;
    }
    if (!packed) { failed.push(d0); continue; }
    const { error } = await supabase.from("finance_pit_market_daily").upsert({ as_of: used, n: packed.n, cols: packed.cols, data: packed.data, source: "backfill" }, { onConflict: "as_of", ignoreDuplicates: true });
    if (error) { console.error("bt-data: ghi bảng số liệu", used, error.message); failed.push(d0); continue; }
    done.push({ as_of: used, symbols: packed.n });
  }
  return { ok: failed.length === 0 || done.length > 0, requested: targets.length, done, failed };
}

async function runStatus(supabase: any) {
  const days = await tradingDays(supabase);
  const have = await haveDays(supabase);
  const sorted = [...have].sort();
  const { count: pitBack } = await supabase.from("finance_pit_market_daily").select("as_of", { count: "exact", head: true }).eq("source", "backfill");
  const { count: pitLive } = await supabase.from("finance_pit_market_daily").select("as_of", { count: "exact", head: true }).eq("source", "live");
  return { ok: true, tradingDays: days.length, stored: have.size, first: sorted[0] ?? null, last: sorted[sorted.length - 1] ?? null, missing: days.filter((d) => !have.has(d)).length, pitBackfill: pitBack ?? 0, pitLive: pitLive ?? 0, today: todayVn() };
}

function selfTest() {
  const p = parseDay({ data: [
    { code: "AAA", type: "STOCK", floor: "HOSE", close: 10, basicPrice: 9.5, ceilingPrice: 10.1, floorPrice: 8.9, nmValue: 12.3e9 },
    { code: "BBB", type: "STOCK", floor: "UPCOM", close: 5, basicPrice: 5, ceilingPrice: 5.7, floorPrice: 4.3, nmValue: 1e6 },
    { code: "ETF1", type: "ETF", floor: "HOSE", close: 20, basicPrice: 20 },
  ] });
  return { kept: p.kept, stocks: p.stocks, aaa: p.data.AAA };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng */ }
  if (body && body.selftest === true) return json({ ok: true, result: selfTest() });
  // Chốt chặn: chỉ lịch hệ thống (x-cron-secret) được gọi (xem cron-guard.ts, finance-cron-secret-migration.sql)
  { const blocked = await cronGuard(req, { fn: "bt-data", allowUser: false }); if (blocked) return blocked; }
  const mode = String(body?.mode || "");
  if (!["fill", "factors", "status"].includes(mode)) return json({ ok: false, error: "mode không hợp lệ" }, 400);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const t0 = Date.now();
  let result: any, ok = true;
  try {
    if (mode === "fill") result = await runFill(supabase, Math.min(Math.max(Number(body.limit) || 30, 1), 200), typeof body.refillBefore === "string" && !isNaN(Date.parse(body.refillBefore)) ? body.refillBefore : null);
    else if (mode === "factors") result = await runFactors(supabase, body.dates);
    else result = await runStatus(supabase);
    ok = result?.ok !== false;
  } catch (e) {
    console.error("bt-data", mode, String((e as Error).message || e));
    ok = false; result = { ok: false, error: "Không chạy được." };
  }
  if (mode !== "status") await supabase.from("finance_function_runs").insert({ fn: "bt-data", mode, ok, duration_ms: Date.now() - t0, detail: result }).then(() => {}, () => {});
  return json(result, ok ? 200 : 502);
});
