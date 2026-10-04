import { describe, it, expect, beforeEach } from 'vitest';
import SectorMap from '../../lib/sector-map.js';
import FinCalc from '../../lib/finance-calc.js';
import Brinson from '../../lib/brinson-calc.js';

describe('SectorMap', () => {
  it('đổi mã ICB cấp 2 sang ngành nội bộ; mã lạ hoặc rỗng -> Chưa phân ngành', () => {
    expect(SectorMap.sectorFromIcb2('8300')).toBe('Ngân hàng');
    expect(SectorMap.sectorFromIcb2(9500)).toBe('Công nghệ');
    expect(SectorMap.sectorFromIcb2('830')).toBe('Chưa phân ngành');       // 0830 không phải ICB
    expect(SectorMap.sectorFromIcb2('')).toBe('Chưa phân ngành');
    expect(SectorMap.sectorFromIcb2(null)).toBe('Chưa phân ngành');
    expect(SectorMap.icbName('8600')).toBe('Bất động sản');
    expect(SectorMap.fromIcb2('0500')).toEqual({ code: '0500', name: 'Dầu khí', sector: 'Dầu khí & năng lượng' });
  });
  it('mọi ngành nội bộ sinh ra từ ICB đều có chỉ số ngành hoặc là ngành chưa có chỉ số riêng (Brinson)', () => {
    const all = new Set(Brinson.allSectors());
    Object.keys(SectorMap.ICB2).forEach(code => expect(all.has(SectorMap.ICB2[code].sector), code).toBe(true));
  });
  it('buildMap bỏ dòng không nhận ra ICB; coverage đếm mã chưa có ngành', () => {
    const m = SectorMap.buildMap([{ symbol: 'abc', icb2_code: '8300' }, { symbol: 'XYZ', icb2_code: null }, { symbol: 'KLM', icb2_code: '1234' }, { symbol: '', icb2_code: '8300' }]);
    expect(m).toEqual({ ABC: 'Ngân hàng' });
    const cov = SectorMap.coverage(['abc', 'XYZ', 'abc'], (s) => (s === 'ABC' ? 'Ngân hàng' : 'Chưa phân ngành'));
    expect(cov).toEqual({ total: 2, known: 1, unknown: ['XYZ'] });
  });
});

describe('FinCalc: ngành động theo ICB', () => {
  beforeEach(() => FinCalc.registerSectors({}));
  it('mã ngoài bảng tự gõ lấy ngành ICB; bảng tự gõ luôn ưu tiên; nguồn được ghi nhận', () => {
    expect(FinCalc.sectorOf('ZZZ')).toBe('Chưa phân ngành');
    expect(FinCalc.sectorSource('ZZZ')).toBe('unknown');
    expect(FinCalc.registerSectors({ zzz: 'Viễn thông', FPT: 'Ngân hàng' })).toBe(2);
    expect(FinCalc.sectorOf('ZZZ')).toBe('Viễn thông');
    expect(FinCalc.sectorSource('zzz')).toBe('icb');
    expect(FinCalc.sectorOf('FPT')).toBe('Công nghệ');                      // tự gõ thắng ICB
    expect(FinCalc.sectorSource('FPT')).toBe('manual');
  });
  it('registerSectors thay toàn bộ bản đăng ký cũ', () => {
    FinCalc.registerSectors({ QQQ: 'Bán lẻ' });
    FinCalc.registerSectors({ BBB: 'Bảo hiểm' });
    expect(FinCalc.sectorOf('QQQ')).toBe('Chưa phân ngành');
    expect(FinCalc.sectorOf('BBB')).toBe('Bảo hiểm');
  });
  it('phân bổ ngành dùng ngành ICB cho mã ngoài bảng', () => {
    FinCalc.registerSectors({ ZZZ: 'Viễn thông' });
    const a = FinCalc.sectorAllocation([{ symbol: 'ZZZ', marketValue: 300 }, { symbol: 'VCB', marketValue: 700 }]);
    expect(a.map(x => [x.sector, x.pct])).toEqual([['Ngân hàng', 70], ['Viễn thông', 30]]);
  });
});
