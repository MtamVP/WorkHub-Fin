// Edge Function: fetch-stock-prices (v4) -- bản lưu trong repo của hàm đang chạy trên Supabase.
// v4: lấy giá cả mã trong danh sách theo dõi (finance_watchlist) + tự chụp NAV mỗi ngày giao dịch (finance_nav_history, xem nav.ts).
// Triển khai: Supabase MCP deploy_edge_function (verify_jwt = true), file này là nguồn; sửa ở đây rồi deploy lại.
// - Lấy giá đóng cửa/giá gần nhất cho mọi mã CP đang được theo dõi trong finance_transactions và
//   cập nhật finance_holdings_price (bỏ qua các cặp user/mã đã khóa giá).
// - Nguồn chính: VNDirect dchart-api. Nguồn dự phòng: VNDirect finfo v4 (host khác). Nguồn dự phòng
//   chỉ được chấp nhận khi giá không lệch quá xa giá đang lưu (chặn lỗi đơn vị / dữ liệu rác).
// - Ghi kèm price_date (ngày của mức giá) + price_source để giao diện hiện độ tươi của giá.
// - Đồng bộ VN-Index vào finance_benchmark_prices (thay cho nhập tay).
// - Ghi trạng thái lần chạy vào app_settings.price_fetch_status.
// Gọi định kỳ bởi pg_cron qua net.http_post (Bearer = publishable key, verify_jwt giữ true). Bên trong
// dùng SERVICE_ROLE_KEY do Supabase cấp cho hàm. Body tuỳ chọn {dryRun:true, symbols:[...]} chỉ để
// chẩn đoán nguồn (tối đa 5 mã, KHÔNG ghi dữ liệu).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildNavRows, heldQuantities, isWeekday } from "./nav.ts";

const UA = { "User-Agent": "Mozilla/5.0 (compatible; WorkHubPriceSync/1.0)" };
const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;

type Quote = { price: number; date: string; source: string };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Unix giây -> ngày YYYY-MM-DD theo giờ Việt Nam (UTC+7)
function vnDate(unixSec: number): string {
  return new Date((unixSec + 7 * 3600) * 1000).toISOString().slice(0, 10);
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null; // mã không tồn tại -> body rỗng dù HTTP 200
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

// VNDirect trả giá theo nghìn đồng (65.3 = 65.300đ) -> quy đổi về VND nguyên.
async function viaDchart(symbol: string): Promise<Quote | null> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 10 * 86400;
  const json = await getJson(
    `https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=${symbol}&from=${from}&to=${now}`,
  );
  if (!json || json.s !== "ok" || !Array.isArray(json.c) || !Array.isArray(json.t) || json.c.length === 0) return null;
  const last = json.c[json.c.length - 1];
  const ts = json.t[json.t.length - 1];
  if (typeof last !== "number" || !(last > 0) || typeof ts !== "number") return null;
  return { price: Math.round(last * 1000), date: vnDate(ts), source: "vnd-dchart" };
}

async function viaFinfo(symbol: string): Promise<Quote | null> {
  const json = await getJson(
    `https://api-finfo.vndirect.com.vn/v4/stock_prices?q=code:${symbol}&sort=date&size=1`,
  );
  const row = json?.data?.[0];
  if (!row) return null;
  const close = Number(row.close);
  if (!(close > 0) || !row.date) return null;
  return { price: Math.round(close * 1000), date: String(row.date), source: "vnd-finfo" };
}

// Giá dự phòng chỉ nhận khi nằm trong [0.3x, 3x] so với giá đang lưu (nếu có).
function plausible(price: number, prev: number | undefined): boolean {
  if (!prev || prev <= 0) return true;
  const r = price / prev;
  return r >= 0.3 && r <= 3;
}

async function getQuote(symbol: string, prev: number | undefined): Promise<Quote | null> {
  if (!SYMBOL_RE.test(symbol)) return null;
  const primary = await viaDchart(symbol);
  if (primary) return primary;
  const fallback = await viaFinfo(symbol);
  if (fallback && plausible(fallback.price, prev)) return fallback;
  return null;
}

async function syncVnIndex(supabase: any): Promise<{ rows: number; latest: string | null; error?: string }> {
  const { data: latestRow } = await supabase
    .from("finance_benchmark_prices").select("price_date").eq("index_code", "VNINDEX")
    .order("price_date", { ascending: false }).limit(1).maybeSingle();
  let fromSec: number;
  if (latestRow?.price_date) {
    fromSec = Math.floor(new Date(latestRow.price_date + "T00:00:00Z").getTime() / 1000) - 10 * 86400;
  } else {
    const { data: firstTx } = await supabase
      .from("finance_transactions").select("trade_date").is("deleted_at", null)
      .order("trade_date", { ascending: true }).limit(1).maybeSingle();
    const start = firstTx?.trade_date ? new Date(firstTx.trade_date + "T00:00:00Z").getTime() : Date.now() - 365 * 86400000;
    fromSec = Math.floor(start / 1000) - 7 * 86400;
  }
  const now = Math.floor(Date.now() / 1000);
  const json = await getJson(
    `https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=VNINDEX&from=${fromSec}&to=${now}`,
  );
  if (!json || json.s !== "ok" || !Array.isArray(json.c) || !Array.isArray(json.t)) {
    return { rows: 0, latest: latestRow?.price_date ?? null, error: "VNINDEX: không lấy được dữ liệu" };
  }
  const rows: any[] = [];
  for (let i = 0; i < json.t.length; i++) {
    const c = json.c[i];
    if (typeof c === "number" && c > 0) {
      rows.push({ index_code: "VNINDEX", price_date: vnDate(json.t[i]), close_value: c, created_by: "auto-vndirect" });
    }
  }
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from("finance_benchmark_prices").upsert(chunk, { onConflict: "index_code,price_date" });
    if (error) return { rows: written, latest: latestRow?.price_date ?? null, error: error.message };
    written += chunk.length;
  }
  return { rows: written, latest: rows.length ? rows[rows.length - 1].price_date : latestRow?.price_date ?? null };
}

// PostgREST trả tối đa 1.000 dòng mỗi lần đọc; quá thì CẮT IM LẶNG. Đọc từng trang tới khi hết và ném lỗi thay vì trả mảng rỗng
// (mảng rỗng do lỗi => NAV/cảnh báo tính như thể không có lệnh nào rồi ghi đè dữ liệu thật).
async function fetchAll(build: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    out.push(...data);
    from += data.length;
  }
  return out;
}

async function snapshotNav(supabase: any, latestIndexDate: string | null): Promise<{ date: string | null; rows: number; skipped?: string; error?: string }> {
  const today = vnDate(Math.floor(Date.now() / 1000));
  if (!isWeekday(today)) return { date: today, rows: 0, skipped: "cuối tuần" };
  if (latestIndexDate !== today) return { date: today, rows: 0, skipped: "chưa có phiên hôm nay" };
  try {
    const [txns, actions, priceRows, assets, flows] = await Promise.all([
      fetchAll(() => supabase.from("finance_transactions").select("user_id, symbol, type, quantity, trade_date, created_at").is("deleted_at", null).order("id")),
      fetchAll(() => supabase.from("finance_corporate_actions").select("user_id, symbol, action_type, ratio, ex_date, created_at").is("deleted_at", null).order("id")),
      fetchAll(() => supabase.from("finance_holdings_price").select("user_id, symbol, market_price").order("user_id").order("symbol")),
      fetchAll(() => supabase.from("finance_assets").select("user_id, cash, debt").order("user_id")),
      fetchAll(() => supabase.from("finance_cash_flows").select("user_id, flow_type, amount").is("deleted_at", null).in("flow_type", ["deposit", "withdrawal"]).order("id")),
    ]);
    const held = heldQuantities((txns ?? []) as any, (actions ?? []) as any);
    const prices = new Map<string, Map<string, number>>();
    for (const r of priceRows ?? []) {
      if (!prices.has(r.user_id)) prices.set(r.user_id, new Map());
      prices.get(r.user_id)!.set(r.symbol, Number(r.market_price) || 0);
    }
    const assetMap = new Map<string, { cash: number; debt: number }>();
    for (const a of assets ?? []) assetMap.set(a.user_id, { cash: Number(a.cash) || 0, debt: Number(a.debt) || 0 });
    const contributed = new Map<string, number>();
    for (const f of flows ?? []) contributed.set(f.user_id, (contributed.get(f.user_id) ?? 0) + (f.flow_type === "withdrawal" ? -Number(f.amount) : Number(f.amount)));
    // Chỉ chụp cho user ĐÃ có dòng finance_assets (đã từng dùng Bàn Tài Sản): tránh tạo dữ liệu cho tài khoản chưa dùng
    const rows = buildNavRows(today, held, prices, assetMap, contributed).filter((r) => assetMap.has(r.user_id));
    if (!rows.length) return { date: today, rows: 0 };
    const { error } = await supabase.from("finance_nav_history").upsert(rows, { onConflict: "user_id,snapshot_date" });
    if (error) return { date: today, rows: 0, error: error.message };
    // Giữ finance_assets.nav (trang Tổng hợp team đọc cột này) khớp với NAV mới
    for (const r of rows) await supabase.from("finance_assets").update({ nav: r.nav }).eq("user_id", r.user_id);
    return { date: today, rows: rows.length };
  } catch (e) {
    return { date: today, rows: 0, error: String((e as Error).message || e) };
  }
}

Deno.serve(async (req: Request) => {
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng từ cron */ }

  // Chế độ chẩn đoán: thử từng nguồn cho vài mã, không ghi gì
  if (body && body.dryRun === true && Array.isArray(body.symbols)) {
    const results: Record<string, unknown> = {};
    for (const raw of body.symbols.slice(0, 5)) {
      const s = String(raw).toUpperCase();
      if (!SYMBOL_RE.test(s)) { results[s] = "mã không hợp lệ"; continue; }
      results[s] = { dchart: await viaDchart(s), finfo: await viaFinfo(s) };
    }
    return jsonResponse({ dryRun: true, results });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);
  const startedAt = new Date().toISOString();

  let txns: any[], watchRows: any[], priceRows: any[];
  try {
    [txns, watchRows, priceRows] = await Promise.all([
      fetchAll(() => supabase.from("finance_transactions").select("symbol, user_id").is("deleted_at", null).order("id")),
      fetchAll(() => supabase.from("finance_watchlist").select("symbol, user_id").order("id")),
      fetchAll(() => supabase.from("finance_holdings_price").select("user_id, symbol, market_price, locked").order("user_id").order("symbol")),
    ]);
  } catch (e) {
    return jsonResponse({ error: String((e as Error).message || e) }, 500);
  }

  // Mọi mã từng được giao dịch -> cập nhật giá cho mọi user từng chạm mã đó. Rẻ và an toàn hơn replay FIFO
  // ở đây: user đã bán hết thì dòng giá của họ chỉ không còn được getHoldingsView dùng tới.
  const usersBySymbol = new Map<string, Set<string>>();
  for (const t of txns ?? []) {
    if (!t.symbol || !t.user_id) continue;
    if (!usersBySymbol.has(t.symbol)) usersBySymbol.set(t.symbol, new Set());
    usersBySymbol.get(t.symbol)!.add(t.user_id as string);
  }

  // Mã trong DANH SÁCH THEO DÕI (chưa mua) cũng cần giá để canh giá muốn mua / hiện upside.
  for (const w of watchRows ?? []) {
    if (!w.symbol || !w.user_id) continue;
    if (!usersBySymbol.has(w.symbol)) usersBySymbol.set(w.symbol, new Set());
    usersBySymbol.get(w.symbol)!.add(w.user_id as string);
  }

  // Giá đang lưu (để kiểm tra độ hợp lý của nguồn dự phòng) + tập (user:symbol) đã khóa
  const lockedSet = new Set<string>();
  const prevBySymbol = new Map<string, number>();
  for (const r of priceRows ?? []) {
    if (r.locked) lockedSet.add(`${r.user_id}:${r.symbol}`);
    const p = Number(r.market_price) || 0;
    if (p > 0 && !prevBySymbol.has(r.symbol)) prevBySymbol.set(r.symbol, p);
  }

  let priced = 0;
  let rowsUpdated = 0;
  let rowsSkippedLocked = 0;
  const failed: string[] = [];
  const sources: Record<string, number> = {};

  const entries = [...usersBySymbol.entries()];
  for (let i = 0; i < entries.length; i += 5) {
    const batch = entries.slice(i, i + 5);
    const quotes = await Promise.all(batch.map(([symbol]) => getQuote(symbol, prevBySymbol.get(symbol))));
    for (let j = 0; j < batch.length; j++) {
      const [symbol, userIds] = batch[j];
      const quote = quotes[j];
      if (!quote) { failed.push(symbol); continue; }
      priced++;
      sources[quote.source] = (sources[quote.source] ?? 0) + 1;
      const targetUserIds = [...userIds].filter((uid) => !lockedSet.has(`${uid}:${symbol}`));
      rowsSkippedLocked += userIds.size - targetUserIds.length;
      if (!targetUserIds.length) continue;
      const nowIso = new Date().toISOString();
      const rows = targetUserIds.map((user_id) => ({
        user_id, symbol, market_price: quote.price, updated_at: nowIso,
        price_date: quote.date, price_source: quote.source,
      }));
      const { error } = await supabase.from("finance_holdings_price").upsert(rows, { onConflict: "user_id,symbol" });
      if (!error) rowsUpdated += rows.length;
    }
  }

  const index = await syncVnIndex(supabase);

  // Chụp NAV mỗi ngày giao dịch (chỉ khi VN-Index đã có phiên của chính hôm nay -> loại cuối tuần/ngày lễ/trước giờ mở cửa).
  // Ghi đè cùng 1 dòng trong ngày nên dòng cuối phiên là NAV chốt phiên.
  const nav = await snapshotNav(supabase, index.latest);

  const status = {
    ranAt: new Date().toISOString(), startedAt,
    symbols: usersBySymbol.size, priced, rowsUpdated, rowsSkippedLocked, failed, sources, index, nav,
  };
  await supabase.from("app_settings").upsert({
    key: "price_fetch_status", value: JSON.stringify(status), updated_by: "cron", updated_at: status.ranAt,
  }, { onConflict: "key" });

  return jsonResponse(status);
});
