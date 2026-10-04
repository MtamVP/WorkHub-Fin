// Logic thuần của Edge Function stock-events -- không import Deno/Supabase để Vitest chạy được (tests/unit/stock-events-parse.test.js).
// Nguồn: VNDirect finfo v4 /events (group investorRight). Các loại dùng ở đây:
//   DIVIDEND = cổ tức tiền mặt (dividend = đồng/cp, effectiveDate = ngày giao dịch không hưởng quyền, actualDate = ngày thanh toán)
//   STOCKDIV = cổ tức bằng cổ phiếu (ratio = 15 nghĩa là tỷ lệ 100:15, tức nhận thêm 15%)
//   KINDDIV  = cổ phiếu thưởng (cùng quy ước ratio)
//   ISSUE    = phát hành thêm (ratio = số cp mới trên 100 cp đang giữ, price = giá phát hành đ/cp); chỉ lấy đợt cho cổ đông hiện hữu
// Các loại khác (họp cổ đông, niêm yết thêm, lịch dự kiến...) bị bỏ qua.

export const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;
export const MAX_SYMBOLS = 30;
export const EVENT_TYPES = ["DIVIDEND", "STOCKDIV", "KINDDIV", "ISSUE"] as const;
export type EventKind = "cash_dividend" | "stock_dividend" | "bonus" | "rights";

export type EventRow = {
  id?: string; code?: string; type?: string; locale?: string; note?: string | null; status?: string | null;
  dividend?: number | string | null; ratio?: number | string | null; price?: number | string | null; divYear?: number | string | null;
  divPeriod?: number | string | null; effectiveDate?: string | null; actualDate?: string | null; expiredDate?: string | null;
  registerEndDate?: string | null; tradingEndDate?: string | null;
};
export type CorporateEvent = {
  id: string; symbol: string; kind: EventKind; exDate: string; payDate: string | null; dps: number | null; ratio: number | null;
  price: number | null; divYear: number | null; period: number | null; note: string;
};

const KIND_OF_TYPE: Record<string, EventKind> = { DIVIDEND: "cash_dividend", STOCKDIV: "stock_dividend", KINDDIV: "bonus", ISSUE: "rights" };

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function isoDate(v: unknown): string | null {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function validateRequest(body: any): { error: string | null; symbols: string[]; since: string } {
  const fallbackSince = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);
  if (!body) return { error: "Thiếu dữ liệu yêu cầu.", symbols: [], since: fallbackSince };
  const list = Array.isArray(body.symbols) ? body.symbols : (body.symbol ? [body.symbol] : []);
  if (!list.length) return { error: "Thiếu mã cổ phiếu.", symbols: [], since: fallbackSince };
  const symbols = [...new Set(list.map((s: unknown) => String(s).trim().toUpperCase()))] as string[];
  if (symbols.some((s) => !SYMBOL_RE.test(s))) return { error: "Mã cổ phiếu không hợp lệ.", symbols: [], since: fallbackSince };
  if (symbols.length > MAX_SYMBOLS) return { error: `Tối đa ${MAX_SYMBOLS} mã mỗi lần.`, symbols: [], since: fallbackSince };
  let since = fallbackSince;
  if (body.since !== undefined && body.since !== null && body.since !== "") {
    const d = isoDate(body.since);
    if (!d) return { error: "Ngày bắt đầu không hợp lệ (cần dạng YYYY-MM-DD).", symbols: [], since: fallbackSince };
    // Chặn lùi quá 8 năm để câu truy vấn không phình ra
    const floor = new Date(Date.now() - 8 * 365 * 86400000).toISOString().slice(0, 10);
    since = d < floor ? floor : d;
  }
  return { error: null, symbols, since };
}

// Chuẩn hoá 1 dòng nguồn -> sự kiện của app; null nếu không dùng được.
export function normalizeEvent(e: EventRow): CorporateEvent | null {
  const type = String(e.type ?? "");
  const kind = KIND_OF_TYPE[type];
  if (!kind) return null;
  if (e.locale && e.locale !== "VN") return null;
  const symbol = String(e.code ?? "").trim().toUpperCase();
  const exDate = isoDate(e.effectiveDate);
  const id = String(e.id ?? "").trim();
  if (!symbol || !exDate || !id) return null;
  const note = String(e.note ?? "").trim();
  const ratio = num(e.ratio), dps = num(e.dividend), price = num(e.price);

  if (kind === "cash_dividend") {
    if (dps === null || !(dps > 0)) return null;
  } else if (kind === "rights") {
    // Chỉ đợt chào bán cho cổ đông hiện hữu mới là quyền mua của người đang giữ; ESOP/riêng lẻ bỏ qua
    if (!/CĐHH|cổ đông hiện hữu/i.test(note)) return null;
    if (ratio === null || !(ratio > 0) || price === null || !(price > 0)) return null;
  } else if (ratio === null || !(ratio > 0)) {
    return null;
  }

  return {
    id, symbol, kind, exDate,
    payDate: isoDate(e.actualDate) ?? (kind === "cash_dividend" ? isoDate(e.expiredDate) : null),
    dps: kind === "cash_dividend" ? dps : null,
    ratio: kind === "cash_dividend" ? null : ratio,
    price: kind === "rights" ? price : null,
    divYear: num(e.divYear), period: num(e.divPeriod), note,
  };
}

// Sự kiện từ ngày `since` trở đi, mới nhất trước; bỏ trùng theo id.
export function buildEvents(rows: EventRow[], since: string): CorporateEvent[] {
  const seen = new Set<string>();
  const out: CorporateEvent[] = [];
  for (const r of rows) {
    const ev = normalizeEvent(r);
    if (!ev || ev.exDate < since || seen.has(ev.id)) continue;
    seen.add(ev.id);
    out.push(ev);
  }
  return out.sort((a, b) => (a.exDate < b.exDate ? 1 : a.exDate > b.exDate ? -1 : a.id < b.id ? -1 : 1));
}
