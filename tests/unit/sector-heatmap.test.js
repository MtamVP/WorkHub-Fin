import { describe, it, expect } from 'vitest';
import SH from '../../lib/sector-heatmap.js';
import MS from '../../lib/market-screener.js';

const row = (symbol, icb, cap, chg1m, pe, extra) => ({ symbol, icb2_code: icb, m: Object.assign({ marketcap: cap * 1e9, chg1m: chg1m, pe: pe }, extra || {}) });
const ROWS = [
  row('VCB', '8300', 500000, 0.06, 15), row('BID', '8300', 300000, 0.02, 12), row('NHN', '8300', 500, 0.5, 7),
  row('FPT', '9500', 200000, -0.04, 20), row('CMG', '9500', 10000, -0.08, 30),
  row('HPG', '1700', 150000, 0.00, 14), row('HSG', '1700', 8000, 0.10, null), row('NOV', '1700', 3000, null, 9),
  row('XXX', null, 700, 0.01, 5), row('ZERO', '4500', 0, 0.2, 5),
];
const NAMES = { '8300': 'Ngân hàng', '9500': 'Công nghệ', '1700': 'Tài nguyên cơ bản' };

describe('SectorHeatmap.aggregate / build', () => {
  it('bình quân gia quyền theo vốn hoá chỉ trên mã có số liệu kỳ; trung vị; tỷ lệ mã tăng; độ phủ', () => {
    const a = SH.aggregate(ROWS.filter((r) => r.icb2_code === '1700'), 'chg1m');
    expect(a.nCap).toBe(3); expect(a.nHave).toBe(2);
    expect(a.chg).toBeCloseTo((150000 * 0 + 8000 * 0.10) / 158000, 10);
    expect(a.median).toBeCloseTo(0.05, 10); expect(a.up).toBe(0.5);
    expect(a.cover).toBeCloseTo(158000 / 161000, 10);
  });
  it('build: sắp theo vốn hoá giảm dần, bỏ ngành vốn hoá 0, đặt tên, so với thị trường', () => {
    const b = SH.build(ROWS, 'chg1m', { names: NAMES });
    expect(b.sectors.map((s) => s.name)).toEqual(['Ngân hàng', 'Công nghệ', 'Tài nguyên cơ bản', 'Chưa phân ngành']);
    expect(b.sectors.find((s) => s.code === '4500')).toBeUndefined();
    const bank = b.sectors[0];
    expect(bank.chg).toBeCloseTo((500000 * 0.06 + 300000 * 0.02 + 500 * 0.5) / 800500, 10);
    expect(bank.rel).toBeCloseTo(bank.chg - b.market.chg, 10);
    expect(bank.biggest.map((x) => x.symbol)).toEqual(['VCB', 'BID', 'NHN']);
    expect(bank.best).toEqual({ symbol: 'VCB', chg: 0.06 });          // chỉ xét mã từ 1.000 tỷ: NHN (500 tỷ) tăng 50% không được xếp dẫn đầu
    expect(bank.worst).toEqual({ symbol: 'BID', chg: 0.02 });
    expect(b.empty).toBe(false);
  });
  it('kỳ chưa có số liệu (ví dụ ảnh chụp cũ chưa có chgYtd): ngành không đủ độ phủ và bản đồ báo rỗng', () => {
    const b = SH.build(ROWS, 'chgYtd', { names: NAMES });
    expect(b.empty).toBe(true); expect(b.sectors.every((s) => !s.ok && s.chg === null)).toBe(true); expect(b.market.chg).toBeNull();
  });
  it('ngành chỉ có vài mã nhỏ có số liệu (độ phủ vốn hoá dưới 50%) không được tô màu', () => {
    const rows = [row('A', '1', 1000, null, 5), row('B', '1', 10, 0.3, 5)];
    expect(SH.build(rows, 'chg1m').sectors[0].ok).toBe(false);
    expect(SH.build(rows, 'chg1m', { minCover: 0 }).sectors[0].ok).toBe(true);
  });
  it('chạy được với hàng dựng từ buildRows (dữ liệu thật dạng ảnh chụp)', () => {
    const snap = ROWS.map((r) => ({ symbol: r.symbol, icb2_code: r.icb2_code, metrics: r.m }));
    const rows = MS.buildRows(snap, {}, {});
    expect(SH.build(rows, 'chg1m').sectors.length).toBe(4);
  });
});

describe('SectorHeatmap.bucket / periodOf', () => {
  it('bậc màu theo biên độ của kỳ, kẹp trong [-3, 3]; thiếu số liệu là null', () => {
    expect(SH.bucket(0, 'chg1m')).toBe(0); expect(SH.bucket(0.08, 'chg1m')).toBe(3); expect(SH.bucket(0.5, 'chg1m')).toBe(3); expect(SH.bucket(-0.04, 'chg1m')).toBe(-2);
    expect(SH.bucket(0.08, 'chgYtd')).toBe(1); expect(SH.bucket(null, 'chg1m')).toBeNull(); expect(SH.bucket(undefined, 'chg1m')).toBeNull();
    expect(SH.periodOf('lạ').key).toBe('chg1m'); expect(SH.PERIODS.map((p) => p.key)).toEqual(['chg1m', 'chg3m', 'chg6m', 'chgYtd', 'chg1y']);
  });
});

describe('SectorHeatmap.treemap', () => {
  it('lấp đầy hình chữ nhật, diện tích tỷ lệ với giá trị, không chồng lấn, không vượt biên', () => {
    const items = [{ key: 'a', value: 50 }, { key: 'b', value: 30 }, { key: 'c', value: 12 }, { key: 'd', value: 5 }, { key: 'e', value: 3 }, { key: 'z', value: 0 }];
    const r = SH.treemap(items, 100, 56);
    expect(r.map((x) => x.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const sum = r.reduce((s, x) => s + x.w * x.h, 0); expect(sum).toBeCloseTo(100 * 56, 6);
    r.forEach((x) => { expect(x.x).toBeGreaterThanOrEqual(-1e-9); expect(x.y).toBeGreaterThanOrEqual(-1e-9); expect(x.x + x.w).toBeLessThanOrEqual(100 + 1e-9); expect(x.y + x.h).toBeLessThanOrEqual(56 + 1e-9); });
    expect(r[0].w * r[0].h / (100 * 56)).toBeCloseTo(0.5, 6); expect(r[1].w * r[1].h / (100 * 56)).toBeCloseTo(0.3, 6);
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
      const a = r[i], b = r[j], ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      expect(ox > 1e-6 && oy > 1e-6).toBe(false);
    }
  });
  it('ít hơn mức tối thiểu: rỗng, một phần tử choán hết, nhiều phần tử (30 ngành) vẫn lấp đầy', () => {
    expect(SH.treemap([], 100, 56)).toEqual([]); expect(SH.treemap([{ key: 'a', value: 1 }], 0, 56)).toEqual([]);
    const one = SH.treemap([{ key: 'a', value: 7 }], 100, 56); expect(one[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 56 });
    const many = SH.treemap(Array.from({ length: 30 }, (_, i) => ({ key: 'k' + i, value: 1 + (i * 37) % 11 })), 100, 56);
    expect(many).toHaveLength(30); expect(many.reduce((s, x) => s + x.w * x.h, 0)).toBeCloseTo(5600, 6);
    expect(Math.min.apply(null, many.map((x) => Math.min(x.w, x.h)))).toBeGreaterThan(1);       // không có ô quá mỏng
  });
});
