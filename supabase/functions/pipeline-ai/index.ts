// Edge Function: pipeline-ai -- cầu Gemini cho trang Pipeline (xử lý tài liệu và viết báo cáo nháp). TRƯỚC ĐÂY 5 khoá Gemini nằm cứng trong pipeline/pipeline.js (đóng gói vào app, nằm trong git công khai):
// nay trình duyệt chỉ gửi lời nhắc lên đây, khoá đọc từ biến môi trường GEMINI_API_KEY (cùng khoá với market-news-ai). Cần đăng nhập (auth.getUser), có trần lượt/ngày theo người dùng.
// Vào: { prompt: string, json?: boolean, model?: string }. Ra: { ok: true, text, model } hoặc { ok: false, code, error }.
// Mô hình: thử lần lượt AI_MODEL (danh sách cách nhau bởi dấu phẩy) hoặc mặc định gemini-3.5-flash, gemini-3.5-flash-lite; 429 / 5xx thì sang mô hình kế. {"selftest":true} báo có khoá hay không (không lộ giá trị).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });

const MAX_PROMPT = 200_000;
const DEFAULT_MODELS = ["gemini-3.5-flash", "gemini-3.5-flash-lite"];
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{2,40}$/;
const DAILY_CAP = Number(Deno.env.get("PIPELINE_AI_DAILY_CAP")) > 0 ? Number(Deno.env.get("PIPELINE_AI_DAILY_CAP")) : 300;
const used = new Map<string, { day: string; n: number }>();      // theo phiên bản chạy của hàm (đủ để chặn lạm dụng; không phải hạn mức tài chính)

function models(wanted: unknown): string[] {
  const env = (Deno.env.get("AI_MODEL") || "").split(",").map((s) => s.trim()).filter((s) => MODEL_RE.test(s));
  const base = env.length ? env : DEFAULT_MODELS;
  const w = typeof wanted === "string" && MODEL_RE.test(wanted.trim()) ? wanted.trim() : "";
  return w ? [w].concat(base.filter((m) => m !== w)) : base;
}

async function callOnce(key: string, model: string, prompt: string, asJson: boolean, signal: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  let res: Response;
  try {
    res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
      method: "POST", signal,
      headers: { "x-goog-api-key": key, "content-type": "application/json" },     // khoá ở tiêu đề, không ở địa chỉ (khỏi lọt nhật ký)
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: Object.assign({ temperature: 0.2 }, asJson ? { responseMimeType: "application/json" } : {}) }),
    });
  } catch (_e) { return { ok: false, status: 0 }; }
  if (!res.ok) return { ok: false, status: res.status };
  let j: any;
  try { j = await res.json(); } catch (_e) { return { ok: false, status: 502 }; }
  const parts = j && Array.isArray(j.candidates) && j.candidates[0] && j.candidates[0].content && Array.isArray(j.candidates[0].content.parts) ? j.candidates[0].content.parts : [];
  const text = parts.filter((p: any) => p && typeof p.text === "string" && !p.thought).map((p: any) => p.text).join("");
  return text.trim() ? { ok: true, text } : { ok: false, status: 502 };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, code: "method", error: "Chỉ nhận POST." }, 405);

  let body: any = null;
  try { body = await req.json(); } catch (_e) { /* thân không phải JSON: báo lỗi bên dưới */ }
  const key = Deno.env.get("GEMINI_API_KEY") || "";
  if (body && body.selftest === true) return json({ ok: true, hasKey: !!key, models: models(null), cap: DAILY_CAP });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: auth, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !auth?.user) return json({ ok: false, code: "auth", error: "Cần đăng nhập." }, 401);

  if (!key) return json({ ok: false, code: "no_key", error: "Máy chủ chưa đặt khoá Gemini (GEMINI_API_KEY). Nhờ quản trị đặt khoá." }, 503);
  const prompt = body && typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) return json({ ok: false, code: "bad_request", error: "Thiếu lời nhắc." }, 400);
  if (prompt.length > MAX_PROMPT) return json({ ok: false, code: "too_long", error: "Lời nhắc quá dài (tối đa " + MAX_PROMPT + " ký tự)." }, 413);

  const today = new Date().toISOString().slice(0, 10), u = used.get(auth.user.id);
  const rec = u && u.day === today ? u : { day: today, n: 0 };
  if (rec.n >= DAILY_CAP) return json({ ok: false, code: "cap", error: "Đã hết " + DAILY_CAP + " lượt AI hôm nay cho tài khoản này." }, 429);
  rec.n++; used.set(auth.user.id, rec);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 110_000);
  try {
    let lastStatus = 0;
    for (const model of models(body.model)) {
      const r = await callOnce(key, model, prompt, body.json === true, ctrl.signal);
      if (r.ok) return json({ ok: true, text: r.text, model });
      lastStatus = r.status;
      if (r.status === 401 || r.status === 403 || r.status === 400) break;        // khoá sai / lời nhắc bị từ chối: đổi mô hình không giúp ích
    }
    const code = lastStatus === 429 ? "rate_limited" : (lastStatus === 401 || lastStatus === 403 ? "invalid_key" : "upstream");
    return json({ ok: false, code, error: code === "rate_limited" ? "Gemini đang quá tải, thử lại sau ít phút." : (code === "invalid_key" ? "Khoá Gemini trên máy chủ không hợp lệ." : "Gemini không trả kết quả (" + lastStatus + ")." ) }, code === "rate_limited" ? 429 : 502);
  } finally { clearTimeout(timer); }
});
