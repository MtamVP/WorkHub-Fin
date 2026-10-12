// Công cụ DỮ LIỆU của Quản gia (CHỈ ĐỌC): danh mục của tôi, của cả nhóm, một mã, giới hạn đầu tư, lệnh chờ duyệt.
// Mỗi công cụ gồm một hàm THUẦN dựng "sự kiện" (facts) từ các dòng đã đọc (kiểm thử bằng Vitest với đúng thư viện của app) và một hàm đọc CSDL nhận client `sb`.
// `sb` LUÔN là client dựng từ khoá công khai + tiêu đề Authorization của NGƯỜI HỎI (xem index.ts) nên mọi truy vấn chịu RLS của chính họ. Tính toán dùng ĐÚNG GroupCalc / PortfolioCalc / LimitsCalc của app (bản sao ở thư mục này,
// có test khớp lib/), nên số liệu trùng với màn hình Toàn Nhóm / Danh Mục. KHÔNG import Deno / supabase ở đây. Không tool nào ghi dữ liệu.
import "./finance-calc.js";
import "./portfolio-calc.js";
import "./group-calc.js";
import "./limits-calc.js";
import { computeCompliance } from "./compliance.ts";

const g = globalThis as any;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : 0; };
const iso = (v: unknown) => String(v || "").slice(0, 10);

export type Me = { id: string; email: string; nickname: string; group: string; admin: boolean };
export type Member = { id: string; email: string; nickname: string | null };
export type Raw = { members: Member[]; txns: any[]; actions: any[]; prices: any[]; assets: any[] };

// Chỉ nhóm tài chính / quản trị có dữ liệu tài chính
export const canSeeFinance = (me: Me) => me.admin || me.group === "finance";

// ---------- hàm thuần ----------
function holdingFacts(h: any, nav: number) {
  return { symbol: h.symbol, sector: g.FinCalc && g.FinCalc.sectorOf ? g.FinCalc.sectorOf(h.symbol) : null, quantity: Math.round(h.quantity), avgCost: Math.round(h.avgCost), price: Math.round(h.price), value: Math.round(h.value), weightPct: r1(h.weightPct), navPct: nav > 0 ? r1(h.value / nav * 100) : 0, unrealizedPct: h.unrealizedPct === null || h.unrealizedPct === undefined ? null : r1(h.unrealizedPct), noPrice: !!h.noPrice };
}
function priceDateOf(prices: any[]): string | null {
  let best = "";
  (prices || []).forEach((p) => { const d = iso(p.price_date) || iso(p.updated_at); if (d > best) best = d; });
  return best || null;
}

// Danh mục của MỘT thành viên (me). raw.members phải chứa me.
export function buildPortfolio(raw: Raw, meId: string) {
  const ports = g.GroupCalc.memberPortfolios({ members: raw.members, txns: raw.txns, actions: raw.actions, prices: raw.prices, assets: raw.assets });
  const p = ports.find((x: any) => x.id === meId);
  if (!p) return null;
  const cost = p.holdings.reduce((s: number, h: any) => s + h.quantity * h.avgCost, 0), value = p.holdings.reduce((s: number, h: any) => s + (h.price > 0 ? h.value : 0), 0);
  return {
    name: p.name, nav: Math.round(p.nav), cash: Math.round(p.cash), debt: Math.round(p.debt), marketValue: Math.round(p.marketValue),
    cashPct: p.nav > 0 ? r1(p.cash / p.nav * 100) : null, unrealizedPct: cost > 0 && value > 0 ? r1((value / cost - 1) * 100) : null,
    positionCount: p.holdings.length, noPriceCount: p.holdings.filter((h: any) => h.noPrice).length, priceDate: priceDateOf(raw.prices),
    holdings: p.holdings.slice(0, 15).map((h: any) => holdingFacts(h, p.nav)),
  };
}

// Danh mục gộp của cả nhóm (các thành viên trong raw.members)
export function buildGroup(raw: Raw) {
  const ports = g.GroupCalc.memberPortfolios({ members: raw.members, txns: raw.txns, actions: raw.actions, prices: raw.prices, assets: raw.assets });
  const c = g.GroupCalc.consolidate(ports);
  return {
    memberCount: ports.length, nav: Math.round(c.nav), marketValue: Math.round(c.marketValue), cash: Math.round(c.cash), debt: Math.round(c.debt),
    cashPct: c.nav > 0 ? r1(c.cash / c.nav * 100) : null, sharedCount: c.sharedCount, sharedValuePct: r1(c.sharedValuePct), priceDate: priceDateOf(raw.prices),
    top: c.symbols.slice(0, 10).map((s: any) => ({ symbol: s.symbol, sector: s.sector || null, value: Math.round(s.value), weightPct: r1(s.weightPct), holderCount: s.holderCount, unrealizedPct: s.unrealizedPct === null || s.unrealizedPct === undefined ? null : r1(s.unrealizedPct) })),
    members: ports.map((p: any) => ({ name: p.name, nav: Math.round(p.nav), marketValue: Math.round(p.marketValue), positions: p.holdings.length })).sort((a: any, b: any) => b.nav - a.nav),
  };
}

// Một mã: vị thế của tôi + vị thế gộp của nhóm (không nêu tên ai khác)
export function buildHolding(raw: Raw, meId: string, symbol: string) {
  const ports = g.GroupCalc.memberPortfolios({ members: raw.members, txns: raw.txns, actions: raw.actions, prices: raw.prices, assets: raw.assets });
  const mine = ports.find((x: any) => x.id === meId), c = g.GroupCalc.consolidate(ports);
  const mh = mine ? mine.holdings.find((h: any) => h.symbol === symbol) : null, gs = c.symbols.find((s: any) => s.symbol === symbol);
  return {
    symbol,
    mine: mh ? holdingFacts(mh, mine.nav) : null,
    group: gs ? { value: Math.round(gs.value), weightPct: r1(gs.weightPct), holderCount: gs.holderCount, quantity: Math.round(gs.quantity), unrealizedPct: gs.unrealizedPct === null || gs.unrealizedPct === undefined ? null : r1(gs.unrealizedPct), myShareOfSymbolPct: mh && gs.value > 0 ? r1(mh.value / gs.value * 100) : null } : null,
    priceDate: priceDateOf(raw.prices),
  };
}

// Giới hạn đầu tư: dòng của tôi, dòng cả nhóm gộp, và SỐ thành viên khác đang vượt / sắp vượt (không nêu tên)
export function buildLimits(raw: Raw, limits: any[], meId: string) {
  const active = (limits || []).filter((l) => l.active !== false);
  const rows = computeCompliance({ GroupCalc: g.GroupCalc, LimitsCalc: g.LimitsCalc }, { members: raw.members, txns: raw.txns, actions: raw.actions, prices: raw.prices, assets: raw.assets, limits: active });
  const label = (it: any) => { const k = g.LimitsCalc.KINDS[it.kind]; return Object.assign({}, it, { kindLabel: k ? k.label : it.kind, unit: k ? k.unit : "", modeLabel: g.LimitsCalc.MODES[it.mode] ? g.LimitsCalc.MODES[it.mode].label : it.mode }); };
  const mine = rows.find((r) => r.user_id === meId) || null, group = rows.find((r) => r.user_id === null) || null;
  const others = rows.filter((r) => r.user_id !== null && r.user_id !== meId);
  return {
    activeLimits: active.length,
    me: mine ? { limitCount: mine.limit_count, breaches: mine.breaches.map(label), warns: mine.warns.map(label) } : null,
    group: group ? { limitCount: group.limit_count, breaches: group.breaches.map(label), warns: group.warns.map(label) } : null,
    otherMembers: { withBreach: others.filter((r) => r.breaches.length).length, withWarn: others.filter((r) => r.warns.length).length, total: others.length },
  };
}

// Lệnh chờ duyệt (RLS quyết định thấy những dòng nào): thành viên thấy lệnh của mình, quản lý thấy cả nhóm
export function buildApprovals(rows: any[], names: Record<string, string>, meId: string, manager: boolean, today: string) {
  const pending = (rows || []).filter((r) => r.status === "pending").map((r) => ({
    id: String(r.id), symbol: r.symbol, side: r.side, quantity: Math.round(num(r.quantity)), value: Math.round(num(r.value)), orderPct: r.order_pct === null || r.order_pct === undefined ? null : r1(num(r.order_pct)),
    requester: names[r.created_by] || names[r.user_id] || "", mine: r.created_by === meId || r.user_id === meId, createdAt: String(r.created_at || ""), validUntil: r.valid_until ? iso(r.valid_until) : null,
    ageDays: r.created_at ? Math.max(0, Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(iso(r.created_at) + "T00:00:00Z")) / 86400000)) : 0,
  })).sort((a, b) => b.ageDays - a.ageDays);
  return { manager, total: pending.length, mine: pending.filter((p) => p.mine).length, pending: pending.slice(0, 20) };
}

// Tín hiệu đầu tư gọn cho câu "hôm nay có gì": lệnh chờ duyệt, tuân thủ giới hạn theo nhật ký MỚI NHẤT (check-limits ghi mỗi ngày giao dịch), ý tưởng chờ phản biện
export function buildSignals(input: { approvals: any[]; manager: boolean; meId: string; log: any[]; ideasInReview: number }) {
  const pend = (input.approvals || []).filter((r) => r.status === "pending");
  const mineP = pend.filter((r) => r.created_by === input.meId || r.user_id === input.meId).length;
  let date = "";
  (input.log || []).forEach((r) => { const d = iso(r.log_date); if (d > date) date = d; });
  const rows = (input.log || []).filter((r) => iso(r.log_date) === date);
  const mine = rows.find((r) => r.user_id === input.meId), grp = rows.find((r) => r.user_id === null);
  const n = (a: any) => (Array.isArray(a) ? a.length : 0);
  return {
    approvals: { total: pend.length, mine: mineP, manager: input.manager },
    compliance: date ? { date, mineBreaches: mine ? n(mine.breaches) : 0, mineWarns: mine ? n(mine.warns) : 0, groupBreaches: grp ? n(grp.breaches) : 0, groupWarns: grp ? n(grp.warns) : 0 } : null,
    ideasInReview: input.ideasInReview || 0,
  };
}

// ---------- đọc CSDL ----------
async function fetchAll(build: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// Dữ liệu thô của một tập thành viên (đã qua RLS)
export async function fetchRaw(sb: any, members: Member[]): Promise<Raw> {
  const ids = members.map((m) => m.id);
  const [txns, actions, prices, assets] = await Promise.all([
    fetchAll(() => sb.from("finance_transactions").select("*").in("user_id", ids).is("deleted_at", null).order("trade_date", { ascending: true }).order("id")),
    fetchAll(() => sb.from("finance_corporate_actions").select("*").in("user_id", ids).is("deleted_at", null).order("ex_date", { ascending: true }).order("id")),
    fetchAll(() => sb.from("finance_holdings_price").select("user_id, symbol, market_price, price_date, updated_at").in("user_id", ids).order("user_id").order("symbol")),
    fetchAll(() => sb.from("finance_assets").select("user_id, cash, debt, nav").in("user_id", ids).order("user_id")),
  ]);
  return { members, txns, actions, prices, assets };
}

// Thành viên đang hoạt động của nhóm tài chính (đúng như check-limits)
export async function fetchMembers(sb: any): Promise<Member[]> {
  const { data, error } = await sb.from("users").select("id, email, nickname, group_key, active").in("group_key", ["finance", "admin"]);
  if (error) throw new Error("users: " + error.message);
  return (data ?? []).filter((u: any) => u.active !== false).map((u: any) => ({ id: u.id, email: u.email, nickname: u.nickname ?? null }));
}

export async function toolPortfolio(sb: any, me: Me) {
  const raw = await fetchRaw(sb, [{ id: me.id, email: me.email, nickname: me.nickname }]);
  return buildPortfolio(raw, me.id);
}
export async function toolGroup(sb: any) { return buildGroup(await fetchRaw(sb, await fetchMembers(sb))); }
export async function toolHolding(sb: any, me: Me, symbol: string) {
  const members = await fetchMembers(sb);
  if (!members.find((m) => m.id === me.id)) members.push({ id: me.id, email: me.email, nickname: me.nickname });
  return buildHolding(await fetchRaw(sb, members), me.id, symbol);
}
export async function toolLimits(sb: any, me: Me) {
  const members = await fetchMembers(sb);
  if (!members.find((m) => m.id === me.id)) members.push({ id: me.id, email: me.email, nickname: me.nickname });
  const { data: limits, error } = await sb.from("finance_limits").select("*").eq("active", true);
  if (error) throw new Error("finance_limits: " + error.message);
  if (!(limits ?? []).length) return { activeLimits: 0, me: null, group: null, otherMembers: { withBreach: 0, withWarn: 0, total: 0 } };
  return buildLimits(await fetchRaw(sb, members), limits ?? [], me.id);
}
export async function toolSignals(sb: any, me: Me) {
  const { data: roles } = await sb.from("fin_roles").select("role").eq("user_id", me.id);
  const manager = me.admin || (roles ?? []).some((r: any) => r.role === "asset_manager");
  const [ap, lg, ide] = await Promise.all([
    sb.from("finance_order_requests").select("id, user_id, created_by, status").eq("status", "pending").limit(200),
    sb.from("finance_compliance_log").select("log_date, user_id, breaches, warns").order("log_date", { ascending: false }).limit(60),
    sb.from("finance_ideas").select("id").eq("status", "review").limit(200),
  ]);
  if (ap.error) throw new Error("finance_order_requests: " + ap.error.message);
  return buildSignals({ approvals: ap.data ?? [], manager, meId: me.id, log: lg.error ? [] : (lg.data ?? []), ideasInReview: ide.error ? 0 : (ide.data ?? []).length });
}
export async function toolApprovals(sb: any, me: Me, nowMs: number) {
  const { data: roles } = await sb.from("fin_roles").select("role").eq("user_id", me.id);
  const manager = me.admin || (roles ?? []).some((r: any) => r.role === "asset_manager");
  const { data, error } = await sb.from("finance_order_requests").select("id, user_id, created_by, symbol, side, quantity, value, order_pct, status, created_at, valid_until").eq("status", "pending").order("created_at", { ascending: true }).limit(200);
  if (error) throw new Error("finance_order_requests: " + error.message);
  const ids = [...new Set((data ?? []).flatMap((r: any) => [r.created_by, r.user_id]).filter(Boolean))] as string[];
  const names: Record<string, string> = {};
  if (ids.length) {
    const { data: us } = await sb.from("users").select("id, email, nickname").in("id", ids);
    (us ?? []).forEach((u: any) => { names[u.id] = u.nickname || String(u.email || "").split("@")[0]; });
  }
  return buildApprovals(data ?? [], names, me.id, manager, new Date(nowMs + 7 * 3600000).toISOString().slice(0, 10));
}
