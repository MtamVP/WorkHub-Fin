// Logic thuần của Edge Function send-price-alerts -- không import Deno/Supabase để Vitest chạy được
// (tests/unit/price-alerts-logic.test.js). Phải khớp hành vi phía app: api.js (_valuationTarget, _priceMeta,
// getHoldingsView) và notify-deadlines.js (checkPriceAlerts).

export type Txn = { user_id: string; symbol: string; type: string; quantity: number | string; trade_date: string; created_at: string };
export type Action = { user_id: string; symbol: string; action_type: string; ratio: number | string; ex_date: string; created_at: string };
export type PriceRow = {
  user_id: string; symbol: string; market_price: number | string | null; locked: boolean | null;
  target_price: number | string | null; stop_loss: number | string | null;
  price_date: string | null; updated_at: string | null;
};
export type WatchRow = { user_id: string; symbol: string; buy_below: number | string | null };
export type Alert = { symbol: string; kind: "target" | "stop" | "buy"; threshold: number; price: number };

const DAY_MS = 86400000;

// Ngày theo giờ Việt Nam (UTC+7), dạng YYYY-MM-DD
export function vnDate(now: Date): string {
  return new Date(now.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

// Khối lượng đang nắm theo (user -> symbol), replay theo thứ tự thời gian: mua +, bán - (không âm),
// tách/gộp nhân hệ số, cổ tức cổ phiếu nhân (1 + tỷ lệ). Khớp _replayFifo (api.js) về tổng khối lượng.
export function heldQuantities(txns: Txn[], actions: Action[]): Map<string, Map<string, number>> {
  type Ev = { kind: "txn" | "action"; date: string; ts: string; row: any };
  const events: Ev[] = [
    ...txns.map((t) => ({ kind: "txn" as const, date: t.trade_date, ts: t.created_at, row: t })),
    ...actions.map((a) => ({ kind: "action" as const, date: a.ex_date, ts: a.created_at, row: a })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind !== b.kind ? (a.kind === "action" ? -1 : 1) : a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  // ^ cùng ngày: sự kiện doanh nghiệp trước lệnh (ngày không hưởng quyền: bán hôm đó là bán cổ phiếu đã điều chỉnh)

  const result = new Map<string, Map<string, number>>();
  const get = (u: string, s: string) => {
    if (!result.has(u)) result.set(u, new Map());
    return result.get(u)!.get(s) ?? 0;
  };
  const set = (u: string, s: string, q: number) => result.get(u)!.set(s, q);

  for (const ev of events) {
    const r = ev.row;
    if (ev.kind === "action") {
      const cur = get(r.user_id, r.symbol);
      if (cur <= 0) continue;
      const ratio = Number(r.ratio);
      const mult = r.action_type === "split" ? ratio : 1 + ratio;
      if (mult > 0) set(r.user_id, r.symbol, cur * mult);
    } else {
      const cur = get(r.user_id, r.symbol);
      const qty = Number(r.quantity) || 0;
      set(r.user_id, r.symbol, r.type === "buy" ? cur + qty : Math.max(0, cur - qty));
    }
  }
  return result;
}

// Giá mục tiêu suy ra từ Định Giá CP. Hồ sơ mới có sẵn fair_value (giá hợp lý theo mẫu ngành) -> dùng luôn; hồ sơ cũ: trung bình giá
// theo P/E và P/B mục tiêu (phần dương), đọc cả khoá v1/v2/v3 lẫn snake_case thời Google Sheet. Khớp api.js (_valuationTarget).
export function valuationTarget(d: any): number | null {
  const fair = Number(d && d.fair_value);
  if (fair > 0) return fair;
  const v1 = Number(d && (d.v1 || d.charter_capital)) || 0;
  if (!v1) return null;
  const eps = ((Number(d.v3 || d.lnst) || 0) / v1) * 10000;
  const bvps = ((Number(d.v2 || d.equity) || 0) / v1) * 10000;
  const parts = [(Number(d.targetPE || d.target_pe) || 0) * eps, (Number(d.targetPB || d.target_pb) || 0) * bvps].filter((p) => p > 0);
  return parts.length ? parts.reduce((s, p) => s + p, 0) / parts.length : null;
}

// Giá đã cũ: tự động > 4 ngày lịch; nhập tay > 7 ngày và chưa khóa. Khớp _priceMeta (api.js).
export function isStalePrice(row: PriceRow, now: Date): boolean {
  const dayDiff = (iso: string) => Math.max(0, Math.round((Date.parse(vnDate(now) + "T00:00:00Z") - Date.parse(iso.slice(0, 10) + "T00:00:00Z")) / DAY_MS));
  if (row.price_date) return dayDiff(row.price_date) > 4;
  if (row.updated_at) return !row.locked && dayDiff(String(row.updated_at)) > 7;
  return false;
}

// Các cảnh báo đang thỏa điều kiện của 1 user. heldQty: symbol -> khối lượng; valuations: symbol -> giá mục tiêu từ định giá.
export function evaluateAlerts(rows: PriceRow[], heldQty: Map<string, number>, valuations: Map<string, number>, now: Date): Alert[] {
  const alerts: Alert[] = [];
  for (const row of rows) {
    if ((heldQty.get(row.symbol) ?? 0) <= 1e-9) continue; // không còn giữ mã này
    const price = Number(row.market_price) || 0;
    if (price <= 0 || isStalePrice(row, now)) continue;
    const manualTarget = Number(row.target_price) || 0;
    const valTarget = valuations.get(row.symbol);
    const target = manualTarget || (valTarget ? Math.round(valTarget) : 0);
    const stop = Number(row.stop_loss) || 0;
    if (target > 0 && price >= target) alerts.push({ symbol: row.symbol, kind: "target", threshold: target, price });
    if (stop > 0 && price <= stop) alerts.push({ symbol: row.symbol, kind: "stop", threshold: stop, price });
  }
  return alerts;
}

// Cảnh báo "chạm giá muốn mua" cho mã trong DANH SÁCH THEO DÕI mà người dùng CHƯA nắm giữ: giá thị trường <= giá muốn mua đã đặt.
// Cùng quy tắc giá cũ với evaluateAlerts (giá quá cũ thì không báo).
export function evaluateWatchAlerts(watch: WatchRow[], rows: PriceRow[], heldQty: Map<string, number>, now: Date): Alert[] {
  const alerts: Alert[] = [];
  for (const w of watch) {
    const buyBelow = Number(w.buy_below) || 0;
    if (buyBelow <= 0) continue;
    if ((heldQty.get(w.symbol) ?? 0) > 1e-9) continue; // đã mua rồi -> không còn là mã "chờ mua"
    const row = rows.find((r) => r.symbol === w.symbol);
    if (!row) continue;
    const price = Number(row.market_price) || 0;
    if (price <= 0 || isStalePrice(row, now)) continue;
    if (price <= buyBelow) alerts.push({ symbol: w.symbol, kind: "buy", threshold: buyBelow, price });
  }
  return alerts;
}

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

const fmt = (n: number) => Math.round(n).toLocaleString("vi-VN");

export function buildEmail(alerts: Alert[], nickname: string | null): { subject: string; html: string; text: string } {
  const label = (a: Alert) => (a.kind === "target" ? `${a.symbol} chạm giá mục tiêu` : a.kind === "buy" ? `${a.symbol} chạm giá muốn mua` : `${a.symbol} chạm ngưỡng cắt lỗ`);
  const subject = `WorkHub: ${alerts.length === 1 ? label(alerts[0]) : alerts.length + " cảnh báo giá — " + alerts.map(label).join(", ")}`;
  const lineText = (a: Alert) =>
    a.kind === "target"
      ? `• ${a.symbol}: giá ${fmt(a.price)} ≥ mục tiêu ${fmt(a.threshold)} — cân nhắc chốt lời.`
      : a.kind === "buy"
      ? `• ${a.symbol}: giá ${fmt(a.price)} ≤ giá muốn mua ${fmt(a.threshold)} — mã trong danh sách theo dõi, cân nhắc mua theo kế hoạch.`
      : `• ${a.symbol}: giá ${fmt(a.price)} ≤ ngưỡng cắt lỗ ${fmt(a.threshold)} — cân nhắc cắt lỗ.`;
  const greeting = nickname ? `Chào ${nickname},` : "Chào bạn,";
  const text = `${greeting}\n\n${alerts.map(lineText).join("\n")}\n\nĐây là cảnh báo tự động từ WorkHub Finance (mỗi mức chỉ báo 1 lần/ngày). Bạn có thể tắt email cảnh báo trong tab Danh Mục của Investment Workbench.`;
  const row = (a: Alert) => {
    const isTarget = a.kind === "target";
    const color = isTarget ? "#12855A" : a.kind === "buy" ? "#2A62C9" : "#C23B3B";
    const what = isTarget ? "Chạm giá mục tiêu" : a.kind === "buy" ? "Chạm giá muốn mua" : "Chạm ngưỡng cắt lỗ";
    return `<tr><td style="padding:10px 14px;border-bottom:1px solid #e6e1d6;font-weight:700">${escapeHtml(a.symbol)}</td>` +
      `<td style="padding:10px 14px;border-bottom:1px solid #e6e1d6;color:${color};font-weight:600">${what}</td>` +
      `<td style="padding:10px 14px;border-bottom:1px solid #e6e1d6;text-align:right">${fmt(a.price)}</td>` +
      `<td style="padding:10px 14px;border-bottom:1px solid #e6e1d6;text-align:right">${fmt(a.threshold)}</td></tr>`;
  };
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1C1915;max-width:560px">` +
    `<p>${escapeHtml(greeting)}</p>` +
    `<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr style="text-align:left;color:#6b655a;font-size:12px">` +
    `<th style="padding:6px 14px">Mã</th><th style="padding:6px 14px">Sự kiện</th><th style="padding:6px 14px;text-align:right">Giá hiện tại</th><th style="padding:6px 14px;text-align:right">Mức đặt</th></tr></thead><tbody>${alerts.map(row).join("")}</tbody></table>` +
    `<p style="color:#6b655a;font-size:12px;margin-top:16px">Cảnh báo tự động từ WorkHub Finance — mỗi mức chỉ báo 1 lần/ngày. Tắt email cảnh báo trong tab Danh Mục của Investment Workbench.</p></div>`;
  return { subject, html, text };
}
