// Edge Function: live-quotes -- GIÁ TRỰC TIẾP trong phiên cho Danh Mục, lấy từ bảng giá VCI (Vietcap). Chỉ ĐỌC từ nguồn ngoài, KHÔNG đụng cơ sở dữ liệu và không dùng khoá bí mật.
// Vì sao qua máy chủ: bảng giá VCI chỉ cho phép gọi từ trang của chính họ (CORS), nên ứng dụng không gọi thẳng được. Hàm này gọi thay và giữ bộ nhớ đệm vài giây để nhiều người dùng cùng lúc chỉ tốn một lượt gọi VCI.
// Vào: { symbols: ["FPT", ...] } (tối đa 80 mã). Ra: { ok, quotes: { SYM: {price, ref, ceil, floor, open, high, low, volume, bid, ask, exchange} } (giá tính bằng đồng), missing, failed, asOf (ISO), source: "vci" }.
// verify_jwt = true: chỉ người đã đăng nhập (hoặc khoá publishable) gọi được. {"selftest":true} chạy không đụng mạng.
// Nguồn không có cam kết dịch vụ: có thể đổi hoặc chặn bất cứ lúc nào; ứng dụng tự quay về giá VNDirect khi hàm này lỗi.
import { collect, GROUPS, MAX_SYMBOLS, validateRequest } from "./parse.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });

const VCI_URL = "https://trading.vietcap.com.vn/api/price/v1/w/priceboard/tickers/price/group";
const VCI_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; WorkHubPriceSync/1.0)", "Accept": "application/json", "Content-Type": "application/json",
  "Origin": "https://trading.vietcap.com.vn", "Referer": "https://trading.vietcap.com.vn/",
};
const CACHE_MS = 3000;
const cache = new Map<string, { at: number; rows: any[] }>();
const inflight = new Map<string, Promise<any[] | null>>();

async function loadBoard(group: string): Promise<any[] | null> {
  const hit = cache.get(group);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const running = inflight.get(group);
  if (running) return running;                       // nhiều yêu cầu cùng lúc dùng chung một lượt gọi
  const p = (async () => {
    try {
      const res = await fetch(VCI_URL, { method: "POST", headers: VCI_HEADERS, body: JSON.stringify({ group }), signal: AbortSignal.timeout(12000) });
      if (!res.ok) return null;
      const rows = await res.json();
      if (!Array.isArray(rows) || !rows.length) return null;
      cache.set(group, { at: Date.now(), rows });
      return rows;
    } catch (_e) { return hit ? hit.rows : null; }  // lỗi mạng: dùng bản đệm cũ nếu có (vẫn tốt hơn không có)
    finally { inflight.delete(group); }
  })();
  inflight.set(group, p);
  return p;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng */ }
  if (body && body.selftest === true) return json({ ok: true, groups: GROUPS, max: MAX_SYMBOLS });
  const v = validateRequest(body);
  if ("error" in v) return json({ ok: false, error: v.error }, 400);
  const r = await collect(v.symbols, loadBoard);
  if (!r.boards.length) return json({ ok: false, error: "Không lấy được bảng giá từ nguồn.", failed: r.failed }, 502);
  return json({ ok: true, quotes: r.quotes, missing: r.missing, failed: r.failed, asOf: new Date().toISOString(), source: "vci" });
});
