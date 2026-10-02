// Edge Function: stock-financials -- số liệu tài chính của doanh nghiệp niêm yết để điền tự động vào Định Giá CP:
// báo cáo năm (vốn điều lệ, vốn chủ, lợi nhuận, doanh thu, tổng tài sản), lợi nhuận/doanh thu từng quý riêng lẻ và cổ tức tiền mặt theo năm.
// Nguồn: VNDirect finfo v4 (financial_statements, events) -- cùng nguồn với fetch-stock-prices / stock-history.
// Triển khai: Supabase MCP deploy_edge_function (verify_jwt = true). CHỈ cho người dùng đã đăng nhập (kiểm tra JWT người dùng), để hàm không thành
// "proxy mở" tới VNDirect. Body: { symbol: "FPT" } hoặc { symbols: ["FPT","VCB"] } (tối đa 5)
// -> { ok, results: { FPT: { form, annual: [...], quarters: [...], dividends: { "2025": 2000 } } }, errors: { XXX: "..." }, fetchedAt }.
// Đơn vị: đồng (VND) cho mọi số tiền; cổ tức là đồng/cổ phiếu. Phía app tự quy đổi sang đơn vị người dùng chọn.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ANNUAL_ITEMS, ANNUAL_MODELS, QUARTER_ITEMS, QUARTER_MODELS, buildFinancials, validateRequest, type EventRow, type Row } from "./parse.ts";

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
  if (annual === null && quarter === null) throw new Error("Không lấy được báo cáo tài chính từ nguồn dữ liệu.");
  if (!(annual ?? []).length && !(quarter ?? []).length) throw new Error("Nguồn dữ liệu chưa có báo cáo tài chính cho mã này (kiểm tra lại mã).");
  return buildFinancials((annual ?? []) as Row[], (quarter ?? []) as Row[], (events ?? []) as EventRow[]);
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

  const results: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  await Promise.all(v.symbols.map(async (s) => {
    try { results[s] = await financialsFor(s); } catch (e) { errors[s] = String((e as Error).message || e); }
  }));
  return json({ ok: Object.keys(results).length > 0, results, errors, fetchedAt: new Date().toISOString() });
});
