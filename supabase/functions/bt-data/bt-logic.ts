// Logic thuần của Edge Function bt-data -- không import Deno/Supabase để Vitest chạy được (tests/unit/bt-data.test.js).
// Kho GIÁ THEO NGÀY cho kiểm thử chiến lược (Insight > Kiểm thử): mỗi ngày giao dịch một dòng finance_price_days với toàn thị trường dạng gọn { "FPT": [giá đóng cửa THÔ, LỢI SUẤT NGÀY, giá trị khớp lệnh (triệu đồng), cờ trần/sàn, sàn] }.
// Vì sao lưu LỢI SUẤT ngày thay vì giá đã điều chỉnh: giá điều chỉnh của nguồn bị tính lại mỗi khi có cổ tức / thưởng mới (cả lịch sử đổi theo). Lợi suất ngày = adClose(D) / adClose(D-1) - 1 với CẢ HAI giá lấy trong CÙNG MỘT
//   lần gọi nguồn (cùng một mốc điều chỉnh) nên đã gồm cổ tức, thưởng, chia tách đúng ngày không hưởng quyền và KHÔNG BAO GIỜ đổi sau đó: kho chỉ cần THÊM ngày mới, không phải viết lại. Đã đối chiếu 8 mã với chuỗi dchart trong 6 năm.
// KHÔNG dùng close / giá tham chiếu - 1: chỉ đúng ở HOSE (tham chiếu = giá đóng cửa hôm trước). HNX và UPCoM dùng GIÁ BÌNH QUÂN hôm trước làm tham chiếu nên chuỗi nối bằng cách đó sai (đã gặp: mã penny UPCoM phình tới 10^16 lần).
//   Mã chưa có giá hôm trước (mới niêm yết, vừa trở lại) thì lấy close / tham chiếu - 1 làm dự phòng.
// Mọi mã (cả UPCoM, cả mã sau này hủy niêm yết) đều có mặt MỌI ngày kể cả ngày không giao dịch (giá đóng cửa = giá tham chiếu): kho không bị thiên lệch người sống sót, và chuỗi lợi suất của từng mã liền mạch.
// BÀI HỌC (11/10/2026): bản đầu bỏ các dòng UPCoM giá trị khớp < 50 triệu. Mã penny (giá 0,4-0,5 nghìn đồng, bước giá 0,1 = 20-25%) chỉ có dòng ở những ngày bật lên, nên chuỗi tích luỹ chỉ ghi nhận các nhịp tăng
// và mức giá phình tới 1,7 triệu lần. Mất dòng ở ngày nào thì mất luôn nhịp của ngày đó; vì vậy KHÔNG được lọc bớt dòng trong kho giá.
import { buildSnapshot, SNAP_DAILY, SNAP_QUARTER, type SnapRow } from "./peers.ts";

export const DAY0 = "2020-01-02";                 // ngày giao dịch đầu tiên của kho (dchart VN-Index có từ đây)
export const MIN_STOCKS_PER_DAY = 600;            // dưới mức này: nguồn chưa đăng đủ ngày đó (cuối phiên) hoặc không phải ngày giao dịch -> không lưu
export const INDEX_CODES = ["VNINDEX", "VN30", "HNX", "UPCOM", "VNFIN", "VNREAL", "VNMAT", "VNIT", "VNHEAL", "VNCOND", "VNCONS", "VNENE", "VNIND", "VNUTI"];
export type DayRow = [number, number, number, number, number];     // [đóng cửa thô, lợi suất ngày, triệu đồng, cờ, sàn]
const EXCHANGE: Record<string, number> = { HOSE: 0, HSX: 0, HNX: 1, UPCOM: 2 };

const isDate = (s: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// Unix giây -> ngày theo giờ Việt Nam
export function vnDate(sec: number): string { return new Date((sec + 7 * 3600) * 1000).toISOString().slice(0, 10); }

// finfo stock_prices?q=date:gte:P~date:lte:D~type:STOCK: các dòng của ngày `day` (và ngày liền trước `prevDay` để tính lợi suất). Không truyền ngày: coi mọi dòng là của ngày cần lưu, không có ngày trước.
// Trả { stocks, kept, data }. stocks = số mã có giá; kept = số mã giữ lại (bằng stocks: không lọc bớt dòng nào có giá). Lợi suất làm tròn 5 chữ số thập phân.
export function parseDay(json: any, day?: string, prevDay?: string): { stocks: number; kept: number; data: Record<string, DayRow> } {
  const all = json && Array.isArray(json.data) ? json.data : [];
  const dateOf = (r: any) => String(r && r.date || "").slice(0, 10);
  const rows = day ? all.filter((r: any) => dateOf(r) === day) : all;
  const prevAd = new Map<string, number>();
  if (day && prevDay) for (const r of all) { if (dateOf(r) === prevDay) { const a = Number(r.adClose); const c = String(r && r.code || "").trim().toUpperCase(); if (a > 0 && c) prevAd.set(c, a); } }
  const data: Record<string, DayRow> = {};
  let stocks = 0;
  for (const r of rows) {
    const code = String(r && r.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(code)) continue;
    if (r.type && String(r.type).toUpperCase() !== "STOCK") continue;
    const close = Number(r.close), basic = Number(r.basicPrice);
    if (!(close > 0) || !(basic > 0)) continue;
    const x = EXCHANGE[String(r.floor || "").toUpperCase()];
    if (x === undefined) continue;
    stocks++;
    const value = Number(r.nmValue) > 0 ? Number(r.nmValue) : 0;
    const ceil = Number(r.ceilingPrice), floor = Number(r.floorPrice);
    const k = ceil > 0 && close >= ceil - 1e-9 ? 1 : (floor > 0 && close <= floor + 1e-9 ? -1 : 0);
    const ad = Number(r.adClose), pa = prevAd.get(code);
    const ret = ad > 0 && pa !== undefined ? ad / pa - 1 : close / basic - 1;
    data[code] = [r3(close), Math.round(ret * 1e5) / 1e5, Math.round(value / 1e6), k, x];
  }
  return { stocks, kept: Object.keys(data).length, data };
}

// dchart { s, t, c } của chỉ số -> { d: [ngày], c: [điểm] } (ngày tăng dần, không trùng)
export function parseIndex(json: any): { d: string[]; c: number[] } {
  const out = { d: [] as string[], c: [] as number[] };
  if (!json || json.s !== "ok" || !Array.isArray(json.t) || !Array.isArray(json.c)) return out;
  let last = "";
  for (let i = 0; i < json.t.length; i++) {
    const c = Number(json.c[i]), t = Number(json.t[i]);
    if (!(c > 0) || !isFinite(t)) continue;
    const d = vnDate(t);
    if (d <= last) continue;
    out.d.push(d); out.c.push(Math.round(c * 100) / 100); last = d;
  }
  return out;
}

// Ngày giao dịch còn thiếu trong kho, mới nhất trước, tối đa limit ngày. all: ngày giao dịch (VN-Index); have: ngày đã có.
export function missingDays(all: string[], have: Set<string>, limit: number, from: string = DAY0): string[] {
  const out: string[] = [];
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) { if (all[i] >= from && !have.has(all[i])) out.push(all[i]); }
  return out;
}

// Ngày giao dịch CUỐI THÁNG cho từng tháng trong [from, to] (YYYY-MM-DD); days: ngày giao dịch tăng dần.
export function monthEndTradingDays(days: string[], from: string, to: string): string[] {
  const last = new Map<string, string>();
  for (const d of days) { if (d >= from && d <= to) last.set(d.slice(0, 7), d); }
  return [...last.values()].sort();
}

// ---------- bảng số liệu theo thời điểm (finance_pit_market_daily) dựng ngược ----------
// Cùng thứ tự cột với fn_pit_capture (finance-pit-migration.sql). 'price' và 'shares' để trống ở các ngày dựng ngược (nguồn chỉ có số cổ phần hiện tại).
export const PIT_COLS = ["icb2", "price", "marketcap", "pe", "pb", "ps", "evEbitda", "divYield", "roae", "roaa", "beta", "chg1m", "chg3m", "chg6m", "chg1y", "chgYtd", "advValue20", "freefloat", "netMargin", "grossMargin", "debtToEquity", "netProfitGrowthYoY", "salesGrowthYoY", "epsGrowthYoY", "jdkRs", "jdkMom", "shares"];
const NO_BACKFILL = new Set(["price", "freefloat", "shares"]);
// Cùng cách làm tròn với fn_pit_r: từ 1000 trở lên lấy nguyên, còn lại 5 chữ số thập phân
export function pitRound(v: unknown): number | null {
  const n = typeof v === "number" ? v : NaN;
  if (!isFinite(n)) return null;
  return Math.abs(n) >= 1000 ? Math.round(n) : Math.round(n * 1e5) / 1e5;
}
export function packPit(rows: SnapRow[]): { n: number; cols: string[]; data: Record<string, (string | number | null)[]> } {
  const data: Record<string, (string | number | null)[]> = {};
  for (const r of rows) {
    data[r.symbol] = PIT_COLS.map((c) => (c === "icb2" ? (r.icb2_code ?? null) : (NO_BACKFILL.has(c) ? null : pitRound(r.metrics[c]))));
  }
  return { n: Object.keys(data).length, cols: PIT_COLS.slice(), data };
}

// Số liệu quý chỉ được dùng khi ĐÃ CÓ THỂ biết: quý 1-3 sau 45 ngày kể từ cuối kỳ, quý 4 (báo cáo năm, kiểm toán) sau 90 ngày -- cùng hạn công bố bảo thủ của lib/pit-calc.js (knownAt).
export const lagOf = (reportDate: string) => (String(reportDate).slice(5, 10) === "12-31" ? 90 : 45);
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export function knownByDate(reportDate: string, asOf: string): boolean { return isDate(reportDate) && addDays(reportDate, lagOf(reportDate)) <= asOf; }
export function filterQuarterPit(rows: any[], asOf: string): any[] {
  return (rows ?? []).filter((r) => r && knownByDate(String(r.reportDate || "").slice(0, 10), asOf));
}
// Khoảng reportDate cần hỏi để chắc chắn gồm quý mới nhất đã công bố: lùi tối đa 200 ngày, tới 45 ngày trước ngày D (quý cuối năm lọc thêm bằng filterQuarterPit)
export function quarterWindow(asOf: string): { from: string; to: string } { return { from: addDays(asOf, -200), to: addDays(asOf, -45) }; }

export const BACKFILL_DAILY = SNAP_DAILY;
export const BACKFILL_QUARTER = SNAP_QUARTER.filter((c) => c !== "TOTAL_SHARES" && c !== "FREEFLOAT");      // hai chỉ số này VNDirect ghi theo cuối năm HIỆN TẠI, không có lịch sử theo ngày

// Dựng bảng số liệu của ngày asOf từ các phản hồi ratios đã gom: daily { MÃ_CHỈ_SỐ: hàng[] } (reportDate = asOf), quarter { MÃ_CHỈ_SỐ: hàng[] } (cửa sổ quarterWindow).
export function buildPitDay(asOf: string, daily: Record<string, any[]>, quarter: Record<string, any[]>, icbOf: (s: string) => string | null) {
  const q: Record<string, any[]> = {};
  for (const k of Object.keys(quarter)) q[k] = filterQuarterPit(quarter[k], asOf);
  const rows = buildSnapshot(daily, q, icbOf);
  return packPit(rows);
}
