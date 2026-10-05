// Sao chép các thư viện thuần của app vào các Edge Function check-limits, approval-watch và valuation-watch (Deno không đọc được thư mục lib/ của app).
// Bản sao = nguyên văn lib/<tên>.js + một dòng `globalThis.<Tên> = <Tên>;` ở cuối (để các thư viện phụ thuộc nhau thấy global như khi nạp bằng thẻ <script>).
// Chạy sau mỗi lần sửa lib/finance-calc.js, portfolio-calc.js, group-calc.js, limits-calc.js hoặc approval-calc.js:  node scripts/sync-edge-libs.mjs
// tests/unit/check-limits.test.js kiểm tra bản sao khớp với lib/ nên quên chạy sẽ làm CI đỏ.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EDGE_LIBS = [
  { file: 'finance-calc.js', global: 'FinCalc' },
  { file: 'portfolio-calc.js', global: 'PortfolioCalc' },
  { file: 'group-calc.js', global: 'GroupCalc' },
  { file: 'limits-calc.js', global: 'LimitsCalc' },
];
// approval-watch chỉ cần thư viện duyệt lệnh
export const WATCH_LIBS = [{ file: 'approval-calc.js', global: 'ApprovalCalc' }];
// valuation-watch: tỷ trọng ngành của nhóm (FinCalc, PortfolioCalc, GroupCalc, SectorMap) + lịch sử định giá và cảnh báo (ValuationHistory, ValuationAlerts)
export const VALUATION_LIBS = [
  { file: 'finance-calc.js', global: 'FinCalc' },
  { file: 'portfolio-calc.js', global: 'PortfolioCalc' },
  { file: 'group-calc.js', global: 'GroupCalc' },
  { file: 'sector-map.js', global: 'SectorMap' },
  { file: 'valuation-history.js', global: 'ValuationHistory' },
  { file: 'valuation-alerts.js', global: 'ValuationAlerts' },
];
export const suffixFor = (g) => `globalThis.${g} = ${g};\n`;
export function expectedCopy(lib) {
  let src = fs.readFileSync(path.join(root, 'lib', lib.file), 'utf8');
  if (!src.endsWith('\n')) src += '\n';
  return src + suffixFor(lib.global);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const lib of EDGE_LIBS) {
    fs.writeFileSync(path.join(root, 'supabase', 'functions', 'check-limits', lib.file), expectedCopy(lib));
    console.log('đã sao chép', lib.file);
  }
  for (const lib of WATCH_LIBS) {
    fs.writeFileSync(path.join(root, 'supabase', 'functions', 'approval-watch', lib.file), expectedCopy(lib));
    console.log('đã sao chép (approval-watch)', lib.file);
  }
  for (const lib of VALUATION_LIBS) {
    fs.writeFileSync(path.join(root, 'supabase', 'functions', 'valuation-watch', lib.file), expectedCopy(lib));
    console.log('đã sao chép (valuation-watch)', lib.file);
  }
}
