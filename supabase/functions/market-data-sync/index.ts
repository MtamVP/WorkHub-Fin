// Edge Function: market-data-sync -- dữ liệu thị trường MIỄN PHÍ và kiểm chất lượng dữ liệu, chạy cả khi không ai mở app. Ba chế độ (body {"mode": ...}; "all" chạy cả ba):
//  "meta"   (pg_cron hằng tuần): thông tin mã -> finance_stock_meta (sàn, phân ngành ICB cấp 2 từ VCI, thuộc VN30 và ngày niêm yết từ VNDirect). Thay bảng ngành tự gõ chỉ có ~200 mã.
//  "rates"  (pg_cron mỗi ngày làm việc): lợi suất trái phiếu chính phủ 1-15 năm (TradingView scanner công khai) -> finance_rates; app dùng làm lãi phi rủi ro THEO NGÀY.
//  "health" (pg_cron mỗi ngày làm việc): kiểm chất lượng dữ liệu giá của các mã đang nắm/theo dõi -- so VNDirect với VCI, nhảy giá vượt biên độ, thiếu phiên, giá cũ -> finance_data_health.
// Mỗi lần chạy ghi finance_function_runs (app cảnh báo khi hàm quá hạn). Nguồn đều là điểm cuối công khai KHÔNG có cam kết dịch vụ: có thể đổi/chặn bất cứ lúc nào, nên có kiểm tra và ghi nhận "nguồn lỗi".
// Gọi bởi pg_cron (Bearer = publishable key, verify_jwt giữ true). Phản hồi chỉ có SỐ LƯỢNG. {"selftest":true} chạy bài tự kiểm không đụng mạng/CSDL.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { BAND, comparePrices, detectGaps, detectJumps, mergeMeta, metaGaps, parseDchartBars, parseTvYield, parseVciBars, parseVciSymbols, parseVndStocks, TENORS, type Bar, type Health } from "./logic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
// KHÔNG gửi Accept: application/json -- dchart của VNDirect trả 406 nếu có header này (đã gặp khi triển khai).
const UA = { "User-Agent": "Mozilla/5.0 (compatible; WorkHubPriceSync/1.0)" };
const VCI_HEADERS = { ...UA, "Accept": "application/json", "Origin": "https://trading.vietcap.com.vn", "Referer": "https://trading.vietcap.com.vn/" };

async function getJson(url: string, headers: Record<string, string> = UA, init?: RequestInit): Promise<any | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000), ...init });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (_e) { return null; }
}

async function chunked<T>(rows: T[], n: number, fn: (part: T[]) => Promise<void>) { for (let i = 0; i < rows.length; i += n) await fn(rows.slice(i, i + n)); }
async function inBatches<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn)));
  return out;
}

async function syncMeta(supabase: any) {
  const [vciRaw, vndRaw] = await Promise.all([
    getJson("https://trading.vietcap.com.vn/api/price/symbols/getAll", VCI_HEADERS),
    getJson("https://api-finfo.vndirect.com.vn/v4/stocks?q=type:STOCK~status:listed&fields=code,floor,indexCode,listedDate,status,shortName,companyName&size=3000"),
  ]);
  const vci = parseVciSymbols(vciRaw), vnd = parseVndStocks(vndRaw);
  if (!vci.length && !Object.keys(vnd).length) return { ok: false, error: "Cả hai nguồn thông tin mã đều không trả dữ liệu." };
  // an toàn: nếu nguồn trả ít bất thường (hỏng một phần) thì không ghi đè
  const prev = await supabase.from("finance_stock_meta").select("symbol", { count: "exact", head: true });
  const total = Math.max(vci.length, Object.keys(vnd).length);
  if (prev.count && total < prev.count * 0.5) return { ok: false, error: `Nguồn trả ${total} mã, ít hơn nhiều so với ${prev.count} mã đang lưu: bỏ qua để không ghi đè dữ liệu tốt.` };
  const rows = mergeMeta(vci, vnd, new Date().toISOString());
  let n = 0;
  await chunked(rows, 400, async (part) => {
    const { error } = await supabase.from("finance_stock_meta").upsert(part, { onConflict: "symbol" });
    if (error) throw new Error(error.message);
    n += part.length;
  });
  return { ok: true, upserted: n, vci: vci.length, vnd: Object.keys(vnd).length };
}

async function syncRates(supabase: any) {
  const got = await inBatches([...TENORS], 4, async (t) => {
    const j = await getJson(`https://scanner.tradingview.com/symbol?symbol=${encodeURIComponent("TVC:VN" + t.replace("Y", "").padStart(2, "0") + "Y")}&fields=close,time&no_404=true`);
    const p = parseTvYield(j);
    return p ? { rate_date: p.date, tenor: t, yield_pct: p.yield_pct, source: "tradingview" } : null;
  });
  const rows = got.filter((x) => x) as any[];
  if (!rows.length) return { ok: false, error: "Không lấy được lợi suất trái phiếu." };
  const { error } = await supabase.from("finance_rates").upsert(rows, { onConflict: "rate_date,tenor" });
  if (error) throw new Error(error.message);
  return { ok: true, rows: rows.length, date: rows[0].rate_date };
}

async function barsFromDchart(symbol: string, fromSec: number, toSec: number, isIndex: boolean): Promise<Bar[] | null> {
  const j = await getJson(`https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=${symbol}&from=${fromSec}&to=${toSec}`);
  return j ? parseDchartBars(j, isIndex) : null;
}
async function barsFromVci(symbol: string, toSec: number): Promise<Bar[] | null> {
  const j = await getJson("https://trading.vietcap.com.vn/api/chart/OHLCChart/gap-chart", VCI_HEADERS, { method: "POST", headers: { ...VCI_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ timeFrame: "ONE_DAY", symbols: [symbol], to: toSec, countBack: 25 }) });
  return j ? parseVciBars(j, symbol) : null;
}

async function checkHealth(supabase: any) {
  const nowSec = Math.floor(Date.now() / 1000), fromSec = nowSec - 40 * 86400, toSec = nowSec + 86400;
  const [{ data: tx }, { data: wl }] = await Promise.all([
    supabase.from("finance_transactions").select("symbol").is("deleted_at", null).limit(5000),
    supabase.from("finance_watchlist").select("symbol").limit(1000),
  ]);
  const symbols = [...new Set([...(tx ?? []), ...(wl ?? [])].map((r: any) => String(r.symbol || "").toUpperCase()).filter((s) => /^[A-Z0-9]{1,12}$/.test(s)))].slice(0, 80);
  if (!symbols.length) return { ok: true, checked: 0, flagged: 0 };
  const { data: metaRows } = await supabase.from("finance_stock_meta").select("symbol, exchange, listed_date, icb2_code").in("symbol", symbols);
  const meta = new Map((metaRows ?? []).map((m: any) => [m.symbol, m]));
  const index = await barsFromDchart("VNINDEX", fromSec, toSec, true);
  const flags: Health[] = [];
  let primaryDown = 0, secondaryDown = 0;
  await inBatches(symbols, 5, async (sym) => {
    const [a, b] = await Promise.all([barsFromDchart(sym, fromSec, toSec, false), barsFromVci(sym, toSec)]);
    if (!a || !a.length) primaryDown++;
    if (!b || !b.length) secondaryDown++;
    const m: any = meta.get(sym);
    if (a && a.length) {
      flags.push(...detectJumps(sym, m?.exchange ?? null, a.slice(-25), m?.listed_date ?? null));
      if (index && index.length) flags.push(...detectGaps(sym, a, index));
    }
    if (a && a.length && b && b.length) flags.push(...comparePrices(sym, a.slice(-8), b.slice(-8), { names: ["vndirect", "vci"] }));
  });
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  if (primaryDown >= Math.max(3, symbols.length * 0.5)) flags.push({ kind: "source_down", symbol: null, severity: "error", ref_date: today, detail: { source: "vndirect dchart", failed: primaryDown, of: symbols.length }, dedupe_key: `source_down|vndirect|${today}` });
  if (secondaryDown >= Math.max(3, symbols.length * 0.5)) flags.push({ kind: "source_down", symbol: null, severity: "warn", ref_date: today, detail: { source: "vci", failed: secondaryDown, of: symbols.length, note: "Không có nguồn thứ hai để đối chiếu giá hôm nay." }, dedupe_key: `source_down|vci|${today}` });
  flags.push(...metaGaps(symbols, (s) => !!(meta.get(s) as any)?.icb2_code, today));
  let inserted = 0;
  if (flags.length) {
    const { data, error } = await supabase.from("finance_data_health").upsert(flags, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(error.message);
    inserted = (data ?? []).length;
  }
  return { ok: true, checked: symbols.length, flagged: flags.length, newlyRecorded: inserted, primaryDown, secondaryDown };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng */ }
  if (body && body.selftest === true) return json({ ok: true, band: BAND, tenors: TENORS });
  const mode = ["meta", "rates", "health", "all"].includes(body?.mode) ? body.mode : "health";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const t0 = Date.now();
  const result: Record<string, unknown> = {};
  let ok = true;
  try {
    for (const m of mode === "all" ? ["meta", "rates", "health"] : [mode]) {
      try { result[m] = m === "meta" ? await syncMeta(supabase) : (m === "rates" ? await syncRates(supabase) : await checkHealth(supabase)); }
      catch (e) { result[m] = { ok: false, error: String((e as Error).message || e).slice(0, 200) }; }
      if (!(result[m] as any).ok) ok = false;
    }
  } finally {
    await supabase.from("finance_function_runs").insert({ fn: "market-data-sync", mode, ok, duration_ms: Date.now() - t0, detail: result }).then(() => {}, () => {});
  }
  return json({ ok, mode, result }, ok ? 200 : 207);
});
