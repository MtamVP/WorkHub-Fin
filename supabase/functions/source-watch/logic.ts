// Logic thuần của Edge Function source-watch -- không import Deno/Supabase để Vitest chạy được (tests/unit/source-watch.test.js).
// Giám sát các nguồn dữ liệu MIỄN PHÍ không có cam kết dịch vụ mà app phụ thuộc: bảng giá VCI (giá trực tiếp), VNDirect finfo (dự phòng), VNDirect dchart (nến, VN-Index), và việc ảnh chụp thị trường cuối ngày có chạy không.
// Quy tắc báo (theo yêu cầu "hỏng quá 1 ngày mới email quản lý"):
//  - probe_warn: một nguồn lỗi 4 lần thăm dò liên tiếp (2 giờ) -> cảnh báo mức "cảnh báo" trong tab Dữ Liệu, KHÔNG email.
//  - probe_error: một nguồn lỗi quá nửa số lần thăm dò (tối thiểu 6 lần/ngày) trong CẢ HAI ngày giao dịch gần nhất -> mức "lỗi", email quản lý.
//  - snapshot: ảnh chụp thị trường chậm 1 ngày giao dịch -> "cảnh báo"; chậm từ 2 ngày giao dịch -> "lỗi" + email.
// Mỗi cảnh báo có dedupe_key theo (loại, nguồn, ngày) nên cùng một sự cố chỉ ghi và chỉ email một lần mỗi ngày.

export type Source = "vci" | "finfo" | "dchart";
export const SOURCE_LABEL: Record<Source, string> = {
  vci: "Bảng giá VCI (giá trực tiếp)", finfo: "VNDirect finfo (giá trực tiếp dự phòng)", dchart: "VNDirect dchart (nến 1 phút, VN-Index)",
};
export type Run = { mode: string; run_at: string; ok: boolean; detail?: any };
export type Flag = { kind: "source_probe" | "snapshot_stale"; symbol: null; severity: "warn" | "error"; ref_date: string; detail: Record<string, unknown>; dedupe_key: string };

export const vnDate = (now: Date): string => new Date(now.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const isWeekend = (iso: string) => { const w = new Date(iso + "T00:00:00Z").getUTCDay(); return w === 0 || w === 6; };
export type IsHoliday = (iso: string) => boolean;
export const isTradingDay = (iso: string, isHoliday: IsHoliday) => !isWeekend(iso) && !isHoliday(iso);

// Số ngày giao dịch trong khoảng (from, to] (loại from, gồm to)
export function tradingDaysBetween(from: string, to: string, isHoliday: IsHoliday): number {
  let n = 0;
  for (let t = Date.parse(from + "T00:00:00Z") + 86400000, end = Date.parse(to + "T00:00:00Z"); t <= end; t += 86400000) {
    if (isTradingDay(new Date(t).toISOString().slice(0, 10), isHoliday)) n++;
  }
  return n;
}
// Ngày giao dịch liền trước ngày d
export function prevTradingDay(d: string, isHoliday: IsHoliday): string {
  let t = Date.parse(d + "T00:00:00Z");
  for (let i = 0; i < 20; i++) { t -= 86400000; const s = new Date(t).toISOString().slice(0, 10); if (isTradingDay(s, isHoliday)) return s; }
  return d;
}

// ---------- đánh giá kết quả một lần thăm dò ----------
export function judgeVci(rows: unknown): { ok: boolean; detail: Record<string, unknown> } {
  if (!Array.isArray(rows)) return { ok: false, detail: { error: "không phải mảng" } };
  const priced = rows.filter((r: any) => r && (Number(r.c) > 0 || Number(r.ref) > 0)).length;
  return { ok: rows.length >= 300 && priced >= 200, detail: { rows: rows.length, priced } };       // bảng HOSE thường ~430 mã
}
export function judgeFinfo(json: any, today: string): { ok: boolean; detail: Record<string, unknown> } {
  if (!json || !Array.isArray(json.data)) return { ok: false, detail: { error: "không có data" } };
  const hasToday = json.data.some((r: any) => String(r && r.date).slice(0, 10) === today);
  return { ok: true, detail: { rows: json.data.length, hasToday } };                            // ngày lễ không có dòng hôm nay vẫn là nguồn khoẻ
}
export function judgeDchart(json: any): { ok: boolean; detail: Record<string, unknown> } {
  const n = json && Array.isArray(json.t) ? json.t.length : 0;
  return { ok: !!json && json.s === "ok" && n > 0, detail: { s: json && json.s, bars: n } };
}

// ---------- phân tích lịch sử thăm dò ----------
const modeOf = (s: Source) => "probe:" + s;
// runsDesc: các lần chạy mới nhất trước (mọi nguồn lẫn nhau). Số lần lỗi liên tiếp gần nhất của một nguồn.
export function consecutiveFailures(runsDesc: Run[], s: Source): number {
  let n = 0;
  for (const r of runsDesc) { if (r.mode !== modeOf(s)) continue; if (r.ok) break; n++; }
  return n;
}
export function dayRate(runs: Run[], s: Source, date: string): { ok: number; total: number } {
  const mine = runs.filter((r) => r.mode === modeOf(s) && vnDate(new Date(r.run_at)) === date);
  return { ok: mine.filter((r) => r.ok).length, total: mine.length };
}

export const MIN_PROBES_PER_DAY = 6;
export const WARN_CONSECUTIVE = 4;

export function evaluateProbes(runsDesc: Run[], today: string, isHoliday: IsHoliday): Flag[] {
  const flags: Flag[] = [];
  const prev = prevTradingDay(today, isHoliday);
  (["vci", "finfo", "dchart"] as Source[]).forEach((s) => {
    const consec = consecutiveFailures(runsDesc, s);
    const a = dayRate(runsDesc, s, today), b = dayRate(runsDesc, s, prev);
    const bad = (r: { ok: number; total: number }) => r.total >= MIN_PROBES_PER_DAY && r.ok / r.total < 0.5;
    if (bad(a) && bad(b)) {
      flags.push({ kind: "source_probe", symbol: null, severity: "error", ref_date: today, dedupe_key: `probe:${s}:${today}:error`,
        detail: { source: SOURCE_LABEL[s], key: s, level: "day", today: a, previous: { date: prev, ...b } } });
    } else if (consec >= WARN_CONSECUTIVE) {
      flags.push({ kind: "source_probe", symbol: null, severity: "warn", ref_date: today, dedupe_key: `probe:${s}:${today}:warn`,
        detail: { source: SOURCE_LABEL[s], key: s, level: "streak", failed: consec, today: a } });
    }
  });
  return flags;
}

// asOf: ngày dữ liệu của ảnh chụp thị trường (finance_sector_stats.as_of); today: ngày VN hiện tại, gọi SAU giờ chạy ảnh chụp (18:20). Ngày dữ liệu kỳ vọng = ngày giao dịch liền trước today.
export function evaluateSnapshot(asOf: string | null, today: string, isHoliday: IsHoliday): Flag[] {
  if (!isTradingDay(today, isHoliday)) return [];
  if (!asOf) return [{ kind: "snapshot_stale", symbol: null, severity: "error", ref_date: today, dedupe_key: `snapshot:${today}:error`, detail: { source: "Ảnh chụp thị trường", asOf: null, behind: null } }];
  // Số liệu cuối ngày của VNDirect mang ngày của phiên TRƯỚC (đo thật: ảnh chụp chạy tối 06/10 có ngày số liệu 05/10), nên ngày kỳ vọng là ngày giao dịch liền trước hôm nay.
  const expected = prevTradingDay(today, isHoliday);
  const behind = tradingDaysBetween(asOf, expected, isHoliday);
  if (behind <= 0) return [];
  const severity = behind >= 2 ? "error" : "warn";
  return [{ kind: "snapshot_stale", symbol: null, severity, ref_date: today, dedupe_key: `snapshot:${today}:${severity}`, detail: { source: "Ảnh chụp thị trường (market-data-sync snapshot)", asOf, behind } }];
}

// ---------- email ----------
const escH = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
export function describeFlag(r: { kind: string; detail: any; ref_date?: string | null }): string {
  const d = r.detail || {};
  if (r.kind === "snapshot_stale") return d.asOf ? `${d.source}: số liệu ngày ${d.asOf}, chậm ${d.behind} ngày giao dịch` : `${d.source}: chưa có số liệu`;
  if (d.level === "day") return `${d.source}: lỗi quá nửa số lần thăm dò trong 2 ngày giao dịch liên tiếp (hôm nay ${d.today?.ok}/${d.today?.total} đạt, ${d.previous?.date} ${d.previous?.ok}/${d.previous?.total} đạt)`;
  return `${d.source}: ${d.failed} lần thăm dò liên tiếp thất bại`;
}
export function buildEmail(rows: { severity: string; kind: string; detail: any; ref_date?: string | null }[]): { subject: string; html: string; text: string } {
  const errors = rows.filter((r) => r.severity === "error").length;
  const subject = `WorkHub: nguồn dữ liệu có sự cố (${rows.length} cảnh báo${errors ? ", " + errors + " lỗi" : ""})`;
  const line = (r: typeof rows[0]) => `[${r.severity === "error" ? "LỖI" : "Cảnh báo"}] ${describeFlag(r)}`;
  const text = `Chào bạn,\n\n${rows.slice(0, 20).map(line).join("\n")}\n\nApp tự quay về nguồn dự phòng (giá VNDirect) khi bảng giá VCI lỗi, nhưng số liệu có thể trễ hơn. Xem chi tiết ở Toàn Nhóm > Dữ Liệu. Đây là cảnh báo tự động từ WorkHub Finance (mỗi sự cố báo một lần mỗi ngày).`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;color:#1c1c1e"><h2 style="margin:0 0 12px">Nguồn dữ liệu có sự cố</h2>`
    + rows.slice(0, 20).map((r) => `<div style="border:1px solid #e3e3e6;border-radius:8px;padding:8px 12px;margin:0 0 8px"><b style="color:${r.severity === "error" ? "#c0392b" : "#b9770e"}">${r.severity === "error" ? "Lỗi" : "Cảnh báo"}</b> — ${escH(describeFlag(r))}</div>`).join("")
    + `<p style="color:#6b6b72;font-size:13px">App tự quay về nguồn dự phòng khi bảng giá VCI lỗi, nhưng số liệu có thể trễ hơn. Xem chi tiết ở Toàn Nhóm &gt; Dữ Liệu. Mỗi sự cố chỉ báo một lần mỗi ngày.</p></div>`;
  return { subject, html, text };
}
