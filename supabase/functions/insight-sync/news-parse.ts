// Logic thuần của Edge Function market-news: đọc RSS công khai của các báo tài chính -> danh sách tin chuẩn hoá (tiêu đề, đường dẫn về báo gốc, nguồn, giờ đăng, mô tả ngắn dạng chữ thường).
// Không import Deno/Supabase để Vitest chạy được (tests/unit/market-news-fn.test.js, kèm mẫu RSS thật 09/10/2026 trong tests/fixtures/news-feeds.json).
// Nguyên tắc: CHỈ lấy tiêu đề + đoạn mô tả ngắn (tối đa 220 ký tự) + đường dẫn về báo gốc, KHÔNG sao chép nội dung bài. Mỗi đường dẫn phải thuộc đúng tên miền của báo đã khai báo (http nâng lên https).
// RSS là nguồn công khai không có cam kết dịch vụ: định dạng mỗi báo một kiểu (CDATA, HTML bị mã hoá, thực thể &#242; lồng trong CDATA) nên bộ đọc chịu được dữ liệu thiếu/lỗi và không bao giờ ném.

export type Feed = { id: string; name: string; url: string; hosts: string[] };
export const FEEDS: Feed[] = [
  { id: "cafef", name: "CafeF", url: "https://cafef.vn/thi-truong-chung-khoan.rss", hosts: ["cafef.vn"] },
  { id: "vnexpress", name: "VnExpress", url: "https://vnexpress.net/rss/kinh-doanh.rss", hosts: ["vnexpress.net"] },
  { id: "vietstock", name: "Vietstock", url: "https://vietstock.vn/830/chung-khoan/co-phieu.rss", hosts: ["vietstock.vn"] },
  { id: "vneconomy", name: "VnEconomy", url: "https://vneconomy.vn/chung-khoan.rss", hosts: ["vneconomy.vn"] },
  { id: "vietnambiz", name: "Vietnambiz", url: "https://vietnambiz.vn/chung-khoan.rss", hosts: ["vietnambiz.vn"] },
];
export const MAX_PER_FEED = 30;
export const MAX_TOTAL = 120;
export const SUMMARY_MAX = 220;
export const TITLE_MAX = 220;

export type NewsItem = { id: string; title: string; link: string; source: string; sourceName: string; ts: number | null; summary: string };

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", ndash: "–", mdash: "—", hellip: "…" };
export function decodeEntities(s: string): string {
  return String(s ?? "").replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, g: string) => {
    if (g[0] === "#") {
      const code = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return Object.prototype.hasOwnProperty.call(NAMED, g) ? NAMED[g] : m;
  });
}

// Nội dung một thẻ: có CDATA thì lấy nguyên văn (là HTML), không thì giải mã thực thể (XML thường). Trả chuỗi rỗng khi thiếu thẻ.
export function tagText(block: string, tag: string): string {
  const m = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i").exec(block);
  if (!m) return "";
  const raw = m[1].trim(), c = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  return c ? c[1] : decodeEntities(raw);
}
// Bỏ thẻ HTML và thực thể, gộp khoảng trắng
export function plain(html: string): string {
  return decodeEntities(String(html ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1), sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, "") + "…";
}

// Đường dẫn hợp lệ: http/https, đúng tên miền của báo (hoặc tên miền con); http nâng lên https. Trả null nếu không hợp lệ.
export function safeLink(url: string, hosts: string[]): string | null {
  const t = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(t)) return null;
  let u: URL;
  try { u = new URL(t); } catch (_e) { return null; }
  const h = u.hostname.toLowerCase();
  if (!hosts.some((x) => h === x || h.endsWith("." + x))) return null;
  u.protocol = "https:";
  return u.toString();
}
// Giờ đăng: RSS dùng RFC 822; không đọc được hoặc lệch quá 1 ngày về tương lai thì bỏ (null) thay vì đoán
export function parseDate(s: string, now: number): number | null {
  const t = Date.parse(String(s ?? "").trim());
  if (!isFinite(t)) return null;
  return t > now + 24 * 3600000 ? null : t;
}

export function parseRss(xml: string, feed: Feed, now: number): NewsItem[] {
  const out: NewsItem[] = [], text = String(xml ?? "");
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < MAX_PER_FEED) {
    const b = m[1], title = clip(plain(tagText(b, "title")), TITLE_MAX), link = safeLink(plain(tagText(b, "link")) || plain(tagText(b, "guid")), feed.hosts);
    if (!title || !link) continue;
    let summary = plain(tagText(b, "description"));
    if (summary.toLowerCase() === title.toLowerCase() || summary.toLowerCase().startsWith(title.toLowerCase())) summary = summary.slice(title.length).trim();
    out.push({ id: link, title, link, source: feed.id, sourceName: feed.name, ts: parseDate(tagText(b, "pubDate") || tagText(b, "dc:date"), now), summary: clip(summary, SUMMARY_MAX) });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\u0111/g, "d").replace(/[^a-z0-9]+/g, " ").trim();
// Gộp nhiều nguồn: bỏ trùng theo đường dẫn và theo tiêu đề đã chuẩn hoá (cùng một tin đăng ở hai báo thì giữ bản đăng sớm nhất), mới nhất trước, tin không rõ giờ xếp cuối
export function merge(lists: NewsItem[][], limit?: number): NewsItem[] {
  const seenLink = new Set<string>(), byTitle = new Map<string, NewsItem>();
  for (const it of lists.flat()) {
    if (seenLink.has(it.link)) continue;
    seenLink.add(it.link);
    const k = norm(it.title), prev = byTitle.get(k);
    if (!prev || (it.ts !== null && (prev.ts === null || it.ts < prev.ts))) byTitle.set(k, it);
  }
  return [...byTitle.values()].sort((a, b) => (b.ts ?? -1) - (a.ts ?? -1) || (a.title < b.title ? -1 : 1)).slice(0, limit ?? MAX_TOTAL);
}
