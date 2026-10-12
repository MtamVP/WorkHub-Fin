// Sinh từ docs/huong-dan-su-dung.html (nguồn viết tay + phụ lục sinh từ mã) HAI thứ dùng chung một nguồn nên luôn khớp nhau:
//   1. lib/butler-guide-data.js  = chỉ mục hướng dẫn cho Quản gia (mỗi mục: id, chương, tiêu đề, tóm tắt, từ khoá, từ đặc trưng) -> Quản gia trả lời câu hỏi "là gì / cách đọc / cách tính" bằng QUY TẮC, dẫn tới đúng mục.
//   2. guide/index.html          = bản đọc ngay trong app (mỗi mục có id để mở thẳng: /guide/#s4-4).
// Chạy:  node scripts/build-guide-web.mjs   (ghi hai tệp trên).  tests/unit/butler-guide.test.js dựng lại trong bộ nhớ và so với hai tệp đã commit: sửa hướng dẫn mà quên chạy lệnh trên thì CI đỏ.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { appendices, fillAppendices } from './guide-appendix.mjs';

const require = createRequire(import.meta.url);
export const GUIDE_HREF = (id) => '/guide/#' + id;

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&nbsp;': ' ', '&#39;': "'", '&middot;': '·' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|nbsp|#39|middot);/g, (m) => ENT[m] || m);
const plain = (html) => decode(String(html)
  .replace(/<figure[\s\S]*?<\/figure>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<\/(p|li|tr|dt|dd|div|h[1-6]|table|ol|ul|figcaption)>|<br\s*\/?>|<\/t[dh]>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/ ([,.;:!?)])/g, '$1').replace(/\( /g, '(').trim();
const clip = (s, max) => { if (s.length <= max) return s; const cut = s.slice(0, max - 1), sp = cut.lastIndexOf(' '); return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '') + '…'; };
const slug = (C, s) => C.fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

// Tên mục: "4.4 Tổng Quan TT (mới)" -> n = "4.4", t = "Tổng Quan TT (mới)". Chương: "4. Investment Workbench" -> n = "4". Phụ lục: "Phụ lục A: ..." -> n = "A"
function splitTitle(raw) {
  const t = plain(raw);
  let m;
  if ((m = /^(\d+(?:\.\d+)?)\.?\s+(.*)$/.exec(t))) return { n: m[1], t: m[2] };
  if (/^Phụ lục [A-Z]\s*:/.test(t)) return { n: '', t };
  return { n: '', t };
}

export function generate(root) {
  const C = require(path.join(root, 'lib/butler-core.js'));
  const ver = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
  const ap = appendices(root);
  const src = fs.readFileSync(path.join(root, 'docs', 'huong-dan-su-dung.html'), 'utf8').replace(/\r\n/g, '\n');
  const html = fillAppendices(src, ap);
  const start = html.indexOf('<h1 id="s1">');
  if (start < 0) throw new Error('Không thấy chương 1 trong nguồn hướng dẫn.');
  const body = html.slice(start);

  // ---- tách theo tiêu đề h1 / h2 ----
  const re = /<h([12])([^>]*)>([\s\S]*?)<\/h\1>/g, heads = [];
  let m;
  while ((m = re.exec(body)) !== null) heads.push({ lv: Number(m[1]), attrs: m[2], raw: m[3], at: m.index, end: m.index + m[0].length });
  const secs = [];
  let chap = null, h2idx = 0;
  heads.forEach((hd, i) => {
    const block = body.slice(hd.end, i + 1 < heads.length ? heads[i + 1].at : body.length);
    const { n, t } = splitTitle(hd.raw);
    if (hd.lv === 1) {
      const idm = /id="([\w-]+)"/.exec(hd.attrs);
      chap = { id: idm ? idm[1] : 'c' + i, n, t }; h2idx = 0;
      secs.push({ id: chap.id, lv: 1, n, t, ct: chap.t, block, head: hd });
    } else {
      h2idx++;
      const nm = /^(\d+)\.(\d+)$/.exec(n);
      const id = nm ? 's' + nm[1] + '-' + nm[2] : chap.id + '-x' + h2idx;
      secs.push({ id, lv: 2, n, t, ct: chap.t, cn: chap.n, cid: chap.id, block, head: hd });
    }
  });
  secs.forEach((s) => { if (s.lv === 1) s.cn = s.n; });

  // ---- phụ lục C: mỗi thuật ngữ một mục ----
  const terms = [];
  const glo = secs.find((s) => s.id === 'pc');
  if (glo) {
    const dre = /<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g; let d;
    while ((d = dre.exec(glo.block)) !== null) {
      const name = plain(d[1]), id = 'pc-' + slug(C, name);
      terms.push({ id, lv: 2, n: '', t: name, ct: glo.ct, cn: glo.n, def: plain(d[2]), raw: d[0], pid: 'pc' });
    }
  }

  // ---- văn bản, tóm tắt, từ khoá của từng mục ----
  const all = secs.map((s) => {
    const noTbl = s.block.replace(/<table[\s\S]*?<\/table>/g, ' ').replace(/<figure[\s\S]*?<\/figure>/g, ' ');
    const lead = []; let lm; const lre = /<(p|li)[^>]*>([\s\S]*?)<\/\1>/g;
    while ((lm = lre.exec(noTbl)) !== null) { const x = plain(lm[2]); if (x.length >= 12) lead.push(x); if (lead.join(' ').length >= 240) break; }
    let summary = lead.join(' '), text = plain(s.block);
    if (!summary) summary = plain(s.block.replace(/<thead>[\s\S]*?<\/thead>/g, ' '));                                                            // mục chỉ có bảng / danh sách: lấy đầu phần chữ của bảng
    if (s.lv === 1) {                                                                          // chương: tổng quan = phần mở đầu + tên các mục con (chương chỉ có mục con vẫn tìm được)
      const kids = secs.filter((x) => x.lv === 2 && x.cid === s.id).map((x) => (x.n ? x.n + ' ' : '') + x.t);
      if (summary.length < 60 && kids.length) summary = (summary ? summary + ' ' : '') + 'Gồm: ' + kids.join(' · ') + '.';
      text = text + ' ' + kids.join(' ');
    }
    return { id: s.id, n: s.n, t: s.t, ct: s.ct, cn: s.cn, lv: s.lv, text, summary: clip(summary, 280), block: s.block };
  });
  terms.forEach((x) => all.push({ id: x.id, n: '', t: x.t, ct: x.ct, cn: x.cn, lv: 3, text: x.t + ' ' + x.def, summary: clip(x.def, 280), block: x.raw, term: true }));

  const N = all.length;
  const sets = all.map((s) => { const g = C.gramsOf(s.t + ' ' + s.text); const tf = new Map(); g.forEach((x) => tf.set(x, (tf.get(x) || 0) + 1)); return tf; });
  const df = new Map(); sets.forEach((tf) => tf.forEach((_v, k) => df.set(k, (df.get(k) || 0) + 1)));

  // từ khoá: tên mục + chữ in đậm / giao diện / mã / ô đầu bảng; bỏ cụm xuất hiện ở quá nhiều mục
  const keyRaw = all.map((s) => {
    const ks = [];
    if (s.term) s.t.split(/\s*,\s*|\s+\/\s+/).forEach((x) => ks.push(x.trim()));                    // "Ke, WACC" / "VaR / ES" tách ra; "P/E" giữ nguyên
    else {
      const bare = s.t.replace(/\s*\((mới[^)]*)\)\s*$/i, '');
      ks.push(bare);
      const colon = bare.split(/\s*[:—]\s*/)[0];                                                // "Market Simulation: mô phỏng xác suất" -> thêm "Market Simulation"
      if (colon && colon !== bare) ks.push(colon);
    }
    const add = (re, fn) => { let k; while ((k = re.exec(s.block)) !== null) { const v = plain(fn ? fn(k) : k[1]); if (v.length >= 2 && v.length <= 40 && !/^[\d.,% ×x-]+$/.test(v)) ks.push(v); } };
    add(/<span class="ui">([\s\S]*?)<\/span>/g); add(/<tr><td[^>]*>([\s\S]*?)<\/td>/g); add(/<b>([\s\S]*?)<\/b>/g); add(/<code>([\s\S]*?)<\/code>/g);
    return ks;
  });
  const kdf = new Map(); keyRaw.forEach((ks) => new Set(ks.map((x) => C.tokens(x).join(" "))).forEach((k) => kdf.set(k, (kdf.get(k) || 0) + 1)));
  if (all.some((s) => s.id === 'pb')) {
    const pb = keyRaw[all.findIndex((s) => s.id === 'pb')]; ap.methodNames.forEach((x) => pb.push(x));
  }
  // cụm quá phổ biến (gặp ở > 8% số mục: "định giá", "dữ liệu"...): không dùng làm từ khoá riêng của mục (lúc chấm điểm chúng đã bị giảm trọng số bằng IDF)
  const common = [...df.entries()].filter(([, c]) => c > N * 0.08).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 320).map(([k]) => k);
  const commonSet = new Set(common);
  const sections = all.map((s, i) => {
    const seen = new Set(), keys = [];
    keyRaw[i].forEach((k, j) => { const f = C.tokens(k).join(' '); if (!f || seen.has(f)) return; if (j > 0 && ((kdf.get(f) || 0) > 4 || commonSet.has(f))) return; seen.add(f); keys.push(k); });
    const max = s.id === 'pb' ? 50 : 12;
    const tf = sets[i], scored = [...tf.entries()].map(([k, v]) => ({ k, sc: v * Math.log(1 + N / (df.get(k) || 1)) * (k.indexOf(' ') > 0 ? 1.3 : 1) })).sort((a, b) => b.sc - a.sc || (a.k < b.k ? -1 : 1));
    const w = scored.slice(0, 20).map((x) => x.k);
    const o = { id: s.id, n: s.n, t: s.t, ct: s.ct, s: s.summary, k: keys.slice(0, max), w: w.join('|') };
    if (s.lv === 3) o.p = 'pc'; return o;
  });

  const data = '// TỆP SINH TỰ ĐỘNG từ docs/huong-dan-su-dung.html bằng `node scripts/build-guide-web.mjs` -- KHÔNG sửa tay. Chỉ mục hướng dẫn cho Quản gia: mỗi mục có id (mở ở /guide/#id), tên, tóm tắt, từ khoá.\n'
    + '// Trang dùng làm phương án dự phòng khi mất kết nối máy chủ; Edge Function butler đọc cùng nội dung này từ bảng butler_guide (finance-butler-guide-data.sql). Trường: n = số mục, t = tên, ct = tên chương, s = tóm tắt, k = từ khoá, w = từ / cặp từ đặc trưng (đã bỏ dấu), p = mục cha (thuật ngữ).\n'
    + 'const ButlerGuideData = ' + JSON.stringify({ version: ver, sections }, null, 0).replace(/\},\{/g, '},\n{') + ';\n\n'
    + "if (typeof module !== 'undefined' && module.exports) module.exports = ButlerGuideData;\nglobalThis.ButlerGuideData = ButlerGuideData;\n";

  // ---- SQL nạp bảng butler_guide (Edge Function butler đọc bảng này; chạy lại an toàn, mục cũ của bản trước bị xoá ở câu cuối) ----
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const rows = sections.map((s, i) => '(' + [q(s.id), i + 1, q(ver), q(s.n), q(s.t), q(s.ct), q(s.s), q(JSON.stringify(s.k)) + '::jsonb', q(s.w), s.p ? q(s.p) : 'null'].join(', ') + ')');
  const stmts = [];
  for (let i = 0; i < rows.length; i += 12) {
    stmts.push('insert into public.butler_guide (id, ord, ver, n, t, ct, s, k, w, p) values\n' + rows.slice(i, i + 12).join(',\n')
      + '\non conflict (id) do update set ord = excluded.ord, ver = excluded.ver, n = excluded.n, t = excluded.t, ct = excluded.ct, s = excluded.s, k = excluded.k, w = excluded.w, p = excluded.p;');
  }
  stmts.push('delete from public.butler_guide where ver <> ' + q(ver) + ';');
  const sql = '-- TỆP SINH TỰ ĐỘNG từ docs/huong-dan-su-dung.html bằng `node scripts/build-guide-web.mjs` -- KHÔNG sửa tay. Nạp chỉ mục hướng dẫn cho Quản gia (bảng butler_guide, tạo bởi finance-butler-guide-migration.sql).\n'
    + '-- Áp dụng sau MỖI lần hướng dẫn đổi hoặc nâng phiên bản: chạy toàn bộ tệp này (từng câu lệnh độc lập, chạy lại an toàn). Phiên bản chỉ mục: ' + ver + ', ' + sections.length + ' mục.\n\n' + stmts.join('\n\n') + '\n';

  // ---- bản đọc trong app ----
  let web = html.replace(/\r\n/g, '\n');
  web = web.replace(/<section class="cover">[\s\S]*?<\/section>\s*/, '');
  web = web.replace(/<figure>[\s\S]*?<figcaption>([\s\S]*?)<\/figcaption><\/figure>/g, (_m, cap) => '<p class="small fig">Ảnh minh hoạ: ' + cap + ' (xem bản PDF)</p>');
  let h2n = 0, ch = '';
  web = web.replace(/<h([12])([^>]*)>([\s\S]*?)<\/h\1>/g, (full, lv, attrs, raw) => {
    if (lv === '1') { const im = /id="([\w-]+)"/.exec(attrs); ch = im ? im[1] : ch; h2n = 0; return full; }
    h2n++;
    const { n } = splitTitle(raw), nm = /^(\d+)\.(\d+)$/.exec(n);
    const id = nm ? 's' + nm[1] + '-' + nm[2] : ch + '-x' + h2n;
    return '<h2 id="' + id + '">' + raw + '</h2>';
  });
  const pcAt = web.indexOf('<h1 id="pc">');                                                    // chỉ thuật ngữ của phụ lục C có neo (các <dl> khác trong hướng dẫn không dùng)
  if (pcAt >= 0) web = web.slice(0, pcAt) + web.slice(pcAt).replace(/<dt>([\s\S]*?)<\/dt>/g, (_f, raw) => '<dt id="pc-' + slug(C, plain(raw)) + '">' + raw + '</dt>');
  web = web.replace('<head>', '<head>\n<meta name="viewport" content="width=device-width, initial-scale=1">');
  const css = '<style>\n@media screen {\n  html { font-size: 16px; background: #fff; color-scheme: light; }\n  body { max-width: 900px; margin: 0 auto; padding: 0 20px 80px; background: #fff; color: var(--ink); }\n'
    + '  h1 { break-before: auto; margin-top: 48px; scroll-margin-top: 64px; } h1.first { margin-top: 16px; } h2, h3, dt { scroll-margin-top: 64px; }\n'
    + '  :target { background: #FFF4CC; outline: 6px solid #FFF4CC; border-radius: 3px; }\n'
    + '  table { display: block; overflow-x: auto; } .toc { columns: 2; }\n'
    + '  .webbar { position: sticky; top: 0; z-index: 5; display: flex; gap: 14px; align-items: center; padding: 10px 0; margin-bottom: 8px; background: #fff; border-bottom: 1px solid var(--rule); font-size: 14px; }\n'
    + '  .webbar a { font-weight: 600; } .webbar a:focus-visible { outline: 2px solid var(--info); outline-offset: 2px; } .webbar span { color: var(--muted); margin-left: auto; }\n'
    + '}\n@media screen and (max-width: 720px) { .toc { columns: 1; } .two { grid-template-columns: 1fr; } .webbar span { display: none; } }\n@media print { .webbar { display: none; } }\n</style>\n';
  web = web.replace('</head>', css + '</head>');
  web = web.replace('<body>', '<body>\n<nav class="webbar" aria-label="Điều hướng hướng dẫn"><a id="web-back" href="/">&larr; Quay lại WorkHub Fin</a><span>Hướng dẫn sử dụng · phiên bản ' + ver + '</span></nav>');
  web = web.replace('</body>', '<script src="back.js"></script>\n</body>');
  return { ver, sections, data, sql, web, ids: { sections: sections.map((s) => s.id) } };
}

export const BACK_JS = "// Nút \"Quay lại\" của trang hướng dẫn: quay về trang vừa mở (nếu có), không thì về trang chính (href mặc định).\n(function () {\n  var a = document.getElementById('web-back');\n  if (!a) return;\n  a.addEventListener('click', function (ev) { if (window.history.length > 1) { ev.preventDefault(); window.history.back(); } });\n})();\n";
