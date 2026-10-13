// Sao chép các thư viện thuần của app vào các Edge Function check-limits, approval-watch, valuation-watch, vb-data, source-watch, sim-watch, insight-sync và bt-data (Deno không đọc được thư mục lib/ của app).
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
// vb-data chỉ cần bảng ánh xạ mã khoản mục của lib/vb-statements.js để lọc đúng các khoản mục cần dùng
export const VBDATA_LIBS = [{ file: 'vb-statements.js', global: 'VBStatements' }];
// source-watch cần lịch nghỉ lễ của sàn để không báo sai vào ngày lễ
export const SOURCEWATCH_LIBS = [{ file: 'vn-holidays.js', global: 'VnHolidays' }];
// sim-watch chấm điểm nhật ký mô phỏng bằng đúng SimScore của trang và logic theo dõi SimWatch
export const SIMWATCH_LIBS = [{ file: 'sim-score.js', global: 'SimScore' }, { file: 'sim-watch.js', global: 'SimWatch' }];
// sim-watch cũng cần phần chuẩn hoá sự kiện doanh nghiệp (cổ tức, thưởng, chia tách) của hàm stock-events để điều chỉnh giá các mã trước khi chấm "danh mục giữ nguyên": bản sao nguyên văn tệp .ts
export const SIMWATCH_TS = [{ from: 'supabase/functions/stock-events/parse.ts', to: 'supabase/functions/sim-watch/events-parse.ts' }];
// insight-sync: kiểm luận điểm (ThesisCalc) và đọc dữ liệu sở hữu (OwnershipCalc) bằng đúng bản của trang; news-parse.ts là bản sao nguyên văn parse.ts của market-news (cùng nguồn RSS)
export const INSIGHT_LIBS = [{ file: 'thesis-calc.js', global: 'ThesisCalc' }, { file: 'ownership-calc.js', global: 'OwnershipCalc' }, { file: 'news-events.js', global: 'NewsEvents' }, { file: 'action-inbox.js', global: 'ActionInbox' }];
export const INSIGHT_TS = [{ from: 'supabase/functions/market-news/parse.ts', to: 'supabase/functions/insight-sync/news-parse.ts' }];
// bt-data dựng ngược bảng số liệu theo thời điểm bằng đúng buildSnapshot / bảng mã chỉ số của market-data-sync (bản sao nguyên văn peers.ts và logic.ts)
export const BTDATA_TS = [
  { from: 'supabase/functions/market-data-sync/peers.ts', to: 'supabase/functions/bt-data/peers.ts' },
  { from: 'supabase/functions/market-data-sync/logic.ts', to: 'supabase/functions/bt-data/logic.ts' },
];
// Chốt chặn cron (supabase/functions/_shared/cron-guard.ts) được chép nguyên văn vào mọi Edge Function dùng service role mà pg_cron hoặc người dùng gọi
export const CRON_GUARD_FUNCTIONS = ['bt-data', 'insight-sync', 'sim-watch', 'market-data-sync', 'check-limits', 'approval-watch', 'valuation-watch', 'source-watch', 'refresh-financials', 'fetch-stock-prices', 'send-price-alerts'];
// butler (AI Quản gia): lõi + bản đồ tính năng dùng đúng bản của trang, và ai.ts (khuôn gọi Gemini, chuỗi mô hình dự phòng, chống tiêm lệnh) là bản sao nguyên văn của market-news-ai/ai.ts
export const BUTLER_LIBS = [{ file: 'butler-core.js', global: 'ButlerCore' }, { file: 'butler-map-fin.js', global: 'ButlerMapFin' }];
export const BUTLER_TS = [{ from: 'supabase/functions/market-news-ai/ai.ts', to: 'supabase/functions/butler/ai.ts' }];
// butler-data (công cụ dữ liệu của Quản gia, chỉ đọc bằng JWT người hỏi): dùng đúng bốn thư viện tính của check-limits (EDGE_LIBS) và compliance.ts (chấm tuân thủ giới hạn)
export const BUTLERDATA_LIBS = EDGE_LIBS;
export const BUTLERDATA_TS = [{ from: 'supabase/functions/check-limits/compliance.ts', to: 'supabase/functions/butler-data/compliance.ts' }];
// butler-brief (bản tin sáng của Quản gia, service role): CHỈ dùng chốt chặn cron; allowUser theo mode ('me' = người dùng bấm Gửi thử), nên không nằm trong CRON_GUARD_FUNCTIONS (test cron-guard buộc mẫu allowUser cố định) -- tests/unit/butler-brief.test.js kiểm riêng
export const BRIEF_GUARD_FUNCTIONS = ['butler-brief'];
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
  for (const lib of VBDATA_LIBS) {
    fs.writeFileSync(path.join(root, 'supabase', 'functions', 'vb-data', lib.file), expectedCopy(lib));
    console.log('đã sao chép (vb-data)', lib.file);
  }
  for (const lib of SIMWATCH_LIBS) {
    fs.writeFileSync(path.join(root, 'supabase', 'functions', 'sim-watch', lib.file), expectedCopy(lib));
    console.log('đã sao chép (sim-watch)', lib.file);
  }
  for (const c of SIMWATCH_TS) {
    fs.writeFileSync(path.join(root, c.to), fs.readFileSync(path.join(root, c.from), 'utf8'));
    console.log('đã sao chép (sim-watch)', c.to);
  }
  for (const lib of INSIGHT_LIBS) {
    fs.writeFileSync(path.join(root, 'supabase', 'functions', 'insight-sync', lib.file), expectedCopy(lib));
    console.log('đã sao chép (insight-sync)', lib.file);
  }
  for (const c of INSIGHT_TS) {
    fs.writeFileSync(path.join(root, c.to), fs.readFileSync(path.join(root, c.from), 'utf8'));
    console.log('đã sao chép (insight-sync)', c.to);
  }
  for (const c of BTDATA_TS) {
    fs.writeFileSync(path.join(root, c.to), fs.readFileSync(path.join(root, c.from), 'utf8'));
    console.log('đã sao chép (bt-data)', c.to);
  }
  for (const lib of SOURCEWATCH_LIBS) {
    fs.writeFileSync(path.join(root, 'supabase', 'functions', 'source-watch', lib.file), expectedCopy(lib));
    console.log('đã sao chép (source-watch)', lib.file);
  }
  for (const lib of BUTLER_LIBS) {
    fs.writeFileSync(path.join(root, 'supabase', 'functions', 'butler', lib.file), expectedCopy(lib));
    console.log('đã sao chép (butler)', lib.file);
  }
  for (const c of BUTLER_TS) {
    fs.writeFileSync(path.join(root, c.to), fs.readFileSync(path.join(root, c.from), 'utf8'));
    console.log('đã sao chép (butler)', c.to);
  }
  for (const lib of BUTLERDATA_LIBS) {
    fs.writeFileSync(path.join(root, 'supabase', 'functions', 'butler-data', lib.file), expectedCopy(lib));
    console.log('đã sao chép (butler-data)', lib.file);
  }
  for (const c of BUTLERDATA_TS) {
    fs.writeFileSync(path.join(root, c.to), fs.readFileSync(path.join(root, c.from), 'utf8'));
    console.log('đã sao chép (butler-data)', c.to);
  }
  const guard = fs.readFileSync(path.join(root, 'supabase', 'functions', '_shared', 'cron-guard.ts'), 'utf8');
  for (const fn of CRON_GUARD_FUNCTIONS.concat(BRIEF_GUARD_FUNCTIONS)) {
    fs.writeFileSync(path.join(root, 'supabase', 'functions', fn, 'cron-guard.ts'), guard);
    console.log('đã sao chép (' + fn + ')', 'cron-guard.ts');
  }
}
