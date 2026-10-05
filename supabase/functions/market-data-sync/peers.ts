// Logic thuần: ẢNH CHỤP CẢ THỊ TRƯỜNG và thống kê THEO NGÀNH để định giá tương đối (mã này rẻ hay đắt so với các mã cùng ngành).
// VNDirect /v4/ratios cho phép hỏi MỘT chỉ số của MỌI mã trong một lần (q=ratioCode:X~reportDate:Y&size=3000) nên cả thị trường chỉ cần khoảng 16 lần gọi thay vì hàng nghìn.
// Không import Deno/Supabase để Vitest chạy được (tests/unit/market-peers.test.js).
import { DAILY_MAP, QUARTER_MAP } from "./logic.ts";

export const SNAP_DAILY = [
  "PRICE_TO_EARNINGS", "PRICE_TO_BOOK", "PRICE_TO_SALES", "MARKETCAP", "DIVIDEND_YIELD", "PRICE_TO_EARNINGS_AVG_CR_5Y", "PRICE_TO_BOOK_AVG_CR_5Y",
  "NMVALUE_AVG_CR_20D", "PRICE_CHG_PCT_CR_1Y", "PRICE_CHG_PCT_CR_3M", "BETA", "DAILY_JDK_RS_CR", "DAILY_JDK_RS_MOMENTUM_CR",
];
export const SNAP_QUARTER = ["ROAE_TR_AVG5Q", "NET_MARGIN_TR", "EPS_TR_GRYOY", "NET_SALES_TR_GRYOY", "DEBT_TO_EQUITY_AQ"];

export const MIN_CAP_VND = 300e9;      // chỉ tính thống kê ngành trên mã vốn hoá từ 300 tỷ (loại mã quá nhỏ làm méo trung vị)
export const MIN_SECTOR_N = 5;         // ngành ít hơn 5 mã hợp lệ thì không có thống kê
export const QUANTILE_POINTS = 11;     // p0, p10, ..., p100

export type SnapRow = { symbol: string; icb2_code: string | null; daily_date: string | null; quarter_date: string | null; metrics: Record<string, number> };

const isDate = (s: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000;

// Chỉ giữ cổ phiếu (group STOCK hoặc không ghi group), mã hợp lệ, giá trị hữu hạn
function usable(rows: any[]): { code: string; date: string; value: number }[] {
  const out: { code: string; date: string; value: number }[] = [];
  for (const r of rows ?? []) {
    const code = String(r && r.code || "").trim().toUpperCase();
    const date = String(r && r.reportDate || "").slice(0, 10);
    const value = Number(r && r.value);
    if (!/^[A-Z0-9]{1,12}$/.test(code) || !isDate(date) || !isFinite(value)) continue;
    if (r.group && String(r.group).toUpperCase() !== "STOCK") continue;
    out.push({ code, date, value });
  }
  return out;
}

// daily: { RATIO_CODE: hàng[] } của nhóm chỉ số ngày; quarter: nhóm chỉ số quý (có thể nhiều quý, lấy quý mới nhất của TỪNG mã).
export function buildSnapshot(daily: Record<string, any[]>, quarter: Record<string, any[]>, icbOf: (symbol: string) => string | null): SnapRow[] {
  const bySym = new Map<string, SnapRow>();
  const get = (s: string) => { let r = bySym.get(s); if (!r) { r = { symbol: s, icb2_code: icbOf(s) ?? null, daily_date: null, quarter_date: null, metrics: {} }; bySym.set(s, r); } return r; };

  const dailyUse: Record<string, ReturnType<typeof usable>> = {};
  let globalMax = "";
  for (const code of Object.keys(daily)) {
    dailyUse[code] = usable(daily[code]);
    for (const x of dailyUse[code]) if (x.date > globalMax) globalMax = x.date;
  }
  for (const code of Object.keys(dailyUse)) {
    const name = DAILY_MAP[code];
    if (!name) continue;
    let max = ""; for (const x of dailyUse[code]) if (x.date > max) max = x.date;
    if (!max || (globalMax && dayDiff(max, globalMax) > 5)) continue;       // chỉ số này cũ hơn hẳn các chỉ số còn lại: bỏ để không trộn ngày
    for (const x of dailyUse[code]) if (x.date === max) { const r = get(x.code); r.metrics[name] = x.value; r.daily_date = r.daily_date && r.daily_date > max ? r.daily_date : max; }
  }
  for (const code of Object.keys(quarter)) {
    const name = QUARTER_MAP[code];
    if (!name) continue;
    const latest = new Map<string, { date: string; value: number }>();
    for (const x of usable(quarter[code])) { const c = latest.get(x.code); if (!c || x.date > c.date) latest.set(x.code, { date: x.date, value: x.value }); }
    latest.forEach((v, sym) => { const r = get(sym); r.metrics[name] = v.value; r.quarter_date = !r.quarter_date || v.date > r.quarter_date ? v.date : r.quarter_date; });
  }
  // Chỉ giữ mã có ít nhất một chỉ số định giá hoặc vốn hoá
  return [...bySym.values()].filter((r) => r.metrics.marketcap > 0 || r.metrics.pe > 0 || r.metrics.pb > 0);
}

// Phân vị tuyến tính trên mảng đã sắp tăng dần, p trong [0, 1]
export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, p)), lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const r4 = (v: number) => Math.round(v * 10000) / 10000;

// Điều kiện hợp lệ của từng chỉ số khi đưa vào thống kê (loại giá trị vô lý: P/E âm, P/E hàng trăm lần do lợi nhuận tiệm cận 0...)
const VALID: Record<string, (v: number) => boolean> = {
  pe: (v) => v > 0 && v < 100, pb: (v) => v > 0 && v < 30, roae: (v) => v > -1 && v < 1, divYield: (v) => v >= 0 && v < 0.3, ps: (v) => v > 0 && v < 100,
  // các chỉ số cho hồ sơ phong cách (quy mô, động lượng, biến động) và vòng quay ngành (JdK 100 = ngang thị trường)
  marketcap: (v) => v > 0, chg1y: (v) => v > -0.95 && v < 10, chg3m: (v) => v > -0.95 && v < 5, beta: (v) => v > -1 && v < 4, jdkRs: (v) => v > 50 && v < 150, jdkMom: (v) => v > 50 && v < 150,
};
export const STAT_KEYS = Object.keys(VALID);

// Thống kê theo ngành ICB cấp 2 và toàn thị trường ('ALL'). Trả hàng cho bảng finance_sector_stats.
export function sectorStats(rows: SnapRow[], asOf: string | null, nowIso: string): { icb2_code: string; n: number; as_of: string | null; stats: Record<string, { n: number; median: number; q: number[] }>; updated_at: string }[] {
  const groups = new Map<string, SnapRow[]>();
  const put = (k: string, r: SnapRow) => { const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]); };
  for (const r of rows) {
    if (!(r.metrics.marketcap >= MIN_CAP_VND)) continue;
    put("ALL", r);
    if (r.icb2_code) put(r.icb2_code, r);
  }
  const out: any[] = [];
  groups.forEach((list, key) => {
    const stats: Record<string, { n: number; median: number; q: number[] }> = {};
    for (const k of STAT_KEYS) {
      const vals = list.map((r) => r.metrics[k]).filter((v) => typeof v === "number" && isFinite(v) && VALID[k](v)).sort((a, b) => a - b);
      if (vals.length < MIN_SECTOR_N) continue;
      const q: number[] = [];
      for (let i = 0; i < QUANTILE_POINTS; i++) q.push(r4(quantile(vals, i / (QUANTILE_POINTS - 1))));
      stats[k] = { n: vals.length, median: r4(quantile(vals, 0.5)), q };
    }
    if (Object.keys(stats).length) out.push({ icb2_code: key, n: list.length, as_of: asOf, stats, updated_at: nowIso });
  });
  return out.sort((a, b) => (a.icb2_code < b.icb2_code ? -1 : 1));
}

// Ngày dữ liệu chung của ảnh chụp (ngày báo cáo ngày phổ biến nhất)
export function snapshotDate(rows: SnapRow[]): string | null {
  const c = new Map<string, number>();
  for (const r of rows) if (r.daily_date) c.set(r.daily_date, (c.get(r.daily_date) ?? 0) + 1);
  let best: string | null = null, n = 0;
  c.forEach((v, k) => { if (v > n || (v === n && best !== null && k > best)) { best = k; n = v; } });
  return best;
}

// ---------- LỊCH SỬ ĐỊNH GIÁ ----------
// Mỗi ngày (và khi bù ngược quá khứ) ghi một dòng cho toàn thị trường ('ALL') và mỗi ngành ICB: trung vị và giá trị TỔNG HỢP theo vốn hoá của P/E, P/B.
// P/E tổng hợp = tổng vốn hoá / tổng lợi nhuận (điều hoà có trọng số vốn hoá, chỉ mã có lãi): gần với P/E của chỉ số. Chỉ tính mã vốn hoá từ 300 tỷ.
// LƯU Ý thiên lệch: ngành ICB lấy theo danh sách HIỆN TẠI nên mã đã hủy niêm yết chỉ có trong 'ALL' (thiên lệch người sống sót nhẹ ở các ngành).
export type HistRow = { as_of: string; scope: string; n: number; n_pe: number; n_pb: number; pe_median: number | null; pb_median: number | null; pe_agg: number | null; pb_agg: number | null; mcap_total: number };

function aggRatio(list: SnapRow[], key: string, valid: (v: number) => boolean): { median: number | null; agg: number | null; n: number } {
  const xs = list.filter((r) => typeof r.metrics[key] === "number" && valid(r.metrics[key]) && r.metrics.marketcap > 0);
  if (xs.length < MIN_SECTOR_N) return { median: null, agg: null, n: xs.length };
  const sorted = xs.map((r) => r.metrics[key]).sort((a, b) => a - b);
  const cap = xs.reduce((s, r) => s + r.metrics.marketcap, 0), denom = xs.reduce((s, r) => s + r.metrics.marketcap / r.metrics[key], 0);
  return { median: r4(quantile(sorted, 0.5)), agg: denom > 0 ? r4(cap / denom) : null, n: xs.length };
}

export function historyRows(rows: SnapRow[], asOf: string): HistRow[] {
  const groups = new Map<string, SnapRow[]>();
  const put = (k: string, r: SnapRow) => { const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]); };
  for (const r of rows) {
    if (!(r.metrics.marketcap >= MIN_CAP_VND)) continue;
    put("ALL", r);
    if (r.icb2_code) put(r.icb2_code, r);
  }
  const out: HistRow[] = [];
  groups.forEach((list, scope) => {
    const pe = aggRatio(list, "pe", VALID.pe), pb = aggRatio(list, "pb", VALID.pb);
    if (pe.median === null && pb.median === null) return;
    out.push({ as_of: asOf, scope, n: list.length, n_pe: pe.n, n_pb: pb.n, pe_median: pe.median, pb_median: pb.median, pe_agg: pe.agg, pb_agg: pb.agg, mcap_total: Math.round(list.reduce((s, r) => s + r.metrics.marketcap, 0)) });
  });
  return out.sort((a, b) => (a.scope < b.scope ? -1 : 1));
}

// Các ngày cuối tháng (YYYY-MM-DD) từ tháng `from` tới tháng `to` (YYYY-MM, gồm cả hai), mới nhất trước; ngày thật có dữ liệu do hàm gọi tự dò lùi (cuối tuần, lễ).
export function monthEnds(from: string, to: string): string[] {
  const ok = (x: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(x);
  if (!ok(from) || !ok(to) || from > to) return [];
  const out: string[] = [];
  let [y, m] = to.split("-").map(Number);
  const [fy, fm] = from.split("-").map(Number);
  while (y > fy || (y === fy && m >= fm)) {
    out.push(new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10));
    m--; if (m === 0) { m = 12; y--; }
    if (out.length > 120) break;
  }
  return out;
}
