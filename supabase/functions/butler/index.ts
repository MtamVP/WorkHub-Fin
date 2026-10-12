// Edge Function: butler -- QUẢN GIA (trợ lý trong app WorkHub Fin). Nhận câu hỏi của người dùng, trả lời bằng QUY TẮC trước (chỉ đường tới đúng chức năng, việc hôm nay), chỉ gọi AI (Gemini miễn phí) khi quy tắc không chắc.
// BẢO MẬT: hàm chạy hoàn toàn bằng JWT của NGƯỜI HỎI (client dựng từ khoá công khai + tiêu đề Authorization của họ) nên RLS của chính họ giới hạn dữ liệu; KHÔNG dùng service role (tests/unit/butler-edge.test.js chặn).
//   Không công cụ nào ghi dữ liệu. AI chỉ chọn id tính năng / công cụ trong danh mục (server kiểm lại), không bịa đường dẫn hay số liệu; đường dẫn do trang dựng từ lib/links.js.
// Vào: { q: "câu hỏi", ctx: { page, sym }, ai: true|false (mặc định true), feedback?: { id, rating: 1|-1 } } .  Ra: { ok, mode: 'rule'|'ai', intent, text, cards, notices, model?, logId? } hoặc { ok:false, code, error }.
//   {"selftest":true} (không cần đăng nhập): { ok, hasKey, provider, models, version, tools }. {"probe":true} (cần đăng nhập, 5 phút một lần): thử từng mô hình bằng một câu rất ngắn.
// Biến môi trường: BUTLER_GEMINI_KEY (khoá riêng, nên đặt ở dự án Google khác để không tranh hạn mức với tóm tắt tin) hoặc GEMINI_API_KEY (dùng chung với market-news-ai); BUTLER_MODEL (danh sách mô hình, thử theo thứ tự);
//   BUTLER_DAILY_CAP (số lượt AI mỗi người mỗi ngày, mặc định 30). Khi hết lượt / hết hạn mức / AI lỗi: Quản gia vẫn trả phần xây bằng quy tắc, kèm một dòng thông báo.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "./butler-core.js";
import "./butler-map-fin.js";
import { callAi, chainFor, createCooldown, fail, pickProvider, statusFor, summarizeWithFallback } from "./ai.ts";
import { fetchGuide, fetchToday, type Me } from "./tools.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
const BC = () => (globalThis as any).ButlerCore;
const MAP = () => (globalThis as any).ButlerMapFin;

export const BUTLER_MODELS_DEFAULT = "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.6-flash";
const capDefault = () => { const n = Number(Deno.env.get("BUTLER_DAILY_CAP")); return n > 0 && n <= 200 ? Math.floor(n) : 30; };
const cooldown = createCooldown(() => Date.now());
let lastProbe = 0;

// Chỉ mục hướng dẫn sử dụng đọc từ bảng butler_guide (mọi người dùng đăng nhập đọc được; sinh từ docs/huong-dan-su-dung.html, xem scripts/build-guide-web.mjs). Đệm 10 phút dùng chung mọi người; lỗi thì giữ bản cũ, không có bản nào thì trả lời không kèm hướng dẫn.
let guideCache: { at: number; data: any } | null = null;
const GUIDE_TTL = 10 * 60000;
async function loadGuide(sb: any) {
  if (guideCache && Date.now() - guideCache.at < GUIDE_TTL) return guideCache.data;
  try {
    const g = await fetchGuide(sb);
    if (g) guideCache = { at: Date.now(), data: g };
    else if (guideCache) guideCache.at = Date.now() - GUIDE_TTL + 60000;
  } catch (_e) { if (guideCache) guideCache.at = Date.now() - GUIDE_TTL + 60000; }          // lỗi đọc: thử lại sau 1 phút, trong lúc đó dùng bản cũ
  return guideCache ? guideCache.data : null;
}

// Bộ nhớ đệm kế hoạch AI (kế hoạch chỉ chứa id nên dùng chung được cho mọi người): cùng một câu hỏi trong 30 phút không tốn thêm lượt
const planCache = new Map<string, { at: number; plan: any; model: string }>();
const PLAN_TTL = 30 * 60000, PLAN_MAX = 300;
function cacheGet(k: string) { const v = planCache.get(k); if (!v) return null; if (Date.now() - v.at > PLAN_TTL) { planCache.delete(k); return null; } return v; }
function cachePut(k: string, plan: any, model: string) { if (planCache.size >= PLAN_MAX) planCache.delete(planCache.keys().next().value as string); planCache.set(k, { at: Date.now(), plan, model }); }

function aiConfig() {
  const key = (Deno.env.get("BUTLER_GEMINI_KEY") || Deno.env.get("GEMINI_API_KEY") || "").trim();
  const pick = pickProvider({ provider: "gemini", geminiKey: key, anthropicKey: "" });
  const models = chainFor("gemini", Deno.env.get("BUTLER_MODEL") || BUTLER_MODELS_DEFAULT);
  return { pick, models, hasKey: !!pick, separateKey: !!(Deno.env.get("BUTLER_GEMINI_KEY") || "").trim() };
}

// Gọi hàm butler-data cùng dự án, chuyển tiếp chính tiêu đề xác thực của người hỏi (hàm kia cũng chạy bằng JWT của họ nên RLS giữ nguyên)
async function callData(req: Request, tool: string, args: any): Promise<{ ok: true; facts: any } | { ok: false; code: string; error: string }> {
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) return { ok: false, code: "upstream", error: "thiếu cấu hình máy chủ" };
  const headers: Record<string, string> = { "content-type": "application/json" };
  const a = req.headers.get("authorization"), k = req.headers.get("apikey");
  if (a) headers["authorization"] = a;
  if (k) headers["apikey"] = k;
  try {
    const res = await fetch(base + "/functions/v1/butler-data", { method: "POST", headers, body: JSON.stringify({ tool, args: args || {} }), signal: AbortSignal.timeout(25000) });
    let j: any = null;
    try { j = await res.json(); } catch (_e) { /* thân không phải JSON */ }
    if (res.ok && j && j.ok) return { ok: true, facts: j.facts };
    return { ok: false, code: String((j && j.code) || "upstream"), error: String((j && j.error) || "máy chủ dữ liệu không trả lời") };
  } catch (_e) { return { ok: false, code: "upstream", error: "không kết nối được máy chủ dữ liệu" }; }
}

function userClient(req: Request) {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("authorization") || "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function whoAmI(sb: any, req: Request): Promise<{ me: Me; role: string } | { error: string; status: number }> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token.split(".").length !== 3) return { error: "Cần đăng nhập để dùng Quản gia.", status: 401 };
  const { data: au, error: ae } = await sb.auth.getUser(token);
  const email = String(au?.user?.email || "").trim().toLowerCase();
  if (ae || !email) return { error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.", status: 401 };
  const { data: rows, error: ue } = await sb.from("users").select("id, email, nickname, group_key, active").ilike("email", email).limit(5);
  if (ue) return { error: "Không đọc được hồ sơ người dùng.", status: 500 };
  const u = (rows || []).find((r: any) => String(r.email || "").toLowerCase() === email);
  if (!u) return { error: "Tài khoản chưa có hồ sơ trong WorkHub.", status: 403 };
  if (u.active === false) return { error: "Tài khoản đã bị vô hiệu hoá.", status: 403 };
  let role = "editor";
  try { const r = await sb.rpc("current_user_role", { p_group_key: "finance" }); if (!r.error && typeof r.data === "string") role = r.data; } catch (_e) { /* mặc định editor như hàm SQL */ }
  const group = String(u.group_key || "guest");
  return { me: { id: u.id, email, nickname: String(u.nickname || email.split("@")[0]), group, admin: group === "admin" }, role };
}

// Ghi nhật ký dùng (không có nội dung câu hỏi); lỗi ghi không bao giờ làm hỏng câu trả lời
async function writeLog(sb: any, me: Me, row: Record<string, unknown>): Promise<string | null> {
  try {
    const { data, error } = await sb.from("butler_log").insert(Object.assign({ user_id: me.id }, row)).select("id").single();
    return error ? null : (data?.id ?? null);
  } catch (_e) { return null; }
}

async function takeAiTurn(sb: any): Promise<{ ok: boolean; used?: number; cap?: number; reason?: string }> {
  try {
    const { data, error } = await sb.rpc("fn_butler_take", { p_cost: 1, p_cap: capDefault() });
    if (error || !data) return { ok: false, reason: "usage" };
    return data;
  } catch (_e) { return { ok: false, reason: "usage" }; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng */ }
  const cfg = aiConfig();
  if (body && body.selftest === true) {
    const C = BC(), M = MAP();
    return json({ ok: true, hasKey: cfg.hasKey, separateKey: cfg.separateKey, provider: cfg.pick ? cfg.pick.provider : null, models: cfg.models, cooling: cooldown.state().map((c) => c.model), dailyCap: capDefault(), version: C.VERSION, features: M.features.length, guide: guideCache ? guideCache.data.sections.length : 0, guideVersion: guideCache ? guideCache.data.version : null, tools: Object.keys(C.TOOLS).filter((k) => C.TOOLS[k].enabled) });
  }
  const sb = userClient(req);
  const who = await whoAmI(sb, req);
  if ("error" in who) return json({ ok: false, code: "auth", error: who.error }, who.status);
  const { me, role } = who, C = BC(), M = MAP(), t0 = Date.now();
  const user = { group: me.group, admin: me.admin, role };
  const GD = await loadGuide(sb);

  if (body && body.probe === true) {
    if (!cfg.pick) { const f = fail("no_key"); return json(f, statusFor(f.code)); }
    if (Date.now() - lastProbe < 5 * 60000) return json({ ok: false, code: "cap", error: "Chẩn đoán chỉ chạy 5 phút một lần." }, 429);
    lastProbe = Date.now();
    const pick = cfg.pick;
    const results = await Promise.all(cfg.models.map(async (m) => {
      const s = Date.now(), r: any = await callAi({ provider: pick.provider, key: pick.key, model: m, system: "Chỉ trả JSON.", user: "Trả về {\"ok\": true}", fetchFn: fetch, signal: AbortSignal.timeout(20000), thinking: "low", maxTokens: 256 });
      return { model: m, ok: r.ok, ms: Date.now() - s, code: r.ok ? null : r.code, status: r.ok ? null : (r.status ?? null), detail: r.ok ? null : (r.detail ?? null) };
    }));
    return json({ ok: true, results });
  }

  // Phản hồi 👍/👎: chỉ sửa dòng nhật ký của chính người dùng (RLS)
  if (body && body.feedback && typeof body.feedback === "object") {
    const id = String(body.feedback.id || ""), rating = Number(body.feedback.rating);
    if (!/^[0-9a-f-]{36}$/i.test(id) || (rating !== 1 && rating !== -1)) return json({ ok: false, code: "bad_request", error: "Phản hồi không hợp lệ." }, 400);
    const { error } = await sb.from("butler_log").update({ rating }).eq("id", id).eq("user_id", me.id);
    return error ? json({ ok: false, code: "upstream", error: "Không ghi được phản hồi." }, 502) : json({ ok: true });
  }

  const q = C.sanitizeQuestion(body && body.q);
  const ctx = { page: typeof body?.ctx?.page === "string" ? body.ctx.page.slice(0, 80) : "", sym: C.validArg("sym", body?.ctx?.sym) || "" };
  const und = C.understand(q, { sym: ctx.sym }, M, GD);
  const useAi = !(body && body.ai === false);
  const notices: string[] = [];
  const tools: string[] = [];
  let reply: { text: string; cards: any[] } | null = null, mode = "rule", intent = und.intent, model = "", fallback = "";

  // Hỏi "cách làm / ở đâu" mà hướng dẫn sử dụng cũng có phần khớp rõ: đưa thêm một thẻ "xem thêm trong hướng dẫn" sau câu chỉ đường
  function withGuide(r: { text: string; cards: any[] }, u: any) {
    const g = (u.guide || []).filter((x: any) => x.score >= 5).slice(0, 2);
    if (!g.length) return r;
    const x = C.composeGuide(g.map((y: any) => y.id), GD, { extra: true });
    return { text: r.text, cards: r.cards.concat(x.cards.filter((c: any) => c.type === "guide")) };
  }
  async function doToday() {
    tools.push("today");
    // Việc / lịch (bắt buộc) + tín hiệu đầu tư (tuỳ chọn: thiếu quyền hoặc lỗi thì bỏ qua, không làm hỏng câu trả lời)
    const [data, sg] = await Promise.all([fetchToday(sb, me, Date.now()), callData(req, "signals", {})]);
    if (sg.ok) tools.push("signals");
    return C.composeToday(data, Date.now(), sg.ok ? sg.facts : null);
  }
  // Công cụ dữ liệu (hàm butler-data, cùng JWT người hỏi). Lỗi / không đủ quyền -> không bịa: trả lối tới màn hình tương ứng kèm lý do.
  const FEATURE_OF: Record<string, string> = { portfolio: "assets-holdings", group: "group-portfolio", limits: "group-limits", approvals: "group-approvals" };
  async function doData(tool: string, args: any) {
    tools.push(tool);
    const r = await callData(req, tool, args);
    if (r.ok) {
      const c = C.composeData(tool, r.facts, args);
      if (c) { if (c.notices) notices.push(...c.notices); return { text: c.text, cards: c.cards }; }
    }
    const f = FEATURE_OF[tool] ? C.composeFeatures([FEATURE_OF[tool]], M, user, "") : (args && args.sym ? C.composeSymbol(args.sym) : C.composeHelp(M));
    if (!r.ok && r.code === "forbidden") return { text: r.error, cards: f.cards };
    notices.push("Chưa đọc được số liệu lúc này (" + (r.ok ? "không dựng được câu trả lời" : r.error) + "); bạn có thể xem trực tiếp ở màn hình dưới đây.");
    return { text: f.text, cards: f.cards };
  }

  try {
    if (und.intent === "help") reply = C.composeHelp(M);
    else if (und.intent === "symbol") reply = C.composeSymbol(und.sym);
    else if (und.intent === "today") reply = await doToday();
    else if (und.intent === "data" && und.data) reply = await doData(und.data.tool, und.data.args);
    else if (und.intent === "guide" && und.confident) reply = C.composeGuide(und.guide.slice(0, 3).map((g: any) => g.id), GD);
    else if (und.intent === "features" && und.confident) reply = withGuide(C.composeFeatures(und.features.slice(0, 3).map((f: any) => f.id), M, user, und.sym), und);

    if (!reply) {
      // Quy tắc không chắc: hỏi AI chọn tính năng (một lượt), nếu được phép và còn lượt
      let plan: any = null;
      if (!useAi) fallback = "ai_off";
      else if (!cfg.pick) fallback = "no_key";
      else {
        const key = C.fold(q) + "|" + ctx.sym, hit = cacheGet(key);
        if (hit) { plan = hit.plan; model = hit.model; mode = "ai"; }
        else {
          const take = await takeAiTurn(sb);
          if (!take.ok) fallback = take.reason === "cap" ? "cap" : "usage";
          else {
            const p = C.buildPlanPrompt(q, M, ctx, GD), pick = cfg.pick;
            const res = await summarizeWithFallback({
              models: cfg.models, cooldown, now: () => Date.now(), budgetMs: 20000,
              attempt: (m: string) => callAi({ provider: pick.provider, key: pick.key, model: m, system: p.system, user: p.user, fetchFn: fetch, signal: AbortSignal.timeout(9000), thinking: "low", maxTokens: 400 }),
              parse: (text: string) => C.parsePlan(text, M, GD),
            });
            if (res.ok) { plan = (res as any).parsed; model = (res as any).model; mode = "ai"; cachePut(key, plan, model); }
            else fallback = String((res as any).code || "upstream");
          }
        }
      }
      if (plan) {
        const sym = plan.sym || und.sym;
        const dataTool = plan.intent === "data" ? plan.tools.find((t: any) => C.TOOLS[t.id] && C.TOOLS[t.id].data) : null;
        if (dataTool) { intent = "data"; reply = await doData(dataTool.id, dataTool.args); }
        else if (plan.intent === "today" || plan.tools.some((t: any) => t.id === "today")) { intent = "today"; reply = await doToday(); }
        else if (plan.intent === "guide") { intent = "guide"; reply = C.composeGuide(plan.guide, GD); }
        else if (plan.intent === "features") { intent = "features"; reply = withGuide(C.composeFeatures(plan.features, M, user, sym), und); }
        else { intent = "chat"; reply = { text: "Mình chỉ hỗ trợ các việc trong WorkHub Fin: chỉ đường tới chức năng, giải thích theo hướng dẫn sử dụng, việc hôm nay và số liệu trong phạm vi quyền của bạn. Bạn thử hỏi theo kiểu \"tôi muốn nhập sao kê\" hoặc \"hôm nay có việc gì\".", cards: [{ type: "chips", items: M.examples.slice(0, 6) }] }; }
      } else if (und.intent === "guide" && und.guide.length) {
        // Không dùng được AI: đưa các mục hướng dẫn khớp nhất, nói rõ là gợi ý
        intent = "guide";
        reply = C.composeGuide(und.guide.slice(0, 3).map((g: any) => g.id), GD);
        notices.push("Mình chưa chắc đây là điều bạn cần; đây là các mục hướng dẫn khớp nhất với câu hỏi.");
      } else if (und.features.length) {
        // Không dùng được AI: vẫn đưa các mục khớp nhất bằng quy tắc, nói rõ là gợi ý
        intent = "features";
        reply = C.composeFeatures(und.features.slice(0, 3).map((f: any) => f.id), M, user, und.sym);
        notices.push("Mình chưa chắc đây là điều bạn cần; đây là các mục khớp nhất với câu hỏi.");
      } else {
        reply = { text: "Mình chưa hiểu bạn muốn làm gì. Thử mô tả bằng vài từ khoá, ví dụ \"nhập sao kê\", \"giới hạn đầu tư\" hay \"hôm nay có việc gì\".", cards: [{ type: "chips", items: M.examples.slice(0, 6) }] };
      }
      if (fallback === "cap") notices.push("Bạn đã dùng hết lượt hỏi AI hôm nay; phần dưới là gợi ý theo quy tắc, lượt mới tính lại vào ngày mai.");
      else if (fallback === "rate_limited") notices.push("Dịch vụ AI miễn phí đang hết hạn mức; phần dưới là gợi ý theo quy tắc.");
      else if (fallback && fallback !== "ai_off") notices.push("Phần hiểu câu hỏi bằng AI tạm không dùng được; phần dưới là gợi ý theo quy tắc.");
    }
  } catch (e) {
    const msg = String((e as any)?.message || e);
    console.error("[butler] lỗi:", msg.slice(0, 200));
    const logId = await writeLog(sb, me, { intent, mode: "error", tools, ok: false, ms: Date.now() - t0, model: null, fallback: "error" });
    return json({ ok: false, code: "upstream", error: "Quản gia gặp lỗi khi đọc dữ liệu, thử lại sau ít phút.", logId }, 502);
  }

  const logId = await writeLog(sb, me, { intent, mode, tools, ok: true, ms: Date.now() - t0, model: model || null, fallback: fallback || null });
  return json({ ok: true, mode, intent, text: reply!.text, cards: reply!.cards, notices, model: model || undefined, logId: logId || undefined, you: { group: me.group, admin: me.admin, role } });
});
