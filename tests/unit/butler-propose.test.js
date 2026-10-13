import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import C from '../../lib/butler-core.js';
import M from '../../lib/butler-map-fin.js';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const parse = (q, ctx) => C.parseProposal(q, ctx || {});

describe('Quản gia giai đoạn D: nhận ra yêu cầu ghi', () => {
  it('việc cá nhân: "nhắc tôi", "tạo việc", "ghi nhớ" lấy phần còn lại làm nội dung', () => {
    expect(parse('nhắc tôi gọi khách hàng ABC vào thứ hai')).toEqual({ kind: 'todo', fields: { title: 'gọi khách hàng ABC vào thứ hai' } });
    expect(parse('Tạo việc: nộp báo cáo tuần').fields.title).toBe('nộp báo cáo tuần');
    expect(parse('giúp tôi tạo công việc rằng chốt sổ tháng 10').fields.title).toBe('chốt sổ tháng 10');
    expect(parse('xin hãy ghi nhớ rà soát giới hạn').kind).toBe('todo');
  });
  it('quyết định: hành động, mã, giá (120k / 27.500 / 1,2tr) và lý do (sau ":" hoặc "vì")', () => {
    const a = parse('ghi quyết định mua FPT giá 120k vì định giá rẻ');
    expect(a.kind).toBe('decision');
    expect(a.fields).toMatchObject({ symbol: 'FPT', action: 'buy', price: '120000', reason: 'định giá rẻ' });
    expect(a.fields.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parse('ghi nhật ký quyết định bán HPG giá 27.500: chốt lời').fields).toMatchObject({ symbol: 'HPG', action: 'sell', price: '27500', reason: 'chốt lời' });
    expect(parse('lưu quyết định bỏ qua VNM').fields).toMatchObject({ symbol: 'VNM', action: 'skip', price: '', reason: '' });
    expect(parse('thêm quyết định giữ MWG giá 1,2tr').fields.price).toBe('1200000');
  });
  it('ý tưởng nháp: mã + tiêu đề, hướng mặc định là mua', () => {
    expect(parse('tạo ý tưởng HPG: thép hồi phục').fields).toEqual({ symbol: 'HPG', title: 'thép hồi phục', direction: 'long', thesis: '' });
    expect(parse('ghi ý tưởng', { sym: 'FPT' }).fields.symbol).toBe('FPT');
  });
  it('câu HỎI (ở đâu / cách / là gì / có dấu hỏi) và câu thường không bao giờ thành đề xuất ghi', () => {
    ['giúp tôi tạo công việc mới ở đâu?', 'tạo việc ở đâu', 'cách ghi quyết định là gì', 'nhắc tôi có việc gì?', 'hôm nay có việc gì', 'nhập sao kê', 'ghi nhớ ở đâu', 'quyết định mua bán là gì'].forEach((q) => expect(parse(q), q).toBeNull());
  });
  it('understand: propose thắng mọi ý định khác và giữ nguyên ý định cũ cho câu thường', () => {
    expect(C.understand('nhắc tôi nộp thuế', {}, M, null).intent).toBe('propose');
    expect(C.understand('hôm nay có việc gì', {}, M, null).intent).toBe('today');
    expect(C.understand('nhập sao kê ở đâu', {}, M, null).intent).not.toBe('propose');
  });
});

describe('Quản gia giai đoạn D: kiểm khuôn đề xuất (máy chủ và trang dùng chung)', () => {
  it('todo: cần ít nhất 3 ký tự, cắt 120, bỏ ký tự điều khiển', () => {
    expect(C.validateProposal('todo', { title: ' ab ' }).ok).toBe(false);
    expect(C.validateProposal('todo', { title: 'gọi\u0007 khách' })).toEqual({ ok: true, fields: { title: 'gọi khách' } });
    expect(C.validateProposal('todo', { title: 'x'.repeat(300) }).fields.title.length).toBeLessThanOrEqual(120);
  });
  it('decision: bắt buộc mã, hành động, ngày; giá nếu có phải > 0; hành động ngoài danh sách bị loại', () => {
    const ok = { symbol: 'fpt', action: 'buy', date: '2026-10-13', price: '120000', reason: 'rẻ' };
    expect(C.validateProposal('decision', ok)).toEqual({ ok: true, fields: { symbol: 'FPT', action: 'buy', date: '2026-10-13', price: '120000', reason: 'rẻ' } });
    expect(C.validateProposal('decision', { ...ok, action: 'drop' }).ok).toBe(false);
    expect(C.validateProposal('decision', { ...ok, symbol: 'F P' }).ok).toBe(false);
    expect(C.validateProposal('decision', { ...ok, date: '13/10/2026' }).ok).toBe(false);
    expect(C.validateProposal('decision', { ...ok, price: '-5' }).ok).toBe(false);
    expect(C.validateProposal('decision', { ...ok, price: '' }).ok).toBe(true);
  });
  it('idea: cần mã và tiêu đề ≥ 3 ký tự; hướng lạ thành "long"', () => {
    expect(C.validateProposal('idea', { symbol: 'HPG', title: 'ab' }).ok).toBe(false);
    expect(C.validateProposal('idea', { symbol: 'HPG', title: 'thép hồi phục', direction: 'zzz' }).fields.direction).toBe('long');
    expect(C.validateProposal('lạ', {}).ok).toBe(false);
  });
  it('composeProposal: một thẻ proposal, câu mở đầu nói rõ CHƯA ghi gì', () => {
    const r = C.composeProposal(parse('nhắc tôi nộp thuế'));
    expect(r.cards).toEqual([{ type: 'proposal', kind: 'todo', title: 'Tạo việc cá nhân', fields: { title: 'nộp thuế' } }]);
    expect(r.text).toMatch(/chưa ghi gì/i);
  });
  it('parseAmount: dấu chấm phân cách nghìn, dấu phẩy thập phân, đơn vị k / tr', () => {
    expect([C.parseAmount('120000'), C.parseAmount('120.000'), C.parseAmount('120,5'), C.parseAmount('120', 'k'), C.parseAmount('1,2', 'tr'), C.parseAmount('0'), C.parseAmount('abc')]).toEqual([120000, 120000, 120.5, 120000, 1200000, null, null]);
  });
});

describe('Quản gia giai đoạn D: không có đường ghi nào ở máy chủ', () => {
  it('hàm Edge trả thẻ proposal nhưng không ghi gì ngoài butler_log (test butler-edge giữ chặt danh sách ghi)', () => {
    const idx = read('supabase/functions/butler/index.ts');
    expect(idx).toMatch(/und\.intent === "propose"\) reply = C\.composeProposal/);
    expect(idx).not.toMatch(/finance_decisions|finance_ideas|personal_items/);
  });
  it('trang chỉ ghi qua API sẵn có sau khi bấm Xác nhận, và kiểm khuôn lại bằng lõi trước khi ghi', () => {
    const ui = read('lib/butler-ui.js');
    expect(ui).toMatch(/A\.personal\.upsert\(/);
    expect(ui).toMatch(/A\.asset\.journal\.save\(/);
    expect(ui).toMatch(/A\.ideas\.save\(/);
    expect(ui).toMatch(/validateProposal\(card\.kind, vals\)/);
    // mọi lệnh ghi nằm trong executeProposal (chỉ được gọi từ nút Xác nhận)
    expect(ui.match(/executeProposal\(/g).length).toBe(2);
  });
});
