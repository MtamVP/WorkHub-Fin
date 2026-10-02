// Logic thuần của Edge Function stock-financials -- không import Deno/Supabase để Vitest chạy được (tests/unit/stock-financials-parse.test.js).
// Nguồn: VNDirect finfo v4 (financial_statements + events). Mỗi loại doanh nghiệp dùng bộ mô hình báo cáo riêng:
//   NON_FINANCE: BS 1 / IS 2 | BANK: 101 / 102 | SECURITIES: 89 / 90 | INSURANCE: 411 / 412 (bảng cân đối / kết quả kinh doanh).
// Mã chỉ tiêu dùng chung: 12700 tổng tài sản, 14000 vốn chủ sở hữu (GỒM lợi ích cổ đông thiểu số), 14240 lợi ích cổ đông không kiểm soát,
// 14110 vốn góp (vốn điều lệ), 23000 lợi nhuận sau thuế của công ty mẹ. Doanh thu khác nhau theo loại: 21001 (thường), 21000 (chứng khoán),
// 421701 tổng thu nhập hoạt động (ngân hàng); bảo hiểm không lấy doanh thu.

export const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;
export const MAX_SYMBOLS = 5;

export const ITEM = { assets: 12700, equity: 14000, minority: 14240, charter: 14110, lnst: 23000, revNonFin: 21001, revSecurities: 21000, revBank: 421701 } as const;
export const ANNUAL_ITEMS = [ITEM.assets, ITEM.equity, ITEM.minority, ITEM.charter, ITEM.lnst, ITEM.revNonFin, ITEM.revSecurities, ITEM.revBank];
export const QUARTER_ITEMS = [ITEM.lnst, ITEM.revNonFin, ITEM.revSecurities, ITEM.revBank];
export const ANNUAL_MODELS = [1, 2, 101, 102, 89, 90, 411, 412];
export const QUARTER_MODELS = [2, 102, 90, 412];

export type Form = "NON_FINANCE" | "BANK" | "SECURITIES" | "INSURANCE";
export type Row = { code?: string; itemCode: number | string; modelType: number | string; numericValue: number | string | null; fiscalDate: string };
export type Annual = { year: number; fiscalDate: string; charter: number | null; equity: number | null; minority: number; equityParent: number | null; lnst: number | null; revenue: number | null; assets: number | null };
export type Quarter = { year: number; quarter: number; fiscalDate: string; lnst: number | null; revenue: number | null };
export type EventRow = { type?: string; locale?: string; dividend?: number | string | null; divYear?: number | string | null; effectiveDate?: string | null };

const FORM_OF_MODEL: Record<number, Form> = { 1: "NON_FINANCE", 2: "NON_FINANCE", 101: "BANK", 102: "BANK", 89: "SECURITIES", 90: "SECURITIES", 411: "INSURANCE", 412: "INSURANCE" };
const REVENUE_ITEM: Record<Form, number | null> = { NON_FINANCE: ITEM.revNonFin, SECURITIES: ITEM.revSecurities, BANK: ITEM.revBank, INSURANCE: null };

export function validateRequest(body: any): { error: string | null; symbols: string[] } {
  if (!body) return { error: "Thiếu dữ liệu yêu cầu.", symbols: [] };
  const list = Array.isArray(body.symbols) ? body.symbols : (body.symbol ? [body.symbol] : []);
  if (!list.length) return { error: "Thiếu mã cổ phiếu.", symbols: [] };
  const symbols = [...new Set(list.map((s: unknown) => String(s).trim().toUpperCase()))] as string[];
  if (symbols.length > MAX_SYMBOLS) return { error: `Tối đa ${MAX_SYMBOLS} mã mỗi lần.`, symbols: [] };
  if (symbols.some((s) => !SYMBOL_RE.test(s))) return { error: "Có mã không hợp lệ.", symbols: [] };
  return { error: null, symbols };
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Loại doanh nghiệp theo mô hình báo cáo xuất hiện nhiều nhất trong dữ liệu trả về.
export function detectForm(rows: Row[]): Form | null {
  const count = new Map<Form, number>();
  for (const r of rows) {
    const f = FORM_OF_MODEL[Number(r.modelType)];
    if (f) count.set(f, (count.get(f) ?? 0) + 1);
  }
  let best: Form | null = null, bestN = 0;
  for (const [f, n] of count) if (n > bestN) { best = f; bestN = n; }
  return best;
}

// Quý theo THÁNG DƯƠNG LỊCH của ngày chốt báo cáo (3->Q1, 6->Q2, 9->Q3, 12->Q4). Ngày lạ (không phải cuối quý) -> null.
export function quarterOf(fiscalDate: string): { year: number; quarter: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fiscalDate || ""));
  if (!m) return null;
  const month = Number(m[2]);
  const quarter = ({ 3: 1, 6: 2, 9: 3, 12: 4 } as Record<number, number>)[month];
  return quarter ? { year: Number(m[1]), quarter } : null;
}

// Gom số liệu năm: mỗi ngày chốt năm 1 dòng. Vốn chủ sở hữu của cổ đông công ty mẹ = 14000 - 14240 (cùng căn cứ với lợi nhuận của công ty mẹ).
export function buildAnnual(rows: Row[], form: Form | null): Annual[] {
  const revCode = form ? REVENUE_ITEM[form] : null;
  const byDate = new Map<string, Record<number, number>>();
  for (const r of rows) {
    const v = num(r.numericValue);
    if (v === null) continue;
    const key = String(r.fiscalDate).slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, {});
    byDate.get(key)![Number(r.itemCode)] = v;
  }
  const out: Annual[] = [];
  for (const [date, it] of byDate) {
    if (it[ITEM.lnst] === undefined && it[ITEM.equity] === undefined) continue;
    const minority = it[ITEM.minority] ?? 0;
    const equity = it[ITEM.equity] ?? null;
    out.push({
      year: Number(date.slice(0, 4)), fiscalDate: date,
      charter: it[ITEM.charter] ?? null, equity, minority,
      equityParent: equity === null ? null : equity - minority,
      lnst: it[ITEM.lnst] ?? null,
      revenue: revCode !== null ? (it[revCode] ?? null) : null,
      assets: it[ITEM.assets] ?? null,
    });
  }
  return out.sort((a, b) => b.year - a.year);
}

// Số liệu QUÝ RIÊNG LẺ (không phải lũy kế): tổng 4 quý = số cả năm (đã đối chiếu với FPT 2025).
export function buildQuarters(rows: Row[], form: Form | null): Quarter[] {
  const revCode = form ? REVENUE_ITEM[form] : null;
  const byDate = new Map<string, Record<number, number>>();
  for (const r of rows) {
    const v = num(r.numericValue);
    if (v === null) continue;
    const key = String(r.fiscalDate).slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, {});
    byDate.get(key)![Number(r.itemCode)] = v;
  }
  const out: Quarter[] = [];
  for (const [date, it] of byDate) {
    const q = quarterOf(date);
    if (!q || it[ITEM.lnst] === undefined) continue;
    out.push({ year: q.year, quarter: q.quarter, fiscalDate: date, lnst: it[ITEM.lnst], revenue: revCode !== null ? (it[revCode] ?? null) : null });
  }
  return out.sort((a, b) => (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter));
}

// Cổ tức tiền mặt/cổ phiếu (VND) cộng theo NĂM TÀI CHÍNH được chia (divYear), chỉ dòng tiếng Việt để khỏi đếm đôi.
export function buildDividends(events: EventRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== "DIVIDEND" || (e.locale && e.locale !== "VN")) continue;
    const amount = num(e.dividend), year = num(e.divYear);
    if (amount === null || !(amount > 0) || year === null || year < 1990) continue;
    out[String(year)] = (out[String(year)] ?? 0) + amount;
  }
  return out;
}

export function buildFinancials(annualRows: Row[], quarterRows: Row[], events: EventRow[]) {
  const form = detectForm(annualRows) ?? detectForm(quarterRows);
  return {
    form,
    annual: buildAnnual(annualRows, form),
    quarters: buildQuarters(quarterRows, form),
    dividends: buildDividends(events),
  };
}
