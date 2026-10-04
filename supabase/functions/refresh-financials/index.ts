// Edge Function: refresh-financials -- mỗi ngày tự làm mới số liệu tài chính (báo cáo năm, quý, cổ tức) của MỌI mã đã có trong bảng định giá
// và lưu vào bảng đệm finance_financials_cache. Nhờ đó trang Tổng Hợp CP biết mã nào vừa có báo cáo mới (changed_at) mà không phải gọi nguồn
// từ máy người dùng, và có thể áp dụng thẳng số liệu đã đệm (vẫn do người dùng bấm xác nhận, trừ khi họ bật "tự cập nhật khi mở trang").
// Gọi định kỳ bởi pg_cron (Bearer = publishable key, verify_jwt giữ true) -- cùng kiểu fetch-stock-prices / send-price-alerts.
// Mỗi lần chỉ làm mới tối đa MAX_PER_RUN mã (cũ nhất trước) và bỏ qua mã mới lấy trong 20 giờ, nên gọi lặp lại không tốn thêm gì.
// Phản hồi chỉ có SỐ LƯỢNG. Nguồn: VNDirect finfo v4 (cùng truy vấn với stock-financials; parse.ts là bản sao nguyên văn -- có test so khớp).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ANNUAL_ITEMS, ANNUAL_MODELS, QUARTER_ITEMS, QUARTER_MODELS, buildFinancials, type EventRow, type Row } from "./parse.ts";
import { classify, fingerprint, latestKeys, pickSymbols, summarize, type CacheMeta, type Fin } from "./refresh.ts";

const UA = { "User-Agent": "Mozilla/5.0 (compatible; WorkHubPriceSync/1.0)" };
const BASE = "https://api-finfo.vndirect.com.vn/v4";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

async function getData(url: string): Promise<any[] | null> {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j?.data) ? j.data : null;
  } catch (_e) {
    return null;
  }
}

async function financialsFor(symbol: string) {
  const year = new Date().getUTCFullYear();
  const annualQ = `code:${symbol}~reportType:ANNUAL~itemCode:${ANNUAL_ITEMS.join(",")}~modelType:${ANNUAL_MODELS.join(",")}~fiscalDate:gte:${year - 9}-01-01`;
  const quarterQ = `code:${symbol}~reportType:QUARTER~itemCode:${QUARTER_ITEMS.join(",")}~modelType:${QUARTER_MODELS.join(",")}~fiscalDate:gte:${year - 3}-01-01`;
  const eventQ = `code:${symbol}~type:DIVIDEND~locale:VN`;
  const [annual, quarter, events] = await Promise.all([
    getData(`${BASE}/financial_statements?q=${annualQ}&sort=fiscalDate&size=800`),
    getData(`${BASE}/financial_statements?q=${quarterQ}&sort=fiscalDate&size=400`),
    getData(`${BASE}/events?q=${eventQ}&sort=effectiveDate&size=80`),
  ]);
  if (annual === null && quarter === null) throw new Error("source");
  if (!(annual ?? []).length && !(quarter ?? []).length) throw new Error("empty");
  return buildFinancials((annual ?? []) as Row[], (quarter ?? []) as Row[], (events ?? []) as EventRow[]);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = new Date();

  const { data: vals, error: vErr } = await supabase.from("finance_stock_valuations").select("symbol");
  if (vErr) return json({ ok: false, error: vErr.message }, 500);
  const symbols = [...new Set((vals ?? []).map((v) => String(v.symbol).toUpperCase()))];
  if (!symbols.length) return json({ ok: true, symbols: 0, tried: 0, refreshed: 0, changed: 0, failed: 0 });

  const { data: cacheRows } = await supabase.from("finance_financials_cache").select("symbol, fetched_at, fingerprint").in("symbol", symbols);
  const cache = (cacheRows ?? []) as CacheMeta[];
  const todo = pickSymbols(symbols, cache, now);
  const prevFp = new Map(cache.map((c) => [c.symbol, c.fingerprint ?? null]));

  const changed: string[] = [], failed: string[] = [];
  let refreshed = 0;
  for (let i = 0; i < todo.length; i += 5) {
    await Promise.all(todo.slice(i, i + 5).map(async (sym) => {
      try {
        const fin = await financialsFor(sym) as unknown as Fin;
        const fp = fingerprint(fin);
        const change = classify(prevFp.get(sym), fp);
        const k = latestKeys(fin);
        const row: Record<string, unknown> = {
          symbol: sym, form: fin.form, payload: fin, annual_year: k.annualYear, quarter_key: k.quarterKey, fingerprint: fp, fetched_at: now.toISOString(),
        };
        // changed_at chỉ đổi khi số liệu thật sự KHÁC lần trước, để người dùng không bị báo "có báo cáo mới" mỗi ngày.
        // Mã mới vào đệm lần đầu: đặt mốc xa (1970) để không báo nhầm cho hồ sơ vừa đồng bộ trước đó.
        if (change === "changed") row.changed_at = now.toISOString();
        else if (change === "new") row.changed_at = new Date(0).toISOString();
        const { error } = await supabase.from("finance_financials_cache").upsert(row, { onConflict: "symbol" });
        if (error) throw error;
        refreshed++;
        if (change === "changed") changed.push(sym);
      } catch (_e) {
        failed.push(sym);
      }
    }));
  }

  // Lần chạy không làm gì (mọi mã còn mới) KHÔNG ghi đè trạng thái, để người dùng vẫn thấy lần làm mới thật gần nhất
  if (todo.length) {
    const status = summarize({ ranAt: now.toISOString(), total: symbols.length, tried: todo.length, refreshed, changed, failed });
    await supabase.from("app_settings").upsert({ key: "financials_refresh_status", value: JSON.stringify(status), updated_by: "refresh-financials", updated_at: now.toISOString() });
  }
  return json({ ok: true, symbols: symbols.length, tried: todo.length, refreshed, changed: changed.length, failed: failed.length });
});
