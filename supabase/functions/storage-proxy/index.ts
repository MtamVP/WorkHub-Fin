// Shared file-storage proxy for WorkHub-Fin / WorkHub-Sci / WorkHub-ORG.
// Keeps the MinIO (TrueNAS) root credential server-side only — clients never see it.
// Routes: POST .../storage-proxy/upload, GET .../storage-proxy/download, DELETE .../storage-proxy/delete
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

function resolveBucket(name: string): string {
  if (KNOWN_BUCKETS.has(name)) return name;
  if (BUCKET_MAP[name]) return BUCKET_MAP[name];
  throw new Error(`Unknown bucket: ${name}`);
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

async function requireUser(req: Request, url: URL): Promise<string> {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "") || url.searchParams.get("token");
  if (!token) throw new Error("auth: missing token");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, anonKey);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new Error("auth: invalid or expired token");
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
      await requireUser(req, url);
      const form = await req.formData();
      const bucket = resolveBucket(String(form.get("bucket") || ""));
      const path = String(form.get("path") || "");
      const file = form.get("file");
      if (!path || !(file instanceof File)) {
        return jsonResponse({ error: "Missing path or file" }, 400);
      }
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
      await requireUser(req, url);
      const bucket = resolveBucket(url.searchParams.get("bucket") || "");
      const path = url.searchParams.get("path") || "";
      if (!path) return jsonResponse({ error: "Missing path" }, 400);

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
      await requireUser(req, url);
      const payload = await req.json().catch(() => ({}));
      const bucket = resolveBucket(String(payload.bucket || ""));
      const path = String(payload.path || "");
      if (!path) return jsonResponse({ error: "Missing path" }, 400);

      await s3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: path }));
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /^auth:/.test(message) ? 401 : 500;
    return jsonResponse({ error: message }, status);
  }
});
