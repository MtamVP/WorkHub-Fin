// Logic thuần của Edge Function vb-data -- không import Deno/Supabase để Vitest chạy được (tests/unit/vb-data-parse.test.js).
// Nguồn: VNDirect finfo v4 (financial_statements, ratios) và dchart (nến ngày). Hàm này phục vụ Valuation Bench: trả báo cáo tài chính ĐẦY ĐỦ (không chỉ vài chỉ tiêu như stock-financials),
// nến OHLCV và chuỗi bội số lịch sử của một mã, kèm VN-Index để tính sức mạnh tương đối.

export const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;
export type Form = "NON_FINANCE" | "BANK" | "SECURITIES" | "INSURANCE";
// Mã mô hình báo cáo [bảng cân đối, kết quả kinh doanh, lưu chuyển tiền] theo loại doanh nghiệp (chứng khoán dùng bộ "web mới" 89/90/91)
export const MODELS: Record<Form, [number, number, number]> = { NON_FINANCE: [1, 2, 3], BANK: [101, 102, 103], SECURITIES: [89, 90, 91], INSURANCE: [411, 412, 413] };
export const FORM_ORDER: Form[] = ["NON_FINANCE", "BANK", "SECURITIES", "INSURANCE"];
export const RATIO_CODES: Record<string, string> = { pe: "PRICE_TO_EARNINGS", pb: "PRICE_TO_BOOK", ps: "PRICE_TO_SALES" };
export const INDEX_CODES = new Set(["VNINDEX", "VN30", "HNXINDEX", "HNX30", "UPCOMINDEX"]);
export const MAX_CANDLE_DAYS = 2600;

export type Mode = "all" | "statements" | "ohlc" | "ratios";
export function validateRequest(body: any): { error: string | null; symbol: string; mode: Mode; years: number; candleYears: number; index: boolean } {
  const fail = (error: string) => ({ error, symbol: "", mode: "all" as Mode, years: 8, candleYears: 5, index: true });
  if (!body) return fail("Thiếu dữ liệu yêu cầu.");
  const symbol = String(body.symbol || "").trim().toUpperCase();
  if (!symbol) return fail("Thiếu mã cổ phiếu.");
  if (!SYMBOL_RE.test(symbol)) return fail("Mã không hợp lệ.");
  const mode = (["all", "statements", "ohlc", "ratios"].includes(body.mode) ? body.mode : "all") as Mode;
  const years = Math.min(10, Math.max(3, Math.round(Number(body.years) || 8)));
  const candleYears = Math.min(7, Math.max(1, Math.round(Number(body.candleYears) || 5)));
  return { error: null, symbol, mode, years, candleYears, index: body.index !== false };
}

// Ngày YYYY-MM-DD cách hôm nay `years` năm (giờ UTC), dùng làm ngày bắt đầu truy vấn
export function yearsAgo(now: Date, years: number): string {
  const d = new Date(now.getTime()); d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}
export function vnDate(unixSec: number): string { return new Date((unixSec + 7 * 3600) * 1000).toISOString().slice(0, 10); }

export type Row = { itemCode: number; fiscalDate: string; numericValue: number; modelType: number };
// Giữ các hàng có mã khoản mục cần dùng, rút gọn trường (giảm kích thước phản hồi); bỏ giá trị không phải số
export function slimRows(rows: any[], codes: Set<number> | null): Row[] {
  const out: Row[] = [];
  for (const r of rows ?? []) {
    const code = Math.round(Number(r && r.itemCode)), v = Number(r && r.numericValue);
    if (!isFinite(code) || !isFinite(v) || !r.fiscalDate) continue;
    if (codes && !codes.has(code)) continue;
    out.push({ itemCode: code, fiscalDate: String(r.fiscalDate).slice(0, 10), numericValue: v, modelType: Math.round(Number(r.modelType)) });
  }
  return out;
}

// Phản hồi dchart { s, t[], o[], h[], l[], c[], v[] } -> nến theo ngày; cổ phiếu nhân 1000 (dchart tính nghìn đồng), chỉ số giữ nguyên. null nếu lỗi hoặc rỗng.
export function candlesFromDchart(json: any, symbol: string): { t: string[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] } | null {
  if (!json || json.s !== "ok" || !Array.isArray(json.t) || !Array.isArray(json.c) || !Array.isArray(json.o) || !Array.isArray(json.h) || !Array.isArray(json.l)) return null;
  const scale = INDEX_CODES.has(symbol) ? 1 : 1000, byDate = new Map<string, { o: number; h: number; l: number; c: number; v: number }>();
  for (let i = 0; i < json.t.length; i++) {
    const o = json.o[i], h = json.h[i], l = json.l[i], c = json.c[i], v = Array.isArray(json.v) ? json.v[i] : 0, t = json.t[i];
    if (![o, h, l, c, t].every((x) => typeof x === "number" && isFinite(x)) || !(c > 0) || !(h >= l)) continue;
    byDate.set(vnDate(t), { o: o * scale, h: h * scale, l: l * scale, c: c * scale, v: typeof v === "number" && v >= 0 ? v : 0 });
  }
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return null;
  return { t: dates, o: dates.map((d) => byDate.get(d)!.o), h: dates.map((d) => byDate.get(d)!.h), l: dates.map((d) => byDate.get(d)!.l), c: dates.map((d) => byDate.get(d)!.c), v: dates.map((d) => byDate.get(d)!.v) };
}

// Hàng ratios [{ reportDate, value }] -> mảng giá trị tăng theo ngày (bỏ giá trị không dương và ngày trùng)
export function ratioValues(rows: any[]): { dates: string[]; values: number[] } {
  const by = new Map<string, number>();
  for (const r of rows ?? []) { const v = Number(r && r.value); if (isFinite(v) && v > 0 && r.reportDate) by.set(String(r.reportDate).slice(0, 10), v); }
  const dates = [...by.keys()].sort();
  return { dates, values: dates.map((d) => by.get(d)!) };
}

// Gộp ngày/giá trị của mã để tính nhanh phân vị: chỉ trả giá trị (client không cần ngày)
export function summarizeCoverage(annual: Row[], quarter: Row[]): { annualYears: string[]; quarters: string[] } {
  const ys = [...new Set(annual.map((r) => r.fiscalDate))].sort(), qs = [...new Set(quarter.map((r) => r.fiscalDate))].sort();
  return { annualYears: ys, quarters: qs };
}
