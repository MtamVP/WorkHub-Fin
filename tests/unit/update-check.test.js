// lib/update-check.js (logic thuần của "Kiểm tra cập nhật") và updater.js THẬT chạy trong vm với Tauri giả: kiểm tra, tải có tiến độ, khởi động lại, lỗi, chấm "Mới", web không có Tauri.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import UC from '../../lib/update-check.js';

const ROOT = path.resolve(__dirname, '../..');

describe('so sánh phiên bản', () => {
  it('so từng số, bỏ chữ v và phần sau dấu gạch, thiếu số coi là 0', () => {
    expect(UC.compareVersions('0.1.15', '0.1.14')).toBe(1);
    expect(UC.compareVersions('0.1.14', '0.1.15')).toBe(-1);
    expect(UC.compareVersions('v0.1.15', '0.1.15')).toBe(0);
    expect(UC.compareVersions('0.1.9', '0.1.10')).toBe(-1);            // so số, không so chuỗi
    expect(UC.compareVersions('0.2', '0.1.99')).toBe(1);
    expect(UC.compareVersions('1.0', '1.0.0')).toBe(0);
    expect(UC.compareVersions('0.1.15-beta.1', '0.1.15')).toBe(0);
    expect(UC.compareVersions('', '0.0.1')).toBe(-1);
    expect(UC.compareVersions(null, undefined)).toBe(0);
  });
});

describe('kết quả kiểm tra', () => {
  it('chỉ coi là bản mới khi phiên bản thật sự cao hơn bản đang chạy', () => {
    expect(UC.describeResult('0.1.15', { version: '0.1.16' })).toEqual({ kind: 'available', version: '0.1.16', headline: 'Có bản mới v0.1.16', detail: 'Bạn đang dùng v0.1.15.' });
    expect(UC.describeResult('0.1.15', { version: '0.1.15' }).kind).toBe('latest');
    expect(UC.describeResult('0.1.15', { version: '0.1.14' }).kind).toBe('latest');   // nguồn trả bản cũ hơn: không bao giờ hạ cấp
    expect(UC.describeResult('0.1.15', null)).toEqual({ kind: 'latest', version: '0.1.15', headline: 'Bạn đang dùng bản mới nhất', detail: 'Phiên bản hiện tại: v0.1.15.' });
    expect(UC.describeResult('v0.1.15', { version: 'v0.1.16' }).version).toBe('0.1.16');
    expect(UC.describeResult('', { version: '0.1.16' }).detail).toBe('');
  });
});

describe('tiến độ tải', () => {
  it('có tổng thì ra phần trăm và MB; không có tổng thì chỉ số MB; chặn 0-100', () => {
    expect(UC.progress(5242880, 10485760)).toEqual({ percent: 50, text: '50% (5.0 / 10.0 MB)' });
    expect(UC.progress(0, 10485760).percent).toBe(0);
    expect(UC.progress(20000000, 10485760).percent).toBe(100);
    expect(UC.progress(3145728, 0)).toEqual({ percent: null, text: '3.0 MB đã tải' });
    expect(UC.progress(undefined, undefined)).toEqual({ percent: null, text: '0.0 MB đã tải' });
    expect(UC.progress(-5, 100).percent).toBe(0);
  });
});

describe('ghi chú phát hành', () => {
  it('giữ nguyên khi ngắn, gọn dòng trống thừa, cắt ở ranh giới khi dài và thêm …', () => {
    expect(UC.notesBrief('Dòng 1\r\n\r\n\r\n\r\nDòng 2')).toBe('Dòng 1\n\nDòng 2');
    expect(UC.notesBrief(null)).toBe('');
    const line = 'a'.repeat(99), long = (line + '\n').repeat(10), out = UC.notesBrief(long, 300);
    expect(out).toBe([line, line, line].join('\n') + '…');                                  // 300 ký tự đầu gồm đúng ba dòng và dấu xuống dòng cuối: cắt hết dòng thứ ba, không đứt giữa dòng
    expect(UC.notesBrief('x'.repeat(1000), 100)).toBe('x'.repeat(100) + '…');           // không có chỗ ngắt thì cắt cứng
  });
});

describe('lỗi của bộ cập nhật', () => {
  it('đổi lỗi mạng, chữ ký, thông tin phát hành sang câu rõ ràng; lỗi lạ giữ nhưng cắt ngắn', () => {
    expect(UC.friendlyError(new Error('error sending request for url (https://github.com/...)'))).toContain('Không kết nối được');
    expect(UC.friendlyError('dns error: failed to lookup address information')).toContain('Không kết nối được');
    expect(UC.friendlyError('the signature could not be verified')).toContain('KHÔNG được cài');
    expect(UC.friendlyError('Could not fetch a valid release JSON from the remote')).toContain('Chưa đọc được thông tin bản phát hành');
    expect(UC.friendlyError('boom ' + 'x'.repeat(400)).length).toBeLessThan(190);
    expect(UC.friendlyError('')).toContain('Không kiểm tra được');
    expect(UC.friendlyError(null)).toContain('Không kiểm tra được');
  });
});

describe('kiểm tra ngầm', () => {
  it('chưa từng kiểm hoặc đủ 4 giờ thì kiểm, chưa đủ thì không', () => {
    expect(UC.shouldAutoCheck(0, 1e12)).toBe(true);
    expect(UC.shouldAutoCheck(NaN, 1e12)).toBe(true);
    const t0 = 1e12;
    expect(UC.shouldAutoCheck(t0, t0 + 4 * 3600000 - 1)).toBe(false);
    expect(UC.shouldAutoCheck(t0, t0 + 4 * 3600000)).toBe(true);
    expect(UC.shouldAutoCheck(t0, t0 + 59999, 60000)).toBe(false);
    expect(UC.shouldAutoCheck(t0, t0 + 60000, 60000)).toBe(true);
  });
});

// ---------- updater.js thật trong vm ----------
const IDS = ['update-current', 'update-status', 'update-detail', 'update-notes', 'update-progress-wrap', 'update-bar', 'update-progress-text', 'update-install-btn', 'update-restart-btn', 'update-check-btn', 'update-badge', 'user-badge'];
function boot(opts) {
  const o = opts || {};
  const els = {}; IDS.forEach((id) => { els[id] = { id, textContent: '', style: {}, disabled: false, classList: { on: new Set(), toggle(c, f) { if (f) this.on.add(c); else this.on.delete(c); } } }; });
  const log = { modals: [], swal: [], relaunched: 0, installs: 0, checks: 0, intervals: [], timeouts: [], domHandlers: {} };
  const update = o.update === undefined ? { version: '0.1.16', body: 'Mô tả bản mới\n<b>không phải html</b>', downloadAndInstall: async (cb) => { log.installs++; if (o.installFail) throw new Error(o.installFail); cb({ event: 'Started', data: { contentLength: 1000 } }); cb({ event: 'Progress', data: { chunkLength: 400 } }); cb({ event: 'Progress', data: { chunkLength: 600 } }); cb({ event: 'Finished' }); } } : o.update;
  const T = o.noTauri ? undefined : {
    updater: { check: async () => { log.checks++; if (o.checkFail) throw new Error(o.checkFail); return update; } },
    app: { getVersion: async () => o.current || '0.1.15' },
    process: { relaunch: async () => { log.relaunched++; } },
  };
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, Date, Promise, Math, Number, String, isFinite, setTimeout: (f, ms) => { log.timeouts.push({ f, ms }); return 1; }, setInterval: (f, ms) => { log.intervals.push({ f, ms }); return 1; },
    document: { getElementById: (id) => els[id] || null, hidden: !!o.hidden }, window: { __TAURI__: T, addEventListener: (n, f) => { log.domHandlers[n] = f; } },
    openAppModal: (id) => log.modals.push(id), Swal: { fire: async (cfg) => { log.swal.push(cfg); return { isConfirmed: !!o.confirm }; } },
    UpdateCheck: UC,
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'updater.js'), 'utf8') + '\nglobalThis.WU = WorkHubUpdater;', ctx, { filename: 'updater.js' });
  return { WU: vm.runInContext('WU', ctx), els, log, ctx };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('updater.js: hộp "Kiểm tra cập nhật"', () => {
  it('đang dùng bản mới nhất: ghi rõ, không có nút cài, không có chấm Mới', async () => {
    const t = boot({ update: null });
    expect(await t.WU.check()).toBe('latest');
    expect(t.els['update-status'].textContent).toBe('Bạn đang dùng bản mới nhất');
    expect(t.els['update-current'].textContent).toBe('v0.1.15');
    expect(t.els['update-detail'].textContent).toContain('Phiên bản hiện tại: v0.1.15.');
    expect(t.els['update-install-btn'].style.display).toBe('none');
    expect(t.els['update-badge'].style.display).toBe('none');
    expect(t.els['user-badge'].classList.on.has('has-update')).toBe(false);
  });
  it('có bản mới: hiện phiên bản, ghi chú (không biên dịch HTML), nút cài và chấm Mới', async () => {
    const t = boot();
    expect(await t.WU.check()).toBe('available');
    expect(t.els['update-status'].textContent).toBe('Có bản mới v0.1.16');
    expect(t.els['update-notes'].textContent).toContain('<b>không phải html</b>');         // gán bằng textContent
    expect(t.els['update-notes'].style.display).toBe('');
    expect(t.els['update-install-btn'].style.display).toBe('');
    expect(t.els['update-badge'].style.display).toBe('');
    expect(t.els['user-badge'].classList.on.has('has-update')).toBe(true);
  });
  it('nguồn trả đúng bản đang dùng hoặc bản cũ hơn thì không báo có bản mới', async () => {
    expect(await boot({ update: { version: '0.1.15', body: '' } }).WU.check()).toBe('latest');
    expect(await boot({ update: { version: '0.1.10', body: '' } }).WU.check()).toBe('latest');
  });
  it('bấm cài: hiện tiến độ theo phần trăm, xong thì có nút khởi động lại; bấm khởi động lại gọi relaunch', async () => {
    const t = boot(), seen = [];
    await t.WU.check();
    const p = t.WU.install();
    seen.push(t.WU.U.phase);
    await p;
    expect(seen).toEqual(['downloading']);
    expect(t.log.installs).toBe(1);
    expect(t.WU.U.downloaded).toBe(1000);
    expect(t.WU.U.total).toBe(1000);
    expect(t.els['update-status'].textContent).toBe('Đã tải và cài xong');
    expect(t.els['update-restart-btn'].style.display).toBe('');
    expect(t.els['update-install-btn'].style.display).toBe('none');
    expect(t.els['user-badge'].classList.on.has('has-update')).toBe(true);       // vẫn chờ khởi động lại
    await t.WU.restart();
    expect(t.log.relaunched).toBe(1);
  });
  it('trong lúc tải: hiện thanh tiến độ, khoá nút kiểm tra; đã tải xong thì kiểm tra lại không ghi đè trạng thái', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const t = boot({ update: { version: '0.1.16', body: '', downloadAndInstall: async (cb) => { cb({ event: 'Started', data: { contentLength: 2000 } }); cb({ event: 'Progress', data: { chunkLength: 500 } }); await gate; } } });
    await t.WU.check();
    const p = t.WU.install();
    await flush();
    expect(t.els['update-progress-wrap'].style.display).toBe('');
    expect(t.els['update-bar'].style.width).toBe('25%');
    expect(t.els['update-progress-text'].textContent).toContain('25%');
    expect(t.els['update-check-btn'].disabled).toBe(true);
    expect(await t.WU.check()).toBe('downloading');
    release(); await p;
    expect(t.WU.U.phase).toBe('ready');
    expect(await t.WU.check()).toBe('ready');
    expect(t.log.checks).toBe(1);
  });
  it('không có tổng dung lượng: thanh đầy và chỉ ghi số MB đã tải', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const t = boot({ update: { version: '0.1.16', body: '', downloadAndInstall: async (cb) => { cb({ event: 'Started', data: {} }); cb({ event: 'Progress', data: { chunkLength: 2097152 } }); await gate; } } });
    await t.WU.check(); const p = t.WU.install(); await flush();
    expect(t.els['update-progress-text'].textContent).toBe('2.0 MB đã tải');
    expect(t.els['update-bar'].style.width).toBe('100%');
    release(); await p;
  });
  it('lỗi mạng khi kiểm tra: câu dễ hiểu, không có nút cài; lỗi khi tải: có nút thử lại và giữ bản cập nhật', async () => {
    const a = boot({ checkFail: 'error sending request for url' });
    expect(await a.WU.check()).toBe('error');
    expect(a.els['update-status'].textContent).toBe('Chưa cập nhật được');
    expect(a.els['update-detail'].textContent).toContain('Không kết nối được');
    expect(a.els['update-install-btn'].style.display).toBe('none');
    const b = boot({ installFail: 'signature verify failed' });
    await b.WU.check(); await b.WU.install();
    expect(b.WU.U.phase).toBe('error');
    expect(b.els['update-detail'].textContent).toContain('KHÔNG được cài');
    expect(b.els['update-install-btn'].style.display).toBe('');
    expect(b.els['update-restart-btn'].style.display).toBe('none');
  });
  it('trình duyệt web không có Tauri: báo chỉ có ở app desktop, không lỗi', async () => {
    const t = boot({ noTauri: true });
    expect(await t.WU.check()).toBe('web');
    expect(t.els['update-status'].textContent).toBe('Chỉ có trong ứng dụng desktop');
    expect(t.els['update-check-btn'].disabled).toBe(true);
    expect(t.els['update-install-btn'].style.display).toBe('none');
  });
  it('mở hộp từ menu: mở modal và tự kiểm tra lần đầu; mở lại ngay thì không kiểm lại, sau 1 phút thì kiểm lại', async () => {
    const t = boot();
    t.WU.openModal(); await flush(); await flush();
    expect(t.log.modals).toEqual(['update-modal']);
    expect(t.log.checks).toBe(1);
    t.WU.openModal(); await flush();
    expect(t.log.checks).toBe(1);
    t.WU.U.checkedAt = Date.now() - 61000;
    t.WU.openModal(); await flush(); await flush();
    expect(t.log.checks).toBe(2);
  });
});

describe('updater.js: lúc mở app và kiểm tra ngầm', () => {
  it('lúc mở app có bản mới: hỏi bằng hộp thoại; chọn cập nhật thì mở hộp tiến độ và cài; chọn để sau thì chấm Mới vẫn còn', async () => {
    const yes = boot({ confirm: true });
    await yes.WU.startupCheck();
    expect(yes.log.swal[0].title).toBe('Có Phiên Bản Mới!');
    expect(yes.log.swal[0].text).toContain('v0.1.16');
    expect(yes.log.modals).toEqual(['update-modal']);
    expect(yes.log.installs).toBe(1);
    const no = boot({ confirm: false });
    await no.WU.startupCheck();
    expect(no.log.installs).toBe(0);
    expect(no.els['update-badge'].style.display).toBe('');
  });
  it('lúc mở app: đã là bản mới nhất hoặc lỗi mạng thì im lặng, không bật hộp thoại', async () => {
    const a = boot({ update: null }); await a.WU.startupCheck();
    const b = boot({ checkFail: 'error sending request' }); await b.WU.startupCheck();
    expect(a.log.swal.length + b.log.swal.length).toBe(0);
  });
  it('start(): hẹn kiểm tra 3 giây sau khi mở app và kiểm ngầm mỗi 30 phút; kiểm ngầm chỉ chạy khi đủ 4 giờ và tab đang hiện', async () => {
    const t = boot();
    t.WU.start();
    expect(t.log.timeouts.map((x) => x.ms)).toEqual([3000]);
    expect(t.log.intervals.map((x) => x.ms)).toEqual([30 * 60000]);
    t.WU.backgroundTick(); await flush(); await flush();
    expect(t.log.checks).toBe(1);
    t.WU.backgroundTick(); await flush();
    expect(t.log.checks).toBe(1);                                                    // chưa đủ 4 giờ
    t.WU.U.checkedAt = Date.now() - 4 * 3600000 - 1;
    t.WU.backgroundTick(); await flush(); await flush();
    expect(t.log.checks).toBe(2);
    expect(t.log.swal.length).toBe(0);                                              // kiểm ngầm không bật hộp thoại
    const hid = boot({ hidden: true }); hid.WU.backgroundTick(); await flush();
    expect(hid.log.checks).toBe(0);
  });
});

describe('index.html: lối vào và nạp script', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  it('menu tài khoản có mục Kiểm tra cập nhật, hộp #update-modal có đủ phần tử mà updater.js dùng, và nạp update-check.js trước updater.js', () => {
    expect(html).toContain('onclick="openUpdateModal()"');
    expect(html).toContain('id="update-modal"');
    IDS.filter((id) => id !== 'user-badge').forEach((id) => expect(html).toContain('id="' + id + '"'));
    expect(html.indexOf('lib/update-check.js')).toBeGreaterThan(-1);
    expect(html.indexOf('lib/update-check.js')).toBeLessThan(html.indexOf('src="updater.js'));
  });
});
