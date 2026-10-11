// Hồi quy lỗi thật 12/10/2026: trong trình duyệt, `const X = (function ...)` ở thẻ <script> thường KHÔNG tạo thuộc tính của globalThis, nên lib nào tra `globalThis.PitCalc` / `globalThis.StrategyBacktest`
// khi nạp sẽ nhận undefined (chạy Vitest bằng require thì vẫn đúng nên không bắt được). Ở đây nạp các lib của Phòng kiểm thử đúng như trình duyệt (vm.runInContext, không đổi const thành var).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { makeRows, indexRow } = require('../helpers/bt-fixtures.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const ORDER = ['lib/pit-calc.js', 'lib/bt-panel.js', 'lib/strategy-backtest.js', 'lib/factor-model.js'];     // đúng thứ tự thẻ <script> trong lab/index.html

describe('Phòng kiểm thử nạp như trình duyệt', () => {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout });
  ORDER.forEach((f) => vm.runInContext(read(f), ctx));
  it('mỗi lib gắn mình vào globalThis để lib nạp sau tra được', () => {
    ['PitCalc', 'BtPanel', 'StrategyBacktest', 'FactorModel'].forEach((g) => expect(vm.runInContext('typeof globalThis.' + g, ctx), g).toBe('object'));
  });
  it('thứ tự thẻ trong lab/index.html khớp thứ tự đã kiểm', () => {
    const html = read('lab/index.html'), at = (n) => html.indexOf('/' + n + '.js');
    expect(at('pit-calc')).toBeGreaterThan(0); expect(at('pit-calc')).toBeLessThan(at('bt-panel')); expect(at('bt-panel')).toBeLessThan(at('strategy-backtest')); expect(at('strategy-backtest')).toBeLessThan(at('factor-model'));
  });
  it('bộ máy dùng được bộ lọc theo số liệu cơ bản và dựng yếu tố, không văng "undefined" do thiếu lib', async () => {
    const stocks = {}; for (let k = 0; k < 40; k++) stocks['S' + k] = { ret: (t) => 0.0005 * (k % 5) + 0.01 * Math.sin(t * (0.3 + k * 0.07) + k), p0: 20 + k, val: 30000 };
    const { rows, dates } = makeRows(520, stocks);
    ctx.__rows = JSON.parse(JSON.stringify(rows)); ctx.__idx = JSON.parse(JSON.stringify([indexRow('VNINDEX', dates, (t) => 0.0004 + 0.004 * Math.sin(t * 0.9))]));
    const out = await vm.runInContext(`(async () => {
      const P = BtPanel.build(__rows, __idx);
      const spec = StrategyBacktest.normalizeSpec({ universe: { minAdv: 0, minHistory: 60, exchanges: ['HOSE'] }, rank: [{ key: 'mom3', dir: 'high', w: 1 }], select: { n: 5 }, rebalance: 'M' }).spec;
      const res = await StrategyBacktest.run(P, spec, { pit: [], randomRuns: 5 });
      const F = FactorModel.buildFactorReturns(P, [], { onlyKeys: ['MOM', 'LVOL'], minAdv: 0 });
      return { ok: res.ok, built: Object.keys(F.built || {}) };
    })()`, ctx);
    expect(out.ok).toBe(true); expect(out.built.length).toBeGreaterThan(0);
  });
});
