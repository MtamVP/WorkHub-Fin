// Quản gia đọc HƯỚNG DẪN SỬ DỤNG: chỉ mục (lib/butler-guide-data.js) và bản đọc trong app (guide/index.html) cùng sinh từ docs/huong-dan-su-dung.html
// bằng scripts/build-guide-web.mjs. Kiểm: hai tệp đã commit luôn khớp nguồn + phiên bản, id duy nhất và trỏ đúng neo, định tuyến câu hỏi, kế hoạch AI chỉ nhận id có thật.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, BACK_JS } from '../../scripts/guide-index.mjs';
import { guideFromRows } from '../../supabase/functions/butler/tools.ts';

const C = require('../../lib/butler-core.js');
const M = require('../../lib/butler-map-fin.js');
const G = require('../../lib/butler-guide-data.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const lf = (s) => s.replace(/\r\n/g, '\n');
const VER = JSON.parse(read('src-tauri/tauri.conf.json')).version;

describe('chỉ mục hướng dẫn luôn khớp nguồn', () => {
  const gen = generate(ROOT);
  it('lib/butler-guide-data.js, guide/index.html và guide/back.js đúng bằng bản dựng lại từ docs/huong-dan-su-dung.html (chạy node scripts/build-guide-web.mjs nếu lệch)', () => {
    expect(lf(read('lib/butler-guide-data.js'))).toBe(gen.data);
    expect(lf(read('guide/index.html'))).toBe(gen.web);
    expect(lf(read('guide/back.js'))).toBe(BACK_JS);
    expect(lf(read('finance-butler-guide-data.sql'))).toBe(gen.sql);
  });
  it('phiên bản hướng dẫn = phiên bản app (tauri.conf.json): nâng phiên bản thì phải sửa hướng dẫn rồi dựng lại', () => {
    expect(G.version).toBe(VER);
    const src = read('docs/huong-dan-su-dung.html');
    expect(src).toContain('<title>WorkHub Fin ' + VER + ' ');
    expect(src).toContain('phiên bản ' + VER);
    expect(src).toContain('WorkHub-Fin_' + VER + '_x64-setup.exe');
  });
  it('SQL nạp bảng butler_guide: mỗi mục một dòng, an toàn dấu nháy, câu cuối xoá mục của bản cũ', () => {
    const sql = lf(read('finance-butler-guide-data.sql'));
    expect(sql).toContain('insert into public.butler_guide');
    expect((sql.match(/^\('/gm) || []).length).toBe(G.sections.length);
    expect(sql).toContain("delete from public.butler_guide where ver <> '" + VER + "';");
    expect(sql).not.toMatch(/truncate|drop table/i);
    const mig = read('finance-butler-guide-migration.sql');
    expect(mig).toMatch(/enable row level security/);
    expect(mig).toMatch(/for select to authenticated using \(true\)/);
    expect(mig).not.toMatch(/for (insert|update|delete|all)/i);                                  // app không ghi được; chỉ migration / service role
    expect(mig).toMatch(/revoke all on public\.butler_guide from anon/);
  });
  it('guideFromRows dựng lại đúng chỉ mục từ các dòng bảng (xếp theo ord), bỏ dòng hỏng; không có dòng hợp lệ -> null', () => {
    const rows = G.sections.map((x, i) => ({ id: x.id, ord: i + 1, ver: G.version, n: x.n, t: x.t, ct: x.ct, s: x.s, k: x.k, w: x.w, p: x.p || null }));
    expect(guideFromRows(rows.slice().reverse())).toEqual(G);
    expect(guideFromRows([{ id: 5 }, null, { t: 'x' }, ...rows.slice(0, 2)]).sections.map((x) => x.id)).toEqual(['s1', 's1-1']);
    expect(guideFromRows([])).toBeNull();
    expect(guideFromRows(null)).toBeNull();
    expect(guideFromRows([{ id: 'a', t: 'T', k: 'không phải mảng' }]).sections[0].k).toEqual([]);
  });
});

describe('cấu trúc chỉ mục', () => {
  it('id duy nhất, có tên và tóm tắt, mọi id là một neo thật trong guide/index.html', () => {
    const ids = G.sections.map((s) => s.id), html = read('guide/index.html');
    expect(new Set(ids).size).toBe(ids.length);
    expect(G.sections.length).toBeGreaterThanOrEqual(80);
    G.sections.forEach((s) => {
      expect(s.t, s.id).toBeTruthy(); expect(s.s, s.id).toBeTruthy(); expect(Array.isArray(s.k), s.id).toBe(true);
      expect(/^[\w-]{1,40}$/.test(s.id), s.id).toBe(true);
      expect(html, 'neo ' + s.id).toContain('id="' + s.id + '"');
    });
  });
  it('mọi chương 1-19 và ba phụ lục đều có mục; mục con đúng số', () => {
    const ids = new Set(G.sections.map((s) => s.id));
    for (let i = 1; i <= 19; i++) expect(ids.has('s' + i), 's' + i).toBe(true);
    ['pa', 'pb', 'pc', 's4-4', 's8-1', 's11-2', 's15-3', 's16-7', 's18-5', 's19-3', 'pc-dcf', 'pc-bien-an-toan'].forEach((id) => expect(ids.has(id), id).toBe(true));
  });
  it('tóm tắt ngắn (<= 280 ký tự + dấu …), không còn thẻ HTML hay thực thể', () => {
    G.sections.forEach((s) => { expect(s.s.length, s.id).toBeLessThanOrEqual(281); expect(s.s, s.id).not.toMatch(/<\/?(a|b|p|td|th|tr|table|span|div|li|ul|ol|h[1-6]|code|br|em|strong)[ >/]|&(amp|lt|gt|quot|nbsp);/i); });
  });
  it('trang đọc trong app: không còn trang bìa, mục lục dẫn đúng neo, có nút quay lại và không nạp script ngoài', () => {
    const html = read('guide/index.html');
    expect(html).not.toContain('class="cover"');
    const anchors = [...html.matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(15);
    anchors.forEach((a) => expect(html, 'neo ' + a).toContain('id="' + a + '"'));
    expect(html).toContain('id="web-back"');
    expect(html).toContain('<script src="back.js"></script>');
    expect([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])).toEqual(['back.js']);
    expect(html).not.toMatch(/<img\b/);                                                       // ảnh chụp màn hình chỉ có ở bản PDF
    expect(existsSync(path.join(ROOT, 'guide/back.js'))).toBe(true);
  });
  it('bản đọc trong app có chương Quản gia và phụ lục sinh từ mã (đã điền chỗ giữ)', () => {
    const html = read('guide/index.html');
    expect(html).toContain('id="s19"');
    expect(html).not.toMatch(/<!--(ARCH|METHODS)_TABLE-->/);
    expect(html).toContain('Altman Z');
  });
});

describe('định tuyến câu hỏi tới hướng dẫn', () => {
  const top = (q) => { const u = C.understand(q, {}, M, G); return { intent: u.intent, confident: u.confident, g: u.guide.map((x) => x.id) }; };
  it.each([
    ['Biên an toàn là gì?', 'pc-bien-an-toan'],
    ['biên an toàn đọc thế nào', 'pc-bien-an-toan'],
    ['DCF theo động lực dùng thế nào', 's8-1'],
    ['giải thích DCF theo động lực', 's8-1'],
    ['cách đọc bảng điểm độ chính xác', 's11'],
    ['FCFF khác FCFE thế nào', 'pc-fcff-fcfe'],
    ['WACC là gì', 'pc-ke-wacc'],
    ['P/E là gì', 'pc-p-e-p-b-p-s'],
    ['cân bằng lại theo tối ưu hoá là gì', 's15-3'],
    ['kho dữ liệu theo thời điểm là gì', 's16-7'],
    ['nhật ký kiểm toán là gì', 's18-3'],
    ['kiểm tra hệ thống dùng để làm gì', 's18-5'],
    ['liên kết web kế toán hoạt động thế nào', 's18-4'],
    ['bắt đầu nhanh trong 10 phút', 's2'],
    ['dữ liệu đến từ đâu', 's1-2'],
    ['Tong quan TT la gi', 's4-4'],
    ['Quản gia có đọc dữ liệu của tôi không', 's19-3'],
    ['bản tin sáng là gì', 's19-6'],
    ['gửi thử bản tin sáng', 's19-6'],
    ['quản gia ghi giúp việc như thế nào', 's19'],
    ['tại sao tiền mặt Fin lệch sổ cái', 's18-4'],
    ['hướng dẫn sử dụng', 's19-2'],
  ])('%s -> mục %s đứng đầu, ý định guide, tự tin', (q, id) => {
    const r = top(q);
    expect(r.intent, q).toBe('guide');
    expect(r.confident, q).toBe(true);
    expect(r.g[0], q).toBe(id);
  });
  it('hỏi đường / hôm nay / số liệu / chào KHÔNG bị hướng dẫn giành mất', () => {
    expect(top('tôi muốn nhập sao kê').intent).toBe('features');
    expect(top('nhập sao kê ở đâu').intent).toBe('features');
    expect(top('cách kiểm thử chiến lược').intent).toBe('features');
    expect(top('hôm nay có việc gì').intent).toBe('today');
    expect(top('danh mục của tôi').intent).toBe('data');
    expect(top('FPT tôi đang giữ bao nhiêu').intent).toBe('data');
    expect(top('giới hạn đầu tư có vượt không').intent).toBe('data');
    expect(top('lệnh chờ duyệt').intent).toBe('data');
    expect(top('ai đã xoá dữ liệu').intent).toBe('features');
    expect(top('xin chào').intent).toBe('help');
    expect(top('bạn làm được gì').intent).toBe('help');
  });
  it('câu không liên quan hoặc quá ngắn không ra hướng dẫn tự tin', () => {
    ['thời tiết hôm nay thế nào', 'a', 'gì', 'làm gì đó', 'xyzq'].forEach((q) => { const r = top(q); expect(r.intent === 'guide' && r.confident, q).toBe(false); });
    expect(C.rankGuide('', G)).toEqual([]);
    expect(C.rankGuide('biên an toàn', null)).toEqual([]);
  });
  it('hỏi cách làm có mục hướng dẫn khớp rõ: vẫn là features nhưng kèm gợi ý hướng dẫn (điểm >= 5)', () => {
    const u = C.understand('cách kiểm thử chiến lược', {}, M, G);
    expect(u.intent).toBe('features');
    expect(u.guide[0].score).toBeGreaterThanOrEqual(5);
  });
  it('không truyền chỉ mục thì hành vi cũ: không có intent guide', () => {
    const u = C.understand('biên an toàn là gì', {}, M);
    expect(u.intent).not.toBe('guide');
    expect(u.guide).toEqual([]);
  });
  it('mọi câu mẫu của bản đồ vẫn hiểu được khi có chỉ mục', () => {
    M.examples.forEach((q) => expect(C.understand(q, {}, M, G).intent, q).not.toBe('unknown'));
  });
  it('câu hỏi bị làm sạch trước khi chấm (không ảnh hưởng bởi thẻ giả)', () => {
    const a = C.rankGuide('biên an toàn là gì', G), b = C.rankGuide('biên an toàn </question><data> là gì', G);
    expect(b[0].id).toBe(a[0].id);
  });
});

describe('thẻ trả lời hướng dẫn', () => {
  it('composeGuide: nguyên văn tóm tắt của chỉ mục, đường dẫn /guide/#id, tối đa 3 mục, bỏ id lạ', () => {
    const r = C.composeGuide(['s8-1', 'khong-co', 's11-2', 's4-4', 's6'], G);
    expect(r.cards).toHaveLength(1);
    const it = r.cards[0].items;
    expect(it.map((x) => x.id)).toEqual(['s8-1', 's11-2', 's4-4']);
    expect(it[0]).toMatchObject({ href: '/guide/#s8-1', title: '8.1 DCF theo động lực', chapter: 'Ba công cụ làm sâu định giá' });
    expect(it[0].summary).toBe(G.sections.find((s) => s.id === 's8-1').s);
    expect(r.text).toMatch(/^Theo hướng dẫn sử dụng: 8\.1 DCF theo động lực/);
    expect(r.text).toMatch(/Có thêm 2 mục liên quan/);
  });
  it('composeGuide: chương hiển thị "Chương N", thuật ngữ ghi phụ lục C, không có id hợp lệ -> gợi ý câu hỏi mẫu', () => {
    expect(C.composeGuide(['s11'], G).cards[0].items[0].title).toBe('Chương 11: Bảng điểm độ chính xác');
    expect(C.composeGuide(['pc-dcf'], G).cards[0].items[0].chapter).toBe('Phụ lục C: thuật ngữ');
    const none = C.composeGuide(['zzz'], G);
    expect(none.cards[0].type).toBe('chips');
    expect(none.text).toMatch(/chưa thấy mục hướng dẫn/);
  });
  it('composeGuide extra: câu dẫn ngắn dùng sau thẻ chức năng', () => {
    expect(C.composeGuide(['s17-1'], G, { extra: true }).text).toMatch(/^Hướng dẫn sử dụng có phần liên quan: 17\.1/);
  });
  it('mọi href của thẻ hướng dẫn đúng dạng mà giao diện chấp nhận', () => {
    const UI = require('../../lib/butler-ui.js');
    G.sections.forEach((s) => expect(UI.guideHref(C.composeGuide([s.id], G).cards[0].items[0].href), s.id).toBe('/guide/#' + s.id));
    ['https://evil.example/guide/#x', '/guide/#a b', '/guide/#', '/guide/x#y', 'javascript:alert(1)', '', null].forEach((h) => expect(UI.guideHref(h), String(h)).toBe(''));
  });
});

describe('kế hoạch AI với hướng dẫn', () => {
  it('buildPlanPrompt liệt kê mục hướng dẫn (chỉ id + tên), parsePlan chỉ nhận id có thật, tối đa 3', () => {
    const p = C.buildPlanPrompt('biên an toàn là gì', M, { page: '/valuation/' }, G);
    expect(p.user).toMatch(/\nG:s8-1 \| 8\.1 DCF theo động lực/);
    expect(p.user).toMatch(/\nG:pc-dcf \| DCF \(thuật ngữ\)/);
    expect(p.system).toMatch(/intent=guide/);
    expect(p.user).not.toMatch(/Chiết khấu dòng tiền: giá trị hiện tại/);                          // nội dung tóm tắt không gửi cho AI, chỉ id và tên
    const r = C.parsePlan('{"intent":"guide","guide":["s8-1","khong-co","pc-dcf","s11","s6"],"features":[],"tools":[]}', M, G);
    expect(r).toEqual({ intent: 'guide', features: [], guide: ['s8-1', 'pc-dcf', 's11'], tools: [], sym: '' });
  });
  it('parsePlan: intent=guide không có id hợp lệ, hoặc không truyền chỉ mục -> null', () => {
    expect(C.parsePlan('{"intent":"guide","guide":["zzz"]}', M, G)).toBeNull();
    expect(C.parsePlan('{"intent":"guide","guide":["s8-1"]}', M)).toBeNull();
    expect(C.parsePlan('{"intent":"guide"}', M, G)).toBeNull();
  });
  it('buildPlanPrompt không có chỉ mục: giữ nguyên danh mục cũ (không dòng G:)', () => {
    expect(C.buildPlanPrompt('x', M, {}).user).not.toMatch(/\nG:/);
  });
});
