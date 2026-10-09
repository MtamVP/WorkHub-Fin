// lib/market-news.js: phân loại chủ đề, nhận mã cổ phiếu, điểm tin, lọc, nhãn thời gian. Tin thật lấy từ mẫu RSS 09/10/2026 (tests/fixtures/news-feeds.json) qua đúng bộ đọc của Edge Function.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import MN from '../../lib/market-news.js';
import { FEEDS, parseRss } from '../../supabase/functions/market-news/parse.ts';

const FX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/news-feeds.json'), 'utf8'));
const NOW = Date.parse('2026-10-09T00:00:00Z');
const SYMS = new Set(['VPB', 'PNJ', 'SSI', 'POW', 'NT2', 'DIG', 'DIC', 'TCB', 'HDB', 'PLX', 'VPS', 'HPG', 'FPT', 'VND', 'GDP', 'GAS', 'VHM']);
const real = FEEDS.flatMap((f) => parseRss(FX[f.id].xml, f, NOW));
const byTitle = (s) => MN.enrich(real, SYMS).find((x) => x.title.startsWith(s));
const mk = (title, summary) => ({ title, summary: summary || '', link: 'https://cafef.vn/' + encodeURIComponent(title), source: 'cafef', sourceName: 'CafeF', ts: NOW - 3600000 });

describe('phân loại chủ đề (tin thật)', () => {
  it('tin tự doanh/khối ngoại là Chứng khoán và nhận đúng mã', () => {
    const a = byTitle('Tự doanh tiếp tục mua ròng hơn trăm tỷ đồng VPB');
    expect(a.topic).toBe('market'); expect(a.tickers).toEqual(['VPB']);
    const b = byTitle('Khối ngoại bán ròng 12 phiên liên tiếp');
    expect(b.topic).toBe('market'); expect(b.tickers).toEqual(['TCB', 'HDB', 'PNJ', 'PLX']);
    const c = byTitle('Nhu cầu điện tăng vọt');
    expect(c.tickers).toEqual(['SSI']);                       // NT2, POW nằm ở phần mô tả bị cắt ngắn (220 ký tự) nên không được nhận: chỉ tìm mã trong tiêu đề và đoạn mô tả ngắn
  });
  it('chính sách thuế là Vĩ mô; tin không khớp từ khoá nào là Khác', () => {
    expect(byTitle('Doanh nghiệp muốn tham gia góp ý chính sách thuế').topic).toBe('macro');
    expect(MN.classify(mk('Chuyện hôm nay có gì vui'))).toBe('other');
    expect(MN.classify({})).toBe('other');
    expect(MN.classify(null)).toBe('other');
  });
  it('các chủ đề dựng tay: Ngân hàng, Bất động sản, Doanh nghiệp, Hàng hoá, Thế giới', () => {
    expect(MN.classify(mk('Nợ xấu và NIM của các ngân hàng cải thiện'))).toBe('bank');
    expect(MN.classify(mk('Giá chung cư Hà Nội tăng, quỹ đất khan hiếm'))).toBe('realestate');
    expect(MN.classify(mk('Lợi nhuận quý 3 tăng 30%, công ty chia cổ tức tiền mặt'))).toBe('corp');
    expect(MN.classify(mk('Giá dầu thô và giá xăng dầu trong nước cùng giảm'))).toBe('commodity');
    expect(MN.classify(mk('Phố Wall đi xuống, Dow Jones mất 300 điểm'))).toBe('world');
  });
  it('tiêu đề nặng điểm hơn mô tả; hoà điểm lấy chủ đề đứng trước; không phân biệt dấu và hoa thường', () => {
    expect(MN.classify(mk('Ngân hàng tăng vốn', 'chứng khoán thanh khoản khối ngoại'))).toBe('market');     // mô tả 3 điểm chứng khoán nhưng tiêu đề 2 điểm ngân hàng... xem điểm cụ thể bên dưới
    expect(MN.classify(mk('LÃI SUẤT'))).toBe('macro');
    expect(MN.classify(mk('lai suat'))).toBe('macro');
    expect(MN.classify(mk('Lãi suất ngân hàng', ''))).toBe('macro');                                         // macro 2 (lãi suất) = bank 2 (ngân hàng): macro đứng trước
  });
  it('khớp nguyên từ: "thuế" không khớp "thuê", "my" không khớp "mycom"', () => {
    expect(MN.classify(mk('Cho thuê văn phòng'))).toBe('other');
    expect(MN.classify(mk('Mycom ra mắt sản phẩm'))).toBe('other');
  });
});

describe('nhận mã cổ phiếu', () => {
  it('chỉ nhận từ viết hoa 3-4 ký tự có trong danh sách mã; bỏ trùng; giữ thứ tự', () => {
    expect(MN.tickers(mk('HPG và FPT tăng, HPG dẫn đầu', 'VHM giảm'), SYMS)).toEqual(['HPG', 'FPT', 'VHM']);
    expect(MN.tickers(mk('hpg tăng'), SYMS)).toEqual([]);                    // chữ thường
    expect(MN.tickers(mk('AHPG và HPGX'), SYMS)).toEqual([]);               // dính chữ
    expect(MN.tickers(mk('(HPG), "FPT"; VHM.'), SYMS)).toEqual(['HPG', 'FPT', 'VHM']);
    expect(MN.tickers(mk('VN-Index tăng'), SYMS)).toEqual([]);
  });
  it('loại các từ viết tắt trùng mã: VND (tiền), GDP, USD, CEO', () => {
    expect(MN.tickers(mk('VND mất giá, GDP tăng, USD mạnh, CEO từ chức', 'VPB tăng'), SYMS)).toEqual(['VPB']);
    expect(MN.STOP.has('VND')).toBe(true);
  });
  it('mã GAS (khí) vẫn được nhận vì là mã thật', () => { expect(MN.tickers(mk('GAS lãi lớn'), SYMS)).toEqual(['GAS']); });
  it('danh sách mã rỗng hoặc thiếu: không ném', () => {
    expect(MN.tickers(mk('HPG tăng'), new Set())).toEqual([]);
    expect(MN.tickers(mk('HPG tăng'), null)).toEqual([]);
    expect(MN.tickers(null, SYMS)).toEqual([]);
    expect(MN.tickers(mk('HPG tăng'), ['HPG'])).toEqual(['HPG']);            // nhận cả mảng
  });
});

describe('enrich, điểm tin, lọc', () => {
  const items = MN.enrich([
    Object.assign(mk('VPB tăng, khối ngoại mua ròng'), { ts: NOW - 1 * 3600000 }),
    Object.assign(mk('HPG báo lãi quý 3, VPB cũng tăng'), { ts: NOW - 2 * 3600000 }),
    Object.assign(mk('Lãi suất tiền gửi giảm'), { ts: NOW - 10 * 3600000, source: 'vnexpress', sourceName: 'VnExpress' }),
    Object.assign(mk('Tin cũ 3 ngày về HPG'), { ts: NOW - 72 * 3600000 }),
    Object.assign(mk('Tin không rõ giờ về FPT'), { ts: null }),
    { title: '', link: 'https://x' }, { title: 'thiếu link' }, null,
  ], SYMS);
  it('enrich bỏ tin thiếu tiêu đề/link và không đổi bản gốc', () => {
    expect(items.length).toBe(5);
    expect(items.every((x) => typeof x.topic === 'string' && Array.isArray(x.tickers))).toBe(true);
    const src = [mk('VPB tăng')]; MN.enrich(src, SYMS); expect(src[0].topic).toBeUndefined();
  });
  it('digest: chỉ tính trong 24 giờ, đếm theo chủ đề/báo, mã nhắc nhiều nhất, tin 3 giờ qua', () => {
    const d = MN.digest(items, { now: NOW });
    expect(d.total).toBe(3);                       // bỏ tin 3 ngày và tin không rõ giờ
    expect(d.recent3h).toBe(2);
    expect(d.topTickers).toEqual([{ symbol: 'VPB', count: 2 }, { symbol: 'HPG', count: 1 }]);
    expect(d.bySource).toEqual({ CafeF: 2, VnExpress: 1 });
    expect(d.topics.reduce((t, x) => t + x.count, 0)).toBe(3);
    expect(d.topics.every((x, i, a) => i === 0 || a[i - 1].count >= x.count)).toBe(true);
    expect(MN.digest(items, { now: NOW, hours: 100 }).total).toBe(4);
    expect(MN.digest([], { now: NOW })).toMatchObject({ total: 0, recent3h: 0, topics: [], topTickers: [] });
    expect(MN.digest(null, { now: NOW }).total).toBe(0);
  });
  it('filter: theo chủ đề, báo và mã của tôi; kết hợp; tập rỗng là không có tin', () => {
    expect(MN.filter(items, { topic: 'all' }).length).toBe(5);
    expect(MN.filter(items, { source: 'vnexpress' }).map((x) => x.title)).toEqual(['Lãi suất tiền gửi giảm']);
    expect(MN.filter(items, { mine: new Set(['VPB']) }).length).toBe(2);
    expect(MN.filter(items, { mine: ['HPG'] }).length).toBe(2);
    expect(MN.filter(items, { mine: new Set() }).length).toBe(0);
    expect(MN.filter(items, { mine: new Set(['VPB']), source: 'vnexpress' }).length).toBe(0);
    expect(MN.filter(items, { topic: 'macro' }).every((x) => x.topic === 'macro')).toBe(true);
    expect(MN.filter(null, null)).toEqual([]);
    expect(MN.filter(items, null).length).toBe(5);
  });
});

describe('nhãn thời gian', () => {
  it('vừa xong, phút, giờ, hôm qua, ngày/tháng theo giờ Việt Nam; thiếu hoặc lệch tương lai thì rỗng', () => {
    expect(MN.ago(NOW - 20000, NOW)).toBe('vừa xong');
    expect(MN.ago(NOW - 5 * 60000, NOW)).toBe('5 phút trước');
    expect(MN.ago(NOW - 3 * 3600000 - 1000, NOW)).toBe('3 giờ trước');
    expect(MN.ago(NOW - 30 * 3600000, NOW)).toBe('hôm qua');
    expect(MN.ago(Date.parse('2026-10-05T20:00:00Z'), NOW)).toBe('06/10');              // 03:00 ngày 06/10 giờ Việt Nam
    expect(MN.ago(null, NOW)).toBe('');
    expect(MN.ago(NOW + 3600000, NOW)).toBe('');
    expect(MN.ago(NOW + 60000, NOW)).toBe('vừa xong');                                   // lệch nhẹ do đồng hồ máy
  });
});

describe('cấu hình chủ đề', () => {
  it('khoá duy nhất, mỗi chủ đề có từ khoá đã bỏ dấu và viết thường; labelOf', () => {
    expect(new Set(MN.TOPICS.map((t) => t.key)).size).toBe(MN.TOPICS.length);
    MN.TOPICS.forEach((t) => t.kw.forEach((k) => { expect(k, t.key).toBe((/[^\x00-\x7f]/.test(k) ? MN.keep(k) : MN.fold(k)).trim()); expect(k.length).toBeGreaterThan(1); }));
    expect(MN.labelOf('bank')).toBe('Ngân hàng'); expect(MN.labelOf('other')).toBe('Khác'); expect(MN.labelOf('zzz')).toBe('Khác');
  });
});
