import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import AB from '../../lib/accounting-bridge.js';

let seq = 0;
const buy = (symbol, quantity, price, fee, trade_date, extra) => ({ id: 'b' + (++seq), symbol, type: 'buy', quantity, price, fee: fee || 0, tax: 0, trade_date, created_at: trade_date + 'T03:00:' + String(seq % 60).padStart(2, '0') + 'Z', ...extra });
const sell = (symbol, quantity, price, fee, tax, trade_date, extra) => ({ id: 's' + (++seq), symbol, type: 'sell', quantity, price, fee: fee || 0, tax: tax || 0, trade_date, created_at: trade_date + 'T04:00:' + String(seq % 60).padStart(2, '0') + 'Z', ...extra });
const sum = (v, account, side) => v.lines.filter((l) => l.account === account && l.side === side).reduce((s, l) => s + l.amount, 0);
const only = (r, kind) => r.vouchers.filter((v) => v.kind === kind);

describe('mua chứng khoán', () => {
  it('mặc định đưa phí mua vào giá gốc TK 121 (TT200)', () => {
    const r = AB.build({ txns: [buy('FPT', 100, 120000, 18000, '2026-08-12')], period: '2026-08' });
    const v = only(r, 'buy')[0];
    expect(v.lines).toEqual([{ account: '121', side: 'N', amount: 12018000 }, { account: '1121', side: 'C', amount: 12018000 }]);
    expect(v.balanced).toBe(true);
    expect(v.date).toBe('2026-08-12');
    expect(v.id).toMatch(/^FIN-MUA-/);
  });
  it('mã chứng từ không trùng dù các lệnh có chung phần đầu mã gốc (nhập hàng loạt)', () => {
    const mkb = (id) => buy('FPT', 10, 1000, 0, '2026-08-01', { id });
    const r = AB.build({ txns: [mkb('11111111-aaaa-0000-0000-000000000001'), mkb('11111111-aaaa-0000-0000-000000000002'), mkb('11111111-aaaa-0000-0000-000000000003')], period: '2026-08' });
    expect(new Set(r.vouchers.map((v) => v.id)).size).toBe(3);
    expect(r.vouchers[0].id).toBe('FIN-MUA-11111111AAAA' + '0'.repeat(19) + '1');
  });
  it('buyFeePolicy=expense: phí mua vào chi phí tài chính 635', () => {
    const r = AB.build({ txns: [buy('FPT', 100, 120000, 18000, '2026-08-12')], period: '2026-08', buyFeePolicy: 'expense' });
    const v = only(r, 'buy')[0];
    expect(sum(v, '121', 'N')).toBe(12000000);
    expect(sum(v, '635', 'N')).toBe(18000);
    expect(sum(v, '1121', 'C')).toBe(12018000);
    expect(v.balanced).toBe(true);
  });
});

describe('bán chứng khoán (giá vốn FIFO của Fin)', () => {
  const buys = [buy('FPT', 100, 100000, 15000, '2026-07-10')];
  it('lãi: Nợ tiền + 635 (phí, thuế) / Có 121 giá vốn + 515 lãi; lãi ròng khớp realizedNet của Fin', () => {
    const r = AB.build({ txns: [...buys, sell('FPT', 100, 120000, 18000, 12000, '2026-08-12')], period: '2026-08' });
    const v = only(r, 'sell')[0];
    expect(sum(v, '1121', 'N')).toBe(11970000);
    expect(sum(v, '635', 'N')).toBe(30000);
    expect(sum(v, '121', 'C')).toBe(10015000);                    // 10.000.000 giá mua + 15.000 phí mua của lô đã tiêu thụ
    expect(sum(v, '515', 'C')).toBe(1985000);
    expect(v.balanced).toBe(true);
    expect(v.meta.gain - v.meta.fee - v.meta.tax).toBe(Math.round(v.meta.realizedNet));
    expect(r.summary.realizedNet).toBe(1955000);
    expect(r.vouchers.map((x) => x.kind)).toEqual(['sell']);      // lệnh mua tháng 7 nằm ngoài kỳ nhưng vẫn quyết định giá vốn
  });
  it('lỗ: phần lỗ vào Nợ 635 cùng phí và thuế, không có dòng 515', () => {
    const r = AB.build({ txns: [...buys, sell('FPT', 100, 90000, 13500, 9000, '2026-08-12')], period: '2026-08' });
    const v = only(r, 'sell')[0];
    expect(sum(v, '515', 'C')).toBe(0);
    expect(sum(v, '635', 'N')).toBe(13500 + 9000 + 1015000);
    expect(sum(v, '1121', 'N')).toBe(9000000 - 13500 - 9000);
    expect(sum(v, '121', 'C')).toBe(10015000);
    expect(v.balanced).toBe(true);
    expect(r.summary.lossTotal).toBe(1015000);
  });
  it('bán một phần: FIFO tiêu thụ lô cũ trước, phí mua tính theo phần đã bán', () => {
    const txns = [buy('VNM', 100, 50000, 10000, '2026-01-05'), buy('VNM', 100, 60000, 12000, '2026-02-05'), sell('VNM', 150, 70000, 0, 0, '2026-08-03')];
    const r = AB.build({ txns, period: '2026-08' });
    const v = only(r, 'sell')[0];
    // 100 cp lô 1 (5.000.000 + 10.000) + 50 cp lô 2 (3.000.000 + 6.000)
    expect(sum(v, '121', 'C')).toBe(5010000 + 3006000);
    expect(v.balanced).toBe(true);
  });
  it('chia tách cùng ngày được áp TRƯỚC lệnh bán (quy tắc ngày giao dịch không hưởng quyền)', () => {
    const txns = [buy('HPG', 1000, 30000, 0, '2026-03-01'), sell('HPG', 2000, 16000, 0, 0, '2026-08-10')];
    const actions = [{ id: 'a1', symbol: 'HPG', action_type: 'split', ratio: 2, ex_date: '2026-08-10', created_at: '2026-08-11T00:00:00Z' }];
    const r = AB.build({ txns, actions, period: '2026-08' });
    const v = only(r, 'sell')[0];
    expect(sum(v, '121', 'C')).toBe(30000000);
    expect(sum(v, '515', 'C')).toBe(2000000);                    // 32.000.000 - 30.000.000: lãi, không phải lỗ
    expect(r.notes.join(' ')).toMatch(/HPG.*chia tách/);
  });
  it('bán vượt khối lượng đang nắm bị bỏ qua và báo lý do, không sinh bút toán sai', () => {
    const r = AB.build({ txns: [buy('ACB', 100, 20000, 0, '2026-01-02'), sell('ACB', 150, 21000, 0, 0, '2026-08-02')], period: '2026-08' });
    expect(only(r, 'sell')).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/vượt khối lượng/);
  });
  it('lệnh mua giá 0 (cổ phiếu thưởng nhập tay) không phải lỗi: có ghi chú, không bút toán, giá vốn bình quân giảm', () => {
    const r = AB.build({ txns: [buy('SSI', 1000, 30000, 0, '2026-03-01'), buy('SSI', 100, 0, 0, '2026-08-05')], period: '2026-08', prices: { SSI: 30000 }, books: { provision: 0 } });
    expect(r.skipped).toEqual([]);
    expect(r.vouchers.filter((v) => v.kind === 'buy')).toHaveLength(0);
    expect(r.notes.join(' ')).toMatch(/SSI.*giá 0/);
    expect(r.holdings[0]).toMatchObject({ quantity: 1100, cost: 30000000 });
  });
  it('lệnh mua giá 0 có phí: chỉ hạch toán phí', () => {
    const r = AB.build({ txns: [buy('SSI', 100, 0, 5000, '2026-08-05')], period: '2026-08' });
    expect(r.vouchers).toHaveLength(1);
    expect(r.vouchers[0].lines).toEqual([{ account: '121', side: 'N', amount: 5000 }, { account: '1121', side: 'C', amount: 5000 }]);
  });
  it('lệnh bán giá 0 vẫn bị bỏ qua và báo lý do', () => {
    const r = AB.build({ txns: [buy('SSI', 100, 1000, 0, '2026-07-01'), sell('SSI', 100, 0, 0, 0, '2026-08-05')], period: '2026-08' });
    expect(r.skipped).toHaveLength(1);
  });
  it('lệnh đã xoá mềm (deleted_at) không vào bút toán', () => {
    const r = AB.build({ txns: [buy('FPT', 100, 100000, 0, '2026-08-01', { deleted_at: '2026-08-02T00:00:00Z' })], period: '2026-08' });
    expect(r.vouchers).toHaveLength(0);
  });
});

describe('cổ tức và dòng tiền', () => {
  const flows = [
    { id: 'f1', flow_type: 'dividend', amount: 1500000, flow_date: '2026-08-15', symbol: 'FPT' },
    { id: 'f2', flow_type: 'deposit', amount: 50000000, flow_date: '2026-08-02', note: 'Góp vốn đợt 3' },
    { id: 'f3', flow_type: 'withdrawal', amount: 20000000, flow_date: '2026-08-20' },
    { id: 'f4', flow_type: 'dividend', amount: 999, flow_date: '2026-07-31', symbol: 'VNM' },
  ];
  const r = AB.build({ flows, period: '2026-08' });
  it('cổ tức tiền: Nợ tiền / Có 515; nạp: Có 4111; rút: Nợ 4111; chỉ lấy dòng trong kỳ', () => {
    expect(r.vouchers.map((v) => v.kind)).toEqual(['deposit', 'dividend', 'withdrawal']);
    expect(r.vouchers[1].lines).toEqual([{ account: '1121', side: 'N', amount: 1500000 }, { account: '515', side: 'C', amount: 1500000 }]);
    expect(r.vouchers[0].lines).toEqual([{ account: '1121', side: 'N', amount: 50000000 }, { account: '4111', side: 'C', amount: 50000000 }]);
    expect(r.vouchers[2].lines).toEqual([{ account: '4111', side: 'N', amount: 20000000 }, { account: '1121', side: 'C', amount: 20000000 }]);
    expect(r.summary).toMatchObject({ dividends: 1500000, deposits: 50000000, withdrawals: 20000000 });
  });
  it('tài khoản đối ứng nạp/rút và tài khoản tiền chỉnh được', () => {
    const x = AB.build({ flows, period: '2026-08', depositCounter: '3411', accounts: { cash: '1128' } });
    const dep = only(x, 'deposit')[0];
    expect(dep.lines).toEqual([{ account: '1128', side: 'N', amount: 50000000 }, { account: '3411', side: 'C', amount: 50000000 }]);
  });
  it('số tiền không dương bị bỏ qua', () => {
    const x = AB.build({ flows: [{ id: 'z', flow_type: 'deposit', amount: 0, flow_date: '2026-08-02' }], period: '2026-08' });
    expect(x.vouchers).toHaveLength(0);
    expect(x.skipped).toHaveLength(1);
  });
});

describe('dự phòng giảm giá chứng khoán kinh doanh', () => {
  const txns = [buy('FPT', 100, 100000, 15000, '2026-07-10'), buy('VNM', 200, 50000, 0, '2026-07-12')];
  const base = { txns, period: '2026-08', prices: { FPT: 90000, VNM: 55000 } };
  it('cần lập = tổng phần giá thị trường thấp hơn giá gốc theo từng mã (mã lãi không bù mã lỗ)', () => {
    const r = AB.build({ ...base, books: { provision: 0, securities: 20015000 } });
    expect(r.holdings.find((h) => h.symbol === 'FPT').provision).toBe(1015000);
    expect(r.holdings.find((h) => h.symbol === 'VNM').provision).toBe(0);
    const v = only(r, 'provision')[0];
    expect(v.lines).toEqual([{ account: '635', side: 'N', amount: 1015000 }, { account: '2291', side: 'C', amount: 1015000 }]);
    expect(v.id).toBe('FIN-DP-20260831');
    expect(v.date).toBe('2026-08-31');
  });
  it('sổ đã có nhiều hơn mức cần: hoàn nhập (Nợ 2291 / Có 635)', () => {
    const v = only(AB.build({ ...base, books: { provision: 1500000 } }), 'provision')[0];
    expect(v.lines).toEqual([{ account: '2291', side: 'N', amount: 485000 }, { account: '635', side: 'C', amount: 485000 }]);
  });
  it('đã đủ thì không đề xuất; thiếu giá một mã thì không đề xuất và báo lý do', () => {
    expect(only(AB.build({ ...base, books: { provision: 1015000 } }), 'provision')).toHaveLength(0);
    const r = AB.build({ ...base, prices: { FPT: 90000 }, books: { provision: 0 } });
    expect(only(r, 'provision')).toHaveLength(0);
    expect(r.issues.join(' ')).toMatch(/VNM/);
    expect(r.summary.provisionRequired).toBeNull();
  });
  it('không có số dư sổ thì không đề xuất (không đoán số dư TK dự phòng)', () => {
    expect(only(AB.build(base), 'provision')).toHaveLength(0);
  });
  it('đối soát TK 121: chênh lệch = số dư sổ - giá gốc đang nắm theo Fin', () => {
    const r = AB.build({ ...base, books: { provision: 0, securities: 20000000 } });
    expect(r.recon.costHeld).toBe(20015000);
    expect(r.recon.securitiesDiff).toBe(-15000);
  });
  it('chia tách làm đổi số lượng nhưng giữ nguyên tổng giá gốc', () => {
    const r = AB.build({ txns: [buy('HPG', 1000, 30000, 0, '2026-03-01')], actions: [{ id: 'a', symbol: 'HPG', action_type: 'split', ratio: 2, ex_date: '2026-04-01', created_at: '2026-04-01T00:00:00Z' }], period: '2026-08', prices: { HPG: 16000 }, books: { provision: 0 } });
    expect(r.holdings[0]).toMatchObject({ quantity: 2000, cost: 30000000, marketValue: 32000000, provision: 0 });
  });
});

describe('kỳ và gửi sang web kế toán', () => {
  it('periodRange: tháng, quý, năm; sai định dạng trả null', () => {
    expect(AB.periodRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(AB.periodRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(AB.periodRange('2026-Q3')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(AB.periodRange('2026')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(AB.periodRange('abc')).toBeNull();
  });
  it('khoảng thời gian sai trả issues, không ném lỗi', () => {
    expect(AB.build({ period: 'x' }).issues).toHaveLength(1);
    expect(AB.build({ from: '2026-09-01', to: '2026-08-01' }).issues).toHaveLength(1);
  });
  it('plan: mới / đã gửi (nháp, đã ghi sổ) / bị từ chối thì gửi lại bản ~2, ~3', () => {
    const r = AB.build({ flows: [{ id: 'aaaa-1111', flow_type: 'deposit', amount: 10, flow_date: '2026-08-02' }, { id: 'bbbb-2222', flow_type: 'deposit', amount: 20, flow_date: '2026-08-03' }, { id: 'cccc-3333', flow_type: 'deposit', amount: 30, flow_date: '2026-08-04' }, { id: 'dddd-4444', flow_type: 'deposit', amount: 40, flow_date: '2026-08-05' }], period: '2026-08' });
    const ids = r.vouchers.map((v) => v.id);
    const p = AB.plan(r.vouchers, [
      { id: ids[0], status: 'Draft' }, { id: ids[1], status: 'Posted' },
      { id: ids[2], status: 'Rejected' }, { id: ids[3], status: 'Rejected' }, { id: ids[3] + '~2', status: 'Rejected' },
      { id: 'FIN-KHAC', status: 'Posted' },
    ]);
    expect(p.map((x) => x.state)).toEqual(['sent', 'sent', 'rejected', 'rejected']);
    expect(p[2].sendId).toBe(ids[2] + '~2');
    expect(p[3].sendId).toBe(ids[3] + '~3');
    expect(AB.plan(r.vouchers, [])[0]).toMatchObject({ state: 'new', sendId: ids[0] });
  });
  it('toApiPayload khớp POST /api/v9/vouchers; accountsUsed liệt kê mã tài khoản dùng', () => {
    const r = AB.build({ txns: [buy('FPT', 10, 1000, 0, '2026-08-01')], period: '2026-08' });
    const p = AB.plan(r.vouchers, [])[0];
    const body = AB.toApiPayload(p);
    expect(body.voucher).toMatchObject({ id: p.id, date: '2026-08-01', posting_date: '2026-08-01', type: AB.VOUCHER_TYPE, evidence_status: 'Pending' });
    expect(body.lines).toEqual([{ account: '121', side: 'N', amount: 10000 }, { account: '1121', side: 'C', amount: 10000 }]);
    expect(AB.accountsUsed(r.vouchers)).toEqual(['1121', '121']);
  });
  it('holdingsCsv ra đúng cột giá gốc / giá trị hợp lý / dự phòng của thuyết minh B09', () => {
    const r = AB.build({ txns: [buy('FPT', 100, 100000, 15000, '2026-07-10')], period: '2026-08', prices: { FPT: 90000 } });
    const csv = AB.holdingsCsv(r.holdings);
    expect(csv[0]).toEqual(AB.HOLDINGS_HEADER);
    expect(csv[1]).toEqual(['FPT', 100, 10015000, 100150, 90000, 9000000, -1015000, 1015000]);
  });
});

describe('kiểm tra ngẫu nhiên: mọi bút toán cân và khớp sổ FIFO của Fin', () => {
  let seed = 424242;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  for (const policy of ['capitalize', 'expense']) {
    it('200 kịch bản, phí mua ' + policy, () => {
      for (let k = 0; k < 200; k++) {
        const txns = [], actions = [], held = {};
        let d = '2025-01-02';
        const syms = ['AAA', 'BBB', 'CCC'];
        for (let i = 0; i < 30; i++) {
          d = addDays(d, 1 + Math.floor(rnd() * 6));
          const s = syms[Math.floor(rnd() * 3)];
          if (rnd() < 0.08 && held[s] > 0) { const ratio = rnd() < 0.5 ? 2 : 1.1; actions.push({ id: 'a' + k + '_' + i, symbol: s, action_type: ratio === 2 ? 'split' : 'stock_dividend', ratio: ratio === 2 ? 2 : 0.1, ex_date: d, created_at: d + 'T01:00:00Z' }); held[s] = Math.floor(held[s] * ratio); continue; }
          if ((held[s] || 0) > 0 && rnd() < 0.4) {
            const q = Math.max(1, Math.floor(held[s] * (0.2 + rnd() * 0.8)));
            const price = 9000 + Math.round(rnd() * 5000);
            txns.push(sell(s, q, price, Math.round(q * price * 0.0015), Math.round(q * price * 0.001), d)); held[s] -= q;
          } else {
            const q = 100 * (1 + Math.floor(rnd() * 20)), price = 9000 + Math.round(rnd() * 5000);
            txns.push(buy(s, q, price, Math.round(q * price * 0.0015), d)); held[s] = (held[s] || 0) + q;
          }
        }
        const prices = { AAA: 9000 + Math.round(rnd() * 5000), BBB: 9000 + Math.round(rnd() * 5000), CCC: 9000 + Math.round(rnd() * 5000) };
        const r = AB.build({ txns, actions, from: '2025-01-01', to: '2026-12-31', buyFeePolicy: policy, prices, books: { provision: 0, securities: 0 } });
        expect(r.skipped).toEqual([]);
        r.vouchers.forEach((v) => expect(v.balanced).toBe(true));
        // TK 121 tích luỹ qua mọi bút toán (mua - giá vốn bán) phải bằng giá gốc đang nắm theo Fin, lệch tối đa 1 đồng mỗi bút toán do làm tròn
        const net121 = r.vouchers.reduce((s, v) => s + sum(v, '121', 'N') - sum(v, '121', 'C'), 0);
        expect(Math.abs(net121 - r.recon.costHeld)).toBeLessThanOrEqual(r.vouchers.length);
        // lãi ròng sổ kế toán (515 - 635 của các lệnh bán) = lãi ròng đã chốt của Fin (khi phí mua nằm trong giá gốc)
        if (policy === 'capitalize') {
          const book = only(r, 'sell').reduce((s, v) => s + sum(v, '515', 'C') - sum(v, '635', 'N'), 0);
          expect(Math.abs(book - r.summary.realizedNet)).toBeLessThanOrEqual(only(r, 'sell').length + 1);
        }
        // dự phòng: sau khi ghi, số dư TK 2291 = mức cần lập
        const prov = only(r, 'provision')[0];
        const required = r.summary.provisionRequired;
        expect(prov ? prov.meta.delta : 0).toBe(required);
      }
    });
  }
});

describe('bản sao ở web kế toán không được lệch', () => {
  const copy = process.env.ONYXLINE_PATH ? process.env.ONYXLINE_PATH + '/src/accounting-bridge.js' : null;
  (copy && existsSync(copy) ? it : it.skip)('src/accounting-bridge.js giống hệt lib/accounting-bridge.js', () => {
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(new URL('../../lib/accounting-bridge.js', import.meta.url), 'utf8'));
  });
});
