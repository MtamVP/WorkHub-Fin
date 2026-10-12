// Shared file-storage proxy for WorkHub-Fin / WorkHub-Sci / WorkHub-ORG.
// Keeps the MinIO (TrueNAS) root credential server-side only — clients never see it.
// Routes: POST .../storage-proxy/upload, GET .../storage-proxy/download, DELETE .../storage-proxy/delete
// Hiện đang tạm tắt ở phía app (api.js: USE_MINIO_STORAGE = false). Khi bật lại: mỗi bucket chỉ cho nhóm tương ứng dùng (BUCKET_GROUPS), tài khoản bị vô hiệu bị chặn,
// khoá đối tượng được kiểm (validPath). Trước 12/10/2026 chỉ kiểm "đã đăng nhập" nên mọi người dùng đọc/ghi/xoá được mọi bucket.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "https://esm.sh/@aws-sdk/client-s3@3.637.0";

const BUCKET_MAP: Record<string, string> = {
  finance: "wh-fin-files",
  science: "wh-sci-files",
  general: "wh-org-files",
};
const KNOWN_BUCKETS = new Set(Object.values(BUCKET_MAP));
// Nhóm được dùng từng bucket (admin dùng được mọi bucket); danh sách rỗng = mọi người dùng đang hoạt động
const BUCKET_GROUPS: Record<string, string[]> = {
  "wh-fin-files": ["finance", "admin"],
  "wh-sci-files": ["science", "admin"],
  "wh-org-files": [],
};

function resolveBucket(name: string): string {
  if (KNOWN_BUCKETS.has(name)) return name;
  if (BUCKET_MAP[name]) return BUCKET_MAP[name];
  throw new Error(`Unknown bucket: ${name}`);
}

// Khoá đối tượng: không rỗng, không bắt đầu bằng "/", không có đoạn "." hoặc "..", không có ký tự điều khiển, tối đa 512 ký tự
function validPath(p: string): boolean {
  return p.length > 0 && p.length <= 512 && !p.startsWith("/") && !/[\u0000-\u001f]/.test(p) && !p.split("/").some((seg) => seg === ".." || seg === ".");
}

function s3Client(): S3Client {
  const endpoint = Deno.env.get("MINIO_ENDPOINT");
  const accessKeyId = Deno.env.get("MINIO_ROOT_USER");
  const secretAccessKey = Deno.env.get("MINIO_ROOT_PASSWORD");
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("MinIO env vars not configured (MINIO_ENDPOINT / MINIO_ROOT_USER / MINIO_ROOT_PASSWORD)");
  }
  return new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function requireUser(req: Request, url: URL, bucket?: string): Promise<string> {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "") || url.searchParams.get("token");
  if (!token) throw new Error("auth: missing token");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, anonKey);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new Error("auth: invalid or expired token");
  if (bucket) {
    // nhóm + trạng thái hoạt động của người dùng (bảng users ai cũng đọc được theo RLS; dùng chính JWT của người gọi)
    const asUser = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: "Bearer " + token } } });
    const { data: u } = await asUser.from("users").select("group_key, active").eq("auth_user_id", data.user.id).maybeSingle();
    if (!u || u.active === false) throw new Error("forbidden: tài khoản không hoạt động hoặc không có hồ sơ");
    const allowed = BUCKET_GROUPS[bucket];
    if (allowed && allowed.length && allowed.indexOf(String(u.group_key)) === -1) throw new Error("forbidden: nhóm của bạn không được dùng kho tệp này");
  }
  return data.user.id;
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const action = segments[segments.length - 1]; // upload | download | delete

  try {
    if (action === "upload" && req.method === "POST") {
      const form = await req.formData();
      const bucket = resolveBucket(String(form.get("bucket") || ""));
      await requireUser(req, url, bucket);
      const path = String(form.get("path") || "");
      const file = form.get("file");
      if (!path || !(file instanceof File)) {
        return jsonResponse({ error: "Missing path or file" }, 400);
      }
      if (!validPath(path)) return jsonResponse({ error: "Invalid path" }, 400);
      const body = new Uint8Array(await file.arrayBuffer());
      await s3Client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: path,
          Body: body,
          ContentType: file.type || "application/octet-stream",
        })
      );
      return jsonResponse({ bucket, path, size: body.byteLength });
    }

    if (action === "download" && req.method === "GET") {
      const bucket = resolveBucket(url.searchParams.get("bucket") || "");
      await requireUser(req, url, bucket);
      const path = url.searchParams.get("path") || "";
      if (!path) return jsonResponse({ error: "Missing path" }, 400);
      if (!validPath(path)) return jsonResponse({ error: "Invalid path" }, 400);

      const result = await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: path }));
      const stream = (result.Body as { transformToWebStream?: () => ReadableStream } | undefined)
        ?.transformToWebStream?.();
      return new Response(stream, {
        headers: {
          ...corsHeaders(),
          "content-type": result.ContentType || "application/octet-stream",
          "content-length": String(result.ContentLength ?? ""),
        },
      });
    }

    if (action === "delete" && req.method === "DELETE") {
      const payload = await req.json().catch(() => ({}));
      const bucket = resolveBucket(String(payload.bucket || ""));
      await requireUser(req, url, bucket);
      const path = String(payload.path || "");
      if (!path) return jsonResponse({ error: "Missing path" }, 400);
      if (!validPath(path)) return jsonResponse({ error: "Invalid path" }, 400);

      await s3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: path }));
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /^auth:/.test(message) ? 401 : (/^forbidden:/.test(message) ? 403 : 500);
    return jsonResponse({ error: message }, status);
  }
});
