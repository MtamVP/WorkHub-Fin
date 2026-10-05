// Logic thuần của Edge Function valuation-watch -- không import Deno/Supabase để Vitest chạy được (tests/unit/valuation-watch.test.js).
// Tính cảnh báo định giá bằng ĐÚNG các thư viện của app (ValuationAlerts, GroupCalc, SectorMap -- truyền vào qua `libs`), nên khớp với màn hình Toàn Nhóm > Định Lượng.
export interface Libs { GroupCalc: any; ValuationAlerts: any; SectorMap: any }
export interface Alert { key: string; level: "warn" | "info"; scope: string; title: string; detail: string }
export interface StateRow { alert_key: string; level: string; scope: string | null; title: string; detail: string | null; active: boolean; first_seen: string; last_seen: string; last_notified_at: string | null }
export interface Plan { upserts: StateRow[]; deactivate: string[]; notify: Alert[] }

export const COOLDOWN_DAYS = 7;

// Ngày theo giờ Việt Nam (UTC+7) dạng YYYY-MM-DD
export function vnDate(d: Date): string { return new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10); }

// Tỷ trọng danh mục CẢ NHÓM theo ngành ICB (giá trị cổ phiếu / tổng giá trị cổ phiếu; không tính tiền mặt, như bảng "Ngành đang nắm" của app). Số cổ phiếu tính bằng
// GroupCalc.memberPortfolios (FIFO + hành động doanh nghiệp), ngành lấy theo ảnh chụp thị trường (icbBySymbol).
export function sectorWeights(libs: Libs, input: { members: any[]; txns: any[]; actions: any[]; prices: any[]; assets: any[] }, icbBySymbol: Record<string, string | null>): { code: string; name: string; weightPct: number }[] {
  const portfolios = libs.GroupCalc.memberPortfolios(input);
  const group = libs.GroupCalc.consolidate(portfolios);
  const by: Record<string, number> = {};
  let total = 0;
  for (const s of group.symbols as any[]) {
    if (!(s.value > 0)) continue;
    total += s.value;
    const code = icbBySymbol[s.symbol];
    if (code) by[code] = (by[code] || 0) + s.value;
  }
  if (!(total > 0)) return [];
  return Object.keys(by).map((code) => ({ code, name: libs.SectorMap.icbName(code) || ("ICB " + code), weightPct: by[code] / total * 100 })).sort((a, b) => b.weightPct - a.weightPct);
}

export function currentAlerts(libs: Libs, histRows: any[], sectors: { code: string; name: string; weightPct: number }[], bond10yPct: number | null): { alerts: Alert[]; asOf: string | null; enough: boolean } {
  const r = libs.ValuationAlerts.build(histRows, sectors, { bond10yPct });
  return { alerts: r.alerts as Alert[], asOf: r.asOf, enough: r.enough };
}

// So cảnh báo hiện tại với bảng nhớ: cái nào MỚI (chưa có, hoặc đã hết hiệu lực rồi xuất hiện lại) và ngoài thời gian chờ thì được gửi email.
// Không gửi lại trong COOLDOWN_DAYS ngày kể từ lần gửi gần nhất để cảnh báo nhấp nháy quanh ngưỡng không gây thư rác.
export function planNotify(alerts: Alert[], state: StateRow[], today: string, now: Date): Plan {
  const prev = new Map(state.map((s) => [s.alert_key, s]));
  const keys = new Set(alerts.map((a) => a.key));
  const cutoff = now.getTime() - COOLDOWN_DAYS * 86400000;
  const upserts: StateRow[] = [], notify: Alert[] = [];
  for (const a of alerts) {
    const p = prev.get(a.key);
    const isNew = !p || !p.active;
    const lastSent = p && p.last_notified_at ? Date.parse(p.last_notified_at) : null;
    if (isNew && (lastSent === null || lastSent < cutoff)) notify.push(a);
    upserts.push({ alert_key: a.key, level: a.level, scope: a.scope, title: a.title, detail: a.detail, active: true, first_seen: p && p.active ? p.first_seen : today, last_seen: today, last_notified_at: p ? p.last_notified_at : null });
  }
  const deactivate = state.filter((s) => s.active && !keys.has(s.alert_key)).map((s) => s.alert_key);
  return { upserts, deactivate, notify };
}

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildEmail(fresh: Alert[], activeCount: number, asOf: string | null): { subject: string; html: string; text: string } {
  const warn = fresh.filter((a) => a.level === "warn").length;
  const dt = asOf ? String(asOf).slice(0, 10).split("-").reverse().join("/") : "";
  const subject = warn ? `Cảnh báo định giá: ${warn} tín hiệu cần xem${fresh.length > warn ? ` và ${fresh.length - warn} thông tin` : ""}` : `Thông tin định giá: ${fresh.length} tín hiệu mới`;
  const rows = fresh.map((a) => `<li style="margin:0 0 10px"><b>[${a.level === "warn" ? "Cần xem" : "Thông tin"}] ${esc(a.title)}</b><br><span style="color:#444">${esc(a.detail)}</span></li>`).join("");
  const foot = "Đây là tín hiệu để soát danh mục, không phải lệnh mua bán: đắt hay rẻ so với lịch sử có thể kéo dài nhiều năm, và rẻ có thể do lợi nhuận đi xuống. Mở Toàn Nhóm → Định Lượng hoặc Nghiên Cứu → Bản đồ để xem chi tiết.";
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111"><p>Số liệu ngày ${esc(dt)}. Có ${fresh.length} cảnh báo mới (đang có hiệu lực: ${activeCount}).</p><ul style="padding-left:18px">${rows}</ul><p style="color:#555;font-size:12px">${esc(foot)} Tắt email này ở Cài đặt → email cảnh báo.</p></div>`;
  const text = `Số liệu ngày ${dt}. Có ${fresh.length} cảnh báo mới (đang có hiệu lực: ${activeCount}).\n\n` + fresh.map((a) => `- [${a.level === "warn" ? "Cần xem" : "Thông tin"}] ${a.title}\n  ${a.detail}`).join("\n") + `\n\n${foot}`;
  return { subject, html, text };
}

// Bài tự kiểm cố định (không đụng CSDL): sau khi triển khai, gọi hàm với {"selftest":true} và so với tests/unit/valuation-watch.test.js -- bắt lỗi chép thư viện hoặc khác biệt môi trường chạy.
export function selfTest(libs: Libs): { alerts: string[]; sectors: { code: string; weightPct: number }[] } {
  const tx = (id: string, user_id: string, type: string, symbol: string, quantity: number, price: number, trade_date: string) =>
    ({ id, user_id, type, symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + "T01:00:00Z", deleted_at: null });
  const sectors = sectorWeights(libs, {
    members: [{ id: "u1", email: "an@x.vn", nickname: "An" }],
    txns: [tx("1", "u1", "buy", "FPT", 1000, 100000, "2026-01-02"), tx("2", "u1", "buy", "HPG", 2000, 25000, "2026-01-03")],
    actions: [],
    prices: [{ user_id: "u1", symbol: "FPT", market_price: 100000, price_date: "2026-10-02", updated_at: "a" }, { user_id: "u1", symbol: "HPG", market_price: 25000, price_date: "2026-10-02", updated_at: "a" }],
    assets: [{ user_id: "u1", cash: 0, debt: 0 }],
  }, { FPT: "9500", HPG: "1700" });
  const hist: any[] = [];
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(2026, 8, 30) - (59 - i) * 30.4 * 86400000).toISOString().slice(0, 10);
    hist.push({ as_of: d, scope: "ALL", pe_agg: 8 + 10 * i / 59 }, { as_of: d, scope: "9500", pe_agg: 20 - 12 * i / 59 }, { as_of: d, scope: "1700", pe_agg: 10 });
  }
  const r = currentAlerts(libs, hist, sectors, null);
  return { alerts: r.alerts.map((a) => a.key), sectors: sectors.map((s) => ({ code: s.code, weightPct: Math.round(s.weightPct * 10) / 10 })) };
}
