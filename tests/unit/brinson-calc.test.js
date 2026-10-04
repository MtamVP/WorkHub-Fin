// lib/brinson-calc.js: phân tích Brinson-Fachler (phân bổ / chọn mã / tương tác) theo danh mục chuẩn chiến lược. Số tính tay trong ghi chú.
import { describe, it, expect } from 'vitest';
import B from '../../lib/brinson-calc.js';

const att = (over = {}) => Object.assign({
  base: 1000, hasBench: true, from: '2026-01-01', to: '2026-06-30',
  sectors: [{ sector: 'Ngân hàng', pnl: 40, avgMv: 400 }, { sector: 'Công nghệ', pnl: -15, avgMv: 300 }],
  totals: { contributionPct: 2.5 },
}, over);
const ret = { 'Ngân hàng': { index: 'VNFIN', returnPct: 8 }, 'Công nghệ': { index: 'VNIT', returnPct: -2 }, 'Bất động sản': { index: 'VNREAL', returnPct: 4 } };
const policy = { 'Ngân hàng': 30, 'Công nghệ': 30, 'Bất động sản': 20 };         // tiền mặt chuẩn 20%

describe('sectorReturns / indexFor', () => {
  it('ánh xạ ngành -> chỉ số HOSE; ngành lạ dùng VN-Index', () => {
    expect(B.indexFor('Ngân hàng')).toBe('VNFIN');
    expect(B.indexFor('Chứng khoán')).toBe('VNFIN');
    expect(B.indexFor('Thép & vật liệu')).toBe('VNMAT');
    expect(B.indexFor('Chưa phân ngành')).toBe('VNINDEX');
    expect(B.SECTOR_INDEX_CODES.sort()).toEqual(['VNCOND', 'VNCONS', 'VNENE', 'VNFIN', 'VNHEAL', 'VNIND', 'VNIT', 'VNMAT', 'VNREAL', 'VNUTI']);
  });
  it('mọi ngành nội bộ đều có chỉ số', () => {
    expect(B.allSectors()).toHaveLength(16);
    B.allSectors().forEach((s) => expect(B.SECTOR_INDEX[s]).toBeTruthy());
  });
  it('lợi suất giá của chỉ số giữa hai mốc, dùng điểm gần nhất tại hoặc trước mốc', () => {
    const histories = { VNFIN: [['2026-01-01', 1000], ['2026-03-31', 1050], ['2026-06-30', 1080]], VNIT: [['2026-01-02', 2000]] };
    const r = B.sectorReturns(histories, ['Ngân hàng', 'Chứng khoán', 'Công nghệ', 'Bán lẻ'], '2026-01-01', '2026-06-30');
    expect(r['Ngân hàng'].index).toBe('VNFIN');
    expect(r['Ngân hàng'].returnPct).toBeCloseTo(8, 9);
    expect(r['Chứng khoán'].returnPct).toBeCloseTo(8, 9);
    expect(r['Công nghệ'].returnPct).toBeNull();                 // chỉ có 1 điểm sau mốc đầu -> thiếu mốc đầu
    expect(r['Bán lẻ']).toEqual({ index: 'VNCOND', returnPct: null });
  });
});

describe('validatePolicy', () => {
  it('hợp lệ: bỏ ngành 0%, phần còn lại là tiền mặt', () => {
    const v = B.validatePolicy({ 'Ngân hàng': 30, 'Công nghệ': 0, 'Bất động sản': '20' });
    expect(v).toMatchObject({ ok: true, sum: 50, cashPct: 50, weights: { 'Ngân hàng': 30, 'Bất động sản': 20 } });
  });
  it('từ chối: vượt 100%, số sai, ngành lạ', () => {
    expect(B.validatePolicy({ 'Ngân hàng': 60, 'Công nghệ': 50 }).error).toMatch(/vượt 100%/);
    expect(B.validatePolicy({ 'Ngân hàng': -1 }).ok).toBe(false);
    expect(B.validatePolicy({ 'Ngân hàng': 'abc' }).ok).toBe(false);
    expect(B.validatePolicy({ 'Ngành tự chế': 10 }).error).toMatch(/không hợp lệ/);
  });
});

describe('analyze (ví dụ tính tay)', () => {
  // Thực: Ngân hàng 40% (lợi suất 10%), Công nghệ 30% (−5%), tiền 30%  => Rp = 2,5%
  // Chuẩn: NH 30% (8%), CN 30% (−2%), BĐS 20% (4%), tiền 20%            => Rb = 2,6%
  const r = B.analyze({ attribution: att(), policy, returns: ret });
  const row = (n) => r.rows.find((x) => x.sector === n);
  it('lợi suất danh mục và chuẩn', () => {
    expect(r.ok).toBe(true);
    expect(r.portfolioPct).toBeCloseTo(2.5, 9);
    expect(r.benchmarkPct).toBeCloseTo(2.6, 9);
    expect(r.activePct).toBeCloseTo(-0.1, 9);
    expect(r.cashActualPct).toBeCloseTo(30, 9);
    expect(r.cashPolicyPct).toBeCloseTo(20, 9);
  });
  it('phân bổ / chọn mã / tương tác từng ngành', () => {
    expect(row('Ngân hàng').allocation).toBeCloseTo(0.54, 9);
    expect(row('Ngân hàng').selection).toBeCloseTo(0.6, 9);
    expect(row('Ngân hàng').interaction).toBeCloseTo(0.2, 9);
    expect(row('Công nghệ').allocation).toBeCloseTo(0, 9);
    expect(row('Công nghệ').selection).toBeCloseTo(-0.9, 9);
    expect(row('Bất động sản').allocation).toBeCloseTo(-0.28, 9);          // không giữ: chỉ có phần phân bổ
    expect(row('Bất động sản').selection).toBe(0);
    expect(row(B.CASH).allocation).toBeCloseTo(-0.26, 9);
  });
  it('tổng ba phần = lợi suất danh mục − chuẩn (đẳng thức Brinson)', () => {
    expect(r.allocation + r.selection + r.interaction).toBeCloseTo(r.activePct, 9);
    expect(r.gap).toBeCloseTo(0, 9);
    expect(r.allocation).toBeCloseTo(0.54 - 0.28 - 0.26, 9);
    expect(r.selection).toBeCloseTo(0.6 - 0.9, 9);
    expect(r.interaction).toBeCloseTo(0.2, 9);
    r.rows.forEach((x) => expect(x.total).toBeCloseTo(x.allocation + x.selection + x.interaction, 12));
  });
  it('đóng góp của ngành khớp bảng Nguồn gốc lợi nhuận (tỷ trọng × lợi suất = lãi/lỗ ÷ base)', () => {
    expect(row('Ngân hàng').wp * row('Ngân hàng').rp).toBeCloseTo(40 / 1000, 12);
    expect(row('Công nghệ').wp * row('Công nghệ').rp).toBeCloseTo(-15 / 1000, 12);
  });
  it('nhận xét tự động nêu điểm mạnh yếu', () => {
    const t = r.notes.join('\n');
    expect(t).toMatch(/kém chuẩn chiến lược 0,1 điểm/);
    expect(t).toMatch(/Chọn mã kém nhất: Công nghệ/);
    expect(t).toMatch(/Chọn mã tốt nhất: Ngân hàng/);
    expect(t).toMatch(/Phân bổ kém nhất: Bất động sản/);
    expect(t).toMatch(/tiền mặt 30% so với chuẩn 20%/);
  });
  it('đẳng thức vẫn đúng với bộ số bất kỳ (kể cả đòn bẩy: tiền mặt âm)', () => {
    const a = att({ base: 500, sectors: [{ sector: 'Ngân hàng', pnl: 30, avgMv: 400 }, { sector: 'Bất động sản', pnl: -20, avgMv: 300 }, { sector: 'Công nghệ', pnl: 5, avgMv: 100 }] });
    const x = B.analyze({ attribution: a, policy: { 'Ngân hàng': 25, 'Bất động sản': 25, 'Công nghệ': 10, 'Dệt may': 15 }, returns: { ...ret, 'Dệt may': { index: 'VNCOND', returnPct: 12 } } });
    expect(x.cashActualPct).toBeLessThan(0);
    expect(x.allocation + x.selection + x.interaction).toBeCloseTo(x.activePct, 9);
    expect(x.gap).toBeCloseTo(0, 9);
  });
});

describe('thiếu dữ liệu', () => {
  it('thiếu chỉ số ngành: không có phần chọn mã cho ngành đó, báo mã chỉ số thiếu, đẳng thức vẫn đúng', () => {
    const x = B.analyze({ attribution: att(), policy, returns: { ...ret, 'Công nghệ': { index: 'VNIT', returnPct: null } } });
    const cn = x.rows.find((q) => q.sector === 'Công nghệ');
    expect(cn.noIndex).toBe(true);
    expect(cn.selection).toBe(0);
    expect(x.missingIndex).toEqual(['VNIT']);
    expect(x.gap).toBeCloseTo(0, 9);
    expect(x.notes.join(' ')).toMatch(/Thiếu dữ liệu chỉ số VNIT/);
  });
  it('lý do không tính được', () => {
    expect(B.analyze({ attribution: att({ base: null }), policy, returns: ret }).reason).toBe('noBase');
    expect(B.analyze({ attribution: att({ hasBench: false }), policy, returns: ret }).reason).toBe('noBench');
    expect(B.analyze({ attribution: att(), policy: {}, returns: ret }).reason).toBe('noPolicy');
    expect(B.analyze({ attribution: att(), policy: { 'Ngân hàng': 150 }, returns: ret }).reason).toBe('badPolicy');
    expect(B.analyze({}).ok).toBe(false);
    expect(B.analyze().ok).toBe(false);
  });
  it('ngành có lãi/lỗ nhưng vốn bình quân ~ 0 đi vào phần dư, không làm sai tỷ trọng', () => {
    const x = B.analyze({ attribution: att({ sectors: [{ sector: 'Ngân hàng', pnl: 40, avgMv: 400 }, { sector: 'Công nghệ', pnl: 6, avgMv: 0 }] }), policy, returns: ret });
    expect(x.residualPct).toBeCloseTo(0.6, 9);
    expect(x.rows.find((q) => q.sector === 'Công nghệ').wp).toBe(0);
  });
  it('mã chưa phân ngành đứng riêng và dùng VN-Index', () => {
    const x = B.analyze({ attribution: att({ sectors: [{ sector: 'Chưa phân ngành', pnl: 10, avgMv: 100 }] }), policy: { 'Chưa phân ngành': 20 }, returns: { 'Chưa phân ngành': { index: 'VNINDEX', returnPct: 5 } } });
    expect(x.ok).toBe(true);
    expect(x.rows.find((q) => q.sector === 'Chưa phân ngành').index).toBe('VNINDEX');
  });
});
