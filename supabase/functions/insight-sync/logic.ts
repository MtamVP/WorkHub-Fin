// Logic thuần của Edge Function insight-sync (không import Deno/Supabase để Vitest chạy được: tests/unit/insight-sync.test.js).
// Cần ThesisCalc và OwnershipCalc đã nạp vào globalThis (index.ts import bản sao nguyên văn lib/thesis-calc.js và lib/ownership-calc.js).
import type { NewsItem } from "./news-parse.ts";

const g = globalThis as any;

// Từ viết hoa 3-4 chữ cái hay gặp trong tin tài chính nhưng KHÔNG phải mã cổ phiếu cần gắn (hoặc dễ nhầm): bỏ qua dù trùng một mã niêm yết.
export const NOT_TICKERS = new Set(["GDP", "CPI", "PMI", "USD", "VND", "EUR", "JPY", "CNY", "IPO", "ETF", "FED", "OPEC", "WTO", "IMF", "OECD", "ASEAN", "FDI", "ODA", "EPS", "ROE", "ROA", "NIM", "NPL", "CASA",
  "CEO", "CFO", "HOSE", "HNX", "UPCOM", "VNI", "NHNN", "UBCK", "SBV", "SCIC", "ESG", "FTA", "TPP", "EVFTA", "RCEP", "AI", "COVID", "VAT", "TNDN", "TNCN", "BHXH"]);

// Mã cổ phiếu được nhắc trong TIÊU ĐỀ (từ viết hoa nguyên cả từ, 3-4 ký tự, có trong danh sách niêm yết). Tiêu đề viết hoa toàn bộ thì không gắn (không phân biệt được).
export function tagSymbols(title: string, symbols: Set<string>): string[] {
  const t = String(title ?? "");
  const letters = (t.match(/\p{L}/gu) ?? []).length, upper = (t.match(/\p{Lu}/gu) ?? []).length;
  if (letters > 8 && upper / letters > 0.7) return [];
  const out: string[] = [], seen = new Set<string>();
  const re = /(?<![\p{L}\p{N}])([A-Z][A-Z0-9]{2,3})(?![\p{L}\p{N}])/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const s = m[1];
    if (seen.has(s) || NOT_TICKERS.has(s) || !symbols.has(s)) continue;
    seen.add(s); out.push(s);
  }
  return out.slice(0, 8);
}

export function newsRows(items: NewsItem[], symbols: Set<string>) {
  return (items ?? []).filter((it) => it && it.id && it.title).map((it) => ({
    id: String(it.id).slice(0, 500), published_at: it.ts ? new Date(it.ts).toISOString() : null, source: it.source, title: it.title, link: it.link, summary: it.summary || null, symbols: tagSymbols(it.title, symbols),
  }));
}

// updated_at đặt tường minh: upsert không tự cập nhật cột này, mà phép xoá "người không còn trong danh sách" dựa vào nó
export function shareholderRows(parsed: any[], nowIso?: string) {
  const at = nowIso ?? new Date().toISOString();
  return (parsed ?? []).map((h) => ({ symbol: h.symbol, owner_key: h.key, owner_name: h.name, owner_type: h.type, position: h.position, quantity: h.qty, pct: h.pct, public_date: h.publicDate, updated_at: at }));
}
export function insiderRows(parsed: any[]) {
  return (parsed ?? []).map((t) => ({
    id: t.id, symbol: t.symbol, trader: t.trader, position: t.position, related: t.related, action: t.action, event_code: t.code, status: t.status,
    shares_before: t.before, shares_after: t.after, registered: t.registered, acquired: t.acquired, pct_after: t.pctAfter, start_date: t.startDate, end_date: t.endDate, public_date: t.publicDate, url: t.url,
  }));
}
// Dòng DB -> dạng của OwnershipCalc.summarize
export function insiderFromDb(r: any) {
  return { id: r.id, symbol: r.symbol, trader: r.trader, action: r.action, status: r.status, before: r.shares_before === null ? null : Number(r.shares_before), after: r.shares_after === null ? null : Number(r.shares_after),
    registered: r.registered === null ? null : Number(r.registered), acquired: r.acquired === null ? null : Number(r.acquired), startDate: r.start_date, endDate: r.end_date, publicDate: r.public_date };
}

// ---------- luận điểm ----------
export type IdeaRow = { id: string; user_id: string; symbol: string; title?: string; target_price?: number | null };
export type CondRow = { id: string; idea_id: string; metric: string; op: string; threshold: number | null; severity: string; label: string | null; manual_met: boolean | null; last_state: string | null; state_since: string | null; notified_state: string | null };

// Giá từ ảnh chụp thị trường: vốn hoá / số cổ phiếu (ảnh chụp không lưu giá trực tiếp)
export function snapshotPrice(metrics: any): number | null {
  const mc = Number(metrics?.marketcap), sh = Number(metrics?.shares);
  return mc > 0 && sh > 0 ? Math.round(mc / sh) : null;
}

// Đánh giá mọi điều kiện của mọi ý tưởng đang mở. Nhật ký (logs) ghi MỌI lần đổi trạng thái; cảnh báo (alerts) chỉ cho điều kiện critical đang sai và chưa được báo.
//   snapshots: { MÃ: metrics }; ratios: { MÃ: metrics }; insider: { MÃ: [dòng finance_insider_trades] }; insiderSynced: tập mã đã đồng bộ thành công (chưa đồng bộ -> chỉ tiêu nội bộ là 'unknown', không phải 0).
// Trả { updates: [{id, patch}], logs: [{condition_id, idea_id, from_state, to_state, value}], alerts: [{userId, ideaId, symbol, title, label, value, desc}], ideas: [{id, status}] }
export function evaluateAll(ideas: IdeaRow[], conds: CondRow[], snapshots: Record<string, any>, ratios: Record<string, any>, insider: Record<string, any[]>, insiderSynced: Set<string>, todayIso: string, nowIso: string) {
  const T = g.ThesisCalc, O = g.OwnershipCalc;
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [], logs: any[] = [], alerts: any[] = [], summary: Array<{ id: string; status: string }> = [];
  const byIdea = new Map<string, CondRow[]>();
  conds.forEach((c) => { const a = byIdea.get(c.idea_id) ?? []; a.push(c); byIdea.set(c.idea_id, a); });
  for (const idea of ideas) {
    const list = byIdea.get(idea.id);
    if (!list || !list.length) continue;
    const sym = String(idea.symbol).toUpperCase();
    const metrics = snapshots[sym] ?? null;
    const ctx = {
      metrics: metrics, price: snapshotPrice(metrics), targetPrice: idea.target_price ?? null,
      foreignRoomLeftPct: ratios[sym]?.foreignRoomLeftPct ?? null,
      insiderNet90d: insiderSynced.has(sym) ? O.summarize((insider[sym] ?? []).map(insiderFromDb).sort((a: any, b: any) => (a.publicDate < b.publicDate ? 1 : -1)), todayIso, 90).netQty : null,
    };
    const ev = T.evaluateIdea(list.map((c) => ({ id: c.id, metric: c.metric, op: c.op, threshold: c.threshold === null ? null : Number(c.threshold), severity: c.severity, label: c.label, manualMet: c.manual_met })), ctx);
    summary.push({ id: idea.id, status: ev.status });
    const prev: Record<string, string> = {}; list.forEach((c) => { prev[c.id] = c.last_state ?? "unknown"; });
    const tr = T.transitions(prev, ev.conditions);
    const changed = new Set(tr.map((t: any) => t.id));
    for (const c of ev.conditions) {
      const row = list.find((x) => x.id === c.id)!;
      const flipped = changed.has(c.id) || (c.state !== (row.last_state ?? "unknown"));
      const patch: Record<string, unknown> = { last_state: c.state, last_value: c.value, last_checked: nowIso, state_since: flipped || !row.state_since ? nowIso : row.state_since };
      // "đã báo": đặt khi điều kiện critical chuyển sang sai và đã tạo cảnh báo; xoá khi hết sai để lần sau sai lại thì báo lại
      if (c.state === "ok") patch.notified_state = null;
      updates.push({ id: c.id, patch });
    }
    for (const t of tr) logs.push({ condition_id: t.id, idea_id: idea.id, from_state: t.from === "unknown" ? null : t.from, to_state: t.to, value: t.cond.value });
    // Cảnh báo: điều kiện CRITICAL đang sai mà chưa được báo (gồm cả lần gửi trước thất bại -> thử lại; điều kiện đúng thì đã xoá notified_state)
    for (const c of ev.conditions) {
      const row = list.find((x) => x.id === c.id)!;
      if (c.state === "fail" && c.severity === "critical" && row.notified_state !== "fail") alerts.push({ userId: idea.user_id, ideaId: idea.id, symbol: sym, title: idea.title ?? "", label: T.describe(c), value: c.value, condId: c.id });
    }
  }
  return { updates, logs, alerts, ideas: summary };
}

export function thesisEmail(items: Array<{ symbol: string; title: string; label: string; value: number | null }>) {
  const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const fmt = (v: number | null) => (v === null || v === undefined ? "?" : (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("vi-VN") : String(Math.round(v * 100) / 100).replace(".", ",")));
  const subject = items.length === 1 ? `Luận điểm ${items[0].symbol} có điều kiện quan trọng bị phá vỡ` : `${items.length} luận điểm có điều kiện quan trọng bị phá vỡ`;
  const text = items.map((i) => `- ${i.symbol}${i.title ? " (" + i.title + ")" : ""}: ${i.label}; giá trị hiện tại ${fmt(i.value)}`).join("\n") +
    "\n\nĐây là cảnh báo tự động theo điều kiện bạn đã đặt, không phải khuyến nghị đầu tư. Mở WorkHub Finance > Insight > Luận điểm để xem chi tiết.";
  const html = "<p>Các điều kiện <b>quan trọng</b> sau của luận điểm đầu tư đã bị phá vỡ:</p><ul>" + items.map((i) => `<li><b>${esc(i.symbol)}</b>${i.title ? " (" + esc(i.title) + ")" : ""}: ${esc(i.label)}; giá trị hiện tại ${esc(fmt(i.value))}</li>`).join("") +
    "</ul><p style=\"color:#666\">Đây là cảnh báo tự động theo điều kiện bạn đã đặt, không phải khuyến nghị đầu tư. Mở WorkHub Finance &gt; Insight &gt; Luận điểm để xem chi tiết.</p>";
  return { subject, text, html };
}

// Các mã cần đồng bộ sở hữu: đang giữ, theo dõi, ý tưởng đang mở. Chuẩn hoá, bỏ trùng, giới hạn.
export function trackedSymbols(lists: Array<Array<string | null | undefined>>, cap: number): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const l of lists) for (const s of l) {
    const x = String(s ?? "").trim().toUpperCase();
    if (/^[A-Z0-9]{1,12}$/.test(x) && !seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out.slice(0, cap);
}
