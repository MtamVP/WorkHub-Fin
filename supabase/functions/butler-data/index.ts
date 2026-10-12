// Edge Function: butler-data -- CÔNG CỤ DỮ LIỆU của Quản gia (hàm butler gọi sang đây, chuyển tiếp tiêu đề Authorization của người hỏi). Chỉ ĐỌC, không có AI.
// BẢO MẬT: chạy hoàn toàn bằng JWT của NGƯỜI HỎI (client dựng từ khoá công khai + Authorization của họ) nên RLS giới hạn dữ liệu; KHÔNG dùng service role (tests/unit/butler-edge.test.js chặn).
//   Dữ liệu tài chính chỉ trả cho nhóm finance / admin. Thành viên khác trong nhóm KHÔNG bị nêu tên ở công cụ một mã và giới hạn; danh mục nhóm chỉ nêu tên + NAV như màn Toàn Nhóm đã cho mọi thành viên xem.
// Vào: { tool: "portfolio" | "group" | "holding" | "limits" | "approvals" | "signals", args?: { sym } }. Ra: { ok, tool, facts } hoặc { ok:false, code, error }. {"selftest":true} chạy một bài tính cố định không đụng CSDL.
// Tính toán dùng ĐÚNG GroupCalc / PortfolioCalc / LimitsCalc của app (bản sao nguyên văn của lib/, có test khớp: tests/unit/butler-edge.test.js).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "./finance-calc.js";
import "./portfolio-calc.js";
import "./group-calc.js";
import "./limits-calc.js";
import { canSeeFinance, toolApprovals, toolGroup, toolHolding, toolLimits, toolPortfolio, toolSignals, type Me } from "./data.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
const TOOLS = ["portfolio", "group", "holding", "limits", "approvals", "signals"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng */ }
  const g = globalThis as any;
  if (body && body.selftest === true) return json({ ok: true, tools: TOOLS, libs: ["FinCalc", "PortfolioCalc", "GroupCalc", "LimitsCalc"].filter((k) => !!g[k]) });
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token.split(".").length !== 3) return json({ ok: false, code: "auth", error: "Cần đăng nhập." }, 401);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("authorization") || "" } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: au, error: ae } = await sb.auth.getUser(token);
  const email = String(au?.user?.email || "").trim().toLowerCase();
  if (ae || !email) return json({ ok: false, code: "auth", error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn." }, 401);
  const { data: rows, error: ue } = await sb.from("users").select("id, email, nickname, group_key, active").ilike("email", email).limit(5);
  if (ue) return json({ ok: false, code: "upstream", error: "Không đọc được hồ sơ người dùng." }, 502);
  const u = (rows || []).find((r: any) => String(r.email || "").toLowerCase() === email);
  if (!u || u.active === false) return json({ ok: false, code: "forbidden", error: "Tài khoản không được phép." }, 403);
  const group = String(u.group_key || "guest");
  const me: Me = { id: u.id, email, nickname: String(u.nickname || email.split("@")[0]), group, admin: group === "admin" };
  const tool = String(body && body.tool || "");
  if (TOOLS.indexOf(tool) === -1) return json({ ok: false, code: "bad_request", error: "Công cụ không hợp lệ." }, 400);
  if (!canSeeFinance(me)) return json({ ok: false, code: "forbidden", error: "Dữ liệu tài chính chỉ dành cho nhóm Finance." }, 403);
  try {
    let facts: unknown;
    if (tool === "portfolio") facts = await toolPortfolio(sb, me);
    else if (tool === "group") facts = await toolGroup(sb);
    else if (tool === "limits") facts = await toolLimits(sb, me);
    else if (tool === "approvals") facts = await toolApprovals(sb, me, Date.now());
    else if (tool === "signals") facts = await toolSignals(sb, me);
    else {
      const sym = String(body && body.args && body.args.sym || "").trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9._-]{0,11}$/.test(sym)) return json({ ok: false, code: "bad_request", error: "Mã cổ phiếu không hợp lệ." }, 400);
      facts = await toolHolding(sb, me, sym);
    }
    return json({ ok: true, tool, facts });
  } catch (e) {
    console.error("[butler-data] lỗi:", String((e as any)?.message || e).slice(0, 200));
    return json({ ok: false, code: "upstream", error: "Không đọc được dữ liệu, thử lại sau ít phút." }, 502);
  }
});
