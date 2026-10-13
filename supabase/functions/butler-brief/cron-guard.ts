// Chốt chặn cho các Edge Function dùng service role (bản gốc; bản sao nguyên văn nằm ở cron-guard.ts của từng hàm, do scripts/sync-edge-libs.mjs chép).
// Trước đây các hàm này chỉ cần "Authorization: Bearer <khoá publishable>" (verify_jwt = true), mà khoá publishable nằm công khai trong api.js nên AI cũng gọi được.
// Nay hàm chỉ chạy khi: (1) tiêu đề x-cron-secret khớp bí mật cron trong Vault (pg_cron gửi, xem finance-cron-secret-migration.sql / finance-cron-schedule-migration.sql), hoặc
// (2) allowUser = true và Authorization là JWT của một người dùng đã đăng nhập thật (khoá publishable không phải JWT người dùng nên không qua được).
// Chế độ chuyển tiếp: public.cron_guard_state.enforce = false -> thiếu bí mật chỉ ghi cảnh báo vào nhật ký hàm rồi vẫn cho qua; enforce = true -> trả 401. Bật/tắt bằng một câu UPDATE, không cần triển khai lại.
// Không tin được kết quả kiểm (RPC lỗi) thì từ chối (trừ khi là người dùng thật): hàm cần chính CSDL đó để làm việc nên không mất gì.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

let client: any = null;
function service(): any {
  if (!client) client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  return client;
}
const deny = () => new Response(JSON.stringify({ ok: false, error: "Chỉ lịch hệ thống hoặc người dùng đăng nhập được gọi hàm này." }), {
  status: 401,
  headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "content-type": "application/json" },
});

// Trả null nếu cho qua, hoặc Response 401. fn: tên hàm (để ghi nhật ký).
export async function cronGuard(req: Request, opts: { fn: string; allowUser?: boolean }): Promise<Response | null> {
  const sb = service();
  const secret = req.headers.get("x-cron-secret") || "";
  let gate = "deny";
  try {
    const { data, error } = await sb.rpc("fn_cron_gate", { p_secret: secret });
    if (!error && typeof data === "string") gate = data;
  } catch (_e) { gate = "deny"; }
  if (gate === "ok") return null;
  if (opts.allowUser) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (token && token.split(".").length === 3) {                       // JWT người dùng (khoá sb_publishable_... không phải JWT)
      try {
        const { data, error } = await sb.auth.getUser(token);
        if (!error && data && data.user) return null;
      } catch (_e) { /* không xác minh được: rơi xuống bên dưới */ }
    }
  }
  if (gate === "monitor") { console.warn("[cron-guard] " + opts.fn + ": gọi không kèm bí mật cron hợp lệ (chế độ theo dõi, vẫn cho qua)"); return null; }
  return deny();
}
