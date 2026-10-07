// Edge Function: send-price-alerts
// Gửi EMAIL khi giá thị trường của mã đang nắm giữ chạm giá mục tiêu / ngưỡng cắt lỗ -- hoạt động cả khi app đã tắt
// (khác với thông báo OS trong notify-deadlines.js vốn chỉ chạy lúc app mở).
// - Chỉ gửi cho người đã bật finance_alert_prefs.email_enabled, tới email đăng nhập (users.email) của chính họ.
// - Mỗi (user, mã, loại, mức, ngày) chỉ gửi 1 lần: "chiếm chỗ" bằng cách ghi finance_alert_log TRƯỚC khi gửi
//   (unique constraint), gửi lỗi thì xoá dòng chiếm để lần chạy sau thử lại.
// - Gọi định kỳ bởi pg_cron (Bearer = publishable key, verify_jwt giữ true). Phản hồi của lần chạy định kỳ chỉ có SỐ
//   LƯỢNG, không lộ dữ liệu ai/mã nào. Body {test:true} + JWT của người dùng đăng nhập -> gửi 1 email thử tới chính
//   email của JWT đó (không nhận người nhận từ body).
// Secrets (đặt trong Supabase Dashboard > Edge Functions > Secrets): RESEND_API_KEY (bắt buộc),
// ALERT_FROM_EMAIL (tuỳ chọn, mặc định "WorkHub <onboarding@resend.dev>" -- chỉ gửi được tới email chủ tài khoản Resend;
// muốn gửi cho nhiều người phải xác minh tên miền ở Resend rồi đặt địa chỉ gửi thuộc tên miền đó).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildEmail, evaluateAlerts, evaluateWatchAlerts, heldQuantities, valuationTarget, vnDate, type Alert, type PriceRow, type WatchRow } from "./logic.ts";

// App desktop gọi hàm này từ trình duyệt nhúng (origin http://tauri.localhost) -> trình duyệt gửi yêu cầu
// "hỏi đường" OPTIONS trước; thiếu header CORS thì lời gọi bị chặn ("Failed to send a request to the Edge Function").
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

async function sendEmail(apiKey: string, from: string, to: string, subject: string, html: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return { ok: true };
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.message || j.error || msg; } catch (_e) { /* giữ msg mặc định */ }
    return { ok: false, error: msg };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

// PostgREST trả tối đa 1.000 dòng mỗi lần đọc; quá thì CẮT IM LẶNG. Đọc từng trang tới khi hết và ném lỗi thay vì trả mảng rỗng
// (mảng rỗng do lỗi => NAV/cảnh báo tính như thể không có lệnh nào rồi ghi đè dữ liệu thật).
async function fetchAll(build: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    out.push(...data);
    from += data.length;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng từ cron */ }

  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("ALERT_FROM_EMAIL") || "WorkHub <onboarding@resend.dev>";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ---- Email thử: chỉ cho người dùng đã đăng nhập, gửi tới chính email của họ ----
  if (body && body.test === true) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: auth, error: authErr } = await supabase.auth.getUser(token);
    const email = auth?.user?.email;
    if (authErr || !email) return json({ ok: false, error: "Cần đăng nhập để gửi email thử." }, 401);
    if (!apiKey) return json({ ok: false, error: "Máy chủ chưa cấu hình RESEND_API_KEY — cần đặt secret này trong Supabase trước." });
    const sample: Alert[] = [{ symbol: "VÍ DỤ", kind: "target", threshold: 100000, price: 100500 }];
    const mail = buildEmail(sample, null);
    const r = await sendEmail(apiKey, from, email, "WorkHub: email thử cảnh báo giá", mail.html, mail.text);
    return json({ ok: r.ok, to: email, error: r.error });
  }

  if (!apiKey) return json({ configured: false, message: "RESEND_API_KEY chưa được cấu hình — không gửi gì." });

  const now = new Date();
  const alertDate = vnDate(now);

  const { data: prefs, error: prefErr } = await supabase.from("finance_alert_prefs").select("user_id").eq("email_enabled", true);
  if (prefErr) return json({ error: prefErr.message }, 500);
  const userIds = (prefs ?? []).map((p) => p.user_id as string);
  if (!userIds.length) return json({ users: 0, alerts: 0, sent: 0, failed: 0 });

  const { data: users } = await supabase.from("users").select("id, email, nickname, group_key, active").in("id", userIds);
  const eligible = (users ?? []).filter((u) => u.email && u.active !== false && ["finance", "admin"].includes(u.group_key));
  if (!eligible.length) return json({ users: 0, alerts: 0, sent: 0, failed: 0 });
  const eligibleIds = eligible.map((u) => u.id as string);

  let txns: any[], actions: any[], priceRows: any[], watchRows: any[];
  try {
    [txns, actions, priceRows, watchRows] = await Promise.all([
      fetchAll(() => supabase.from("finance_transactions").select("user_id, symbol, type, quantity, trade_date, created_at").in("user_id", eligibleIds).is("deleted_at", null).order("id")),
      fetchAll(() => supabase.from("finance_corporate_actions").select("user_id, symbol, action_type, ratio, ex_date, created_at").in("user_id", eligibleIds).is("deleted_at", null).order("id")),
      fetchAll(() => supabase.from("finance_holdings_price").select("user_id, symbol, market_price, locked, target_price, stop_loss, price_date, updated_at").in("user_id", eligibleIds).order("user_id").order("symbol")),
      fetchAll(() => supabase.from("finance_watchlist").select("user_id, symbol, buy_below").in("user_id", eligibleIds).order("id")),
    ]);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);       // không gửi cảnh báo theo dữ liệu thiếu
  }
  const held = heldQuantities((txns ?? []) as any, (actions ?? []) as any);

  // Định giá mới nhất theo mã (bảng dùng chung) -> giá mục tiêu mặc định khi người dùng không nhập tay
  const symbols = [...new Set((priceRows ?? []).map((r) => r.symbol as string))];
  const valuations = new Map<string, number>();
  if (symbols.length) {
    const vals = await fetchAll(() => supabase.from("finance_stock_valuations").select("symbol, year, data").in("symbol", symbols).order("year", { ascending: false }).order("symbol"));
    for (const v of vals ?? []) {
      if (valuations.has(v.symbol as string)) continue;
      const t = valuationTarget(v.data);
      if (t) valuations.set(v.symbol as string, t);
    }
  }

  let totalAlerts = 0, sent = 0, failed = 0;
  for (const u of eligible) {
    const rows = ((priceRows ?? []) as PriceRow[]).filter((r) => r.user_id === u.id);
    const heldOfUser = held.get(u.id as string) ?? new Map();
    const alerts = [
      ...evaluateAlerts(rows, heldOfUser, valuations, now),
      ...evaluateWatchAlerts(((watchRows ?? []) as WatchRow[]).filter((w) => w.user_id === u.id), rows, heldOfUser, now),
    ];
    if (!alerts.length) continue;
    totalAlerts += alerts.length;

    // Chiếm chỗ: chỉ những dòng THỰC SỰ được chèn mới là cảnh báo mới (đã gửi rồi thì ignoreDuplicates bỏ qua)
    const claimRows = alerts.map((a) => ({ user_id: u.id, symbol: a.symbol, kind: a.kind, threshold: a.threshold, alert_date: alertDate, price: a.price }));
    const { data: claimed, error: claimErr } = await supabase
      .from("finance_alert_log")
      .upsert(claimRows, { onConflict: "user_id,symbol,kind,threshold,alert_date", ignoreDuplicates: true })
      .select("id, symbol, kind, threshold");
    if (claimErr || !claimed || !claimed.length) continue;

    const fresh = alerts.filter((a) => claimed.some((c) => c.symbol === a.symbol && c.kind === a.kind && Number(c.threshold) === a.threshold));
    const mail = buildEmail(fresh, (u.nickname as string) || null);
    const r = await sendEmail(apiKey, from, u.email as string, mail.subject, mail.html, mail.text);
    if (r.ok) {
      sent++;
    } else {
      failed++;
      console.error("send-price-alerts: gửi email thất bại:", r.error);
      await supabase.from("finance_alert_log").delete().in("id", claimed.map((c) => c.id)); // nhả chỗ để lần chạy sau thử lại
    }
  }

  return json({ users: eligible.length, alerts: totalAlerts, sent, failed });
});
