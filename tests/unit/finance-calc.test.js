// Test logic thuần của Bàn Tài Sản: lib/finance-calc.js + các hàm tính toán trong api.js
// (api.js là script trình duyệt không export được, nên trích đúng đoạn hàm ra để chạy -- cùng
// kiểu "đọc nguồn thật" để test không bị lệch khỏi code đang chạy).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import FinCalc from '../../lib/finance-calc.js';

const apiSrc = fs.readFileSync(new URL('../../api.js', import.meta.url), 'utf8');

// Lấy 1 thuộc tính hàm của object literal trong api.js, từ marker bắt đầu tới marker kế tiếp
function extractFn(startMarker, endMarker) {
  const a = apiSrc.indexOf(startMarker);
  const b = apiSrc.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('Không tìm thấy hàm trong api.js: ' + startMarker);
  const body = apiSrc.slice(a + startMarker.length, b).trim().replace(/,\s*$/, '');
  return new Function('return (' + body + ')')();
}

const D = (s) => new Date(s + 'T00:00:00');

describe('_xirr (api.js)', () => {
  const xirr = extractFn('_xirr: ', '// Hiệu quả đầu tư theo từng mã');
  it('10%/năm cho 100 -> 110 sau đúng 365 ngày', () => {
    expect(xirr([{ t: D('2025-01-01'), amt: -100 }, { t: D('2026-01-01'), amt: 110 }])).toBeCloseTo(0.10, 6);
  });
  it('trả số âm khi lỗ', () => {
    expect(xirr([{ t: D('2025-01-01'), amt: -100 }, { t: D('2026-01-01'), amt: 80 }])).toBeCloseTo(-0.20, 6);
  });
  it('null khi thiếu dòng âm hoặc dương', () => {
    expect(xirr([{ t: D('2025-01-01'), amt: -100 }])).toBeNull();
    expect(xirr([])).toBeNull();
  });
});

describe('_valuationTarget (api.js)', () => {
  const vt = extractFn('_valuationTarget: ', '// Độ tươi của giá');
  it('trung bình giá theo P/E và P/B', () => {
    // EPS = 150/1000*10000 = 1500; BVPS = 2000/1000*10000 = 20000 -> 12*1500=18000, 1.2*20000=24000
    expect(vt({ v1: 1000, v2: 2000, v3: 150, targetPE: 12, targetPB: 1.2 })).toBe(21000);
  });
  it('chỉ có 1 phương pháp thì dùng phương pháp đó', () => {
    expect(vt({ v1: 1000, v2: 2000, v3: 150, targetPE: 12 })).toBe(18000);
  });
  it('loại EPS âm; null khi thiếu dữ liệu', () => {
    expect(vt({ v1: 1000, v2: 2000, v3: -50, targetPE: 12, targetPB: 1.2 })).toBe(24000);
    expect(vt({})).toBeNull();
    expect(vt(null)).toBeNull();
    expect(vt({ v1: 0, v2: 1, v3: 1, targetPE: 5 })).toBeNull();
  });
  it('ưu tiên fair_value của hồ sơ mới; hồ sơ cũ snake_case vẫn ra giá mục tiêu', () => {
    expect(vt({ fair_value: 33000, v1: 1000, v2: 2000, v3: 150, targetPE: 12, targetPB: 1.2 })).toBe(33000);
    expect(vt({ charter_capital: 1000, equity: 2000, lnst: 150, target_pe: 12, target_pb: 1.2 })).toBe(21000);
  });
});

describe('_priceMeta (api.js)', () => {
  const priceMeta = extractFn('_priceMeta: ', '// Trạng thái lần chạy gần nhất');
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  it('none khi chưa có giá', () => {
    expect(priceMeta(undefined, 0).kind).toBe('none');
    expect(priceMeta({ priceDate: null }, 0).kind).toBe('none');
  });
  it('auto: cũ khi quá 4 ngày', () => {
    expect(priceMeta({ priceDate: iso(daysAgo(3)), priceSource: 'vnd-dchart' }, 100).stale).toBe(false);
    const m = priceMeta({ priceDate: iso(daysAgo(6)), priceSource: 'vnd-dchart' }, 100);
    expect(m.stale).toBe(true);
    expect(m.ageDays).toBe(6);
  });
  it('manual: cũ khi quá 7 ngày và chưa khóa; giá khóa không cảnh báo', () => {
    const old = daysAgo(10).toISOString();
    expect(priceMeta({ updatedAt: old, locked: false }, 100)).toMatchObject({ kind: 'manual', stale: true });
    expect(priceMeta({ updatedAt: old, locked: true }, 100).stale).toBe(false);
  });
});

describe('getSymbolPerformance (api.js)', () => {
  const xirr = extractFn('_xirr: ', '// Hiệu quả đầu tư theo từng mã');
  const fnSrc = (() => {
    const start = 'getSymbolPerformance: ';
    const a = apiSrc.indexOf(start);
    const b = apiSrc.indexOf('// Email cảnh báo giá khi app tắt', a);
    return apiSrc.slice(a + start.length, b).trim().replace(/,\s*$/, '');
  })();

  function run(txns, flows, holdings) {
    const API = { asset: { listTransactions: async () => txns, getHoldingsView: async () => holdings, cashFlow: { list: async () => flows }, _xirr: xirr } };
    const getUserId = async () => 'u1';
    return new Function('API', 'getUserId', 'return (' + fnSrc + ')')(API, getUserId)('x');
  }

  const txns = [
    { symbol: 'AAA', type: 'buy', quantity: 1000, price: 10000, fee: 15000, trade_date: '2025-01-02', realized_pnl: null },
    { symbol: 'AAA', type: 'sell', quantity: 400, price: 12000, fee: 10000, trade_date: '2025-06-02', realized_pnl: 800000 },
    { symbol: 'BBB', type: 'buy', quantity: 500, price: 20000, fee: 0, trade_date: '2025-03-01', realized_pnl: null },
    { symbol: 'BBB', type: 'sell', quantity: 500, price: 18000, fee: 0, trade_date: '2025-04-01', realized_pnl: -1000000 }
  ];
  const flows = [
    { flow_type: 'dividend', symbol: 'AAA', amount: 300000, flow_date: '2025-09-01' },
    { flow_type: 'dividend', symbol: null, amount: 999, flow_date: '2025-09-01' },
    { flow_type: 'deposit', symbol: 'AAA', amount: 5, flow_date: '2025-09-01' }
  ];
  const holdings = [{ symbol: 'AAA', quantity: 600, marketPrice: 13000, marketValue: 7800000, unrealizedPnl: 1800000 }];

  it('tổng lãi/lỗ = đã chốt + chưa chốt + cổ tức - phí, khớp với dòng tiền thực', async () => {
    const rows = await run(txns, flows, holdings);
    const A = rows.find(r => r.symbol === 'AAA');
    expect(A.totalPnl).toBe(800000 + 1800000 + 300000 - 25000);
    expect(A.sold - A.bought + A.marketValue - A.fees + A.dividends).toBe(A.totalPnl);
  });
  it('mã đã bán hết vẫn có mặt, không còn giữ; sắp xếp theo |tổng lãi| giảm dần', async () => {
    const rows = await run(txns, flows, holdings);
    const B = rows.find(r => r.symbol === 'BBB');
    expect(B).toMatchObject({ held: false, totalPnl: -1000000 });
    expect(rows[0].symbol).toBe('AAA');
    expect(rows[0].xirrPct).toBeGreaterThan(0);
    expect(B.xirrPct).toBeLessThan(0);
  });
  it('mã đang giữ nhưng chưa có giá: đánh dấu noPrice, không tính lãi chưa chốt', async () => {
    const rows = await run(txns.slice(0, 1), [], [{ symbol: 'AAA', quantity: 1000, marketPrice: 0, marketValue: 0, unrealizedPnl: -10000000 }]);
    expect(rows[0].noPrice).toBe(true);
    expect(rows[0].unrealized).toBe(0);
  });
});

describe('FinCalc.sectorAllocation / concentrationWarnings', () => {
  const holdings = [
    { symbol: 'VCB', marketValue: 40e6 }, { symbol: 'TCB', marketValue: 30e6 },
    { symbol: 'FPT', marketValue: 20e6 }, { symbol: 'XYZ', marketValue: 10e6 }, { symbol: 'OLD', marketValue: 0 }
  ];
  it('gộp theo ngành, sắp xếp giảm dần, bỏ mã không có giá trị', () => {
    const s = FinCalc.sectorAllocation(holdings);
    expect(s.map(x => x.sector)).toEqual(['Ngân hàng', 'Công nghệ', FinCalc.UNKNOWN_SECTOR]);
    expect(s[0].pct).toBeCloseTo(70, 6);
    expect(s[0].symbols).toEqual(['VCB', 'TCB']);
  });
  it('cảnh báo mã >= 30% và ngành >= 50%', () => {
    const w = FinCalc.concentrationWarnings(holdings);
    expect(w).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'sector', label: 'Ngân hàng' }),
      expect.objectContaining({ type: 'symbol', label: 'VCB' }),
      expect.objectContaining({ type: 'symbol', label: 'TCB' })
    ]));
    expect(w.find(x => x.label === 'FPT')).toBeUndefined();
  });
  it('không cảnh báo khi chỉ có 1 mã hoặc ngành chưa phân loại', () => {
    expect(FinCalc.concentrationWarnings([{ symbol: 'VCB', marketValue: 1 }])).toEqual([]);
    const w = FinCalc.concentrationWarnings([{ symbol: 'AAA1', marketValue: 90 }, { symbol: 'AAA2', marketValue: 10 }]);
    expect(w.some(x => x.type === 'sector')).toBe(false);
  });
});

describe('FinCalc.priceAgeLabel / priceStatusSummary', () => {
  it('nhãn cho giá tự động, cũ, nhập tay, chưa có', () => {
    expect(FinCalc.priceAgeLabel({ kind: 'auto', date: '2026-10-01', stale: false, source: 'vnd-dchart' }).cls).toBe('auto');
    expect(FinCalc.priceAgeLabel({ kind: 'auto', date: '2026-09-20', stale: true, ageDays: 11 })).toMatchObject({ cls: 'stale', text: 'Giá ngày 20/09 · cũ 11 ngày' });
    expect(FinCalc.priceAgeLabel({ kind: 'manual', date: '2026-10-01', stale: false }).text).toBe('Nhập tay 01/10');
    expect(FinCalc.priceAgeLabel({ kind: 'none' }).cls).toBe('none');
  });
  it('trạng thái lần chạy: ok / warn / bad / none', () => {
    const now = new Date('2026-10-01T10:00:00Z');
    const fresh = new Date('2026-10-01T09:00:00Z').toISOString();
    expect(FinCalc.priceStatusSummary(null, now).level).toBe('none');
    expect(FinCalc.priceStatusSummary({ ranAt: fresh, priced: 4, symbols: 4, failed: [], sources: {} }, now).level).toBe('ok');
    expect(FinCalc.priceStatusSummary({ ranAt: fresh, priced: 3, symbols: 4, failed: ['ZZZ'], sources: {} }, now).level).toBe('warn');
    expect(FinCalc.priceStatusSummary({ ranAt: '2026-09-20T00:00:00Z', priced: 4, symbols: 4, failed: [], sources: {} }, now).level).toBe('bad');
  });
});

describe('FinCalc.buildCsv', () => {
  it('có BOM, escape dấu ngoặc kép, dùng CRLF', () => {
    const csv = FinCalc.buildCsv([['Mã', 'Ghi chú'], ['FPT', 'nói "tốt", ok']]);
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    expect(csv).toContain('"nói ""tốt"", ok"');
    expect(csv).toContain('\r\n');
  });
});
