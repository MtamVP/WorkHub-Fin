// Logic thuần của Edge Function check-limits -- không import Deno/Supabase để Vitest chạy được (tests/unit/check-limits.test.js).
// Tính tuân thủ giới hạn đầu tư bằng ĐÚNG các thư viện của app (GroupCalc, LimitsCalc -- truyền vào qua `libs`), nên kết quả khớp với màn hình Toàn Nhóm.
export interface Libs { GroupCalc: any; LimitsCalc: any }
export interface Input { members: any[]; txns: any[]; actions: any[]; prices: any[]; assets: any[]; limits: any[] }
export interface Item { kind: string; subject: string; current: number; threshold: number; mode: string; scope: string; usage?: number; symbols?: string[] }
export interface LogRow { user_id: string | null; nav: number; limit_count: number; breaches: Item[]; warns: Item[] }

const r4 = (v: number) => Math.round(v * 10000) / 10000;

function trim(i: any, withUsage: boolean): Item {
  const o: Item = { kind: i.kind, subject: String(i.subject), current: r4(Number(i.current) || 0), threshold: r4(Number(i.threshold) || 0), mode: i.mode, scope: i.scope };
  if (withUsage && isFinite(i.usage)) o.usage = r4(i.usage);
  if (Array.isArray(i.symbols)) o.symbols = i.symbols.slice(0, 12);
  return o;
}

// Mỗi thành viên (giới hạn chung + cá nhân của họ) và cả nhóm gộp (giới hạn scope 'consolidated'). Chỉ trả những đối tượng CÓ giới hạn áp dụng.
export function computeCompliance(libs: Libs, input: Input): LogRow[] {
  const { GroupCalc, LimitsCalc } = libs;
  const active = (input.limits ?? []).filter((l) => l.active !== false);
  if (!active.length) return [];
  const portfolios = GroupCalc.memberPortfolios({ members: input.members, txns: input.txns, actions: input.actions, prices: input.prices, assets: input.assets });
  const group = GroupCalc.consolidate(portfolios);
  const m = LimitsCalc.complianceMatrix(active, portfolios, group);
  const out: LogRow[] = [];
  m.rows.forEach((r: any) => {
    if (!r.limits) return;
    out.push({ user_id: r.id, nav: Math.round(r.nav), limit_count: r.limits, breaches: r.breaches.map((x: any) => trim(x, false)), warns: r.warns.map((x: any) => trim(x, true)) });
  });
  if (m.consolidated && m.consolidated.limits) {
    out.push({ user_id: null, nav: Math.round(m.consolidated.nav), limit_count: m.consolidated.limits, breaches: m.consolidated.breaches.map((x: any) => trim(x, false)), warns: m.consolidated.warns.map((x: any) => trim(x, true)) });
  }
  return out;
}

// Ngày theo giờ Việt Nam (UTC+7) dạng YYYY-MM-DD
export function vnDate(d: Date): string { return new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10); }

// Bài tự kiểm cố định (không đụng CSDL): sau khi triển khai, gọi hàm với {"selftest":true} và so kết quả với tests/unit/check-limits.test.js -- bắt lỗi chép thư viện hoặc khác biệt môi trường chạy.
export function selfTest(libs: Libs): LogRow[] {
  const tx = (id: string, user_id: string, type: string, symbol: string, quantity: number, price: number, trade_date: string) =>
    ({ id, user_id, type, symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + "T01:00:00Z", deleted_at: null });
  return computeCompliance(libs, {
    members: [{ id: "u1", email: "an@x.vn", nickname: "An" }, { id: "u2", email: "binh@x.vn", nickname: "Bình" }],
    txns: [tx("1", "u1", "buy", "FPT", 1000, 100000, "2026-01-02"), tx("2", "u1", "buy", "VCB", 200, 100000, "2026-01-03"), tx("3", "u2", "buy", "HPG", 2000, 25000, "2026-01-04"), tx("4", "u2", "sell", "HPG", 500, 26000, "2026-02-04")],
    actions: [{ id: "a1", user_id: "u1", symbol: "FPT", action_type: "stock_dividend", ratio: 0.1, ex_date: "2026-03-01", created_at: "2026-03-01T00:00:00Z", deleted_at: null }],
    prices: [{ user_id: "u1", symbol: "FPT", market_price: 90000, price_date: "2026-10-02", updated_at: "a" }, { user_id: "u1", symbol: "VCB", market_price: 100000, price_date: "2026-10-02", updated_at: "a" }, { user_id: "u2", symbol: "HPG", market_price: 25000, price_date: "2026-10-02", updated_at: "a" }],
    assets: [{ user_id: "u1", cash: 30000000, debt: 0 }, { user_id: "u2", cash: 50000000, debt: 0 }],
    limits: [
      { id: "l1", scope: "member", user_id: null, kind: "max_symbol_pct", symbol: null, sector: null, value: 40, mode: "reason", active: true },
      { id: "l2", scope: "member", user_id: null, kind: "min_cash_pct", symbol: null, sector: null, value: 25, mode: "warn", active: true },
      { id: "l3", scope: "consolidated", user_id: null, kind: "max_sector_pct", symbol: null, sector: null, value: 50, mode: "reason", active: true },
    ],
  });
}
