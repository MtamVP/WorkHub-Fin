// Edge Function: stock-history -- giá đóng cửa theo ngày (lịch sử) của một số mã + VN-Index, cho báo cáo cuối tháng và để lấy giá ngay khi thêm mã vào
// danh sách theo dõi. Nguồn: VNDirect dchart-api (chính), VNDirect finfo v4 (dự phòng, chỉ cổ phiếu) -- cùng nguồn với fetch-stock-prices.
// Triển khai: Supabase MCP deploy_edge_function (verify_jwt = true). CHỈ cho người dùng đã đăng nhập (kiểm tra JWT người dùng), để hàm không thành
// "proxy mở" tới VNDirect. Body: { symbols: ["SSI","VNINDEX"], from: "YYYY-MM-DD", to: "YYYY-MM-DD" } -> { ok, series: { SSI: [[ngày, giá VND]...] }, missing: [...] }.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { INDEX_CODES, parseDchart, parseFinfo, validateRequest, type Series } from "./parse.ts";

const UA = { "User-Agent": "Mozilla/5.0 (compatible; WorkHubPriceSync/1.0)" };
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (_e) {
    return null;
  }
}

async function historyFor(symbol: string, from: string, to: string): Promise<Series> {
  // mở rộng 1 ngày mỗi đầu để chắc chắn gồm cả phiên biên (dchart tính theo giờ UTC)
  const fromSec = Math.floor(Date.parse(from + "T00:00:00Z") / 1000) - 86400;
  const toSec = Math.floor(Date.parse(to + "T00:00:00Z") / 1000) + 2 * 86400;
  const primary = parseDchart(
    await getJson(`https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=${symbol}&from=${fromSec}&to=${toSec}`),
    symbol,
  );
  const inRange = (s: Series) => s.filter(([d]) => d >= from && d <= to);
  if (primary.length) return inRange(primary);
  if (INDEX_CODES.has(symbol)) return [];
  const fallback = parseFinfo(
    await getJson(`https://api-finfo.vndirect.com.vn/v4/stock_prices?q=code:${symbol}~date:gte:${from}~date:lte:${to}&sort=date&size=500`),
  );
  return inRange(fallback);
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

  const series: Record<string, Series> = {};
  const missing: string[] = [];
  for (let i = 0; i < v.symbols.length; i += 5) {
    const batch = v.symbols.slice(i, i + 5);
    const results = await Promise.all(batch.map((s) => historyFor(s, v.from, v.to)));
    batch.forEach((s, j) => { if (results[j].length) series[s] = results[j]; else missing.push(s); });
  }
  return json({ ok: true, series, missing });
});
