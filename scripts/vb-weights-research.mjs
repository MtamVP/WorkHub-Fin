// Nghiên cứu 09/10/2026: trọng số phương pháp theo nhóm mô hình kinh doanh (archetype) học từ IC giai đoạn huấn luyện có cải thiện IC NGOÀI MẪU so với trọng số hiện tại không?
// Kết quả: KHÔNG (chênh -0,015..+0,01, trong nhiễu) -> giữ trọng số. Chạy: node scripts/vb-weights-research.mjs --obs <observations.json của vb-backtest-run.mjs> [--h xr12|xr6]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const BT = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'vb-backtest.js'));
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const obs = JSON.parse(fs.readFileSync(opt('obs', path.join(os.tmpdir(), 'vb-backtest-cache', 'observations.json')), 'utf8'));
const H = opt('h', 'xr12');
const ic = (rows, scoreFn) => {
  const p = rows.filter((x) => x[H] !== null && x[H] !== undefined).map((x) => ({ date: x.date, s: scoreFn(x), y: x[H] })).filter((q) => q.s !== null && isFinite(q.s));
  if (p.length < 60) return { n: p.length };
  const c = BT.icWithCI(p, 300, 21);
  return { n: p.length, ic: +c.ic.toFixed(4), lo: +c.lo.toFixed(4), hi: +c.hi.toFixed(4) };
};
const methodsOf = (x) => Object.keys(x.methods || {}).filter((k) => x.methods[k] > 0);

// IC từng phương pháp theo archetype (và chung) trên một tập
function learn(train) {
  const keys = [...new Set(train.flatMap(methodsOf))], archs = [...new Set(train.map((x) => x.archetype))];
  const overall = {}, cell = {};
  keys.forEach((k) => { overall[k] = ic(train.filter((x) => x.methods[k] > 0), (x) => Math.log(x.methods[k] / x.price)); });
  archs.forEach((a) => { cell[a] = {}; keys.forEach((k) => { const sub = train.filter((x) => x.archetype === a && x.methods[k] > 0); if (sub.length >= 150) cell[a][k] = ic(sub, (x) => Math.log(x.methods[k] / x.price)); }); });
  return { overall, cell };
}
// Trọng số của phương pháp k cho archetype a: IC (chặn dưới 0); ô có đủ mẫu thì dùng IC của ô, không thì IC chung; mode 'sig' chỉ giữ phương pháp có khoảng tin cậy trên 0
function weightFn(model, mode, shrink) {
  return (a, k) => {
    const c = model.cell[a] && model.cell[a][k], o = model.overall[k];
    const pick = c && c.ic !== undefined ? (shrink ? { ic: (c.ic * c.n + o.ic * 600) / (c.n + 600), lo: c.lo } : c) : o;
    if (!pick || pick.ic === undefined) return 0;
    if (mode === 'sig' && !(pick.lo > 0)) return 0;
    return Math.max(0, pick.ic);
  };
}
const composite = (wf) => (x) => {
  let s = 0, w = 0;
  methodsOf(x).forEach((k) => { const wk = wf(x.archetype, k); if (wk > 0) { s += wk * Math.log(x.methods[k] / x.price); w += wk; } });
  return w > 0 ? s / w : null;
};
const baseline = (x) => Math.log(x.fair / x.price);
const median = (x) => { const v = methodsOf(x).map((k) => Math.log(x.methods[k] / x.price)).sort((a, b) => a - b); if (!v.length) return null; const m = (v.length - 1) / 2; return (v[Math.floor(m)] + v[Math.ceil(m)]) / 2; };

for (const split of ['2022-12-31', '2023-12-31', '2024-06-30']) {
  const train = obs.filter((x) => x.date <= split), test = obs.filter((x) => x.date > split);
  const model = learn(train);
  const schemes = {
    'hiện tại (engine)': baseline,
    'trung vị các phương pháp': median,
    'IC học (ô archetype)': composite(weightFn(model, 'ic', false)),
    'IC học, co về chung': composite(weightFn(model, 'ic', true)),
    'chỉ PP có ý nghĩa': composite(weightFn(model, 'sig', true)),
  };
  schemes['50% hiện tại + 50% IC co'] = (x) => { const a = baseline(x), b = schemes['IC học, co về chung'](x); return a === null || b === null ? a : (a + b) / 2; };
  console.log(`\n=== tách tại ${split} | ${H} | huấn luyện ${train.length} / kiểm tra ${test.length} quan sát`);
  for (const [name, fn] of Object.entries(schemes)) { const a = ic(train, fn), b = ic(test, fn); console.log(name.padEnd(28), 'train', JSON.stringify(a), '| TEST', JSON.stringify(b)); }
  if (split === '2023-12-31') {
    const top = Object.entries(model.overall).filter(([, v]) => v.ic !== undefined).sort((a, b) => b[1].ic - a[1].ic).map(([k, v]) => `${k}:${v.ic}`).join(' ');
    console.log('IC chung từng PP (train):', top);
  }
}
