// Logic thuần của Edge Function refresh-financials -- không import Deno/Supabase để Vitest chạy được (tests/unit/refresh-financials.test.js).
// Mỗi lần chạy chỉ làm mới một phần các mã (cũ nhất trước) để không vượt giới hạn thời gian; chạy 2 lần/ngày thì mọi mã được làm mới trong ngày.

export const MAX_PER_RUN = 40;
export const MIN_AGE_HOURS = 20;

export type CacheMeta = { symbol: string; fetched_at: string | null; fingerprint?: string | null };
export type Fin = {
  form: string | null;
  annual: { year: number; lnst: number | null; equity: number | null; charter: number | null; assets: number | null; revenue: number | null }[];
  quarters: { year: number; quarter: number; lnst: number | null }[];
  dividends: Record<string, number>;
};

// Mã cần làm mới: chưa từng lấy trước, rồi đến mã lấy cách đây >= MIN_AGE_HOURS (cũ nhất trước); tối đa `max` mã.
export function pickSymbols(symbols: string[], cache: CacheMeta[], now: Date, max = MAX_PER_RUN, minAgeHours = MIN_AGE_HOURS): string[] {
  const byS = new Map(cache.map((c) => [c.symbol, c]));
  const limit = now.getTime() - minAgeHours * 3600000;
  const never: string[] = [];
  const old: { s: string; t: number }[] = [];
  for (const s of [...new Set(symbols)].sort()) {
    const c = byS.get(s);
    const t = c && c.fetched_at ? Date.parse(c.fetched_at) : NaN;
    if (!c || !isFinite(t)) never.push(s);
    else if (t <= limit) old.push({ s, t });
  }
  old.sort((a, b) => a.t - b.t || (a.s < b.s ? -1 : 1));
  return [...never, ...old.map((x) => x.s)].slice(0, max);
}

// Kỳ báo cáo mới nhất: năm tài chính gần nhất và khoá quý gần nhất ("2026Q2")
export function latestKeys(fin: Fin): { annualYear: number | null; quarterKey: string | null } {
  const years = fin.annual.map((a) => a.year).filter((y) => Number.isFinite(y));
  const qs = fin.quarters.slice().sort((a, b) => (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter));
  return { annualYear: years.length ? Math.max(...years) : null, quarterKey: qs.length ? `${qs[0].year}Q${qs[0].quarter}` : null };
}

// Dấu vân tay của số liệu quan trọng: đổi khi có kỳ báo cáo mới HOẶC số liệu kỳ gần nhất được điều chỉnh/cổ tức mới.
export function fingerprint(fin: Fin): string {
  const k = latestKeys(fin);
  const a = fin.annual.find((x) => x.year === k.annualYear);
  const q = fin.quarters.find((x) => k.quarterKey === `${x.year}Q${x.quarter}`);
  const div = Object.keys(fin.dividends || {}).sort().map((y) => `${y}:${fin.dividends[y]}`).join(",");
  return [k.annualYear ?? "-", a ? `${a.lnst}|${a.equity}|${a.charter}|${a.revenue}|${a.assets}` : "-", k.quarterKey ?? "-", q ? q.lnst : "-", div].join("#");
}

export type Change = "new" | "changed" | "same";
export function classify(prev: string | null | undefined, next: string): Change {
  if (!prev) return "new";
  return prev === next ? "same" : "changed";
}

// Trạng thái lần chạy (lưu app_settings.financials_refresh_status): chỉ số lượng + mã lỗi, không lộ dữ liệu người dùng.
export function summarize(input: { ranAt: string; total: number; tried: number; refreshed: number; changed: string[]; failed: string[] }) {
  return {
    ranAt: input.ranAt, symbols: input.total, tried: input.tried, refreshed: input.refreshed,
    changed: input.changed.slice(0, 50), changedCount: input.changed.length, failed: input.failed.slice(0, 50),
  };
}
