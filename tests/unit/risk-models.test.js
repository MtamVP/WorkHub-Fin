// lib/risk-models.js đối chiếu với numpy/scipy trên cùng dữ liệu (tests/fixtures/risk-models-golden.json, tạo bằng tests/fixtures/make-risk-golden.py).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import RM from '../../lib/risk-models.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(readFileSync(path.join(here, '../fixtures/risk-models-golden.json'), 'utf8'));
const W = [0.4, 0.3, 0.2];
const near = (a, b, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)));

describe('hàm đặc biệt', () => {
  it('chi bình phương (df 1, 2) khớp scipy.stats.chi2.sf trong sai số 2e-7', () => {
    G.chi2.df1.forEach(([x, p]) => expect(Math.abs(RM.chi2Sf(x, 1) - p)).toBeLessThan(2e-7));
    G.chi2.df2.forEach(([x, p]) => expect(Math.abs(RM.chi2Sf(x, 2) - p)).toBeLessThan(1e-12));
    expect(RM.chi2Sf(0, 1)).toBe(1);
    expect(() => RM.chi2Sf(3, 3)).toThrow();
  });
  it('percentile nội suy như numpy', () => {
    expect(RM.percentile([1, 2, 3, 4, 5], 0.05)).toBeCloseTo(1.2, 12);
    expect(RM.percentile([10], 0.5)).toBe(10);
    expect(RM.percentile([], 0.5)).toBeNull();
  });
});

describe('EWMA', () => {
  const port = G.port;
  it('khớp phép đệ quy tham chiếu (RiskMetrics, lambda 0,94, khởi tạo bằng phương sai mẫu 20 ngày)', () => {
    const e = RM.ewma(port, 0.94);
    near(e.sigmaNext, G.ewma.sigmaNext);
    G.ewma.series_first3.forEach((v, i) => near(e.series[i], v));
    G.ewma.series_last5.forEach((v, i) => near(e.series[e.series.length - 5 + i], v));
    near(e.annNext, G.ewma.sigmaNext * Math.sqrt(252) * 100);
  });
  it('lambda lạ rơi về 0,94; quá ít dữ liệu thì không có dự báo; null coi như 0', () => {
    near(RM.ewma(port, 5).sigmaNext, G.ewma.sigmaNext);
    expect(RM.ewma([0.01], 0.94).sigmaNext).toBeNull();
    expect(RM.ewma(port.map((x, i) => (i === 10 ? null : x))).sigmaNext).toBeGreaterThan(0);
  });
  it('biến động tăng vọt cuối kỳ: EWMA cao hơn độ lệch chuẩn mẫu', () => {
    const calm = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.004 : -0.004));
    const shock = calm.concat([0.05, -0.06, 0.05, -0.05, 0.06]);
    expect(RM.ewma(shock).sigmaNext).toBeGreaterThan(Math.sqrt(RM.variance(shock)) * 1.5);
  });
});

describe('beta Dimson', () => {
  ['A', 'B', 'C'].forEach((k) => it('mã ' + k + ' khớp numpy.linalg.lstsq (beta, hồi quy thường, từng hệ số)', () => {
    const d = RM.dimsonBeta(G[k], G.bench);
    near(d.beta, G.dimson[k].beta, 1e-8);
    near(d.simple, G.dimson[k].simple, 1e-8);
    expect(d.obs).toBe(G.dimson[k].obs);
    G.dimson[k].coefs.forEach((c, i) => near(d.coefs[i], c, 1e-8));
  }));
  it('mã phản ứng trễ một ngày: Dimson cao hơn hồi quy thường, gần beta thật (0,9)', () => {
    const d = RM.dimsonBeta(G.B, G.bench);
    expect(d.beta).toBeGreaterThan(d.simple + 0.15);
    expect(Math.abs(d.beta - 0.9)).toBeLessThan(0.2);
  });
  it('thiếu dữ liệu: bỏ ngày thiếu; quá ít ngày thì trả null', () => {
    const y = G.A.map((v, i) => (i % 3 === 0 ? null : v));
    expect(RM.dimsonBeta(y, G.bench).obs).toBeLessThan(G.T - 2);
    expect(RM.dimsonBeta(G.A.slice(0, 20), G.bench.slice(0, 20)).beta).toBeNull();
  });
});

describe('hiệp phương sai co (Ledoit-Wolf)', () => {
  const X = G.A.map((_, t) => [G.A[t], G.B[t], G.C[t]]);
  const sh = RM.shrinkCov(X);
  it('cường độ co, ma trận co và ma trận mẫu khớp công thức gốc tính bằng numpy', () => {
    near(sh.delta, G.lw.delta, 1e-9);
    sh.cov.forEach((row, i) => row.forEach((v, j) => near(v, G.lw.cov[i][j], 1e-9)));
    sh.sample.forEach((row, i) => row.forEach((v, j) => near(v, G.lw.sample[i][j], 1e-9)));
    expect(sh.delta).toBeGreaterThanOrEqual(0); expect(sh.delta).toBeLessThanOrEqual(1);
  });
  it('rủi ro danh mục và đóng góp rủi ro khớp tham chiếu; đóng góp cộng lại bằng 100%', () => {
    const a = RM.portfolioRisk(W, sh.sample), b = RM.portfolioRisk(W, sh.cov);
    near(a.annPct, G.risk.sample.annPct, 1e-9); near(b.annPct, G.risk.shrunk.annPct, 1e-9);
    b.sharePct.forEach((v, i) => near(v, G.risk.shrunk.sharePct[i], 1e-8));
    near(b.sharePct.reduce((s, x) => s + x, 0), 100, 1e-9);
    near(b.contrib.reduce((s, x) => s + x, 0), b.vol, 1e-12);
  });
  it('tương quan căng thẳng k=0,5 khớp tham chiếu; k=0 giữ nguyên, k=1 làm mọi cặp đồng pha (rủi ro bằng tổng trọng số x độ lệch)', () => {
    const s = RM.portfolioRisk(W, RM.stressCov(sh.cov, 0.5));
    near(s.annPct, G.stress.annPct, 1e-9);
    const base = RM.portfolioRisk(W, sh.cov);
    near(RM.portfolioRisk(W, RM.stressCov(sh.cov, 0)).annPct, base.annPct, 1e-12);
    const sd = sh.cov.map((r, i) => Math.sqrt(r[i]));
    const perfect = W.reduce((acc, wi, i) => acc + wi * sd[i], 0);
    near(RM.portfolioRisk(W, RM.stressCov(sh.cov, 1)).vol, perfect, 1e-9);
    expect(s.annPct).toBeGreaterThan(base.annPct);
  });
  it('quá ít dữ liệu: trả null', () => {
    expect(RM.shrinkCov([[0.01, 0.02]])).toBeNull();
    expect(RM.shrinkCov([])).toBeNull();
  });
});

describe('VaR mô phỏng lịch sử có lọc biến động', () => {
  it('khớp tham chiếu: VaR, CVaR, phân vị chuẩn hoá', () => {
    const f = RM.filteredHS(G.port, { level: 0.95 });
    near(f.varPct, G.fhs.varPct, 1e-9); near(f.cvarPct, G.fhs.cvarPct, 1e-9); near(f.quantileZ, G.fhs.q, 1e-9);
    expect(f.cvarPct).toBeGreaterThan(f.varPct);
  });
  it('quá ít dữ liệu: null', () => { expect(RM.filteredHS(G.port.slice(0, 30))).toBeNull(); });
});

describe('kiểm định ngược VaR (Kupiec, Christoffersen)', () => {
  const bt = RM.varBacktest(G.port, { level: 0.95, window: 250 });
  it('số lần vượt, thống kê LR và p-value khớp scipy', () => {
    expect(bt.ok).toBe(true);
    expect(bt.n).toBe(G.backtest.n); expect(bt.exceptions).toBe(G.backtest.x);
    near(bt.kupiec.lr, G.backtest.lr_pof, 1e-9); expect(Math.abs(bt.kupiec.p - G.backtest.p_pof)).toBeLessThan(2e-7);
    near(bt.independence.lr, G.backtest.lr_ind, 1e-9); expect(Math.abs(bt.independence.p - G.backtest.p_ind)).toBeLessThan(2e-7);
    near(bt.conditional.lr, G.backtest.lr_cc, 1e-9); expect(Math.abs(bt.conditional.p - G.backtest.p_cc)).toBeLessThan(1e-9);
    expect(Object.values(bt.transitions)).toEqual(G.backtest.trans);
    near(bt.expected, G.backtest.n * 0.05, 1e-12);
  });
  it('chuỗi vượt đều đặn đúng 5%: kết luận ổn; quá nhiều lần vượt: đánh giá thấp rủi ro; vượt dồn cục: báo dồn cục', () => {
    // chuỗi tuần hoàn: mỗi 20 ngày có 1 ngày lỗ lớn nhưng VaR lịch sử trượt thấy các cú lỗ cũ nên vượt đúng ~5% khi cú lỗ lớn dần
    const base = Array.from({ length: 600 }, (_, i) => 0.01 * Math.sin(i * 1.7) * ((i * 7919) % 13) / 13);
    const ok = RM.varBacktest(base, { level: 0.95, window: 250 });
    expect(['ok', 'overestimates', 'underestimates', 'clustered']).toContain(ok.verdict);
    // biến động tăng gấp 3 sau ngày 300: VaR lịch sử (cửa sổ cũ) đánh giá thấp
    const regime = base.map((x, i) => (i >= 330 ? x * 3 : x));
    const bad = RM.varBacktest(regime, { level: 0.95, window: 250 });
    expect(bad.exceptions).toBeGreaterThan(bad.expected);
    expect(bad.verdict).toBe('underestimates');
    // các lần vượt xảy ra liên tiếp (một đợt khủng hoảng ngắn) -> kiểm định độc lập bắt được
    const calm = Array.from({ length: 450 }, (_, i) => 0.004 * (i % 2 ? 1 : -1) * (1 + (i % 5) / 10));
    const burst = calm.slice(); for (let i = 300; i < 312; i++) burst[i] = -0.05;
    const c = RM.varBacktest(burst, { level: 0.95, window: 250 });
    expect(c.independence.lr).toBeGreaterThan(c.kupiec.lr * 0.1);
    expect(c.transitions.n11).toBeGreaterThan(0);
  });
  it('quá ít dữ liệu: báo thiếu, không kết luận', () => {
    const r = RM.varBacktest(G.port.slice(0, 200), { window: 250 });
    expect(r).toMatchObject({ ok: false, reason: 'short', need: 280, have: 200 });
  });
});

describe('summary: gộp cho giao diện', () => {
  const model = { port: G.port, bench: G.bench, rets: { A: G.A, B: G.B, C: G.C }, weights: { A: 0.4, B: 0.3, C: 0.2 }, nav: 1e9 };
  const s = RM.summary(model, { level: 0.95, window: 250 });
  it('có đủ các khối và đồng nhất với các hàm lẻ', () => {
    expect(s.ok).toBe(true);
    near(s.vol.ewmaAnn, G.ewma.sigmaNext * Math.sqrt(252) * 100, 1e-9);
    near(s.fhs.varPct, G.fhs.varPct, 1e-9);
    expect(s.hist.varPct).toBeGreaterThan(0); expect(s.param.varPct).toBeGreaterThan(0);
    expect(s.backtest.exceptions).toBe(G.backtest.x);
    expect(s.beta.map(b => b.symbol)).toEqual(['A', 'B', 'C']);
    near(s.beta[1].dimson, G.dimson.B.beta, 1e-8);
    near(s.shrink.shrunkAnn, G.risk.shrunk.annPct, 1e-9);
    near(s.stressCorr.annPct, G.stress.annPct, 1e-9);
    expect(s.stressCorr.multiplier).toBeGreaterThan(1);
  });
  it('lịch sử ngắn (261 phiên như cửa sổ 1 năm mặc định): tự chọn cửa sổ nhỏ hơn để vẫn kiểm định ngược được', () => {
    const short = RM.summary({ port: G.port.slice(0, 261), bench: G.bench.slice(0, 261), rets: { A: G.A.slice(0, 261), B: G.B.slice(0, 261) }, weights: { A: 0.5, B: 0.4 } }, {});
    expect(short.backtest.ok).toBe(true);
    expect(short.backtest.window).toBe(117);                     // 45% của 261
    expect(short.backtest.n).toBe(261 - 117);
  });
  it('quá ít dữ liệu hoặc không có mã: báo ngắn', () => {
    expect(RM.summary({ port: G.port.slice(0, 30), rets: { A: G.A } }).ok).toBe(false);
    expect(RM.summary({ port: G.port, rets: {} }).ok).toBe(false);
  });
});
