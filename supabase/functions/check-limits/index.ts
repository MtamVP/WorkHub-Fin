// Edge Function: check-limits -- mỗi ngày giao dịch chấm tuân thủ giới hạn đầu tư của TỪNG thành viên và của cả nhóm gộp, ghi vào finance_compliance_log.
// Khác với kiểm tra lúc ghi lệnh (chỉ chạy khi có lệnh), việc này bắt được trường hợp giá biến động làm danh mục VƯỢT giới hạn mà không ai giao dịch,
// và cho biết vi phạm kéo dài bao nhiêu ngày (Toàn Nhóm > Giới Hạn > Lịch sử tuân thủ). Chạy cả khi không ai mở app.
// Gọi định kỳ bởi pg_cron (Bearer = publishable key, verify_jwt giữ true) -- cùng kiểu fetch-stock-prices. Phản hồi chỉ có SỐ LƯỢNG, không lộ ai vượt gì.
// Tính toán dùng ĐÚNG thư viện của app: finance-calc.js, portfolio-calc.js, group-calc.js, limits-calc.js ở thư mục này là bản sao nguyên văn của lib/ (cộng một dòng
// gán globalThis ở cuối) -- có test so khớp (tests/unit/check-limits.test.js) nên không thể lệch nhau.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "./finance-calc.js";
import "./portfolio-calc.js";
import "./group-calc.js";
import "./limits-calc.js";
import { computeCompliance, selfTest, vnDate } from "./compliance.ts";

const g = globalThis as any;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

// PostgREST giới hạn 1.000 dòng mỗi lần: đọc từng trang cho tới khi hết
async function fetchAll(build: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng từ cron */ }
  if (body && body.selftest === true) return json({ ok: true, rows: selfTest({ GroupCalc: g.GroupCalc, LimitsCalc: g.LimitsCalc }) });   // không đụng CSDL
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const { data: users, error: uErr } = await supabase.from("users").select("id, email, nickname, group_key, active").in("group_key", ["finance", "admin"]);
    if (uErr) throw new Error(uErr.message);
    const members = (users ?? []).filter((u) => u.active !== false).map((u) => ({ id: u.id, email: u.email, nickname: u.nickname ?? null }));
    if (!members.length) return json({ ok: true, members: 0, limits: 0, logged: 0, breaches: 0 });
    const ids = members.map((m) => m.id);

    const { data: limits, error: lErr } = await supabase.from("finance_limits").select("*").eq("active", true);
    if (lErr) throw new Error(lErr.message);
    if (!(limits ?? []).length) return json({ ok: true, members: members.length, limits: 0, logged: 0, breaches: 0 });

    const [txns, actions, prices, assets] = await Promise.all([
      fetchAll(() => supabase.from("finance_transactions").select("*").in("user_id", ids).is("deleted_at", null).order("trade_date", { ascending: true }).order("id")),
      fetchAll(() => supabase.from("finance_corporate_actions").select("*").in("user_id", ids).is("deleted_at", null).order("ex_date", { ascending: true }).order("id")),
      fetchAll(() => supabase.from("finance_holdings_price").select("user_id, symbol, market_price, price_date, updated_at").in("user_id", ids).order("user_id").order("symbol")),
      fetchAll(() => supabase.from("finance_assets").select("user_id, cash, debt, nav").in("user_id", ids).order("user_id")),
    ]);

    const rows = computeCompliance({ GroupCalc: g.GroupCalc, LimitsCalc: g.LimitsCalc }, { members, txns, actions, prices, assets, limits: limits ?? [] });
    const logDate = vnDate(new Date());
    // Chạy lại trong ngày thì thay bằng kết quả mới nhất (giá có thể đã cập nhật thêm)
    const { error: dErr } = await supabase.from("finance_compliance_log").delete().eq("log_date", logDate);
    if (dErr) throw new Error(dErr.message);
    if (rows.length) {
      const { error: iErr } = await supabase.from("finance_compliance_log").insert(rows.map((r) => ({ log_date: logDate, ...r })));
      if (iErr) throw new Error(iErr.message);
    }
    return json({ ok: true, members: members.length, limits: limits!.length, logged: rows.length, breaches: rows.reduce((s, r) => s + r.breaches.length, 0) });
  } catch (e) {
    console.error("check-limits:", (e as Error).message);
    return json({ ok: false, error: "Không chấm được tuân thủ giới hạn." }, 500);
  }
});
