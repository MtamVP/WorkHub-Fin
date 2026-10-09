// Edge Function: market-news -- TIN THỊ TRƯỜNG cho trang "Tổng Quan TT": đọc RSS công khai của CafeF, VnExpress, Vietstock, VnEconomy, Vietnambiz và trả danh sách đã chuẩn hoá. Chỉ ĐỌC từ nguồn ngoài,
// KHÔNG đụng cơ sở dữ liệu, KHÔNG dùng khoá bí mật, KHÔNG dùng AI. Địa chỉ nguồn cố định trong parse.ts (không nhận địa chỉ từ người gọi nên không thể bị lợi dụng gọi đi nơi khác).
// Vì sao qua máy chủ: chỉ CafeF cho trình duyệt đọc trực tiếp (CORS); các báo còn lại thì không. Hàm giữ bộ nhớ đệm 5 phút để nhiều người cùng lúc chỉ tốn một lượt gọi mỗi báo.
// Vào: {} (hoặc không gì). Ra: { ok, items: [{ id, title, link, source, sourceName, ts, summary }], sources: [{ id, name, ok, count, error? }], asOf }.
// Một báo lỗi thì các báo khác vẫn trả; tất cả lỗi mới trả 502. verify_jwt = true (người đã đăng nhập hoặc khoá publishable). {"selftest":true} chạy không đụng mạng.
import { FEEDS, merge, parseRss, type NewsItem } from "./parse.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json" } });

const CACHE_MS = 5 * 60000, MAX_BYTES = 1_500_000;
type Source = { id: string; name: string; ok: boolean; count: number; error?: string };
let cache: { at: number; items: NewsItem[]; sources: Source[] } | null = null;
let inflight: Promise<{ items: NewsItem[]; sources: Source[] }> | null = null;
const lastGood = new Map<string, NewsItem[]>();       // tin lần gần nhất đọc được của từng báo: báo lỗi tạm thời thì vẫn có tin cũ thay vì trống

async function loadOne(feed: typeof FEEDS[number], now: number): Promise<{ items: NewsItem[]; source: Source }> {
  try {
    const res = await fetch(feed.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; WorkHubNews/1.0)", "Accept": "application/rss+xml, application/xml, text/xml, */*" }, redirect: "follow", signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const xml = await res.text();
    if (xml.length > MAX_BYTES) throw new Error("Phản hồi quá lớn");
    const items = parseRss(xml, feed, now);
    if (!items.length) throw new Error("Không đọc được tin nào");
    lastGood.set(feed.id, items);
    return { items, source: { id: feed.id, name: feed.name, ok: true, count: items.length } };
  } catch (e) {
    const old = lastGood.get(feed.id) || [];
    return { items: old, source: { id: feed.id, name: feed.name, ok: false, count: old.length, error: String((e as Error)?.message || e).slice(0, 80) } };
  }
}
async function loadAll(): Promise<{ items: NewsItem[]; sources: Source[] }> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  if (inflight) return inflight;                       // nhiều yêu cầu cùng lúc dùng chung một lượt gọi
  inflight = (async () => {
    const now = Date.now(), rs = await Promise.all(FEEDS.map((f) => loadOne(f, now)));
    const sources = rs.map((r) => r.source), items = merge(rs.map((r) => r.items));
    if (sources.some((s) => s.ok)) cache = { at: Date.now(), items, sources };
    return { items, sources };
  })().finally(() => { inflight = null; });
  return inflight;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* body rỗng */ }
  if (body && body.selftest === true) return json({ ok: true, feeds: FEEDS.map((f) => f.id) });
  const r = await loadAll();
  if (!r.sources.some((s) => s.ok) && !r.items.length) return json({ ok: false, error: "Không lấy được tin từ các báo.", sources: r.sources }, 502);
  return json({ ok: true, items: r.items, sources: r.sources, asOf: new Date().toISOString() });
});
