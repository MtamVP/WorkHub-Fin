// Edge Function: vb-data -- dữ liệu cho VALUATION BENCH: báo cáo tài chính ĐẦY ĐỦ (bảng cân đối, kết quả kinh doanh, lưu chuyển tiền; năm và quý), nến ngày OHLCV của mã và VN-Index, chuỗi P/E-P/B-P/S hằng ngày.
// Nguồn: VNDirect finfo v4 (financial_statements, ratios) và dchart -- miễn phí, cùng nguồn với fetch-stock-prices / stock-history / stock-financials.
// Triển khai: Supabase MCP deploy_edge_function (verify_jwt = true). CHỈ cho người dùng đã đăng nhập (kiểm tra JWT người dùng) để hàm không thành "proxy mở" tới VNDirect.
// Body: { symbol: "FPT", mode?: "all"|"statements"|"ohlc"|"ratios", years?: 3-10 (báo cáo năm, mặc định 8), candleYears?: 1-7 (mặc định 5), index?: true }
// -> { ok, symbol, form, annualRows, quarterRows, candles, indexCandles, ratioSeries: { pe: [...], pb: [...], ps: [...] }, ratioDates, errors, fetchedAt }.
// annualRows/quarterRows là hàng finfo rút gọn { itemCode, fiscalDate, numericValue, modelType } -- phía app chuẩn hoá bằng lib/vb-statements.js (bản sao nguyên văn nằm cạnh file này để lọc đúng các mã cần dùng).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "./vb-statements.js";
import { FORM_ORDER, MAX_CANDLE_DAYS, MODELS, RATIO_CODES, candlesFromDchart, ratioValues, slimRows, validateRequest, yearsAgo, type Form, type Row } from "./parse.ts";

const UA = { "User-Agent": "Mozilla/5.0 (compatible; WorkHubValuationBench/1.0)" };
const BASE = "https://api-finfo.vndirect.com.vn/v4";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

async function getData(url: string, timeoutMs = 25000): Promise<any[] | null> {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j?.data) ? j.data : null;
  } catch (_e) { return null; }
}
async function getRaw(url: string, timeoutMs = 25000): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  } catch (_e) { return null; }
}

const FIELDS = "fields=itemCode,fiscalDate,numericValue,modelType";
function stmtUrl(symbol: string, type: "ANNUAL" | "QUARTER", model: number, from: string): string {
  return `${BASE}/financial_statements?q=code:${symbol}~reportType:${type}~modelType:${model}~fiscalDate:gte:${from}&size=4000&${FIELDS}`;
}

// Mã khoản mục cần dùng của từng loại doanh nghiệp, lấy từ bản sao lib/vb-statements.js
function codesOf(form: Form): Set<number> {
  const map = (globalThis as any).VBStatements?.MAP?.[form] ?? {};
  const s = new Set<number>();
  Object.keys(map).forEach((k) => (map[k] as number[]).forEach((c) => s.add(c)));
  return s;
}

async function fetchStatements(symbol: string, years: number, now: Date): Promise<{ form: Form | null; annualRows: Row[]; quarterRows: Row[]; error?: string }> {
  const from = yearsAgo(now, years), qFrom = yearsAgo(now, 3);
  // nhận dạng loại doanh nghiệp: bảng cân đối của mô hình nào có dữ liệu
  let form: Form | null = null, bsRows: any[] = [];
  for (const f of FORM_ORDER) {
    const rows = await getData(stmtUrl(symbol, "ANNUAL", MODELS[f][0], from));
    if (rows && rows.length) { form = f; bsRows = rows; break; }
  }
  if (!form) return { form: null, annualRows: [], quarterRows: [], error: "Không tìm thấy báo cáo tài chính của mã này." };
  const [bs, is, cf] = MODELS[form], codes = codesOf(form);
  const [isRows, cfRows, qBs, qIs] = await Promise.all([
    getData(stmtUrl(symbol, "ANNUAL", is, from)), getData(stmtUrl(symbol, "ANNUAL", cf, from)),
    getData(stmtUrl(symbol, "QUARTER", bs, qFrom)), getData(stmtUrl(symbol, "QUARTER", is, qFrom)),
  ]);
  return {
    form,
    annualRows: slimRows(bsRows.concat(isRows ?? [], cfRows ?? []), codes),
    quarterRows: slimRows((qBs ?? []).concat(qIs ?? []), codes),
    error: !isRows ? "Thiếu báo cáo kết quả kinh doanh." : undefined,
  };
}

async function fetchCandles(symbol: string, candleYears: number, now: Date) {
  const days = Math.min(MAX_CANDLE_DAYS, Math.round(candleYears * 366));
  const toSec = Math.floor(now.getTime() / 1000) + 2 * 86400, fromSec = toSec - days * 86400;
  return candlesFromDchart(await getRaw(`https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=${symbol}&from=${fromSec}&to=${toSec}`), symbol);
}

async function fetchRatios(symbol: string, candleYears: number, now: Date): Promise<{ series: Record<string, number[]>; dates: Record<string, string[]> }> {
  const from = yearsAgo(now, candleYears), series: Record<string, number[]> = {}, dates: Record<string, string[]> = {};
  const keys = Object.keys(RATIO_CODES);
  const res = await Promise.all(keys.map((k) => getData(`${BASE}/ratios?q=code:${symbol}~ratioCode:${RATIO_CODES[k]}~reportDate:gte:${from}&size=4000&sort=reportDate`)));
  keys.forEach((k, i) => { const r = ratioValues(res[i] ?? []); series[k] = r.values; dates[k] = r.dates; });
  return { series, dates };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = null;
  try { body = await req.json(); } catch (_e) { /* để validateRequest báo lỗi */ }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: auth, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !auth?.user) return json({ ok: false, error: "Cần đăng nhập." }, 401);

  const v = validateRequest(body);
  if (v.error) return json({ ok: false, error: v.error }, 400);

  const now = new Date(), errors: Record<string, string> = {}, out: Record<string, unknown> = { ok: true, symbol: v.symbol, fetchedAt: now.toISOString() };
  try {
    const wantStmt = v.mode === "all" || v.mode === "statements", wantOhlc = v.mode === "all" || v.mode === "ohlc", wantRatios = v.mode === "all" || v.mode === "ratios";
    const [stmt, candles, indexCandles, ratios] = await Promise.all([
      wantStmt ? fetchStatements(v.symbol, v.years, now) : Promise.resolve(null),
      wantOhlc ? fetchCandles(v.symbol, v.candleYears, now) : Promise.resolve(null),
      wantOhlc && v.index ? fetchCandles("VNINDEX", v.candleYears, now) : Promise.resolve(null),
      wantRatios ? fetchRatios(v.symbol, v.candleYears, now) : Promise.resolve(null),
    ]);
    if (stmt) { out.form = stmt.form; out.annualRows = stmt.annualRows; out.quarterRows = stmt.quarterRows; if (stmt.error) errors.statements = stmt.error; }
    if (wantOhlc) { out.candles = candles; out.indexCandles = indexCandles; if (!candles) errors.ohlc = "Không lấy được nến giá của mã này."; }
    if (ratios) { out.ratioSeries = ratios.series; out.ratioDates = ratios.dates; }
  } catch (e) {
    console.error("vb-data:", String((e as Error).message || e));
    return json({ ok: false, error: "Không lấy được dữ liệu từ nguồn." }, 502);
  }
  out.errors = errors;
  return json(out);
});
