// supabase/functions/market-news/parse.ts: đọc RSS thật của 5 báo (mẫu cắt từ nguồn ngày 09/10/2026 trong tests/fixtures/news-feeds.json) + các ca biên dựng tay.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FEEDS, parseRss, merge, decodeEntities, plain, clip, safeLink, parseDate, tagText, MAX_PER_FEED, SUMMARY_MAX } from '../../supabase/functions/market-news/parse.ts';

const FX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/news-feeds.json'), 'utf8'));
const NOW = Date.parse('2026-10-09T00:00:00Z');
const feed = (id) => FEEDS.find((f) => f.id === id);

describe('mẫu RSS thật của 5 báo', () => {
  FEEDS.forEach((f) => {
    it(f.name + ': đọc đủ 4 tin, tiêu đề sạch, link https đúng tên miền, có giờ đăng, mô tả không còn thẻ HTML', () => {
      const items = parseRss(FX[f.id].xml, f, NOW);
      expect(items.length).toBe(4);
      items.forEach((it) => {
        expect(it.title.length).toBeGreaterThan(5);
        expect(it.title).not.toMatch(/[<>]|&#|&[a-z]+;|CDATA/);
        expect(it.link.startsWith('https://')).toBe(true);
        expect(f.hosts.some((h) => new URL(it.link).hostname.endsWith(h))).toBe(true);
        expect(typeof it.ts).toBe('number');
        expect(it.ts).toBeLessThanOrEqual(NOW + 24 * 3600000);
        expect(it.summary).not.toMatch(/[<>]|&#|&lt;|&gt;|CDATA|<img/i);
        expect(it.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
        expect(it.source).toBe(f.id);
        expect(it.sourceName).toBe(f.name);
      });
    });
  });
  it('Vietnambiz: thực thể số trong CDATA được giải mã (r&#242;ng -> ròng)', () => {
    const items = parseRss(FX.vietnambiz.xml, feed('vietnambiz'), NOW);
    expect(items[0].title).toBe('Tự doanh tiếp tục mua ròng hơn trăm tỷ đồng VPB');
    expect(items[0].summary).toMatch(/^Trong phiên 8\/10, tự doanh mua ròng/);
  });
  it('Vietstock: link http được nâng lên https; mô tả là HTML bị mã hoá nên vẫn lấy được chữ, không lấy ảnh', () => {
    const items = parseRss(FX.vietstock.xml, feed('vietstock'), NOW);
    expect(items[0].link).toBe('https://vietstock.vn/2026/10/0910-doc-gi-truoc-gio-giao-dich-chung-khoan-830-1500618.htm');
    expect(items[0].summary.startsWith('Cùng điểm lại những tin tức tài chính')).toBe(true);
    expect(items[0].ts).toBe(Date.parse('2026-10-08T23:00:00Z'));
  });
  it('VnExpress: mô tả có ảnh bọc trong liên kết và thẻ </br> chỉ còn chữ; giờ +0700 đổi đúng', () => {
    const items = parseRss(FX.vnexpress.xml, feed('vnexpress'), NOW);
    expect(items[0].title).toBe('Mỹ - Nga tính chuyện cùng bán lại khí đốt qua đường ống cho EU');
    expect(items[0].summary.startsWith('Giới chức Nga và Mỹ thảo luận')).toBe(true);
    expect(items[0].ts).toBe(Date.parse('2026-10-08T21:00:00Z'));
  });
  it('mô tả không chép lại tiêu đề; không có mô tả thì rỗng', () => {
    const xml = '<rss><channel><item><title>Tin A</title><link>https://cafef.vn/a.chn</link><description>Tin A</description></item><item><title>Tin B</title><link>https://cafef.vn/b.chn</link></item></channel></rss>';
    const r = parseRss(xml, feed('cafef'), NOW);
    expect(r.map((x) => x.summary)).toEqual(['', '']);
    expect(r[0].ts).toBe(null);
  });
});

describe('bộ đọc chịu được dữ liệu xấu', () => {
  it('link ngoài tên miền, không phải http(s), thiếu tiêu đề hoặc thiếu link: bỏ tin đó', () => {
    const xml = ['<item><title>Đúng</title><link>https://cafef.vn/x.chn</link></item>',
      '<item><title>Sai miền</title><link>https://evil.example.com/x</link></item>',
      '<item><title>Giả miền</title><link>https://cafef.vn.evil.com/x</link></item>',
      '<item><title>Script</title><link>javascript:alert(1)</link></item>',
      '<item><title></title><link>https://cafef.vn/y.chn</link></item>',
      '<item><title>Thiếu link</title></item>'].join('');
    const r = parseRss(xml, feed('cafef'), NOW);
    expect(r.map((x) => x.title)).toEqual(['Đúng']);
  });
  it('tiêu đề chứa thẻ script hoặc HTML chỉ còn chữ', () => {
    const r = parseRss('<item><title><![CDATA[<script>alert(1)</script>Tin <b>nóng</b> &amp; hay]]></title><link>https://cafef.vn/z.chn</link></item>', feed('cafef'), NOW);
    expect(r[0].title).toBe('alert(1) Tin nóng & hay');
    expect(r[0].title).not.toMatch(/[<>]/);
  });
  it('XML rỗng, null, rác: trả mảng rỗng, không ném', () => {
    expect(parseRss('', feed('cafef'), NOW)).toEqual([]);
    expect(parseRss(null, feed('cafef'), NOW)).toEqual([]);
    expect(parseRss('<html>429 Too Many Requests</html>', feed('cafef'), NOW)).toEqual([]);
    expect(parseRss('<item><title>chưa đóng thẻ', feed('cafef'), NOW)).toEqual([]);
  });
  it('giới hạn số tin mỗi báo', () => {
    const xml = Array.from({ length: 80 }, (_, i) => `<item><title>Tin ${i}</title><link>https://cafef.vn/t${i}.chn</link></item>`).join('');
    expect(parseRss(xml, feed('cafef'), NOW).length).toBe(MAX_PER_FEED);
  });
  it('ngày: lệch quá 1 ngày về tương lai hoặc không đọc được thì null', () => {
    expect(parseDate('Fri, 09 Oct 2026 04:00:00 +0700', NOW)).toBe(Date.parse('2026-10-08T21:00:00Z'));
    expect(parseDate('Fri, 09 Oct 2030 04:00:00 +0700', NOW)).toBe(null);
    expect(parseDate('hôm qua', NOW)).toBe(null);
    expect(parseDate(undefined, NOW)).toBe(null);
  });
});

describe('hàm nhỏ', () => {
  it('decodeEntities: số thập phân, thập lục, tên thường gặp; thực thể lạ giữ nguyên; mã điểm không hợp lệ bị bỏ', () => {
    expect(decodeEntities('r&#242;ng &#x1F600; &amp; &quot;a&quot; &hellip; &chuale; &#0; &#99999999;')).toBe('ròng 😀 & "a" … &chuale;  ');
  });
  it('plain bỏ thẻ và gộp khoảng trắng', () => { expect(plain('<a href="x"><img src="y"></a>  Xin   <b>chào</b>\n bạn')).toBe('Xin chào bạn'); });
  it('clip cắt ở ranh giới từ và thêm …; chuỗi ngắn giữ nguyên', () => {
    const s = 'một hai ba bốn năm sáu bảy tám chín mười';
    const c = clip(s, 20);
    expect(c.length).toBeLessThanOrEqual(20);
    expect(c.endsWith('…')).toBe(true);
    expect(s.startsWith(c.slice(0, -1))).toBe(true);
    expect(clip('ngắn', 20)).toBe('ngắn');
  });
  it('safeLink: nâng http lên https, nhận tên miền con, loại miền lạ và chuỗi rác', () => {
    expect(safeLink('http://vietstock.vn/a', ['vietstock.vn'])).toBe('https://vietstock.vn/a');
    expect(safeLink('https://m.cafef.vn/a.chn', ['cafef.vn'])).toBe('https://m.cafef.vn/a.chn');
    expect(safeLink('https://notcafef.vn/a', ['cafef.vn'])).toBe(null);
    expect(safeLink('ftp://cafef.vn/a', ['cafef.vn'])).toBe(null);
    expect(safeLink('not a url', ['cafef.vn'])).toBe(null);
    expect(safeLink(null, ['cafef.vn'])).toBe(null);
  });
  it('tagText: CDATA lấy nguyên văn, không CDATA thì giải mã thực thể, thẻ có thuộc tính vẫn đọc được, thiếu thẻ là rỗng', () => {
    expect(tagText('<title><![CDATA[a &amp; b]]></title>', 'title')).toBe('a &amp; b');
    expect(tagText('<title>a &amp; b</title>', 'title')).toBe('a & b');
    expect(tagText('<description type="html">x</description>', 'description')).toBe('x');
    expect(tagText('<a>1</a>', 'title')).toBe('');
  });
});

describe('merge', () => {
  const it0 = (title, link, ts, source = 's') => ({ id: link, title, link, source, sourceName: source, ts, summary: '' });
  it('bỏ trùng theo link và theo tiêu đề đã chuẩn hoá (khác dấu/hoa thường/dấu câu), giữ bản đăng sớm nhất', () => {
    const r = merge([[it0('VN-Index tăng điểm!', 'https://a/1', 200, 'a')], [it0('vn index TĂNG điểm', 'https://b/1', 100, 'b'), it0('Khác hẳn', 'https://b/2', 300, 'b'), it0('Trùng link', 'https://a/1', 999, 'b')]]);
    expect(r.map((x) => x.link)).toEqual(['https://b/2', 'https://b/1']);
  });
  it('mới nhất trước, tin không rõ giờ xếp cuối; giới hạn số tin', () => {
    const r = merge([[it0('A', 'https://a/a', null), it0('B', 'https://a/b', 5), it0('C', 'https://a/c', 9)]]);
    expect(r.map((x) => x.title)).toEqual(['C', 'B', 'A']);
    expect(merge([[it0('A', 'https://a/a', 1), it0('B', 'https://a/b', 2)]], 1).length).toBe(1);
    expect(merge([])).toEqual([]);
  });
  it('dữ liệu thật: gộp 5 báo, không trùng link, đã sắp theo giờ', () => {
    const all = FEEDS.map((f) => parseRss(FX[f.id].xml, f, NOW));
    const m = merge(all);
    expect(m.length).toBe(20);
    expect(new Set(m.map((x) => x.link)).size).toBe(20);
    for (let i = 1; i < m.length; i++) expect((m[i - 1].ts ?? -1) >= (m[i].ts ?? -1)).toBe(true);
  });
});

describe('cấu hình nguồn', () => {
  it('mỗi nguồn có id duy nhất, địa chỉ https và tên miền hợp lệ cho chính địa chỉ đó', () => {
    expect(new Set(FEEDS.map((f) => f.id)).size).toBe(FEEDS.length);
    FEEDS.forEach((f) => { expect(f.url.startsWith('https://')).toBe(true); expect(safeLink(f.url, f.hosts)).toBe(f.url); });
  });
});
