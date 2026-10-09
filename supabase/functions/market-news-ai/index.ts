// Edge Function: market-news-ai -- TÓM TẮT TIN THỊ TRƯỜNG BẰNG AI (Gemini hoặc Claude) cho trang "Tổng Quan TT". Lấy tin từ hàm market-news (RSS 5 báo, đã chuẩn hoá và kiểm tên miền), gửi tiêu đề + mô tả ngắn của tối đa 60 tin
// mới nhất cho mô hình AI (Gemini hoặc Claude), nhận về một bản tóm tắt có dẫn số tin làm căn cứ. KHÔNG đụng cơ sở dữ liệu. Khoá API đọc từ biến môi trường GEMINI_API_KEY hoặc ANTHROPIC_API_KEY (đặt trong Supabase > Edge Functions > Secrets), không bao giờ nằm trong mã.
// Biến tuỳ chọn: AI_PROVIDER (gemini | claude; không đặt thì tự chọn theo khoá có sẵn, ưu tiên Gemini), AI_MODEL (danh sách mô hình cách nhau bởi dấu phẩy, thử theo thứ tự; mặc định Gemini 3.8 Flash rồi lần lượt xuống 3.7, 3.6, 3.5 Flash, 3.5 Flash-Lite, 3.1 Flash-Lite, hoặc claude-haiku-4-5-20251001), AI_DAILY_CAP (mặc định 60 lượt/ngày/phiên bản chạy), AI_THINKING (minimal | low | medium | high | none: mức "suy nghĩ" gửi cho Gemini 3.x, mặc định low).
// Vào: {} . Ra: { ok, headline, points: [{ topic, text, refs: [{ n, title, link, sourceName }] }], model, generatedAt, itemCount, cached, ageSec } hoặc { ok:false, code, error }.
// Chưa có khoá: 503 code no_key (trang hiện hướng dẫn). verify_jwt = true. {"probe":true} gọi thử từng mô hình (5 phút một lần). {"selftest":true} trả { ok, hasKey, provider, model, models, cooling } (chỉ cho biết đã có khoá hay chưa, không lộ khoá), không gọi AI.
import { DAILY_CAP_DEFAULT, buildPrompt, callAi, chainFor, createCooldown, createGate, fail, parseModel, pickProvider, resolveSummary, selectItems, statusFor, summarizeWithFallback } from "./ai.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });

const cooldown = createCooldown(() => Date.now());
const THINKING_OK = ["", "none", "minimal", "low", "medium", "high"];
// Mức "suy nghĩ" gửi cho Gemini 3.x: mặc định low (đo thật 09/10/2026: không đặt thì 3.5 Flash mất 9,6 giây và 3.7/3.8 quá 25 giây cho cả một câu ngắn; đặt low thì còn 1-2 giây, riêng 3.8 vẫn ~10 giây khi đông). AI_THINKING=none để tắt.
const envThinking = () => { const v = (Deno.env.get("AI_THINKING") || "low").trim().toLowerCase(); return THINKING_OK.includes(v) && v !== "none" && v !== "" ? v : (v === "none" ? "" : "low"); };
let lastProbe = 0;
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
  const pick = pickProvider({ provider: Deno.env.get("AI_PROVIDER") || "", geminiKey: Deno.env.get("GEMINI_API_KEY") || "", anthropicKey: Deno.env.get("ANTHROPIC_API_KEY") || "" });
  const models = chainFor(pick ? pick.provider : "gemini", Deno.env.get("AI_MODEL") || "");
  if (body && body.selftest === true) return json({ ok: true, hasKey: !!pick, provider: pick ? pick.provider : null, model: models[0], models, cooling: cooldown.state().map((c) => c.model) });
  if (!pick) { const f = fail("no_key"); return json(f, statusFor(f.code)); }
  // Chẩn đoán: gọi SONG SONG từng mô hình trong chuỗi bằng một câu rất ngắn, trả mã, thời gian và lời báo lỗi ngắn (đã bỏ khoá). Chạy tối đa 5 phút một lần; body.thinking thử mức suy nghĩ khác.
  if (body && body.probe === true) {
    if (Date.now() - lastProbe < 5 * 60000) return json({ ok: false, code: "cap", error: "Chẩn đoán chỉ chạy 5 phút một lần." }, 429);
    lastProbe = Date.now();
    const th = typeof body.thinking === "string" && THINKING_OK.includes(body.thinking.toLowerCase()) ? (body.thinking.toLowerCase() === "none" ? "" : body.thinking.toLowerCase()) : envThinking();
    const results = await Promise.all(models.map(async (m) => {
      const t0 = Date.now(), r: any = await callAi({ provider: pick.provider, key: pick.key, model: m, system: "Chỉ trả JSON.", user: "Trả về {\"ok\": true}", fetchFn: fetch, signal: AbortSignal.timeout(25000), thinking: th || undefined, maxTokens: 512 });
      return { model: m, ok: r.ok, ms: Date.now() - t0, code: r.ok ? null : r.code, status: r.ok ? null : (r.status ?? null), detail: r.ok ? null : (r.detail ?? null) };
    }));
    return json({ ok: true, provider: pick.provider, thinking: th || null, results });
  }
  const r = await gate.run(async () => {
    const now = Date.now(), items = selectItems(await fetchNews(req), now);
    if (!items.length) return fail("no_news");
    const p = buildPrompt(items, now);
    const res = await summarizeWithFallback({
      models, cooldown, now: () => Date.now(), budgetMs: 40000,
      attempt: (m) => callAi({ provider: pick.provider, key: pick.key, model: m, system: p.system, user: p.user, fetchFn: fetch, signal: AbortSignal.timeout(12000), thinking: envThinking() || undefined }),
      parse: (text) => parseModel(text, items.length),
    });
    if (!res.ok) return { ok: false as const, code: res.code, error: res.error };
    const value = resolveSummary(res.parsed, items, res.model, now);
    if (res.skipped.length) value.skipped = res.skipped;
    return { ok: true as const, value };
  });
  if (!r.ok) return json(r, statusFor(r.code));
  return json({ ok: true, ...r.value, cached: r.cached, ageSec: r.ageSec });
});
