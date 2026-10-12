// lib/butler-core.js phần DỮ LIỆU của Quản gia: nhận ra câu hỏi về số liệu (danh mục, nhóm, giới hạn, lệnh chờ duyệt, một mã), kế hoạch AI với công cụ dữ liệu, định dạng số và câu trả lời dựng từ facts.
import { describe, it, expect } from 'vitest';

const C = require('../../lib/butler-core.js');
const M = require('../../lib/butler-map-fin.js');

describe('understand: câu hỏi VỀ DỮ LIỆU -> intent data', () => {
  const u = (q) => C.understand(q, {}, M);
  it.each([
    ['danh mục của tôi', 'portfolio', {}], ['tôi đang giữ gì', 'portfolio', {}], ['NAV của tôi bao nhiêu', 'portfolio', {}], ['danh mục', 'portfolio', {}],
    ['danh mục của cả nhóm', 'group', {}], ['danh mục nhóm đang nắm gì', 'group', {}],
    ['giới hạn đầu tư có vượt không', 'limits', {}], ['lệnh chờ duyệt', 'approvals', {}], ['có lệnh nào chờ duyệt không', 'approvals', {}],
    ['FPT tôi đang giữ bao nhiêu', 'holding', { sym: 'FPT' }], ['lãi lỗ FPT thế nào', 'holding', { sym: 'FPT' }], ['HPG đang giữ', 'holding', { sym: 'HPG' }],
  ])('%s -> %s', (q, tool, args) => {
    const r = u(q);
    expect(r.intent).toBe('data');
    expect(r.data).toEqual({ tool, args });
  });
  it('hỏi đường (ở đâu / cách / hướng dẫn) thì chỉ đường, không đọc dữ liệu', () => {
    ['xem giới hạn đầu tư ở đâu', 'duyệt lệnh ở đâu', 'danh mục ở đâu', 'cách xem lãi lỗ', 'hướng dẫn xem danh mục nhóm'].forEach((q) => expect(u(q).intent, q).toBe('features'));
  });
  it('hôm nay có việc gì vẫn là today; tính năng không có công cụ dữ liệu vẫn là features', () => {
    expect(u('hôm nay có việc gì').intent).toBe('today');
    expect(u('xem sở hữu của FPT').intent).toBe('features');
    expect(u('tôi muốn nhập sao kê').intent).toBe('features');
  });
  it('mục có công cụ dữ liệu khai báo đúng tên công cụ đang bật', () => {
    const withData = M.features.filter((f) => f.data);
    expect(withData.map((f) => f.data).sort()).toEqual(['approvals', 'group', 'limits', 'portfolio']);
    withData.forEach((f) => expect(C.TOOLS[f.data] && C.TOOLS[f.data].data && C.TOOLS[f.data].enabled, f.id).toBe(true));
  });
});

describe('kế hoạch AI với công cụ dữ liệu', () => {
  it('công cụ dữ liệu có trong danh mục gửi AI, kèm tên tham số', () => {
    const p = C.buildPlanPrompt('danh mục của tôi', M, {});
    expect(p.user).toContain('\nT:portfolio |');
    expect(p.user).toContain('\nT:holding(sym) |');
    expect(p.system).toContain('intent=data');
  });
  it('parsePlan: intent data cần ít nhất một công cụ dữ liệu hợp lệ; holding cần mã hợp lệ', () => {
    expect(C.parsePlan('{"intent":"data","features":[],"tools":[{"id":"holding","args":{"sym":"fpt"}}],"sym":"FPT"}', M).tools).toEqual([{ id: 'holding', args: { sym: 'FPT' } }]);
    expect(C.parsePlan('{"intent":"data","features":[],"tools":[{"id":"holding","args":{"sym":"a b"}}]}', M)).toBeNull();
    expect(C.parsePlan('{"intent":"data","features":[],"tools":[]}', M)).toBeNull();
    expect(C.parsePlan('{"intent":"data","features":[],"tools":[{"id":"today","args":{}}]}', M)).toBeNull();
    expect(C.parsePlan('{"intent":"data","tools":[{"id":"portfolio","args":{}}]}', M).tools).toEqual([{ id: 'portfolio', args: {} }]);
  });
});

describe('định dạng số và câu trả lời dữ liệu', () => {
  it('vnd / pct', () => {
    expect(C.vnd(1234567890)).toBe('1,23 tỷ đ');
    expect(C.vnd(45600000)).toBe('45,6 triệu đ');
    expect(C.vnd(-123456)).toBe('−123.456 đ');
    expect(C.vnd(0)).toBe('0 đ');
    expect(C.pct(12.34)).toBe('+12,3%');
    expect(C.pct(-0.5)).toBe('−0,5%');
    expect(C.pct(null)).toBe('—');
  });
  const pf = {
    name: 'An', nav: 1500000000, cash: 300000000, debt: 0, marketValue: 1200000000, cashPct: 20, unrealizedPct: 8.5, positionCount: 2, noPriceCount: 1, priceDate: '2026-10-12',
    holdings: [
      { symbol: 'FPT', sector: 'CNTT', quantity: 5000, avgCost: 100000, price: 120000, value: 600000000, weightPct: 50, navPct: 40, unrealizedPct: 20, noPrice: false },
      { symbol: 'XYZ', sector: null, quantity: 100, avgCost: 10000, price: 0, value: 0, weightPct: 0, navPct: 0, unrealizedPct: null, noPrice: true },
    ],
  };
  it('composePortfolio: câu, KPI, danh sách mã bấm được, cảnh báo thiếu giá', () => {
    const r = C.composePortfolio(pf);
    expect(r.text).toBe('NAV của bạn khoảng 1,50 tỷ đ (giá tới 12/10), đang nắm 2 mã, lãi/lỗ chưa thực hiện +8,5% so với giá vốn; tiền mặt 300,0 triệu đ (20,0% NAV).');
    expect(r.cards[0].type).toBe('kpis');
    expect(r.cards[0].items[3]).toMatchObject({ label: 'Lãi/lỗ chưa thực hiện', value: '+8,5%', tone: 'up' });
    const rows = r.cards[1].rows;
    expect(rows[0]).toMatchObject({ text: 'FPT · 600,0 triệu đ', tone: 'up', ref: { kind: 'symbol', sym: 'FPT' } });
    expect(rows[0].sub).toBe('giá 120.000 đ · 5.000 cp · 40,0% NAV · +20,0% so với giá vốn');
    expect(rows[1].sub).toMatch(/^chưa có giá/);
    expect(r.notices).toEqual(['1 mã chưa có giá thị trường nên chưa tính vào giá trị cổ phiếu.']);
    expect(r.cards[r.cards.length - 1]).toEqual({ type: 'features', items: [{ id: 'assets-holdings', sym: '' }] });
  });
  it('composePortfolio: chưa có dữ liệu -> gợi ý ghi lệnh; lỗ -> tone bad', () => {
    expect(C.composePortfolio(null).cards[0].items[0].id).toBe('ledger');
    const lo = C.composePortfolio(Object.assign({}, pf, { unrealizedPct: -3.2 }));
    expect(lo.cards[0].items[3]).toMatchObject({ value: '−3,2%', tone: 'bad' });
  });
  it('composeHolding: có / không nắm; cả nhóm', () => {
    const f = { symbol: 'FPT', mine: pf.holdings[0], group: { value: 2400000000, weightPct: 30, holderCount: 3, quantity: 20000, unrealizedPct: 12, myShareOfSymbolPct: 25 }, priceDate: '2026-10-12' };
    const r = C.composeHolding(f);
    expect(r.text).toBe('Bạn đang nắm 5.000 cp FPT (giá vốn bình quân 100.000 đ, giá 120.000 đ), giá trị 600,0 triệu đ, 40,0% NAV, +20,0% so với giá vốn. Cả nhóm: 3 người nắm, tổng 2,40 tỷ đ (30,0% danh mục gộp), phần của bạn 25,0%.');
    expect(C.composeHolding({ symbol: 'VNM', mine: null, group: null }).text).toMatch(/không nắm VNM/);
    expect(C.composeHolding({ symbol: 'VNM', mine: null, group: { value: 1e9, weightPct: 5, holderCount: 1, myShareOfSymbolPct: null } }).text).toMatch(/^Bạn hiện không nắm VNM\. Cả nhóm: 1 người nắm/);
  });
  it('composeGroup / composeLimits / composeApprovals', () => {
    const g = C.composeGroup({ memberCount: 3, nav: 5e9, marketValue: 4e9, cash: 1e9, debt: 0, cashPct: 20, sharedCount: 2, sharedValuePct: 35.5, priceDate: '2026-10-12', top: [{ symbol: 'FPT', sector: 'CNTT', value: 1e9, weightPct: 25, holderCount: 3, unrealizedPct: 10 }], members: [{ name: 'An', nav: 3e9, marketValue: 2e9, positions: 4 }, { name: 'Bình', nav: 2e9, marketValue: 2e9, positions: 3 }] });
    expect(g.text).toMatch(/^Danh mục gộp của 3 thành viên: NAV khoảng 5,00 tỷ đ/);
    expect(g.cards.map((c) => c.type)).toEqual(['kpis', 'list', 'list', 'features']);
    const it1 = { kind: 'max_symbol_pct', subject: 'FPT', current: 45, threshold: 40, mode: 'reason', scope: 'member', kindLabel: 'Một mã tối đa', unit: '% NAV', modeLabel: 'Phải ghi lý do' };
    const l = C.composeLimits({ activeLimits: 3, me: { limitCount: 2, breaches: [it1], warns: [Object.assign({}, it1, { current: 38, usage: 0.95, mode: 'warn', modeLabel: 'Cảnh báo' })] }, group: { limitCount: 1, breaches: [], warns: [] }, otherMembers: { withBreach: 1, withWarn: 0, total: 3 } });
    expect(l.text).toBe('Về giới hạn đầu tư: bạn đang vượt 1 giới hạn, 1 giới hạn sắp chạm; cả nhóm gộp không vượt giới hạn nào; trong số 3 thành viên khác có 1 người đang vượt giới hạn.');
    expect(l.cards[0].rows[0]).toMatchObject({ text: 'Một mã tối đa · FPT', tone: 'bad' });
    expect(C.composeLimits({ activeLimits: 0 }).text).toMatch(/chưa có giới hạn/);
    const a = C.composeApprovals({ manager: true, total: 2, mine: 1, pending: [{ id: '1', symbol: 'FPT', side: 'buy', quantity: 1000, value: 1.2e8, orderPct: 8, requester: 'An', mine: false, createdAt: '2026-10-08T01:00:00Z', validUntil: null, ageDays: 4 }, { id: '2', symbol: 'HPG', side: 'sell', quantity: 500, value: 1.3e7, orderPct: 1, requester: 'Bình', mine: true, createdAt: '2026-10-12T01:00:00Z', validUntil: '2026-10-20', ageDays: 0 }] });
    expect(a.text).toBe('2 lệnh đang chờ duyệt (1 lệnh của bạn). Bạn có quyền duyệt các lệnh này.');
    expect(a.cards[0].rows[0]).toMatchObject({ text: 'Mua 1.000 FPT · 120,0 triệu đ', tone: 'bad' });
    expect(a.cards[0].rows[1].sub).toMatch(/đề xuất bởi bạn/);
    expect(C.composeApprovals({ manager: false, total: 0, mine: 0, pending: [] }).text).toBe('Bạn không có lệnh nào đang chờ duyệt.');
  });
  it('composeData chọn đúng hàm; công cụ lạ -> null', () => {
    expect(C.composeData('portfolio', pf).cards[0].type).toBe('kpis');
    expect(C.composeData('holding', null, { sym: 'FPT' }).text).toMatch(/FPT/);
    expect(C.composeData('khong-co', {})).toBeNull();
  });
});

describe('composeToday với tín hiệu đầu tư', () => {
  const day = { date: '2026-10-12', tasks: [], events: [], milestones: [] };
  it('không có tín hiệu: như cũ; có tín hiệu: thêm thẻ + câu "Về đầu tư"', () => {
    const base = C.composeToday(day);
    expect(base.cards.some((c) => c.title && /^Tín hiệu/.test(c.title))).toBe(false);
    expect(base.counts.signals).toBe(0);
    const r = C.composeToday(day, null, { approvals: { total: 3, mine: 1, manager: true }, compliance: { date: '2026-10-12', mineBreaches: 2, mineWarns: 0, groupBreaches: 1, groupWarns: 0 }, ideasInReview: 2 });
    const card = r.cards.find((c) => c.title && /^Tín hiệu đầu tư/.test(c.title));
    expect(card.rows.map((x) => x.text)).toEqual(['3 lệnh đang chờ duyệt (bạn có quyền duyệt)', 'Bạn đang vượt 2 giới hạn đầu tư', 'Cả nhóm gộp đang vượt 1 giới hạn đầu tư', '2 ý tưởng đầu tư đang chờ phản biện']);
    expect(card.rows[1]).toMatchObject({ tone: 'bad', ref: { kind: 'feature', id: 'group-limits' } });
    expect(r.text).toMatch(/Về đầu tư: 3 lệnh đang chờ duyệt \(bạn có quyền duyệt\); bạn đang vượt 2 giới hạn đầu tư;/);
    expect(r.counts.signals).toBe(4);
    expect(r.cards[r.cards.length - 1]).toEqual({ type: 'features', items: [{ id: 'insight-inbox' }] });
  });
  it('chỉ có cảnh báo sắp chạm; tín hiệu rỗng -> không thêm gì', () => {
    const r = C.composeToday(day, null, { approvals: { total: 0, mine: 0, manager: false }, compliance: { date: '2026-10-12', mineBreaches: 0, mineWarns: 2, groupBreaches: 0, groupWarns: 0 }, ideasInReview: 0 });
    expect(r.cards.find((c) => /^Tín hiệu/.test(c.title || '')).rows.map((x) => x.text)).toEqual(['Bạn có 2 giới hạn sắp chạm']);
    expect(C.composeToday(day, null, { approvals: { total: 0, mine: 0, manager: false }, compliance: null, ideasInReview: 0 }).counts.signals).toBe(0);
  });
});
