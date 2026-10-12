// Ghi lib/butler-guide-data.js, guide/index.html (+ guide/back.js) và finance-butler-guide-data.sql từ docs/huong-dan-su-dung.html.  Dùng:  node scripts/build-guide-web.mjs
// Chạy lại mỗi khi sửa hướng dẫn hoặc nâng phiên bản (test butler-guide.test.js bắt quên). Sau đó ÁP DỤNG finance-butler-guide-data.sql lên Supabase (Edge Function butler đọc chỉ mục từ bảng butler_guide: không cần triển khai lại hàm).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, BACK_JS } from './guide-index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const g = generate(root);
fs.mkdirSync(path.join(root, 'guide'), { recursive: true });
fs.writeFileSync(path.join(root, 'lib', 'butler-guide-data.js'), g.data);
fs.writeFileSync(path.join(root, 'guide', 'index.html'), g.web);
fs.writeFileSync(path.join(root, 'guide', 'back.js'), BACK_JS);
fs.writeFileSync(path.join(root, 'finance-butler-guide-data.sql'), g.sql);
console.log('Đã ghi lib/butler-guide-data.js (' + Math.round(g.data.length / 1024) + ' KB, ' + g.sections.length + ' mục), guide/index.html (' + Math.round(g.web.length / 1024) + ' KB) và finance-butler-guide-data.sql (' + Math.round(g.sql.length / 1024) + ' KB), phiên bản ' + g.ver);
