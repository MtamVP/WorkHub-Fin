// Logic thuần ghi NAV hằng ngày trong fetch-stock-prices (không import Deno/Supabase để Vitest chạy được: tests/unit/nav-snapshot.test.js).
// Trước đây ảnh chụp NAV chỉ được ghi khi có người mở app và thao tác (mỗi người chỉ 2-5 điểm trong 7 tuần), nên đường lũy kế/drawdown của
// báo cáo cuối tháng rất thưa. Giờ cron giá tự chụp NAV mỗi ngày giao dịch.
// heldQuantities phải khớp send-price-alerts/logic.ts và _replayFifo (api.js) về tổng khối lượng.

export type Txn = { user_id: string; symbol: string; type: string; quantity: number | string; trade_date: string; created_at: string };
export type Action = { user_id: string; symbol: string; action_type: string; ratio: number | string; ex_date: string; created_at: string };

export function heldQuantities(txns: Txn[], actions: Action[]): Map<string, Map<string, number>> {
  type Ev = { kind: "txn" | "action"; date: string; ts: string; row: any };
  const events: Ev[] = [
    ...txns.map((t) => ({ kind: "txn" as const, date: t.trade_date, ts: t.created_at, row: t })),
    ...actions.map((a) => ({ kind: "action" as const, date: a.ex_date, ts: a.created_at, row: a })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind !== b.kind ? (a.kind === "action" ? -1 : 1) : a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  // ^ cùng ngày: sự kiện doanh nghiệp trước lệnh (ngày không hưởng quyền: bán hôm đó là bán cổ phiếu đã điều chỉnh)
  const result = new Map<string, Map<string, number>>();
  const get = (u: string, s: string) => { if (!result.has(u)) result.set(u, new Map()); return result.get(u)!.get(s) ?? 0; };
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

// Thứ trong tuần (0 = CN) của 1 ngày YYYY-MM-DD. Phiên giao dịch: T2..T6.
export function isWeekday(isoDate: string): boolean {
  const d = new Date(isoDate + "T00:00:00Z").getUTCDay();
  return d >= 1 && d <= 5;
}

export type NavRow = { user_id: string; snapshot_date: string; nav: number; cash: number; debt: number; market_value: number; net_contributed: number };

// Mỗi user có giao dịch -> 1 dòng NAV. prices: user_id -> symbol -> giá. assets: user_id -> {cash, debt}. contributed: user_id -> nạp - rút.
export function buildNavRows(
  date: string, held: Map<string, Map<string, number>>, prices: Map<string, Map<string, number>>,
  assets: Map<string, { cash: number; debt: number }>, contributed: Map<string, number>,
): NavRow[] {
  const rows: NavRow[] = [];
  for (const [userId, perSymbol] of held) {
    let marketValue = 0;
    for (const [symbol, qty] of perSymbol) {
      if (qty <= 1e-9) continue;
      marketValue += qty * (prices.get(userId)?.get(symbol) ?? 0);
    }
    const a = assets.get(userId) ?? { cash: 0, debt: 0 };
    rows.push({
      user_id: userId, snapshot_date: date, nav: marketValue + a.cash - a.debt, cash: a.cash, debt: a.debt,
      market_value: marketValue, net_contributed: contributed.get(userId) ?? 0,
    });
  }
  return rows;
}
