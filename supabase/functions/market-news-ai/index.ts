// Edge Function: market-news-ai -- TÓM TẮT TIN THỊ TRƯỜNG BẰNG AI (Claude) cho trang "Tổng Quan TT". Lấy tin từ hàm market-news (RSS 5 báo, đã chuẩn hoá và kiểm tên miền), gửi tiêu đề + mô tả ngắn của tối đa 60 tin
// mới nhất cho Claude, nhận về một bản tóm tắt có dẫn số tin làm căn cứ. KHÔNG đụng cơ sở dữ liệu. Khoá API đọc từ biến môi trường ANTHROPIC_API_KEY (đặt trong Supabase > Edge Functions > Secrets), không bao giờ nằm trong mã.
// Biến tuỳ chọn: AI_MODEL (mặc định claude-haiku-4-5-20251001), AI_DAILY_CAP (mặc định 60 lượt/ngày/phiên bản chạy).
// Vào: {} . Ra: { ok, headline, points: [{ topic, text, refs: [{ n, title, link, sourceName }] }], model, generatedAt, itemCount, cached, ageSec } hoặc { ok:false, code, error }.
// Chưa có khoá: 503 code no_key (trang hiện hướng dẫn). verify_jwt = true. {"selftest":true} trả { ok, hasKey, model } (chỉ cho biết đã có khoá hay chưa, không lộ khoá), không gọi AI.
import { MODEL_DEFAULT, DAILY_CAP_DEFAULT, buildPrompt, callClaude, createGate, fail, parseModel, resolveSummary, selectItems, statusFor } from "./ai.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });

const gate = createGate({ now: () => Date.now(), cap: Number(Deno.env.get("AI_DAILY_CAP")) > 0 ? Number(Deno.env.get("AI_DAILY_CAP")) : DAILY_CAP_DEFAULT });

// Tin lấy từ hàm market-news cùng dự án (chuyển tiếp chính tiêu đề xác thực của người gọi)
async function fetchNews(req: Request): Promise<any[]> {
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) return [];
  const headers: Record<string, string> = { "content-type": "application/json" };
  const a = req.headers.get("authorization"), k = req.headers.get("apikey");
  if (a) headers["authorization"] = a;
  if (k) headers["apikey"] = k;
  try {
    const res = await fetch(base + "/functions/v1/market-news", { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const j = await res.json();
    return j && j.ok && Array.isArray(j.items) ? j.items : [];
  } catch (_e) { return []; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng */ }
  const key = Deno.env.get("ANTHROPIC_API_KEY") || "", model = Deno.env.get("AI_MODEL") || MODEL_DEFAULT;
  if (body && body.selftest === true) return json({ ok: true, hasKey: key.length > 0, model });
  if (!key) { const f = fail("no_key"); return json(f, statusFor(f.code)); }
  const r = await gate.run(async () => {
    const now = Date.now(), items = selectItems(await fetchNews(req), now);
    if (!items.length) return fail("no_news");
    const p = buildPrompt(items, now);
    const c = await callClaude({ key, model, system: p.system, user: p.user, fetchFn: fetch, signal: AbortSignal.timeout(28000) });
    if (!c.ok) return c;
    const parsed = parseModel(c.text, items.length);
    if (!parsed) return fail("bad_output");
    return { ok: true as const, value: resolveSummary(parsed, items, model, now) };
  });
  if (!r.ok) return json(r, statusFor(r.code));
  return json({ ok: true, ...r.value, cached: r.cached, ageSec: r.ageSec });
});
