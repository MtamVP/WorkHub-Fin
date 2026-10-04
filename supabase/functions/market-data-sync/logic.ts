// Logic thuần của Edge Function market-data-sync -- không import Deno/Supabase để Vitest chạy được (tests/unit/market-data-sync.test.ts.js).
// (1) thông tin mã: sàn, phân ngành ICB cấp 2 (nhà cung cấp VCI), thuộc VN30 (VNDirect). (2) lợi suất trái phiếu chính phủ (TradingView scanner, công khai). (3) KIỂM CHẤT LƯỢNG DỮ LIỆU GIÁ:
// so giá đóng cửa hai nguồn độc lập (VNDirect dchart và VCI), phát hiện nhảy giá vượt biên độ, thiếu phiên, giá cũ -- trước khi con số sai chảy vào NAV, rủi ro, hiệu quả.

export type Bar = { date: string; close: number };
export type Health = { kind: string; symbol: string | null; severity: "info" | "warn" | "error"; ref_date: string | null; detail: Record<string, unknown>; dedupe_key: string };

const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : 0; };
export const BAND: Record<string, number> = { HOSE: 0.07, HNX: 0.10, UPCOM: 0.15 };      // biên độ giá ngày theo sàn
export const EXCHANGE_BY_BOARD: Record<string, string> = { HSX: "HOSE", HOSE: "HOSE", HNX: "HNX", UPCOM: "UPCOM" };
export const TENORS = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y"] as const;

// Unix giây -> ngày YYYY-MM-DD (UTC; cả dchart và VCI đều đặt mốc 00:00 UTC của ngày giao dịch)
export function utcDate(sec: number): string { return new Date(sec * 1000).toISOString().slice(0, 10); }

// ---------- thông tin mã ----------
// VCI getAll: [{symbol, type, board, icbCode2, organShortName, organName, ...}]. Giữ cổ phiếu và ETF/quỹ trên HOSE/HNX/UPCOM.
export function parseVciSymbols(json: any): { symbol: string; name: string; exchange: string; type: string; icb2_code: string | null }[] {
  if (!Array.isArray(json)) return [];
  const out: { symbol: string; name: string; exchange: string; type: string; icb2_code: string | null }[] = [];
  for (const r of json) {
    const symbol = String(r && r.symbol || "").trim().toUpperCase();
    const type = String(r && r.type || "").toUpperCase();
    const exchange = EXCHANGE_BY_BOARD[String(r && r.board || "").toUpperCase()];
    if (!/^[A-Z0-9]{1,12}$/.test(symbol) || !exchange || !(type === "STOCK" || type === "ETF" || type === "FUND")) continue;
    const icb = r.icbCode2 === undefined || r.icbCode2 === null || r.icbCode2 === "" ? null : String(r.icbCode2).padStart(4, "0").slice(0, 4);
    out.push({ symbol, name: String(r.organShortName || r.organName || "").slice(0, 120), exchange, type, icb2_code: icb });
  }
  return out;
}

// VNDirect finfo v4 /stocks: { data: [{ code, floor, indexCode, listedDate, status, companyName }] }
export function parseVndStocks(json: any): Record<string, { exchange: string | null; vn30: boolean; listed_date: string | null; status: string; name: string }> {
  const out: Record<string, { exchange: string | null; vn30: boolean; listed_date: string | null; status: string; name: string }> = {};
  const rows = json && Array.isArray(json.data) ? json.data : [];
  for (const r of rows) {
    const code = String(r && r.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(code)) continue;
    const floor = EXCHANGE_BY_BOARD[String(r.floor || "").toUpperCase()] || null;
    out[code] = { exchange: floor, vn30: String(r.indexCode || "").toUpperCase() === "VN30", listed_date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.listedDate || "")) ? String(r.listedDate) : null, status: String(r.status || "listed").toLowerCase(), name: String(r.shortName || r.companyName || "").slice(0, 120) };
  }
  return out;
}

// Gộp: VCI là nguồn phân ngành (ICB), VNDirect là nguồn sàn/VN30/ngày niêm yết. Mã chỉ có ở một nguồn vẫn được giữ.
export function mergeMeta(vci: ReturnType<typeof parseVciSymbols>, vnd: ReturnType<typeof parseVndStocks>, nowIso: string) {
  const bySym = new Map<string, any>();
  for (const v of vci) bySym.set(v.symbol, { symbol: v.symbol, name: v.name, exchange: v.exchange, type: v.type, icb2_code: v.icb2_code, vn30: false, listed_date: null, status: "listed", source: "vci" });
  for (const code of Object.keys(vnd)) {
    const d = vnd[code], cur = bySym.get(code);
    if (cur) { cur.vn30 = d.vn30; cur.listed_date = d.listed_date; cur.status = d.status; if (d.exchange) cur.exchange = d.exchange; cur.source = "vci+vnd"; }
    else if (d.exchange) bySym.set(code, { symbol: code, name: d.name, exchange: d.exchange, type: "STOCK", icb2_code: null, vn30: d.vn30, listed_date: d.listed_date, status: d.status, source: "vnd" });
  }
  return [...bySym.values()].map((r) => ({ ...r, updated_at: nowIso }));
}

// ---------- lợi suất trái phiếu ----------
// TradingView scanner /symbol?fields=close,time -> { close, time }. Trả null nếu thiếu hoặc vô lý.
export function parseTvYield(json: any): { yield_pct: number; date: string } | null {
  if (!json || typeof json.close !== "number" || !isFinite(json.close) || json.close <= -5 || json.close >= 50) return null;
  const sec = typeof json.time === "number" ? json.time : null;
  const date = sec ? new Date((sec + 7 * 3600) * 1000).toISOString().slice(0, 10) : null;     // ngày theo giờ Việt Nam
  return date ? { yield_pct: json.close, date } : null;
}

// ---------- chuỗi giá ----------
// dchart: { s, t:[unix], c:[giá] } -- cổ phiếu tính bằng nghìn đồng (nhân 1000), chỉ số giữ nguyên điểm.
export function parseDchartBars(json: any, isIndex: boolean): Bar[] {
  if (!json || json.s !== "ok" || !Array.isArray(json.t) || !Array.isArray(json.c)) return [];
  const out: Bar[] = [];
  for (let i = 0; i < json.t.length; i++) {
    const c = json.c[i];
    if (typeof c !== "number" || !(c > 0) || typeof json.t[i] !== "number") continue;
    out.push({ date: utcDate(json.t[i]), close: isIndex ? c : Math.round(c * 1000 * 100) / 100 });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
// VCI gap-chart: [{ symbol, c:[giá VND], t:["unix"] }]
export function parseVciBars(json: any, symbol: string): Bar[] {
  const row = Array.isArray(json) ? json.find((x) => String(x && x.symbol).toUpperCase() === symbol) : null;
  if (!row || !Array.isArray(row.t) || !Array.isArray(row.c)) return [];
  const out: Bar[] = [];
  for (let i = 0; i < row.t.length; i++) {
    const c = Number(row.c[i]), t = Number(row.t[i]);
    if (!(c > 0) || !isFinite(t)) continue;
    out.push({ date: utcDate(t), close: c });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------- kiểm chất lượng ----------
// So hai nguồn trên các ngày chung. Lệch đều một hệ số (cả dãy cùng tỷ lệ) = khác cách điều chỉnh giá (info), không phải lỗi dữ liệu; lệch lẻ tẻ vượt ngưỡng = cảnh báo / lỗi.
export function comparePrices(symbol: string, a: Bar[], b: Bar[], opts?: { warnPct?: number; errorPct?: number; names?: [string, string] }): Health[] {
  const warn = opts?.warnPct ?? 0.5, err = opts?.errorPct ?? 2, names = opts?.names ?? ["dchart", "vci"];
  const mb = new Map(b.map((x) => [x.date, x.close]));
  const rows = a.filter((x) => mb.has(x.date)).map((x) => ({ date: x.date, a: x.close, b: mb.get(x.date)!, diffPct: (x.close / mb.get(x.date)! - 1) * 100 }));
  if (rows.length < 3) return [];
  const diffs = rows.map((r) => r.diffPct);
  const spread = Math.max(...diffs) - Math.min(...diffs);
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const out: Health[] = [];
  if (Math.abs(mean) > warn && spread < 0.2) {
    out.push({ kind: "price_level", symbol, severity: "info", ref_date: rows[rows.length - 1].date, detail: { factor: Math.round((1 + mean / 100) * 10000) / 10000, sources: names, note: "Hai nguồn lệch đều một hệ số: khác cách điều chỉnh giá cho cổ tức/phát hành, không phải lỗi giá." }, dedupe_key: `price_level|${symbol}|${rows[rows.length - 1].date}` });
    return out;
  }
  for (const r of rows) {
    const d = Math.abs(r.diffPct);
    if (d <= warn) continue;
    out.push({ kind: "price_mismatch", symbol, severity: d > err ? "error" : "warn", ref_date: r.date, detail: { [names[0]]: r.a, [names[1]]: r.b, diffPct: Math.round(r.diffPct * 100) / 100 }, dedupe_key: `price_mismatch|${symbol}|${r.date}` });
  }
  return out;
}

// Nhảy giá giữa hai phiên liền kề vượt biên độ sàn (cộng dung sai 0,5 điểm làm tròn) -- thường là sự kiện chưa điều chỉnh giá hoặc dữ liệu lỗi. Bỏ ngày đầu niêm yết (biên độ rộng hơn).
export function detectJumps(symbol: string, exchange: string | null, bars: Bar[], listedDate: string | null): Health[] {
  const band = BAND[exchange || "HOSE"] ?? 0.07, out: Health[] = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1].close, c = bars[i].close;
    if (!(p > 0)) continue;
    const ret = c / p - 1;
    if (Math.abs(ret) <= band + 0.005) continue;
    if (listedDate && bars[i].date <= addDays(listedDate, 10)) continue;
    out.push({ kind: "price_jump", symbol, severity: Math.abs(ret) > 2 * band ? "error" : "warn", ref_date: bars[i].date, detail: { prev: p, close: c, retPct: Math.round(ret * 10000) / 100, bandPct: band * 100, note: "Giá nhảy vượt biên độ sàn: có thể là sự kiện doanh nghiệp chưa điều chỉnh hoặc dữ liệu lỗi." }, dedupe_key: `price_jump|${symbol}|${bars[i].date}` });
  }
  return out;
}

export function addDays(d: string, n: number): string { return new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10); }

// Phiên giao dịch lấy từ chuỗi VN-Index (không cần lịch nghỉ lễ tự gõ). Mã thiếu một phiên mà chỉ số có = thiếu dữ liệu; mã dừng ở phiên cũ hơn phiên cuối của chỉ số quá `staleSessions` phiên = giá cũ.
export function detectGaps(symbol: string, bars: Bar[], indexBars: Bar[], opts?: { lookbackSessions?: number; staleSessions?: number }): Health[] {
  const look = opts?.lookbackSessions ?? 5, stale = opts?.staleSessions ?? 1;
  const sessions = indexBars.map((x) => x.date).slice(-look);
  if (sessions.length < 3 || !bars.length) return [];
  const have = new Set(bars.map((x) => x.date));
  const last = bars[bars.length - 1].date;
  const lastSession = sessions[sessions.length - 1];
  const behind = indexBars.filter((x) => x.date > last).length;
  const out: Health[] = [];
  if (behind > stale) {
    out.push({ kind: "stale_price", symbol, severity: behind >= 3 ? "warn" : "info", ref_date: lastSession, detail: { lastBar: last, sessionsBehind: behind, note: "Mã không có giá ở các phiên gần nhất: có thể bị đình chỉ/tạm ngừng giao dịch hoặc nguồn dữ liệu thiếu." }, dedupe_key: `stale_price|${symbol}|${lastSession}` });
    return out;
  }
  const missing = sessions.filter((d) => !have.has(d) && d <= last);
  if (missing.length) out.push({ kind: "missing_session", symbol, severity: "warn", ref_date: missing[missing.length - 1], detail: { missing, note: "Mã thiếu giá ở phiên mà VN-Index có giao dịch." }, dedupe_key: `missing_session|${symbol}|${missing[missing.length - 1]}` });
  return out;
}

// Mã trong danh mục chưa có phân ngành (cả bảng tự gõ lẫn ICB): báo để biết Brinson / giới hạn ngành đang thiếu mã nào
export function metaGaps(heldSymbols: string[], hasSector: (s: string) => boolean, today: string): Health[] {
  const missing = [...new Set(heldSymbols)].filter((s) => !hasSector(s));
  if (!missing.length) return [];
  return [{ kind: "meta_gap", symbol: null, severity: "info", ref_date: today, detail: { symbols: missing.slice(0, 40), count: missing.length, note: "Các mã này chưa có phân ngành: phân bổ ngành, Brinson và giới hạn ngành sẽ xếp vào 'Chưa phân ngành'." }, dedupe_key: `meta_gap|${today}|${missing.slice(0, 40).join(",")}` }];
}
