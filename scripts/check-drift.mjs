// Enterprise-readiness mục 4 -- cảnh báo trôi lệch giữa 3 app WorkHub (fin/sci/org).
// Chạy từ workspace root của workflow "cross-app-drift" (xem .github/workflows/ci.yml):
//   self/           -- checkout của chính repo đang chạy CI
//   sibling-fin/     sibling-sci/      sibling-org/   -- clone nông 2 repo anh em còn lại
//
// Hai kiểu kiểm tra:
//   1. calendar-connect.js -- PHẢI giống hệt byte-for-byte cả 3 app (đã xác nhận md5 giống
//      hệt tại thời điểm viết) -- fail CI nếu khác.
//   2. Khối Personal Hub trong script.js -- ĐÃ lệch nhau thật dù dùng chung PERSONAL_SHIM
//      (xem scripts/drift-baseline.json), nên chỉ CẢNH BÁO (không fail) khi số dòng khác
//      biệt tăng đáng kể so với baseline đã đo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const APP_DIR_BY_NAME = { 'wh-fin': 'sibling-fin', 'wh-sci': 'sibling-sci', 'wh-org': 'sibling-org' };
const SELF_KEY_BY_NAME = { 'wh-fin': 'fin', 'wh-sci': 'sci', 'wh-org': 'org' };

let failed = false;

function md5(filePath) {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function extractRange(filePath, start, end) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r\n|\n/);
  return lines.slice(start - 1, end).join('\n') + '\n';
}

function diffLineCount(textA, textB) {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || process.env.TEMP || '/tmp', 'wh-drift-'));
  const fa = path.join(dir, 'a.txt');
  const fb = path.join(dir, 'b.txt');
  fs.writeFileSync(fa, textA);
  fs.writeFileSync(fb, textB);
  let out = '';
  try {
    execFileSync('diff', [fa, fb]); // exit 0 = identical, no output captured needed
  } catch (err) {
    out = (err.stdout || '').toString();
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return out.split('\n').filter(l => l.startsWith('<') || l.startsWith('>')).length;
}

const selfPkg = readJson('self/package.json');
const selfName = selfPkg.name; // 'wh-fin' | 'wh-sci' | 'wh-org'
const selfKey = SELF_KEY_BY_NAME[selfName];
if (!selfKey) {
  console.error(`check-drift: không nhận ra tên app "${selfName}" trong self/package.json.`);
  process.exit(1);
}

const otherKeys = Object.values(SELF_KEY_BY_NAME).filter(k => k !== selfKey);

// 1. calendar-connect.js -- so tuyệt đối, fail nếu khác.
const selfCalHash = md5('self/calendar-connect.js');
for (const otherKey of otherKeys) {
  const otherDir = APP_DIR_BY_NAME[Object.keys(SELF_KEY_BY_NAME).find(n => SELF_KEY_BY_NAME[n] === otherKey)];
  const otherPath = path.join(otherDir, 'calendar-connect.js');
  if (!fs.existsSync(otherPath)) { console.warn(`check-drift: thiếu ${otherPath}, bỏ qua so sánh calendar-connect.js.`); continue; }
  const otherHash = md5(otherPath);
  if (otherHash !== selfCalHash) {
    console.error(`LỆCH: calendar-connect.js khác giữa ${selfName} và ${otherDir} (md5 ${selfCalHash} != ${otherHash}). File này được kỳ vọng giống hệt byte-for-byte cả 3 app.`);
    failed = true;
  } else {
    console.log(`OK: calendar-connect.js giống hệt giữa ${selfName} và ${otherDir}.`);
  }
}

// 2. Khối Personal Hub trong script.js -- cảnh báo mềm khi lệch tăng đáng kể so baseline.
const selfBaseline = readJson('self/scripts/drift-baseline.json');
const selfRange = selfBaseline.personal_hub_block;
const selfBlock = extractRange('self/script.js', selfRange.start, selfRange.end);
const threshold = selfBaseline.warn_threshold_ratio || 1.15;

for (const otherName of Object.keys(SELF_KEY_BY_NAME).filter(n => n !== selfName)) {
  const otherKey = SELF_KEY_BY_NAME[otherName];
  const otherDir = APP_DIR_BY_NAME[otherName];
  const otherBaselinePath = path.join(otherDir, 'scripts', 'drift-baseline.json');
  const otherScriptPath = path.join(otherDir, 'script.js');
  if (!fs.existsSync(otherBaselinePath) || !fs.existsSync(otherScriptPath)) {
    console.warn(`check-drift: thiếu ${otherDir}, bỏ qua so sánh khối Personal Hub.`);
    continue;
  }
  const otherBaseline = readJson(otherBaselinePath);
  const otherRange = otherBaseline.personal_hub_block;
  const otherBlock = extractRange(otherScriptPath, otherRange.start, otherRange.end);

  const diffCount = diffLineCount(selfBlock, otherBlock);
  const pairKey = [selfKey, otherKey].sort().join('-');
  const baselineCount = selfBaseline.pairs_diff_lines_baseline?.[pairKey];

  if (baselineCount == null) {
    console.log(`check-drift: chưa có baseline cho cặp "${pairKey}", chỉ ghi nhận: ${diffCount} dòng khác biệt.`);
    continue;
  }

  const limit = Math.ceil(baselineCount * threshold);
  if (diffCount > limit) {
    console.log(`::warning::Khối Personal Hub lệch nhiều hơn baseline giữa ${selfName} và ${otherName}: ${diffCount} dòng khác biệt (baseline ${baselineCount}, ngưỡng cảnh báo ${limit}). Không fail build, chỉ cảnh báo -- xem lại xem có đang trôi khỏi PERSONAL_SHIM không.`);
  } else {
    console.log(`OK (trong ngưỡng): Khối Personal Hub giữa ${selfName} và ${otherName}: ${diffCount} dòng khác biệt (baseline ${baselineCount}, ngưỡng ${limit}).`);
  }
}

process.exit(failed ? 1 : 0);
