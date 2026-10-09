// Dựng hướng dẫn sử dụng PDF: docs/huong-dan-su-dung.html (nguồn viết tay, có chỗ giữ cho các phụ lục) -> chèn phụ lục sinh từ mã nguồn thật (bảng vai trò theo mô hình kinh doanh
// từ lib/vb-process.js, thư viện phương pháp từ valuation/vb-methods.js) -> in ra PDF bằng Microsoft Edge/Chrome headless qua giao thức DevTools (có đánh số trang).
// Dùng:  node scripts/build-user-guide.mjs [--out <tệp.pdf>] [--browser <đường dẫn msedge.exe|chrome.exe>]     Cần Node 22+ (WebSocket toàn cục).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..'), require = createRequire(import.meta.url);
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const outPdf = opt('out', path.join(root, 'docs', 'HuongDan-WorkHub-Fin-0.1.17.pdf'));
const candidates = [opt('browser', ''), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
const browser = candidates.find((p) => fs.existsSync(p));
if (!browser) { console.error('Không tìm thấy Edge/Chrome. Dùng --browser <đường dẫn>.'); process.exit(1); }

const P = require(path.join(root, 'lib/vb-process.js')), M = require(path.join(root, 'valuation/vb-methods.js'));
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- Phụ lục A: vai trò phương pháp theo mô hình kinh doanh ----
const label = (k) => (P.META[k] ? P.META[k].label : k);
const tags = (arch, role) => { const ks = Object.keys(arch.roles).filter((k) => arch.roles[k] === role); return ks.length ? ks.map((k) => '<span class="tag ' + role + '">' + esc(label(k)) + '</span>').join(' ') : '<span class="small">—</span>'; };
const ROLE_LABEL = { core: 'Chính (trọng số 2,5)', support: 'Hỗ trợ (1,2)', check: 'Đối chiếu (0,5)', ref: 'Tham khảo (0, chỉ hiển thị)' };
const archBlocks = Object.keys(P.ARCH).map((k) => {
  const a = P.ARCH[k];
  const rows = ['core', 'support', 'check', 'ref'].map((r) => '<tr><td style="width:26%"><b>' + ROLE_LABEL[r] + '</b></td><td>' + tags(a, r) + '</td></tr>').join('');
  return '<div class="arch"><h4>' + esc(a.label) + '</h4><p class="small">' + esc(a.desc) + '</p><table class="roles"><tbody>' + rows + '</tbody></table></div>';
}).join('');
const archTable = archBlocks + '<p class="small">Phương pháp ở tình trạng "Hạn chế" bị giảm một nửa trọng số. Bảng vai trò đã được hiệu chỉnh theo bảng điểm backtest 10/2026 (xem mục 11).</p>';

// ---- Phụ lục B: thư viện phương pháp ----
const groupHtml = Object.keys(M.GROUPS).map((g) => {
  const items = M.LIST.filter((m) => m.group === g);
  if (!items.length) return '';
  return '<h3>' + esc(M.GROUPS[g]) + ' <span class="small">(' + items.length + ' mục)</span></h3><table><thead><tr><th style="width:30%">Phương pháp</th><th>Công thức / cách tính</th></tr></thead><tbody>' + items.map((m) => '<tr><td><b>' + esc(m.name) + '</b></td><td>' + esc(m.formula) + '</td></tr>').join('') + '</tbody></table>';
}).join('');

let html = fs.readFileSync(path.join(root, 'docs', 'huong-dan-su-dung.html'), 'utf8');
if (!html.includes('<!--ARCH_TABLE-->') || !html.includes('<!--METHODS_TABLE-->')) { console.error('Thiếu chỗ giữ phụ lục trong nguồn HTML.'); process.exit(1); }
html = html.replace('<!--ARCH_TABLE-->', archTable).replace('<!--METHODS_TABLE-->', groupHtml);
const tmpHtml = path.join(root, 'docs', '_build-guide.html');
fs.writeFileSync(tmpHtml, html);

// ---- in PDF qua DevTools ----
const PORT = 9360 + Math.floor(Math.random() * 40), udd = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-pdf-'));
const proc = spawn(browser, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + PORT, '--user-data-dir=' + udd, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null; for (let i = 0; i < 80 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch (e) { await sleep(250); } }
if (!targets) { proc.kill(); console.error('Không kết nối được trình duyệt.'); process.exit(1); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (d) => (d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
try {
  await send('Page.enable');
  await send('Page.navigate', { url: pathToFileURL(tmpHtml).href }); await sleep(2500);
  await send('Runtime.enable');
  await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))))', awaitPromise: true });
  const foot = '<div style="width:100%;font-size:8px;color:#5B6773;font-family:Segoe UI,Arial,sans-serif;display:flex;justify-content:space-between;padding:0 17mm"><span>WorkHub Fin 0.1.17 · Hướng dẫn sử dụng</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>';
  const r = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: foot, marginTop: 0.75, marginBottom: 0.8, marginLeft: 0.65, marginRight: 0.65 });
  fs.writeFileSync(outPdf, Buffer.from(r.data, 'base64'));
  console.log('Đã ghi', outPdf, Math.round(fs.statSync(outPdf).size / 1024) + ' KB');
} finally { ws.close(); proc.kill(); try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) { /* bỏ qua */ } fs.rmSync(tmpHtml, { force: true }); }
