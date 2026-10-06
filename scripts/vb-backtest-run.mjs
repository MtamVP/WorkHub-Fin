// Chạy bảng điểm độ chính xác của Valuation Bench (backtest đi tới): tải dữ liệu lịch sử THẬT của VNDirect cho một tập mã, chạy VBEngine tại từng thời điểm trong quá khứ chỉ với dữ liệu có sẵn lúc đó,
// so giá trị hợp lý với lợi suất 6 / 12 tháng sau, rồi ghi valuation/vb-scorecard.js (window.VB_SCORECARD) cho giao diện.
// Cách chạy:  node scripts/vb-backtest-run.mjs [--refresh] [--cache <thư mục>] [--out <tệp>] [--symbols A,B,C] [--icb <tệp json {SYM:"icb2"}>]
// Dữ liệu thô được lưu đệm theo mã để chạy lại nhanh; --refresh tải lại. Cần Node 22+ (đọc trực tiếp tệp .ts của Edge Function vb-data để dùng đúng bộ phân tích dữ liệu).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const refresh = args.includes('--refresh');
const cacheDir = opt('cache', path.join(os.tmpdir(), 'vb-backtest-cache')), outFile = opt('out', path.join(root, 'valuation', 'vb-scorecard.js'));
const DEFAULT_UNIVERSE = 'ACB,BID,BSR,CTG,FPT,GAS,GVR,HDB,HPG,LPB,MBB,MCH,MSN,MWG,SAB,SHB,SSB,SSI,STB,TCB,TCX,VCB,VHM,VIB,VIC,VJC,VNM,VPB,VPL,VRE,PNJ,REE,DGC,DPM,DCM,GMD,KDH,NLG,DXG,VND,HCM,VCI,PLX,POW,VHC,DBC,CTD,HSG,NKG,BVH,PC1,FRT,DGW,PVT,VCG';
const symbols = opt('symbols', DEFAULT_UNIVERSE).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const icbMap = opt('icb') ? JSON.parse(fs.readFileSync(opt('icb'), 'utf8')) : {};

// parse.ts của Edge Function là TypeScript thuần: chép sang thư mục tạm có package.json {"type":"module"} để Node nạp được
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-parse-'));
fs.copyFileSync(path.join(root, 'supabase/functions/vb-data/parse.ts'), path.join(tmp, 'parse.ts')); fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const { FORM_ORDER, MODELS, slimRows, yearsAgo, candlesFromDchart, ratioValues, RATIO_CODES } = await import(pathToFileURL(path.join(tmp, 'parse.ts')).href);
const require = createRequire(import.meta.url);
const VBS = require(path.join(root, 'lib/vb-statements.js')), ENGINE = require(path.join(root, 'lib/vb-engine.js')), BT = require(path.join(root, 'lib/vb-backtest.js'));

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; WorkHubValuationBench/1.0)' }, BASE = 'https://api-finfo.vndirect.com.vn/v4';
const get = async (u) => { for (let k = 0; k < 3; k++) { try { const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(40000) }); if (!r.ok) continue; const j = await r.json(); if (Array.isArray(j?.data)) return j.data; } catch (e) { /* thử lại */ } } return null; };
const raw = async (u) => { for (let k = 0; k < 3; k++) { try { const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(40000) }); if (r.ok) return await r.json(); } catch (e) { /* thử lại */ } } return null; };
const url = (s, t, m, f) => `${BASE}/financial_statements?q=code:${s}~reportType:${t}~modelType:${m}~fiscalDate:gte:${f}&size=4000&fields=itemCode,fiscalDate,numericValue,modelType`;
const now = new Date();
const candles = async (sym) => { const to = Math.floor(Date.now() / 1000) + 172800, from = to - 7 * 366 * 86400; return candlesFromDchart(await raw(`https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=${sym}&from=${from}&to=${to}`), sym); };

fs.mkdirSync(cacheDir, { recursive: true });
async function fetchSymbol(sym) {
  const f = path.join(cacheDir, sym + '.json');
  if (!refresh && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const from = yearsAgo(now, 9), qFrom = yearsAgo(now, 7);
  let form = null, bs = [];
  for (const fm of FORM_ORDER) { const r = await get(url(sym, 'ANNUAL', MODELS[fm][0], from)); if (r && r.length) { form = fm; bs = r; break; } }
  if (!form) return null;
  const [, is, cf] = MODELS[form];
  const [isR, cfR, qB, qI, cd] = await Promise.all([get(url(sym, 'ANNUAL', is, from)), get(url(sym, 'ANNUAL', cf, from)), get(url(sym, 'QUARTER', MODELS[form][0], qFrom)), get(url(sym, 'QUARTER', is, qFrom)), candles(sym)]);
  const codes = new Set(); Object.values(VBS.MAP[form]).forEach((a) => a.forEach((c) => codes.add(c)));
  const ratioSeries = {}, ratioDates = {};
  for (const k of ['pe', 'pb']) { const r = ratioValues(await get(`${BASE}/ratios?q=code:${sym}~ratioCode:${RATIO_CODES[k]}~reportDate:gte:${yearsAgo(now, 7)}&size=4000&sort=reportDate`) ?? []); ratioSeries[k] = r.values; ratioDates[k] = r.dates; }
  const data = { symbol: sym, form, annualRows: slimRows(bs.concat(isR ?? [], cfR ?? []), codes), quarterRows: slimRows((qB ?? []).concat(qI ?? []), codes), candles: cd, ratioSeries, ratioDates, fetchedAt: now.toISOString() };
  if (cd) fs.writeFileSync(f, JSON.stringify(data));
  return data;
}

const idx = await candles('VNINDEX');
if (!idx) { console.error('Không tải được VN-Index.'); process.exit(1); }
const all = [], skipped = [];
for (const sym of symbols) {
  let data = null; try { data = await fetchSymbol(sym); } catch (e) { /* bỏ qua mã lỗi */ }
  if (!data || !data.candles || data.candles.t.length < 400) { skipped.push(sym); console.log(sym, 'bỏ qua (thiếu dữ liệu)'); continue; }
  const t0 = Date.now(), obs = BT.runSymbol(data, ENGINE, idx, { warmup: 150, step: 21, sectorCode: icbMap[sym] || null, mc: 1 });
  all.push(...obs); console.log(sym, data.form, 'candles', data.candles.t.length, 'quan sát', obs.length, (Date.now() - t0) + 'ms');
}
const used = [...new Set(all.map((x) => x.symbol))];
const card = BT.scorecard(all, { generatedAt: new Date().toISOString().slice(0, 10), universe: { requested: symbols.length, used: used.length, skipped: skipped } }, { boot: 300 });
fs.writeFileSync(outFile, '// Tạo bởi scripts/vb-backtest-run.mjs: KHÔNG sửa tay. Xem lib/vb-backtest.js về cách tính và các giới hạn.\nwindow.VB_SCORECARD = ' + JSON.stringify(card) + ';\n');
fs.writeFileSync(path.join(cacheDir, 'observations.json'), JSON.stringify(all));
console.log('xong:', card.nObs, 'quan sát,', card.nSymbols, 'mã,', card.nDates, 'ngày; ghi', outFile);
fs.rmSync(tmp, { recursive: true, force: true });
