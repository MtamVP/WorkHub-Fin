// Logic thuần của Edge Function stock-history -- không import Deno/Supabase để Vitest chạy được (tests/unit/stock-history-parse.test.js).

export const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;
// Chỉ số: giá trả về là điểm chỉ số (không phải nghìn đồng) nên không nhân 1000.
export const INDEX_CODES = new Set(["VNINDEX", "VN30", "HNXINDEX", "HNX30", "UPCOMINDEX"]);
export const MAX_SYMBOLS = 25;
export const MAX_RANGE_DAYS = 2600; // ~7 năm: đủ cho dải P/E-P/B lịch sử của trang Định Giá (1 lần gọi dchart ~1.400 phiên)

export type Series = Array<[string, number]>;

// Unix giây -> ngày YYYY-MM-DD theo giờ Việt Nam (UTC+7)
export function vnDate(unixSec: number): string {
  return new Date((unixSec + 7 * 3600) * 1000).toISOString().slice(0, 10);
}

// Kiểm tra đầu vào; trả về chuỗi lỗi (tiếng Việt) hoặc null nếu hợp lệ.
export function validateRequest(body: any): { error: string | null; symbols: string[]; from: string; to: string; volumes: boolean } {
  const fail = (error: string) => ({ error, symbols: [], from: "", to: "", volumes: false });
  if (!body || !Array.isArray(body.symbols) || !body.symbols.length) return fail("Thiếu danh sách mã.");
  const symbols = [...new Set(body.symbols.map((s: unknown) => String(s).trim().toUpperCase()))] as string[];
  if (symbols.length > MAX_SYMBOLS) return fail(`Tối đa ${MAX_SYMBOLS} mã mỗi lần.`);
  if (symbols.some((s) => !SYMBOL_RE.test(s))) return fail("Có mã không hợp lệ.");
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const from = String(body.from || ""), to = String(body.to || "");
  if (!date.test(from) || !date.test(to)) return fail("Ngày không hợp lệ (cần YYYY-MM-DD).");
  const span = (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000;
  if (!(span >= 0)) return fail("Khoảng ngày không hợp lệ.");
  if (span > MAX_RANGE_DAYS) return fail(`Khoảng ngày tối đa ${MAX_RANGE_DAYS} ngày.`);
  return { error: null, symbols, from, to, volumes: body.volumes === true };
}

// Khối lượng giao dịch ngày (cổ phiếu) từ cùng phản hồi dchart { t:[unix], v:[khối lượng] } -> chuỗi [ngày, khối lượng]. Chỉ số không có khối lượng có nghĩa nên bỏ qua.
export function parseDchartVolumes(json: any, symbol: string): Series {
  if (INDEX_CODES.has(symbol) || !json || json.s !== "ok" || !Array.isArray(json.t) || !Array.isArray(json.v)) return [];
  const byDate = new Map<string, number>();
  for (let i = 0; i < json.t.length; i++) {
    const v = json.v[i], t = json.t[i];
    if (typeof v !== "number" || !(v >= 0) || typeof t !== "number") continue;
    byDate.set(vnDate(t), v);
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// Phản hồi VNDirect dchart { s:'ok', t:[unix...], c:[giá...] } -> chuỗi [ngày, giá VND] (nhân 1000 với cổ phiếu, giữ nguyên với chỉ số).
export function parseDchart(json: any, symbol: string): Series {
  if (!json || json.s !== "ok" || !Array.isArray(json.t) || !Array.isArray(json.c)) return [];
  const scale = INDEX_CODES.has(symbol) ? 1 : 1000;
  const byDate = new Map<string, number>();
  for (let i = 0; i < json.t.length; i++) {
    const c = json.c[i], t = json.t[i];
    if (typeof c !== "number" || !(c > 0) || typeof t !== "number") continue;
    byDate.set(vnDate(t), Math.round(c * scale * 100) / 100);
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// Phản hồi VNDirect finfo v4 { data:[{date, close}] } (nguồn dự phòng, chỉ cho cổ phiếu) -> cùng định dạng chuỗi.
export function parseFinfo(json: any): Series {
  const rows = json && Array.isArray(json.data) ? json.data : [];
  const byDate = new Map<string, number>();
  for (const r of rows) {
    const close = Number(r && r.close);
    if (!(close > 0) || !r.date) continue;
    byDate.set(String(r.date).slice(0, 10), Math.round(close * 1000));
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
