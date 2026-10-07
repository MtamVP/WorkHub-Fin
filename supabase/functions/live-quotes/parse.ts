// Logic thuần của Edge Function live-quotes: giá khớp trực tiếp từ bảng giá VCI (Vietcap) cho Danh Mục. Không import Deno/Supabase để Vitest chạy được (tests/unit/live-quotes-fn.test.js).
// Nguồn: POST https://trading.vietcap.com.vn/api/price/v1/w/priceboard/tickers/price/group {group:"HOSE"|"HNX"|"UPCOM"} trả mảng mã của cả sàn, giá tính bằng ĐỒNG:
//   s mã, c giá khớp gần nhất (0 = chưa khớp), ref giá tham chiếu, cei trần, flo sàn, h cao, l thấp, op mở cửa, vo khối lượng khớp, va giá trị khớp (triệu đồng), bp1/ap1 giá mua/bán tốt nhất, bo sàn ("HSX"|"HNX"|"UPCOM"), st loại ("STOCK"...).
// Đo 07/10/2026 khi sàn mở: HOSE 430 mã 205 KB ~2 giây; giá mới hơn VNDirect finfo (finfo chậm 15 giây đến 2 phút).

export const GROUPS = ["HOSE", "HNX", "UPCOM"] as const;
export const MAX_SYMBOLS = 80;
const SYM = /^[A-Z0-9]{1,12}$/;

const num = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return isFinite(n) ? n : null; };

// body {symbols: [...]} -> mã sạch (viết hoa, bỏ trùng, bỏ mã sai), tối đa MAX_SYMBOLS. Lỗi: { error }.
export function validateRequest(body: any): { symbols: string[] } | { error: string } {
  const raw = body && Array.isArray(body.symbols) ? body.symbols : null;
  if (!raw) return { error: "Thiếu danh sách mã (symbols)." };
  const symbols = [...new Set(raw.map((s: unknown) => String(s ?? "").trim().toUpperCase()).filter((s: string) => SYM.test(s)))] as string[];
  if (!symbols.length) return { error: "Không có mã hợp lệ." };
  if (symbols.length > MAX_SYMBOLS) return { error: `Tối đa ${MAX_SYMBOLS} mã mỗi lần.` };
  return { symbols };
}

export type Quote = { price: number; ref: number | null; ceil: number | null; floor: number | null; open: number | null; high: number | null; low: number | null; volume: number | null; bid: number | null; ask: number | null; exchange: string };

// Một dòng bảng giá -> báo giá; null nếu chưa khớp lệnh nào (c = 0, ví dụ đang ATO hoặc mã không giao dịch hôm nay) hoặc giá ngoài biên trần/sàn (dữ liệu lỗi, dung sai 1%).
export function toQuote(r: any): Quote | null {
  const price = num(r && r.c);
  if (!(price !== null && price > 0)) return null;
  const ceil = num(r.cei), floor = num(r.flo);
  if (ceil !== null && floor !== null && ceil > 0 && floor > 0 && (price > ceil * 1.01 || price < floor * 0.99)) return null;
  const pos = (v: unknown) => { const n = num(v); return n !== null && n > 0 ? n : null; };
  return { price, ref: pos(r.ref), ceil: ceil !== null && ceil > 0 ? ceil : null, floor: floor !== null && floor > 0 ? floor : null, open: pos(r.op), high: pos(r.h), low: pos(r.l), volume: num(r.vo), bid: pos(r.bp1), ask: pos(r.ap1), exchange: String(r.bo || "") };
}

// Lấy báo giá của các mã cần từ một bảng giá. Trả { quotes, found: các mã có dòng trong bảng (kể cả mã chưa khớp lệnh) }.
export function pick(rows: any[], want: Set<string>): { quotes: Record<string, Quote>; found: Set<string> } {
  const quotes: Record<string, Quote> = {}, found = new Set<string>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const s = String(r && r.s || "").toUpperCase();
    if (!want.has(s)) continue;
    found.add(s);
    const q = toQuote(r);
    if (q) quotes[s] = q;
  }
  return { quotes, found };
}

// Ghép nhiều sàn: lần lượt qua các bảng giá cho tới khi mọi mã đều tìm thấy. loadBoard(group) trả mảng dòng (hoặc null nếu lỗi nguồn).
export async function collect(symbols: string[], loadBoard: (g: string) => Promise<any[] | null>): Promise<{ quotes: Record<string, Quote>; missing: string[]; failed: string[]; boards: string[] }> {
  const want = new Set(symbols), quotes: Record<string, Quote> = {}, failed: string[] = [], boards: string[] = [];
  for (const g of GROUPS) {
    if (!want.size) break;
    const rows = await loadBoard(g);
    if (!rows) { failed.push(g); continue; }
    boards.push(g);
    const p = pick(rows, want);
    Object.assign(quotes, p.quotes);
    p.found.forEach((s) => want.delete(s));
  }
  return { quotes, missing: [...want], failed, boards };
}
