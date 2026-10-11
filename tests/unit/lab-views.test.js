// Giao diện Phòng kiểm thử (lab/lab-views.js, lab-factor-views.js): chỉ dựng chuỗi HTML từ kết quả đã tính. Chạy bộ máy thật trên thị trường tổng hợp rồi kiểm: thanh dữ liệu, biểu mẫu, bảng kết quả,
// phán quyết trung thực (không hứa hẹn), thoát HTML, trạng thái lỗi / đang chạy / rỗng của cả hai tab.
import { describe, it, expect, beforeAll } from 'vitest';
import LV from '../../lab/lab-views.js';
import LF from '../../lab/lab-factor-views.js';
import SB from '../../lib/strategy-backtest.js';
import BtPanel from '../../lib/bt-panel.js';
const { makeRows, indexRow } = require('../helpers/bt-fixtures.js');

let P, result, spec;
beforeAll(async () => {
  const stocks = {}, drifts = [0.003, 0.002, 0.001, 0.0005, 0, -0.001, -0.002, -0.003];
  drifts.forEach((d, k) => { stocks['S' + (k + 1)] = { ret: (t) => d + 0.006 * Math.sin(t * 1.7 + k) + 0.004 * Math.cos(t * 0.37 * (k + 1)), p0: 20 + k, val: 20000 }; });
  const { rows, dates } = makeRows(700, stocks);
  P = BtPanel.build(rows, [indexRow('VNINDEX', dates, (t) => 0.0004 + 0.004 * Math.sin(t * 0.9))]);
  spec = SB.normalizeSpec({ name: 'Thử <b>nghiệm</b>', universe: { minAdv: 0, minHistory: 60, exchanges: ['HOSE'] }, rank: [{ key: 'mom3', dir: 'high', w: 1 }], select: { n: 3 }, maxWeight: 0.5, rebalance: 'M', costs: { fee: 0.0015, tax: 0.001, impact: false } }).spec;
  result = await SB.run(P, spec, { pit: [], randomRuns: 20 });
});

const state = (over) => Object.assign({ view: 'backtest', data: { state: 'ready', summary: BtPanel.summary(P), pit: { n: 0 }, downloaded: 700, fromCache: 0, memoryMb: 50 }, draft: spec, preset: 'momentum', errors: [], specWarnings: [], running: false, progress: '', result: null, logScale: false, saving: false, runs: { state: 'ok', list: [] }, trials: { count: 0, srVarDaily: null } }, over || {});

describe('Phòng kiểm thử: tab Kiểm thử', () => {
  it('chạy được trên thị trường tổng hợp và có kết quả đủ trường', () => {
    expect(result.ok).toBe(true); expect(result.metrics.cagr).toBeTypeOf('number'); expect(result.random).toBeTruthy(); expect(result.bench.cagr).toBeTypeOf('number');
  });
  it('thanh dữ liệu: số phiên, số mã, ngày cuối; chưa tải xong thì hiện tiến độ', () => {
    const ready = LV.dataBarHtml(state());
    expect(ready).toContain('700'); expect(ready).toContain('bộ nhớ');
    const loading = LV.dataBarHtml(state({ data: { state: 'loading', progress: { frac: 0.4, text: 'Đã tải 120/700 ngày mới…' } } }));
    expect(loading).toContain('Đã tải 120/700'); expect(loading).toContain('40%');
  });
  it('biểu mẫu: có các bước 1-6, nút chạy, danh sách mẫu; tên cấu hình độc hại bị thoát', () => {
    const h = LV.builderHtml(state());
    ['Vũ trụ và giai đoạn', 'Bộ lọc', 'Xếp hạng', 'Chọn mã và chia tỷ trọng', 'Cân bằng và khớp lệnh', 'Chi phí và vốn', 'Chạy kiểm thử'].forEach((t) => expect(h).toContain(t));
    expect(h).not.toContain('<b>nghiệm</b>'); expect(h).toContain('Động lượng 12-1');
    expect(LV.builderHtml(state({ errors: ['Thiếu tiêu chí <script>'] }))).not.toContain('<script>');
    expect(LV.builderHtml(state({ running: true, progress: 'Chạy rổ ngẫu nhiên…' }))).toContain('disabled');
  });
  it('kết quả: các chỉ số, so với VN-Index, phần "Có đáng tin không?" và phán quyết không hứa hẹn', () => {
    const h = LV.resultHtml(state({ result }));
    expect(h).toContain('Có đáng tin không?'); expect(h).toContain('VN-Index'); expect(h).toContain('rổ ngẫu nhiên'); expect(h).toContain('Sụt giảm');
    expect(h).not.toMatch(/chắc chắn sinh lời|đảm bảo lợi nhuận/i);
    const v = LV.verdict(result); expect(v).toBeTruthy(); expect(JSON.stringify(v)).not.toContain('NaN');
  });
  it('tên chiến lược trong kết quả được thoát HTML', () => {
    expect(LV.resultHtml(state({ result }))).not.toContain('<b>nghiệm</b>');
  });
  it('chưa chạy thì rỗng; đang chạy thì có tiến độ; lỗi thì liệt kê từng lỗi đã thoát', () => {
    expect(LV.resultHtml(state())).toBe('');
    expect(LV.resultHtml(state({ running: true, progress: 'Chọn mã theo từng kỳ…' }))).toContain('Chọn mã theo từng kỳ');
    const h = LV.resultHtml(state({ result: { ok: false, errors: ['Không có mã nào <i>thoả</i>'] } }));
    expect(h).toContain('Không chạy được'); expect(h).not.toContain('<i>thoả</i>');
  });
  it('các lần đã lưu: rỗng thì nói rõ; có thì hiện tên đã thoát và số cấu hình đã thử', () => {
    expect(LV.runsHtml(state())).toContain('Chưa lưu lần kiểm thử nào');
    const h = LV.runsHtml(state({ runs: { state: 'ok', list: [{ id: 'r1', name: 'Mẫu <u>x</u>', created_at: '2026-10-10T00:00:00Z', data_through: '2026-10-09', brief: { cagr: 0.1, sharpe: 0.5, maxDD: -0.3, excess: 0.02 } }] }, trials: { count: 7, srVarDaily: 0.0001 } }));
    expect(h).not.toContain('<u>x</u>'); expect(h).toContain('7');
  });
  it('chuyển đổi hiển thị: tỷ lệ lưu dạng phân số hiện dạng %, rỗng thành null', () => {
    // roae lưu dạng phân số (0,15 = 15%); marketcap lưu bằng đồng, nhập bằng tỷ đồng; pe không đổi đơn vị
    expect(LV.toDisplay('roae', 0.15)).toBe('15'); expect(LV.fromDisplay('roae', '15')).toBeCloseTo(0.15, 12); expect(LV.fromDisplay('roae', ' 12,5 ')).toBeCloseTo(0.125, 12);
    expect(LV.toDisplay('marketcap', 2e9)).toBe('2'); expect(LV.fromDisplay('marketcap', '2')).toBe(2e9);
    expect(LV.toDisplay('pe', 12)).toBe('12'); expect(LV.fromDisplay('pe', '12')).toBe(12);
    expect(LV.fromDisplay('pe', '')).toBeNull(); expect(LV.fromDisplay('pe', 'abc')).toBeNull(); expect(LV.toDisplay('pe', null)).toBe('');
  });
});

describe('Phòng kiểm thử: tab Yếu tố', () => {
  const fac = (over) => Object.assign({ state: 'idle', res: null, error: '', subject: 'mine', window: 504, custom: '' }, over || {});
  const L = (f) => ({ data: { state: 'ready', summary: BtPanel.summary(P), pit: { n: 0 }, memoryMb: 1 }, fac: f });
  it('điều khiển: ba đối tượng, ba cửa sổ; mã tự chọn thì có ô nhập đã thoát', () => {
    const h = LF.factorsHtml(L(fac()));
    Object.values(LF.SUBJECTS).forEach((t) => expect(h).toContain(t)); Object.values(LF.WINDOWS).forEach((t) => expect(h).toContain(t));
    const c = LF.factorsHtml(L(fac({ subject: 'custom', custom: 'FPT" onfocus="x' })));
    expect(c).toContain('lab-fac-custom'); expect(c).not.toContain('onfocus="x');
  });
  it('lỗi, đang chạy, không phân tích được đều có thông điệp rõ và thoát HTML', () => {
    expect(LF.resultHtml(fac({ state: 'running', progress: 'Dựng lợi suất các yếu tố…' }))).toContain('Dựng lợi suất');
    const e = LF.resultHtml(fac({ state: 'error', error: 'Nhập ít nhất một mã <b>x</b>' }));
    expect(e).toContain('Không phân tích được'); expect(e).not.toContain('<b>x</b>');
    expect(LF.resultHtml(fac({ res: { ok: false, reason: 'Mẫu quá ngắn <i>x</i>' } }))).not.toContain('<i>x</i>');
    expect(LF.resultHtml(fac())).toBe('');
  });
});
