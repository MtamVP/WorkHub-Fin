// lib/statement-import.js (đọc sao kê CSV/Excel, chuẩn hoá, chống trùng) + lib/xlsx-writer.js (ghi Excel).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import StatementImport from '../../lib/statement-import.js';
import XlsxWriter from '../../lib/xlsx-writer.js';

describe('parseNumber (số kiểu Việt Nam + quốc tế)', () => {
  it.each([
    ['1.234.567', 1234567], ['1,234,567', 1234567], ['1.234,56', 1234.56], ['1,234.56', 1234.56],
    ['25,5', 25.5], ['25.5', 25.5], ['25.500', 25500], ['1,234', 1234], ['(1.200)', -1200], ['-3.000', -3000],
    ['12,5%', 12.5], ['25 500', 25500], ['33.834 ₫', 33834], ['0', 0], [25500, 25500],
  ])('%s -> %s', (input, expected) => {
    expect(StatementImport.parseNumber(input)).toBe(expected);
  });
  it('chuỗi không phải số trả về null', () => {
    ['', 'abc', 'N/A', '--', null, undefined].forEach(v => expect(StatementImport.parseNumber(v)).toBeNull());
  });
});

describe('parseDate', () => {
  it.each([
    ['15/09/2026', '2026-09-15'], ['5/9/2026', '2026-09-05'], ['15-09-2026', '2026-09-15'], ['15.09.2026', '2026-09-15'],
    ['2026-09-15', '2026-09-15'], ['2026/09/15', '2026-09-15'], ['15/09/2026 09:15:30', '2026-09-15'], ['2026-09-15T09:15:00', '2026-09-15'],
    ['15/09/26', '2026-09-15'], [46280, '2026-09-15'],
  ])('%s -> %s', (input, expected) => {
    expect(StatementImport.parseDate(input)).toBe(expected);
  });
  it('ngày không tồn tại hoặc rác trả về null', () => {
    ['31/02/2026', '32/01/2026', 'hôm qua', '', 5, 999999].forEach(v => expect(StatementImport.parseDate(v)).toBeNull());
  });
});

describe('parseSide', () => {
  it('nhận Mua/Bán nhiều kiểu viết', () => {
    ['Mua', 'MUA', 'mua', 'Lệnh mua', 'B', 'Buy', 'M'].forEach(v => expect(StatementImport.parseSide(v)).toBe('buy'));
    ['Bán', 'BAN', 'S', 'Sell', 'Lệnh bán'].forEach(v => expect(StatementImport.parseSide(v)).toBe('sell'));
    expect(StatementImport.parseSide('Cổ tức tiền mặt')).toBe('dividend');
    expect(StatementImport.parseSide('Chuyển khoản')).toBe('other');
    expect(StatementImport.parseSide('')).toBeNull();
  });
});

describe('parseCsv', () => {
  it('nhận dấu phân cách , ; và tab, ô có ngoặc kép và dấu phẩy bên trong', () => {
    expect(StatementImport.parseCsv('a,b,c\r\n1,"x, y",3\r\n')).toEqual([['a', 'b', 'c'], ['1', 'x, y', '3']]);
    expect(StatementImport.parseCsv('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(StatementImport.parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(StatementImport.parseCsv('"a ""q"" b",c')).toEqual([['a "q" b', 'c']]);
  });
  it('bỏ BOM và dòng trống', () => {
    expect(StatementImport.parseCsv('﻿a,b\n\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('detectColumns', () => {
  it('nhận cột sao kê tiếng Việt, kể cả có dòng tiêu đề báo cáo phía trên', () => {
    const rows = [
      ['SAO KÊ GIAO DỊCH CHỨNG KHOÁN'], ['Khách hàng: Nguyễn Văn A'], [],
      ['Ngày GD', 'Mã CK', 'Loại lệnh', 'KL khớp', 'Giá khớp', 'Giá trị khớp', 'Phí GD', 'Thuế TNCN', 'Số hiệu lệnh'],
      ['15/09/2026', 'SSI', 'Mua', '1,000', '33,800', '33,800,000', '50,700', '0', 'A1'],
    ];
    const d = StatementImport.detectColumns(rows);
    expect(d.headerRow).toBe(3);
    expect(d.mapping).toMatchObject({ date: 0, symbol: 1, side: 2, quantity: 3, price: 4, value: 5, fee: 6, tax: 7, ref: 8 });
  });

  it('nhận cột tiếng Anh và tiêu đề không dấu', () => {
    const d = StatementImport.detectColumns([['Trade Date', 'Symbol', 'Side', 'Quantity', 'Price', 'Commission'], ['2026-09-15', 'VHM', 'Buy', '100', '74000', '111000']]);
    expect(d.mapping).toMatchObject({ date: 0, symbol: 1, side: 2, quantity: 3, price: 4, fee: 5 });
  });

  it('"Giá trị" không bị nhận nhầm thành "Giá"', () => {
    const d = StatementImport.detectColumns([['Ngày', 'Mã', 'Mua/Bán', 'Khối lượng', 'Giá trị', 'Giá']]);
    expect(d.mapping.price).toBe(5);
    expect(d.mapping.value).toBe(4);
  });

  it('không đủ cột bắt buộc thì không nhận', () => {
    expect(StatementImport.detectColumns([['Tên', 'Địa chỉ'], ['a', 'b']]).headerRow).toBe(-1);
  });
});

describe('normalizeRows', () => {
  const header = ['Ngày GD', 'Mã CK', 'Loại lệnh', 'KL', 'Giá', 'Phí', 'Thuế'];
  const run = (body, opts = {}) => {
    const rows = [header, ...body];
    const d = StatementImport.detectColumns(rows);
    return StatementImport.normalizeRows(rows, Object.assign({ headerRow: d.headerRow, mapping: d.mapping }, opts));
  };

  it('chuẩn hoá lệnh mua/bán, giữ phí & thuế trong file', () => {
    const r = run([['15/09/2026', 'ssi', 'Mua', '1.000', '33.800', '50.700', '0'], ['02/10/2026', 'SSI', 'Bán', '500', '35.200', '26.400', '17.600']]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ date: '2026-09-15', symbol: 'SSI', type: 'buy', quantity: 1000, price: 33800, fee: 50700, tax: 0, issues: [] });
    expect(r.rows[1]).toMatchObject({ type: 'sell', quantity: 500, price: 35200, fee: 26400, tax: 17600 });
  });

  it('thiếu cột phí/thuế: tự tính theo biểu phí khi bật, bằng 0 khi tắt', () => {
    const rows = [['Ngày GD', 'Mã CK', 'Loại lệnh', 'KL', 'Giá'], ['02/10/2026', 'SSI', 'Bán', '1000', '25000']];
    const d = StatementImport.detectColumns(rows);
    const on = StatementImport.normalizeRows(rows, { headerRow: d.headerRow, mapping: d.mapping, autoFees: true });
    expect(on.rows[0]).toMatchObject({ fee: 37500, tax: 25000 });
    const off = StatementImport.normalizeRows(rows, { headerRow: d.headerRow, mapping: d.mapping, autoFees: false });
    expect(off.rows[0]).toMatchObject({ fee: 0, tax: 0 });
  });

  it('suy ra giá từ Giá trị / Khối lượng khi không có cột giá, và nhận ra giá tính theo nghìn đồng', () => {
    const rows = [['Ngày', 'Mã', 'Mua/Bán', 'Khối lượng', 'Giá', 'Giá trị khớp'], ['15/09/2026', 'SSI', 'Mua', '1000', '33.8', '33800000'], ['16/09/2026', 'VHM', 'Mua', '100', '74.1', '7410000']];
    const d = StatementImport.detectColumns(rows);
    const r = StatementImport.normalizeRows(rows, { headerRow: d.headerRow, mapping: d.mapping });
    expect(r.priceMultiplier).toBe(1000);
    expect(r.rows[0].price).toBeCloseTo(33800, 6);
    expect(r.rows[1].price).toBeCloseTo(74100, 6);
  });

  it('loại dòng lỗi kèm lý do rõ ràng, bỏ qua dòng tổng cộng và loại giao dịch không hỗ trợ', () => {
    const r = run([
      ['không phải ngày', 'SSI', 'Mua', '100', '10000', '0', '0'],
      ['15/09/2026', 'SSI', '???', '100', '10000', '0', '0'],
      ['15/09/2026', 'SSI', 'Mua', '0', '10000', '0', '0'],
      ['15/09/2026', 'SSI', 'Chuyển khoản', '100', '10000', '0', '0'],
      ['', '', '', '', '', '', ''],
      ['15/09/2026', 'HPG', 'Mua', '100', '25000', '0', '0'],
    ]);
    expect(r.rows.filter(e => !e.issues.length)).toHaveLength(1);
    expect(r.rows[0].issues[0]).toMatch(/ngày/);
    expect(r.rows[1].issues[0]).toMatch(/Mua\/Bán/);
    expect(r.rows[2].issues[0]).toMatch(/Khối lượng/);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/không hỗ trợ/);
  });

  it('khối lượng âm được hiểu là bán khi không có cột Mua/Bán rõ ràng', () => {
    const rows = [['Ngày', 'Mã', 'Mua/Bán', 'KL', 'Giá'], ['15/09/2026', 'SSI', '', '-100', '10000']];
    const d = StatementImport.detectColumns(rows);
    const r = StatementImport.normalizeRows(rows, { headerRow: d.headerRow, mapping: d.mapping });
    expect(r.rows[0].type).toBe('sell');
    expect(r.rows[0].quantity).toBe(100);
  });

  it('gộp các lần khớp cùng ngày/mã/chiều thành 1 lệnh giá bình quân gia quyền (tuỳ chọn)', () => {
    const body = [['15/09/2026', 'SSI', 'Mua', '100', '10000', '1000', '0'], ['15/09/2026', 'SSI', 'Mua', '300', '10400', '3000', '0'], ['15/09/2026', 'SSI', 'Bán', '50', '11000', '500', '550']];
    const r = run(body, { mergeFills: true });
    expect(r.rows).toHaveLength(2);
    const buy = r.rows.find(e => e.type === 'buy');
    expect(buy.quantity).toBe(400);
    expect(buy.price).toBeCloseTo(10300, 6);
    expect(buy.fee).toBe(4000);
    expect(buy.merged).toBe(2);
  });

  it('cổ tức tiền mặt được nhận ra riêng, kèm số tiền', () => {
    const rows = [['Ngày', 'Mã', 'Loại giao dịch', 'KL', 'Giá', 'Giá trị'], ['20/09/2026', 'HPG', 'Cổ tức tiền mặt', '', '', '1.500.000']];
    const d = StatementImport.detectColumns(rows);
    const r = StatementImport.normalizeRows(rows, { headerRow: d.headerRow, mapping: d.mapping });
    expect(r.rows[0]).toMatchObject({ type: 'dividend', symbol: 'HPG', amount: 1500000, date: '2026-09-20' });
    expect(r.rows[0].issues).toEqual([]);
  });
});

describe('dedupe + orderForInsert', () => {
  const inc = (over) => Object.assign({ date: '2026-09-15', symbol: 'SSI', type: 'buy', quantity: 1000, price: 33800, ref: null, line: 1, issues: [] }, over);
  const exist = (over) => Object.assign({ trade_date: '2026-09-15', symbol: 'SSI', type: 'buy', quantity: 1000, price: 33800, external_ref: null }, over);

  it('nhập lại cùng file không tạo trùng', () => {
    const r = StatementImport.dedupe([exist({})], [inc({})]);
    expect(r.fresh).toHaveLength(0);
    expect(r.duplicates).toHaveLength(1);
  });

  it('có đếm số lượng: 2 lệnh giống hệt trong file, sổ đã có 1 => chỉ nhập thêm 1', () => {
    const r = StatementImport.dedupe([exist({})], [inc({ line: 1 }), inc({ line: 2 })]);
    expect(r.fresh).toHaveLength(1);
    expect(r.duplicates).toHaveLength(1);
  });

  it('khác giá/khối lượng/chiều là lệnh khác', () => {
    const r = StatementImport.dedupe([exist({})], [inc({ price: 34000 }), inc({ quantity: 500 }), inc({ type: 'sell' })]);
    expect(r.fresh).toHaveLength(3);
  });

  it('mã lệnh trùng với sổ => trùng; mã lệnh lặp trong file (1 lệnh khớp nhiều dòng) thì không dùng làm khoá', () => {
    expect(StatementImport.dedupe([exist({ external_ref: 'A1', quantity: 7 })], [inc({ ref: 'A1' })]).duplicates).toHaveLength(1);
    const r = StatementImport.dedupe([], [inc({ ref: 'B1', quantity: 100 }), inc({ ref: 'B1', quantity: 200 }), inc({ ref: 'C1' })]);
    expect(r.fresh.map(e => e.externalRef)).toEqual([null, null, 'C1']);
  });

  it('thứ tự chèn: theo ngày, cùng ngày mua trước bán sau', () => {
    const list = [inc({ date: '2026-09-16', type: 'sell', line: 1 }), inc({ date: '2026-09-15', type: 'sell', line: 2 }), inc({ date: '2026-09-15', type: 'buy', line: 3 }), inc({ date: '2026-09-15', type: 'buy', line: 4 })];
    expect(StatementImport.orderForInsert(list).map(e => e.line)).toEqual([3, 4, 2, 1]);
  });
});

describe('XlsxWriter + readXlsx', () => {
  it('ghi rồi đọc lại đúng nội dung (chuỗi tiếng Việt, số, ngày, ký tự đặc biệt XML)', async () => {
    const bytes = XlsxWriter.build([
      { name: 'Tổng quan', rows: [['Chỉ tiêu', 'Giá trị'], ['Lợi suất tháng', { v: 0.038, s: 'pct' }], ['R&D <test> "q"', 12345], ['Ngày', { v: '2026-09-15', s: 'date' }], ['Đúng?', true]] },
      { name: 'Sheet/2:?', rows: [['a'], [1, 2, 3]] },
    ]);
    expect(bytes[0]).toBe(0x50); expect(bytes[1]).toBe(0x4B);               // 'PK'
    const sheets = await StatementImport.readXlsx(bytes);
    expect(sheets.map(s => s.name)).toEqual(['Tổng quan', 'Sheet 2']);
    expect(sheets[0].rows[0]).toEqual(['Chỉ tiêu', 'Giá trị']);
    expect(sheets[0].rows[1]).toEqual(['Lợi suất tháng', 0.038]);
    expect(sheets[0].rows[2]).toEqual(['R&D <test> "q"', 12345]);
    expect(StatementImport.parseDate(sheets[0].rows[3][1])).toBe('2026-09-15');   // ghi thành số ngày Excel, đọc lại ra đúng ngày
    expect(sheets[1].rows[1]).toEqual([1, 2, 3]);
  });

  it('crc32 đúng giá trị chuẩn', () => {
    expect(XlsxWriter.crc32(new TextEncoder().encode('123456789'))).toBe(0xCBF43926);
  });

  it('đọc được file Excel THẬT (do Microsoft tạo, có nén deflate và sharedStrings)', async () => {
    const buf = fs.readFileSync(new URL('../fixtures/excel-created-sample.xlsx', import.meta.url));
    const sheets = await StatementImport.readXlsx(new Uint8Array(buf));
    expect(sheets.length).toBeGreaterThan(0);
    const rows = sheets[0].rows;
    expect(rows[0].join('|')).toMatch(/Portfolio/);
    expect(rows[0].join('|')).toMatch(/Benchmark/);
    expect(rows[1][0]).toBe('Start');
    expect(rows[rows.length - 1][0]).toBe('Month-end');
    expect(typeof rows[1][1]).toBe('number');
  });

  it('file không phải Excel báo lỗi rõ ràng', async () => {
    await expect(StatementImport.readXlsx(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(/Excel/);
  });

  it('end-to-end: sao kê .xlsx -> nhận cột -> chuẩn hoá', async () => {
    const bytes = XlsxWriter.build([{ name: 'Sao kê', rows: [
      ['SAO KÊ GIAO DỊCH'], [],
      ['Ngày GD', 'Mã CK', 'Loại lệnh', 'KL khớp', 'Giá khớp', 'Phí'],
      [{ v: '2026-09-15', s: 'date' }, 'SSI', 'Mua', 1000, 33800, 50700],
      [{ v: '2026-10-02', s: 'date' }, 'SSI', 'Bán', 500, 35200, 26400],
    ] }]);
    const rows = (await StatementImport.readXlsx(bytes))[0].rows;
    const d = StatementImport.detectColumns(rows);
    const r = StatementImport.normalizeRows(rows, { headerRow: d.headerRow, mapping: d.mapping });
    expect(r.rows.map(e => [e.date, e.type, e.quantity, e.price, e.fee])).toEqual([['2026-09-15', 'buy', 1000, 33800, 50700], ['2026-10-02', 'sell', 500, 35200, 26400]]);
    expect(r.rows.every(e => !e.issues.length)).toBe(true);
  });
});
