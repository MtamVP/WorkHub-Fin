// Edge Function: stock-events -- sự kiện doanh nghiệp của các mã bạn nắm: cổ tức tiền, cổ tức bằng cổ phiếu, cổ phiếu thưởng, phát hành thêm cho cổ đông hiện hữu.
// Nguồn: VNDirect finfo v4 /events (cùng nguồn với stock-financials / stock-history).
// Triển khai: Supabase MCP deploy_edge_function (verify_jwt = true) và còn kiểm tra JWT người dùng trong code, để hàm không thành "proxy mở".
// Body: { symbols: ["FPT","HPG"], since: "2024-01-01" } (tối đa 30 mã) -> { ok, events: [CorporateEvent], errors: { XXX: "..." }, fetchedAt }.
// Tiền tính bằng đồng (dps = đồng/cp); ratio = % (15 nghĩa là 100:15). Việc đối chiếu với sổ lệnh của người dùng nằm ở phía app (lib/corporate-events.js).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EVENT_TYPES, buildEvents, validateRequest, type CorporateEvent, type EventRow } from "./parse.ts";

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

// Mỗi lần gom tối đa 6 mã vào 1 truy vấn để khỏi chạm giới hạn kích thước trang của nguồn
async function fetchChunk(symbols: string[], since: string): Promise<EventRow[] | null> {
  const q = `code:${symbols.join(",")}~type:${EVENT_TYPES.join(",")}~locale:VN~effectiveDate:gte:${since}`;
  return await getData(`${BASE}/events?q=${q}&sort=effectiveDate&size=400`) as EventRow[] | null;
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

  const chunks: string[][] = [];
  for (let i = 0; i < v.symbols.length; i += 6) chunks.push(v.symbols.slice(i, i + 6));
  const errors: Record<string, string> = {};
  const rows: EventRow[] = [];
  await Promise.all(chunks.map(async (c) => {
    const got = await fetchChunk(c, v.since);
    if (got === null) c.forEach((s) => { errors[s] = "Không lấy được sự kiện từ nguồn dữ liệu."; });
    else rows.push(...got);
  }));
  const events: CorporateEvent[] = buildEvents(rows, v.since);
  return json({ ok: Object.keys(errors).length < v.symbols.length, events, errors, fetchedAt: new Date().toISOString() });
});
