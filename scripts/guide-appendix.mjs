// Phụ lục của hướng dẫn sử dụng, sinh từ mã nguồn thật (dùng chung cho bản PDF scripts/build-user-guide.mjs và bản đọc trong app scripts/guide-index.mjs):
//   A = bảng vai trò phương pháp theo mô hình kinh doanh (lib/vb-process.js), B = thư viện phương pháp (valuation/vb-methods.js).
import path from 'node:path';
import { createRequire } from 'node:module';

export const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function appendices(root) {
  const require = createRequire(import.meta.url);
  const P = require(path.join(root, 'lib/vb-process.js')), M = require(path.join(root, 'valuation/vb-methods.js'));
  const label = (k) => (P.META[k] ? P.META[k].label : k);
  const tags = (arch, role) => { const ks = Object.keys(arch.roles).filter((k) => arch.roles[k] === role); return ks.length ? ks.map((k) => '<span class="tag ' + role + '">' + esc(label(k)) + '</span>').join(' ') : '<span class="small">—</span>'; };
  const ROLE_LABEL = { core: 'Chính (trọng số 2,5)', support: 'Hỗ trợ (1,2)', check: 'Đối chiếu (0,5)', ref: 'Tham khảo (0, chỉ hiển thị)' };
  const archBlocks = Object.keys(P.ARCH).map((k) => {
    const a = P.ARCH[k];
    const rows = ['core', 'support', 'check', 'ref'].map((r) => '<tr><td style="width:26%"><b>' + ROLE_LABEL[r] + '</b></td><td>' + tags(a, r) + '</td></tr>').join('');
    return '<div class="arch"><h4>' + esc(a.label) + '</h4><p class="small">' + esc(a.desc) + '</p><table class="roles"><tbody>' + rows + '</tbody></table></div>';
  }).join('');
  const archTable = archBlocks + '<p class="small">Phương pháp ở tình trạng "Hạn chế" bị giảm một nửa trọng số. Bảng vai trò đã được hiệu chỉnh theo bảng điểm backtest 10/2026 (xem mục 11).</p>';
  const groupHtml = Object.keys(M.GROUPS).map((g) => {
    const items = M.LIST.filter((m) => m.group === g);
    if (!items.length) return '';
    return '<h3>' + esc(M.GROUPS[g]) + ' <span class="small">(' + items.length + ' mục)</span></h3><table><thead><tr><th style="width:30%">Phương pháp</th><th>Công thức / cách tính</th></tr></thead><tbody>' + items.map((m) => '<tr><td><b>' + esc(m.name) + '</b></td><td>' + esc(m.formula) + '</td></tr>').join('') + '</tbody></table>';
  }).join('');
  return { archTable, groupHtml, methodNames: M.LIST.map((m) => m.name) };
}

// Điền hai chỗ giữ <!--ARCH_TABLE--> / <!--METHODS_TABLE--> của nguồn hướng dẫn
export function fillAppendices(html, ap) {
  if (!html.includes('<!--ARCH_TABLE-->') || !html.includes('<!--METHODS_TABLE-->')) throw new Error('Thiếu chỗ giữ phụ lục trong nguồn HTML.');
  return html.replace('<!--ARCH_TABLE-->', () => ap.archTable).replace('<!--METHODS_TABLE-->', () => ap.groupHtml);
}
