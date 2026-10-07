import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import TB from '../../lib/today-brief.js';
import SH from '../../lib/sector-heatmap.js';
import LA from '../../lib/live-alerts.js';
import LC from '../../lib/limits-calc.js';

const TODAY = '2026-10-07';   // thứ tư
const NAV = [{ snapshot_date: '2026-10-05', nav: 98e6 }, { snapshot_date: '2026-10-06', nav: 100e6 }, { snapshot_date: TODAY, nav: 101e6 }];

describe('TodayBrief: từng phần', () => {
  it('danh mục: so NAV với ngày gần nhất TRƯỚC hôm nay (không lấy bản ghi hôm nay), lãi/lỗ chưa thực hiện, số mã', () => {
    const s = TB.portfolio({ nav: NAV, kpi: { nav: 102e6, unrealizedPnl: -3e6 }, holdingsCount: 4 }, TODAY);
    expect(s.items[0]).toEqual({ text: 'NAV 102.000.000 đ, tăng 2.000.000 đ (+2,00%) so với ngày 06/10', tone: 'up' });
    expect(s.items[1]).toEqual({ text: 'Lãi/lỗ chưa thực hiện −3.000.000 đ · 4 mã đang nắm', tone: 'down' });
    expect(TB.portfolio({ nav: [], kpi: { nav: 5e6, unrealizedPnl: 0 } }, TODAY).items[0].text).toContain('chưa có ngày trước');
    expect(TB.portfolio({ nav: NAV, kpi: null }, TODAY)).toBeNull(); expect(TB.portfolio({ nav: NAV, kpi: { nav: 0 } }, TODAY)).toBeNull();
    expect(TB.portfolio({ nav: NAV, kpi: { nav: 90e6, unrealizedPnl: 1 } }, TODAY).items[0].tone).toBe('down');
  });
  it('sự kiện: tới hạn chưa ghi (cần xem), sắp tới trong 14 ngày sắp theo ngày, quyền mua có hạn; bỏ sự kiện xa hoặc đã ghi', () => {
    const ev = [
      { status: 'pending', symbol: 'FPT', kind: 'cash_dividend', dps: 1000, net: 900000 },
      { status: 'upcoming', symbol: 'VNM', kind: 'cash_dividend', dps: 2000, net: 1800000, due: '2026-10-12' },
      { status: 'upcoming', symbol: 'HPG', kind: 'bonus', ratioPct: 10, bonusShares: 120, due: '2026-10-09' },
      { status: 'upcoming', symbol: 'SSI', kind: 'cash_dividend', dps: 500, net: 100000, due: '2026-12-01' },
      { status: 'info', symbol: 'MWG', kind: 'rights', rightsShares: 300, issuePrice: 20000, deadline: '2026-10-10' },
      { status: 'recorded', symbol: 'VCB', kind: 'cash_dividend' },
    ];
    const s = TB.events({ events: ev }, TODAY);
    expect(s.items.map((i) => i.text.split(':')[0])).toEqual(['FPT', 'HPG', 'MWG', 'VNM']);
    expect(s.items[0]).toMatchObject({ tone: 'warn' }); expect(s.items[0].text).toContain('CHƯA ghi vào sổ');
    expect(s.items[1].text).toContain('còn 2 ngày (09/10)'); expect(s.items[2].text).toContain('quyền mua 300 cp giá 20.000 đ, hạn 10/10');
    expect(TB.events({ events: [ev[3], ev[5]] }, TODAY)).toBeNull();
  });
  it('theo dõi: chỉ mã chưa giữ, trong 5% trên giá muốn mua hoặc đã tới giá; gần nhất trước', () => {
    const w = [{ symbol: 'A', price: 100, buyBelow: 105, held: false }, { symbol: 'B', price: 103, buyBelow: 100, held: false }, { symbol: 'C', price: 120, buyBelow: 100, held: false }, { symbol: 'D', price: 90, buyBelow: 100, held: true }, { symbol: 'E', price: 0, buyBelow: 100 }];
    const s = TB.watch({ watch: w });
    expect(s.items.map((i) => i.text.split(':')[0])).toEqual(['A', 'B']); expect(s.items[0]).toMatchObject({ tone: 'act' }); expect(s.items[0].text).toContain('đã tới giá mua'); expect(s.items[1]).toMatchObject({ tone: 'info' });
    expect(TB.watch({ watch: [w[2], w[3]] })).toBeNull();
  });
  it('giới hạn: liệt kê mục vượt và số mục gần chạm; không có gì thì bỏ phần', () => {
    const items = [{ kind: 'max_symbol_pct', subject: 'FPT', current: 50, threshold: 30, status: 'breach' }];
    const b = LA.evaluateLimits(items, LC.KINDS);
    const s = TB.limits({ limits: { breaches: b, warns: 2 } });
    expect(s.items.map((i) => i.tone)).toEqual(['bad', 'warn']); expect(s.items[0].text).toBe('Một mã tối đa FPT: 50,0% > 30,0%'); expect(s.items[1].text).toBe('2 mục gần chạm hạn mức (từ 90%)');
    expect(TB.limits({ limits: { breaches: [], warns: 0 } })).toBeNull(); expect(TB.limits({})).toBeNull();
  });
  it('ngành: mạnh nhất / yếu nhất 1 tháng và toàn thị trường; ít ngành hoặc chưa có số liệu thì bỏ', () => {
    const mk = (code, cap, chg) => ({ symbol: 'S' + code + cap, icb2_code: code, m: { marketcap: cap * 1e9, chg1m: chg } });
    const rows = [mk('A', 100, 0.08), mk('B', 100, 0.05), mk('C', 100, 0.01), mk('D', 100, -0.02), mk('E', 100, -0.06), mk('F', 100, -0.09)];
    const H = SH.build(rows, 'chg1m', { names: { A: 'Ngân hàng', B: 'Bất động sản', C: 'Thép', D: 'Dầu khí', E: 'Bán lẻ', F: 'Du lịch' } });
    const s = TB.sectors({ sectors: H });
    expect(s.items[0].text).toBe('Mạnh nhất 1 tháng: Ngân hàng +8,0%, Bất động sản +5,0%, Thép +1,0%');
    expect(s.items[1].text).toBe('Yếu nhất 1 tháng: Du lịch −9,0%, Bán lẻ −6,0%, Dầu khí −2,0%'); expect(s.items[2].text).toContain('Toàn thị trường');
    expect(TB.sectors({ sectors: SH.build(rows.slice(0, 3), 'chg1m') })).toBeNull(); expect(TB.sectors({ sectors: SH.build(rows, 'chgYtd') })).toBeNull(); expect(TB.sectors({})).toBeNull();
  });
  it('bộ lọc đã lưu: chỉ mã mới lọt vào của kết quả còn mới (≤4 ngày) và so sánh được', () => {
    const fw = { asOf: '2026-10-06', items: [{ name: 'ROE cao', comparable: true, entered: ['AAA', 'BBB'], left: ['CCC'] }, { name: 'Trống', comparable: true, entered: [], left: [] }, { name: 'Mới', comparable: false, why: 'x' }] };
    const s = TB.filters({ filterwatch: fw }, TODAY);
    expect(s.items).toHaveLength(1); expect(s.items[0]).toEqual({ text: 'Bộ lọc “ROE cao”: AAA, BBB mới lọt vào (số liệu 06/10)', tone: 'act' });
    expect(TB.filters({ filterwatch: Object.assign({}, fw, { asOf: '2026-09-20' }) }, TODAY)).toBeNull(); expect(TB.filters({}, TODAY)).toBeNull();
  });
  it('cảnh báo phiên trước: bỏ qua nếu là hôm nay hoặc trống', () => {
    const a = { date: '2026-10-06', items: [{ title: 'FPT chạm mục tiêu', level: 'good' }, { title: 'SSI cắt lỗ', level: 'bad' }] };
    expect(TB.alerts({ alertsPrev: a }, TODAY).items[0]).toEqual({ text: '06/10: 2 cảnh báo (1 mức xấu) — FPT chạm mục tiêu; SSI cắt lỗ', tone: 'warn' });
    expect(TB.alerts({ alertsPrev: Object.assign({}, a, { date: TODAY }) }, TODAY)).toBeNull(); expect(TB.alerts({ alertsPrev: { date: '2026-10-06', items: [] } }, TODAY)).toBeNull();
  });
});

describe('TodayBrief.build', () => {
  it('tiêu đề có thứ + ngày; đếm việc cần xem (warn, bad, act), không đếm số tăng/giảm; phần trống bị bỏ', () => {
    const r = TB.build({ nav: NAV, kpi: { nav: 102e6, unrealizedPnl: -3e6 }, watch: [{ symbol: 'A', price: 100, buyBelow: 105 }], events: [{ status: 'pending', symbol: 'FPT', kind: 'cash_dividend', dps: 1, net: 1 }] }, TODAY);
    expect(r.headline).toBe('Thứ tư 07/10/2026 · 2 việc cần xem'); expect(r.attention).toBe(2); expect(r.sections.map((s) => s.id)).toEqual(['portfolio', 'events', 'watch']);
    const quiet = TB.build({ nav: NAV, kpi: { nav: 102e6, unrealizedPnl: 5 } }, TODAY);
    expect(quiet.headline).toBe('Thứ tư 07/10/2026 · chưa có việc nào cần xử lý gấp'); expect(quiet.attention).toBe(0);
    expect(TB.build({}, TODAY).sections).toEqual([]);
  });
});

// ---- today.js thật trong vm: tải song song, phần lỗi tự bỏ, thu gọn nhớ theo ngày ----
const REPO = process.cwd().replace(/\\/g, '/');
const dToday = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function boot(over) {
  const o = Object.assign({ fail: [], limitRows: [{ id: 'l1', scope: 'member', kind: 'max_symbol_pct', value: 30, mode: 'warn', active: true }] }, over), store = new Map(), els = {}, calls = [];
  if (o.stored) Object.keys(o.stored).forEach((k) => store.set(k, JSON.stringify(o.stored[k])));
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', hidden: true });
  const snap = ['A', 'B', 'C', 'D', 'E'].map((c, i) => ({ symbol: 'S' + c, icb2_code: String(1000 + i), metrics: { marketcap: 100e9, chg1m: [0.08, 0.04, 0, -0.04, -0.08][i] } }));
  const nav = [{ snapshot_date: '2026-01-01', nav: 100e6 }];
  const ctx = vm.createContext({ document: { getElementById: el }, localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }, setTimeout, clearTimeout, Promise, Date, JSON, Math, console,
    targetEmail: 'a@b.c', escapeAssetHtml: (s) => String(s).replace(/</g, '&lt;'), CE: { state: 'ok', items: [{ status: 'pending', symbol: 'FPT', kind: 'cash_dividend', dps: 1000, net: 900000 }] },
    SectorMap: { icbName: (c) => 'Ngành ' + c },
    callGAS: async (a) => { calls.push(a); if (o.fail.includes(a)) return { status: 'error', message: 'lỗi ' + a };
      if (a === 'getNavHistory') return { status: 'success', data: nav }; if (a === 'getWatchlist') return { status: 'success', data: [{ symbol: 'W', price: 100, buyBelow: 102, held: false }] };
      if (a === 'listLimits') return { status: 'success', data: o.limitRows }; if (a === 'getLimitActor') return { status: 'success', data: { targetId: 'u1' } }; if (a === 'getCashDebt') return { status: 'success', data: { cash: 1e6, debt: 0 } };
      if (a === 'getMarketUniverse') return { status: 'success', data: { snapshot: snap, stats: {}, meta: {} } }; return { status: 'error', message: 'x' }; } });
  ['lib/finance-calc.js', 'lib/limits-calc.js', 'lib/peer-valuation.js', 'lib/market-screener.js', 'lib/sector-heatmap.js', 'lib/live-alerts.js', 'lib/today-brief.js', 'mastersheet/assets/today.js'].forEach((f) => vm.runInContext(fs.readFileSync(REPO + '/' + f, 'utf8'), ctx, { filename: f }));
  return { UI: vm.runInContext('TodayUI', ctx), els, store, calls };
}
const holdings = [{ symbol: 'FPT', marketValue: 10e6 }, { symbol: 'HPG', marketValue: 1e6 }];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('TodayUI (today.js)', () => {
  it('tải nav, theo dõi, giới hạn, ngành song song và dựng thẻ; có phần giới hạn vượt và sự kiện chưa ghi', async () => {
    const t = boot();
    t.UI.afterHoldings(holdings); t.UI.afterKpis({ nav: 120e6, unrealizedPnl: 2e6, marketValue: 11e6 });
    await wait(900);
    const html = t.els['today-brief'].innerHTML;
    expect(t.els['today-brief'].hidden).toBe(false); expect(html).toContain('Hôm nay'); expect(html).toContain('NAV 120.000.000 đ');
    expect(html).toContain('Một mã tối đa FPT'); expect(html).toContain('CHƯA ghi vào sổ'); expect(html).toContain('đã tới giá mua'); expect(html).toContain('Mạnh nhất 1 tháng');
    expect(t.calls.filter((c) => c === 'getMarketUniverse')).toHaveLength(1);
    expect(t.UI.state.result.attention).toBeGreaterThanOrEqual(3);
  });
  it('một phần lỗi (giới hạn, ngành) thì thẻ vẫn hiện các phần còn lại, không ném lỗi', async () => {
    const t = boot({ fail: ['listLimits', 'getMarketUniverse'] });
    t.UI.afterHoldings(holdings); t.UI.afterKpis({ nav: 120e6, unrealizedPnl: 2e6 });
    await wait(900);
    const html = t.els['today-brief'].innerHTML;
    expect(html).toContain('NAV 120.000.000 đ'); expect(html).not.toContain('Một mã tối đa'); expect(html).not.toContain('Mạnh nhất');
  });
  it('chưa có KPI thì ẩn thẻ; thu gọn nhớ theo ngày và chỉ giữ cho hôm nay; hiện lại cảnh báo phiên trước và bộ lọc có mã mới', async () => {
    const t = boot({ stored: { 'wh.fin.livealerts.prev.v1': { date: '2020-01-01', items: [{ title: 'FPT chạm mục tiêu', level: 'good' }] }, 'wh.fin.filterwatch.v1': { asOf: dToday(), items: [{ name: 'ROE cao', comparable: true, entered: ['AAA'], left: [] }] } } });
    t.UI.afterHoldings(holdings); await wait(100); expect(t.els['today-brief']).toBeUndefined();
    t.UI.afterKpis({ nav: 120e6, unrealizedPnl: 2e6 }); await wait(900);
    const html = t.els['today-brief'].innerHTML;
    expect(html).toContain('Cảnh báo phiên trước'); expect(html).toContain('Bộ lọc “ROE cao”: AAA mới lọt vào');
    t.UI.toggle(); expect(t.els['today-brief'].innerHTML).not.toContain('Cảnh báo phiên trước'); expect(JSON.parse(t.store.get('wh.fin.today.v1'))).toEqual({ date: dToday(), collapsed: true });
    const again = boot({ stored: { 'wh.fin.today.v1': { date: dToday(), collapsed: true } } }); expect(again.UI.state.collapsed).toBe(true);
    const nextDay = boot({ stored: { 'wh.fin.today.v1': { date: '2020-01-01', collapsed: true } } }); expect(nextDay.UI.state.collapsed).toBe(false);
  });
});
