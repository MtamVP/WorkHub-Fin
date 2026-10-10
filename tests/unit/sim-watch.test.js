// lib/sim-watch.js (theo dõi nhật ký mô phỏng phía máy chủ, đợt 4) + Edge Function sim-watch (bản sao thư viện). Chế độ signposts của market-news-ai: market-signposts.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SM from '../../lib/sim-models.js';
import MS from '../../lib/market-sim.js';
import SS from '../../lib/sim-score.js';
import SW from '../../lib/sim-watch.js';
import { SIMWATCH_LIBS, expectedCopy } from '../../scripts/sync-edge-libs.mjs';

globalThis.SimScore = SS;
const here = path.dirname(fileURLToPath(import.meta.url));
const edge = (f) => readFileSync(path.join(here, '../../supabase/functions/sim-watch', f), 'utf8');

function synth(seed, n) {
  const R = SM.rng(seed), dates = [], idx = [1000];
  for (let t = 0; t < n; t++) dates.push(new Date(Date.UTC(2019, 0, 1) + t * 86400000).toISOString().slice(0, 10));
  for (let t = 1; t < n; t++) idx.push(idx[t - 1] * Math.exp(0.0004 + 0.01 * R.n()));
  return { dates, index: idx };
}
const FULL = synth(5, 1500), CUT = 1430;
const PAST = { dates: FULL.dates.slice(0, CUT), index: FULL.index.slice(0, CUT), stocks: {} };
const CTX = MS.prepare(PAST, {});
const L0 = PAST.index[CUT - 1];
const EV = MS.eventFromCard({ id: 'e1', title: 'NHNN tăng lãi suất điều hành', prob: 0.4, window: '1m', direction: 'down', marketMove: 0.06 }, MS.eventScale(CTX.rm));
const EV2 = MS.eventFromCard({ id: 'e2', title: 'Nâng hạng thị trường', prob: 0.3, window: '1w', direction: 'up', marketMove: 0.05 }, MS.eventScale(CTX.rm));
const RES = MS.simulate(CTX, { cash: 0, debt: 0, positions: [{ symbol: MS.INDEX, qty: 1, price: L0 }] }, [MS.PRESETS[0]], { paths: 1500, seed: 2, events: [EV, EV2] });
const SNAP = SS.snapshot(RES, null, { asOf: PAST.dates[CUT - 1], indexLevel: L0, subject: 'outlook', events: [{ id: 'e1', signposts: ['Lãi suất OMO tăng'] }, { id: 'e2', signposts: [] }] });
const SC = SS.scoreRun(SNAP, FULL);

describe('bản sao thư viện trong hàm sim-watch', () => {
  it.each(SIMWATCH_LIBS)('$file khớp lib/ (chạy node scripts/sync-edge-libs.mjs nếu lệch)', (lib) => {
    expect(edge(lib.file)).toBe(expectedCopy(lib));
  });
  it('nạp kiểu Deno (không có require/module) vẫn chạy, cho cùng kết quả', () => {
    const sb = { console }; vm.createContext(sb);
    SIMWATCH_LIBS.forEach((lib) => vm.runInContext(edge(lib.file), sb));
    const sc = sb.SimScore.scoreRun(SNAP, FULL);
    expect(sc).toEqual(SC);
    expect(sb.SimWatch.digest(SNAP, {}, sc, null, 'T')).toEqual(SW.digest(SNAP, {}, SC, null, 'T'));
  });
  it('index.ts nạp đúng hai tệp và không lộ khoá', () => {
    const src = edge('index.ts');
    expect(src).toContain('import "./sim-score.js"'); expect(src).toContain('import "./sim-watch.js"');
    expect(src).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}|sb_publishable_/);
  });
});

describe('parseDchart', () => {
  it('đổi giây UTC sang ngày giờ VN, bỏ giá lỗi và ngày trùng/lùi', () => {
    const t = (d) => Date.parse(d + 'T07:00:00Z') / 1000;
    const r = SW.parseDchart({ s: 'ok', t: [t('2026-10-01'), t('2026-10-02'), t('2026-10-02'), t('2026-10-05')], c: [1700, 0, 1710, 1720] });
    expect(r).toEqual({ dates: ['2026-10-01', '2026-10-02', '2026-10-05'], index: [1700, 1710, 1720] });
    expect(SW.parseDchart({ s: 'no_data' })).toEqual({ dates: [], index: [] });
    expect(SW.parseDchart(null).index).toEqual([]);
  });
});

describe('digest / newlyDue', () => {
  it('70 phiên sau: cả 3 mốc đã tới, có nhánh, cây sống khép; giữ notified/hints cũ', () => {
    const w = SW.digest(SNAP, {}, SC, { notified: [5], hints: { e1: { status: 'unclear' } } }, '2026-10-10T00:00:00Z');
    expect(SC.elapsed).toBe(FULL.index.length - CUT);
    expect(w.horizons.every((h) => h.due)).toBe(true);
    expect(w.prefix).toHaveLength(3);
    expect(w.live.path).toBe(w.prefix.slice(0, w.live.depth));
    expect(w.notified).toEqual([5]); expect(w.hints.e1.status).toBe('unclear');
    expect(SW.newlyDue(w).map((h) => h.h)).toEqual([21, 63]);
  });
  it('chưa tới mốc nào: không có gì để báo, còn số phiên', () => {
    const sc = SS.scoreRun(SNAP, { dates: FULL.dates.slice(0, CUT + 2), index: FULL.index.slice(0, CUT + 2) });
    const w = SW.digest(SNAP, {}, sc, null);
    expect(SW.newlyDue(w)).toEqual([]);
    expect(w.horizons[0]).toEqual({ h: 5, due: false, sessionsLeft: 3 });
    expect(w.live.depth).toBe(0);
  });
  it('đánh dấu sự kiện có cây riêng -> cây sống theo sự kiện', () => {
    const w = SW.digest(SNAP, { e1: true }, SC, null);
    expect(w.live.root).toBe('Y');
  });
});

describe('pendingEvents / mergeEvents / applyChecks', () => {
  const sc2 = SS.scoreRun(SNAP, { dates: FULL.dates.slice(0, CUT + 10), index: FULL.index.slice(0, CUT + 10) });
  const W0 = SW.digest(SNAP, {}, sc2, null);
  const NOW = Date.parse('2026-10-10T12:00:00Z');
  it('bỏ sự kiện đã đánh dấu, đã quá cửa sổ (+5 phiên), đã có kết luận hoặc vừa hỏi', () => {
    expect(W0.elapsed).toBe(10);
    // e2 cửa sổ 1 tuần (5 phiên) + 5 = 10 -> còn; e1 1 tháng -> còn
    expect(SW.pendingEvents(SNAP, {}, W0, NOW).map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(SW.pendingEvents(SNAP, { e1: false }, W0, NOW).map((e) => e.id)).toEqual(['e2']);
    expect(SW.pendingEvents(SNAP, {}, Object.assign({}, W0, { elapsed: 11 }), NOW).map((e) => e.id)).toEqual(['e1']);
    const hinted = Object.assign({}, W0, { hints: { e1: { status: 'happened', at: '2026-01-01T00:00:00Z' }, e2: { status: 'unclear', at: new Date(NOW - 3600000).toISOString() } } });
    expect(SW.pendingEvents(SNAP, {}, hinted, NOW)).toEqual([]);
    const old = Object.assign({}, W0, { hints: { e2: { status: 'unclear', at: new Date(NOW - 30 * 3600000).toISOString() } } });
    expect(SW.pendingEvents(SNAP, {}, old, NOW).map((e) => e.id)).toContain('e2');
    expect(SW.pendingEvents(SNAP, {}, W0, NOW)[0]).toMatchObject({ title: 'NHNN tăng lãi suất điều hành', signposts: ['Lãi suất OMO tăng'], since: SNAP.asOf });
  });
  it('gộp trùng tiêu đề giữa các lần chạy, giữ ngày sớm nhất, đánh id e1..', () => {
    const a = { key: 'x', title: 'X', signposts: ['a'], since: '2026-09-01' }, b = { key: 'x', title: 'X', signposts: ['b', 'a'], since: '2026-08-01' }, c = { key: 'y', title: 'Y', signposts: [], since: '2026-09-05' };
    const m = SW.mergeEvents([a, b, c]);
    expect(m).toEqual([{ id: 'e1', key: 'x', title: 'X', signposts: ['a', 'b'], since: '2026-08-01' }, { id: 'e2', key: 'y', title: 'Y', signposts: [], since: '2026-09-05' }]);
    expect(SW.mergeEvents(Array.from({ length: 15 }, (v, i) => ({ key: 'k' + i, title: 'K' + i, signposts: [], since: '2026-01-01' })))).toHaveLength(SW.MAX_EVENTS);
  });
  it('ghi gợi ý theo tiêu đề, không đụng marks; liên kết không phải https bị bỏ; freshHappened / revertFresh', () => {
    const asked = SW.mergeEvents(SW.pendingEvents(SNAP, {}, W0, NOW));
    const checks = [{ id: asked[0].id, status: 'happened', reason: 'NHNN <b>công bố</b>', refs: [{ title: 'Tin', link: 'https://cafef.vn/a.chn', sourceName: 'CafeF' }, { title: 'xấu', link: 'javascript:alert(1)' }] }, { id: 'zz', status: 'happened' }, { id: asked[1].id, status: 'lạ' }];
    const w = SW.applyChecks(SNAP, W0, asked, checks, '2026-10-10T12:00:00Z', 'gemini');
    const e1 = SNAP.events.find((e) => e.title === asked[0].title).id;
    expect(w.hints[e1]).toEqual({ status: 'happened', reason: 'NHNN công bố', at: '2026-10-10T12:00:00Z', model: 'gemini', refs: [{ title: 'Tin', link: 'https://cafef.vn/a.chn', sourceName: 'CafeF' }] });
    expect(Object.keys(w.hints)).toEqual([e1]);
    expect(SW.freshHappened({}, w.hints)).toEqual([e1]);
    expect(SW.freshHappened(w.hints, w.hints)).toEqual([]);
    expect(SW.revertFresh({}, w).hints).toEqual({});
    expect(SW.hintsToShow(SNAP, {}, w).map((h) => h.id)).toEqual([e1]);
    expect(SW.hintsToShow(SNAP, { [e1]: true }, w)).toEqual([]);
  });
});

describe('buildEmail', () => {
  it('liệt kê mốc và gợi ý, thoát HTML', () => {
    const m = SW.buildEmail([{ label: 'Lần <1>', asOf: '2026-09-01', due: [{ h: 5, date: '2026-09-08', ret: -0.031, branch: 0, in90: false }], events: [{ title: 'Sự kiện "A"', status: 'happened', refs: [{ title: 'T', link: 'https://x.vn/a' }] }] }, { label: 'Trống', asOf: '2026-09-02', due: [], events: [] }]);
    expect(m.subject).toBe('Nhật ký mô phỏng: 1 mốc đã tới, 1 sự kiện có tin mới');
    expect(m.text).toContain('Mốc 1 tuần (2026-09-08): VN-Index -3,1%, nhánh giảm, NGOÀI khoảng 90%');
    expect(m.text).not.toContain('Trống');
    expect(m.html).toContain('Lần &lt;1&gt;'); expect(m.html).toContain('&quot;A&quot;');
  });
});

