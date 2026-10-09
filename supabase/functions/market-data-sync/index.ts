// Edge Function: market-data-sync -- dữ liệu thị trường MIỄN PHÍ và kiểm chất lượng dữ liệu, chạy cả khi không ai mở app. Ba chế độ (body {"mode": ...}; "all" chạy cả ba):
//  "meta"   (pg_cron hằng tuần): thông tin mã -> finance_stock_meta (sàn, phân ngành ICB cấp 2 từ VCI, thuộc VN30 và ngày niêm yết từ VNDirect). Thay bảng ngành tự gõ chỉ có ~200 mã.
//  "rates"  (pg_cron mỗi ngày làm việc): lợi suất trái phiếu chính phủ 1-15 năm (TradingView scanner công khai) -> finance_rates; app dùng làm lãi phi rủi ro THEO NGÀY.
//  "ratios" (pg_cron mỗi ngày làm việc, hoặc gọi từ app kèm body.symbols <= 15 mã): chỉ số cơ bản và thị trường từ VNDirect (P/E, P/B, beta, ROE, biên lợi nhuận, đòn bẩy, tăng trưởng, 52 tuần, thanh khoản, khối ngoại) -> finance_stock_ratios.
//  "snapshot" (pg_cron mỗi ngày làm việc): ẢNH CHỤP CẢ THỊ TRƯỜNG (~1.600 mã: P/E, P/B, vốn hoá, ROE... mỗi chỉ số một lần gọi) -> finance_market_snapshot, và thống kê theo ngành ICB (trung vị, phân vị) -> finance_sector_stats để định giá tương đối.
//  "history" (chạy tay, body {from:"2021-01", to:"2021-12"}, tối đa 14 tháng mỗi lần): BÙ NGƯỢC lịch sử định giá (P/E, P/B trung vị và tổng hợp theo vốn hoá của thị trường và từng ngành, cuối mỗi tháng) -> finance_valuation_history; chế độ snapshot hằng ngày ghi tiếp.
//  "health" (pg_cron mỗi ngày làm việc): kiểm chất lượng dữ liệu giá của các mã đang nắm/theo dõi -- so VNDirect với VCI, nhảy giá vượt biên độ, thiếu phiên, giá cũ -> finance_data_health,
//     và gửi email cho quản lý đã bật email cảnh báo khi có cảnh báo MỚI mức lỗi/cảnh báo (Resend, secrets RESEND_API_KEY / ALERT_FROM_EMAIL như approval-watch).
// Mỗi lần chạy ghi finance_function_runs (app cảnh báo khi hàm quá hạn). Nguồn đều là điểm cuối công khai KHÔNG có cam kết dịch vụ: có thể đổi/chặn bất cứ lúc nào, nên có kiểm tra và ghi nhận "nguồn lỗi".
// Gọi bởi pg_cron (Bearer = publishable key, verify_jwt giữ true). Phản hồi chỉ có SỐ LƯỢNG. {"selftest":true} chạy bài tự kiểm không đụng mạng/CSDL.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildSnapshot, historyRows, monthEnds, sectorStats, snapshotDate, SNAP_DAILY, SNAP_QUARTER } from "./peers.ts";
import { addDays, BAND, buildHealthEmail, comparePrices, curateRatios, detectGaps, detectJumps, latestReportDate, mergeMeta, metaGaps, parseDchartBars, parseTvYield, parseVciBars, parseVciSymbols, parseVndStocks, TENORS, type Bar, type Health } from "./logic.ts";

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

async function sendEmail(apiKey: string, from: string, to: string, subject: string, html: string, text: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.error("market-data-sync: Resend HTTP", res.status);
    return res.ok;
  } catch (e) { console.error("market-data-sync: gửi email lỗi:", String((e as Error).message || e)); return false; }
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

// PostgREST trả tối đa 1.000 dòng mỗi lần dù .limit() lớn hơn (đã gặp: 523 mã trong ảnh chụp mất ngành ICB vì chỉ đọc được 1.000 dòng của finance_stock_meta): đọc từng trang tới khi hết
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

// Chỉ số cơ bản của một mã từ VNDirect /v4/ratios (nhóm ngày + nhóm quý) và /v4/foreigns. null nếu không có dữ liệu.
async function ratiosFor(sym: string): Promise<{ symbol: string; daily_date: string | null; quarter_date: string | null; metrics: Record<string, unknown> } | null> {
  const B = "https://api-finfo.vndirect.com.vn/v4";
  const [dj, qj] = await Promise.all([
    getJson(`${B}/ratios?q=code:${sym}~ratioCode:PRICE_TO_EARNINGS&sort=reportDate:desc&size=1`),
    getJson(`${B}/ratios?q=code:${sym}~ratioCode:ROAE_TR_AVG5Q&sort=reportDate:desc&size=1`),
  ]);
  const dd = latestReportDate(dj), qd = latestReportDate(qj);
  const [d, q, f] = await Promise.all([
    dd ? getJson(`${B}/ratios?q=code:${sym}~reportDate:${dd}&size=300`) : Promise.resolve(null),
    qd ? getJson(`${B}/ratios?q=code:${sym}~reportDate:${qd}&size=400`) : Promise.resolve(null),
    getJson(`${B}/foreigns?q=code:${sym}&sort=tradingDate:desc&size=5`),
  ]);
  const metrics = curateRatios(d?.data ?? [], q?.data ?? [], f?.data ?? []);
  return Object.keys(metrics).length ? { symbol: sym, daily_date: dd, quarter_date: qd, metrics } : null;
}

async function syncRatios(supabase: any, only?: string[]) {
  let symbols: string[];
  if (only && only.length) symbols = only;
  else {
    const [tx, wl] = await Promise.all([
      fetchAll(() => supabase.from("finance_transactions").select("symbol").is("deleted_at", null).order("id")),
      fetchAll(() => supabase.from("finance_watchlist").select("symbol").order("id")),
    ]);
    symbols = [...new Set([...(tx ?? []), ...(wl ?? [])].map((r: any) => String(r.symbol || "").toUpperCase()).filter((s) => /^[A-Z0-9]{1,12}$/.test(s)))].slice(0, 80);
  }
  if (!symbols.length) return { ok: true, checked: 0, saved: 0 };
  const got = await inBatches(symbols, 4, (s) => ratiosFor(s));
  const rows = got.filter((x) => x).map((x: any) => ({ symbol: x.symbol, daily_date: x.daily_date, quarter_date: x.quarter_date, metrics: x.metrics, source: "vndirect", updated_at: new Date().toISOString() }));
  if (!rows.length) return { ok: false, error: "VNDirect không trả chỉ số cho mã nào.", checked: symbols.length };
  const { error } = await supabase.from("finance_stock_ratios").upsert(rows, { onConflict: "symbol" });
  if (error) throw new Error(error.message);
  return { ok: true, checked: symbols.length, saved: rows.length };
}

// Ảnh chụp cả thị trường: mỗi chỉ số một lần gọi cho mọi mã (nhóm ngày theo ngày báo cáo mới nhất; nhóm quý theo cửa sổ 150 ngày, lấy quý mới nhất của từng mã).
async function syncSnapshot(supabase: any) {
  const B = "https://api-finfo.vndirect.com.vn/v4";
  let date: string | null = null;
  for (const probe of ["VNM", "VCB", "HPG", "FPT"]) {
    date = latestReportDate(await getJson(`${B}/ratios?q=code:${probe}~ratioCode:PRICE_TO_EARNINGS&sort=reportDate:desc&size=1`));
    if (date) break;
  }
  if (!date) return { ok: false, error: "Không xác định được ngày chỉ số mới nhất của VNDirect." };
  const since = new Date(Date.now() - 150 * 86400000).toISOString().slice(0, 10);
  const daily: Record<string, any[]> = {}, quarter: Record<string, any[]> = {};
  const jobs: [string, boolean][] = [...SNAP_DAILY.map((c) => [c, false] as [string, boolean]), ...SNAP_QUARTER.map((c) => [c, true] as [string, boolean])];
  await inBatches(jobs, 4, async ([code, isQ]) => {
    // nhóm quý xếp ngày mới trước: mã có nhiều kỳ trong cửa sổ (TOTAL_SHARES, FREEFLOAT ~4.600 dòng) vượt 4.000 dòng thì phần bị cắt là kỳ cũ
    const j = await getJson(`${B}/ratios?q=ratioCode:${code}~reportDate:${isQ ? "gte:" + since : date}&size=4000${isQ ? "&sort=reportDate:desc" : ""}`);
    (isQ ? quarter : daily)[code] = j && Array.isArray(j.data) ? j.data : [];
  });
  const metaRows = await fetchAll(() => supabase.from("finance_stock_meta").select("symbol, icb2_code").order("symbol"));
  const icb = new Map((metaRows ?? []).map((m: any) => [m.symbol, m.icb2_code]));
  const rows = buildSnapshot(daily, quarter, (sym) => (icb.get(sym) as string | null) ?? null);
  // an toàn: nguồn trả quá ít (hỏng một phần) thì không ghi đè
  const prev = await supabase.from("finance_market_snapshot").select("symbol", { count: "exact", head: true });
  if (rows.length < 500 || (prev.count && rows.length < prev.count * 0.5)) return { ok: false, error: `Ảnh chụp chỉ có ${rows.length} mã (đang lưu ${prev.count ?? 0}): bỏ qua để không ghi đè dữ liệu tốt.` };
  const now = new Date().toISOString();
  await chunked(rows, 400, async (part) => {
    const { error } = await supabase.from("finance_market_snapshot").upsert(part.map((r) => ({ ...r, updated_at: now })), { onConflict: "symbol" });
    if (error) throw new Error(error.message);
  });
  await supabase.from("finance_market_snapshot").delete().lt("updated_at", new Date(Date.now() - 10 * 86400000).toISOString());   // mã đã hết niêm yết
  const stats = sectorStats(rows, snapshotDate(rows), now);
  const { error } = await supabase.from("finance_sector_stats").upsert(stats, { onConflict: "icb2_code" });
  if (error) throw new Error(error.message);
  // lịch sử định giá: ghi dòng của ngày này; lỗi (ví dụ bảng chưa tạo) chỉ ghi nhận, không làm hỏng ảnh chụp đã lưu
  let history: number | string = 0;
  try {
    const hist = historyRows(rows, snapshotDate(rows) ?? date);
    const { error: hErr } = await supabase.from("finance_valuation_history").upsert(hist, { onConflict: "as_of,scope" });
    history = hErr ? "lỗi: " + hErr.message.slice(0, 80) : hist.length;
  } catch (e) { history = "lỗi: " + String((e as Error).message || e).slice(0, 80); }
  return { ok: true, symbols: rows.length, sectors: stats.length, date, history };
}

// Bù ngược lịch sử định giá theo tháng: mỗi tháng dò lùi tối đa 7 ngày tới ngày có dữ liệu, hỏi P/E, P/B, vốn hoá của cả thị trường (3 lần gọi) rồi tổng hợp như ảnh chụp hằng ngày.
async function syncHistory(supabase: any, from: string, to: string) {
  const months = monthEnds(from, to).slice(0, 14);
  if (!months.length) return { ok: false, error: "Khoảng tháng không hợp lệ: cần from và to dạng YYYY-MM (from <= to), tối đa 14 tháng mỗi lần." };
  const B = "https://api-finfo.vndirect.com.vn/v4";
  const metaRows = await fetchAll(() => supabase.from("finance_stock_meta").select("symbol, icb2_code").order("symbol"));
  const icb = new Map((metaRows ?? []).map((m: any) => [m.symbol, m.icb2_code]));
  const got: string[] = [], skipped: string[] = [];
  let saved = 0;
  await inBatches(months, 2, async (end) => {
    let day: string | null = null, pe: any[] = [];
    for (let k = 0; k < 7 && !day; k++) {
      const d = addDays(end, -k);
      const j = await getJson(`${B}/ratios?q=ratioCode:PRICE_TO_EARNINGS~reportDate:${d}&size=4000`);
      const data = j && Array.isArray(j.data) ? j.data : [];
      if (data.length >= 500) { day = d; pe = data; }
    }
    if (!day) { skipped.push(end); return; }
    const [pb, cap] = await Promise.all([
      getJson(`${B}/ratios?q=ratioCode:PRICE_TO_BOOK~reportDate:${day}&size=4000`),
      getJson(`${B}/ratios?q=ratioCode:MARKETCAP~reportDate:${day}&size=4000`),
    ]);
    const rows = buildSnapshot({ PRICE_TO_EARNINGS: pe, PRICE_TO_BOOK: pb?.data ?? [], MARKETCAP: cap?.data ?? [] }, {}, (sym) => (icb.get(sym) as string | null) ?? null);
    const hist = historyRows(rows, day);
    if (!hist.length) { skipped.push(end); return; }
    const { error } = await supabase.from("finance_valuation_history").upsert(hist, { onConflict: "as_of,scope" });
    if (error) throw new Error(error.message);
    saved += hist.length; got.push(day);
  });
  if (!got.length) return { ok: false, error: "Không tháng nào có dữ liệu.", skipped };
  return { ok: true, months: got.length, rows: saved, skipped: skipped.length ? skipped : undefined };
}

async function checkHealth(supabase: any) {
  const nowSec = Math.floor(Date.now() / 1000), fromSec = nowSec - 40 * 86400, toSec = nowSec + 86400;
  const [tx, wl] = await Promise.all([
    fetchAll(() => supabase.from("finance_transactions").select("symbol").is("deleted_at", null).order("id")),
    fetchAll(() => supabase.from("finance_watchlist").select("symbol").order("id")),
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
  let inserted = 0, emailed = 0;
  if (flags.length) {
    const { data, error } = await supabase.from("finance_data_health").upsert(flags, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id, kind, symbol, severity, ref_date, detail");
    if (error) throw new Error(error.message);
    inserted = (data ?? []).length;
    // Báo quản lý khi có cảnh báo MỚI mức lỗi/cảnh báo (mức thông tin không báo email); mỗi cảnh báo chỉ báo một lần vì chỉ dòng vừa chèn mới được trả về
    const alertRows = (data ?? []).filter((r: any) => r.severity === "error" || r.severity === "warn");
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (alertRows.length && apiKey) {
      const from = Deno.env.get("ALERT_FROM_EMAIL") || "WorkHub <onboarding@resend.dev>";
      const mail = buildHealthEmail(alertRows);
      for (const rcp of await emailManagers(supabase)) { if (await sendEmail(apiKey, from, rcp.email, mail.subject, mail.html, mail.text)) emailed++; }
    }
  }
  return { ok: true, checked: symbols.length, flagged: flags.length, newlyRecorded: inserted, emailed, primaryDown, secondaryDown };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng */ }
  if (body && body.selftest === true) return json({ ok: true, band: BAND, tenors: TENORS });
  const mode = ["meta", "rates", "health", "ratios", "snapshot", "history", "all"].includes(body?.mode) ? body.mode : "health";
  const only: string[] = Array.isArray(body?.symbols) ? [...new Set(body.symbols.map((x: unknown) => String(x).trim().toUpperCase()))].filter((x) => /^[A-Z0-9]{1,12}$/.test(x as string)).slice(0, 15) as string[] : [];
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const t0 = Date.now();
  const result: Record<string, unknown> = {};
  let ok = true;
  try {
    for (const m of mode === "all" ? ["meta", "rates", "health"] : [mode]) {
      try { result[m] = m === "meta" ? await syncMeta(supabase) : (m === "rates" ? await syncRates(supabase) : (m === "ratios" ? await syncRatios(supabase, only) : (m === "snapshot" ? await syncSnapshot(supabase) : (m === "history" ? await syncHistory(supabase, String(body?.from || ""), String(body?.to || "")) : await checkHealth(supabase))))); }
      catch (e) { result[m] = { ok: false, error: String((e as Error).message || e).slice(0, 200) }; }
      if (!(result[m] as any).ok) ok = false;
    }
  } finally {
    await supabase.from("finance_function_runs").insert({ fn: "market-data-sync", mode, ok, duration_ms: Date.now() - t0, detail: result }).then(() => {}, () => {});
  }
  return json({ ok, mode, result }, ok ? 200 : 207);
});
