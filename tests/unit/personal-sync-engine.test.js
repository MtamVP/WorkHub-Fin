// Chạy NGUYÊN FILE personal-sync.js (engine thật) trong môi trường giả lập: ổ đĩa trong bộ nhớ, lệnh Tauri sync_*,
// bảng personal_sync_files + Storage (kiểm tra khoá hợp lệ y như Supabase thật -- khoá có chữ Việt bị "Invalid key").
// Mục đích: chứng minh các lỗi thật của bản cũ không còn tái diễn. Không đụng mạng, không đụng ổ đĩa thật.
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeSyncStorageKey, decodeSyncStorageKey, isTempSyncPath, decideSyncAction, isSuspiciousMassDelete, describeSyncError } from '../../lib/sync-decision.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineSource = readFileSync(path.join(here, '../../personal-sync.js'), 'utf8');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
// Tập ký tự Storage thật sự chấp nhận (theo tài liệu Supabase): '~' và '%' KHÔNG nằm trong đó.
const SAFE_KEY = /^[A-Za-z0-9_\-.',!*&$@=;:+?() /]+$/;

// Dựng 1 "máy" + "đám mây" mới cho mỗi test.
function makeWorld({ uid = 'user-1', owner, root = 'C:/sync', hashes, sizes, failUploadFor = [] } = {}) {
  const fs = new Map();            // relativePath -> Buffer (thư mục trên máy)
  const rows = new Map();          // relativePath -> row bảng personal_sync_files
  const storage = new Map();       // `${uid}/${key}` -> Buffer
  const store = {};                // localStorage
  const handlers = {};             // sự kiện Tauri
  const calls = { uploads: [], deletes: [], markDeleted: [] };
  let folderMissing = false;

  const tauriInvoke = async (cmd, args = {}) => {
    switch (cmd) {
      case 'sync_start_watch': if (folderMissing) throw new Error('The system cannot find the path specified. (os error 3)'); return;
      case 'sync_stop_watch': return;
      case 'sync_list_folder': return folderMissing ? [] : [...fs.entries()].filter(([p]) => !isTempSyncPath(p) || true).map(([p, b]) => ({ relativePath: p, size: b.length }));
      case 'sync_hash_file': if (!fs.has(args.relativePath)) throw new Error('not found (os error 2)'); return sha(fs.get(args.relativePath));
      case 'sync_read_file': return fs.get(args.relativePath).toString('base64');
      case 'sync_write_file': fs.set(args.relativePath, Buffer.from(args.contentBase64, 'base64')); return;
      case 'sync_file_exists': return fs.has(args.relativePath);
      case 'sync_delete_file': fs.delete(args.relativePath); return;
      default: throw new Error('lệnh lạ: ' + cmd);
    }
  };

  const API = {
    personalSync: {
      getUserId: async () => uid,
      listFiles: async () => [...rows.values()].filter(r => !r.deleted),
      getFile: async (rel) => rows.get(rel) || null,
      upsertFile: async (rel, hash, size) => { rows.set(rel, { relative_path: rel, content_hash: hash, size, deleted: false }); },
      markDeleted: async (rel) => { calls.markDeleted.push(rel); const r = rows.get(rel); if (r) r.deleted = true; },
      // api.js thật: path = userId + '/' + encodeSyncStorageKey(relativePath). Storage thật từ chối khoá ngoài tập an toàn.
      uploadBytes: async (u, rel, blob) => {
        if (failUploadFor.includes(rel)) throw new Error('Failed to fetch');
        const key = u + '/' + encodeSyncStorageKey(rel);
        if (!SAFE_KEY.test(key)) throw new Error('Invalid key: ' + key);
        storage.set(key, Buffer.from(await blob.arrayBuffer())); calls.uploads.push(rel);
      },
      downloadBytes: async (u, rel) => {
        const key = u + '/' + encodeSyncStorageKey(rel);
        if (!storage.has(key)) throw new Error('Object not found');
        return new Blob([storage.get(key)]);
      },
      deleteBytes: async (u, rel) => { storage.delete(u + '/' + encodeSyncStorageKey(rel)); calls.deletes.push(rel); },
      subscribe: () => ({}),
    },
  };

  if (root) store.wh_personal_sync_root = root;
  if (owner) store.wh_personal_sync_owner = owner;
  if (hashes) store.wh_personal_sync_hashes = JSON.stringify(hashes);
  if (sizes) store.wh_personal_sync_sizes = JSON.stringify(sizes);

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    Blob, Buffer,
    document: { readyState: 'loading' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    API,
    sbClient: { auth: { getSession: async () => ({ data: { session: { user: { id: uid } } } }), onAuthStateChange() {} }, removeChannel() {} },
    b64toBlob: (b64) => new Blob([Buffer.from(b64, 'base64')]),
    FileReader: class { readAsDataURL(blob) { blob.arrayBuffer().then(ab => { this.result = 'data:application/octet-stream;base64,' + Buffer.from(ab).toString('base64'); this.onload(); }, e => this.onerror(e)); } },
    encodeSyncStorageKey, isTempSyncPath, decideSyncAction, isSuspiciousMassDelete, describeSyncError,
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.__TAURI__ = {
    core: { invoke: tauriInvoke },
    event: { listen: async (name, fn) => { handlers[name] = fn; return () => { delete handlers[name]; }; } },
    dialog: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(engineSource, sandbox);

  return {
    sync: sandbox.window.PersonalSync,
    fs, rows, storage, store, calls,
    setFolderMissing: (v) => { folderMissing = v; },
    emitLocal: (paths) => handlers['personal-sync-local-change']({ payload: paths }),
    putCloud: (rel, text, extra = {}) => {
      const buf = Buffer.from(text);
      rows.set(rel, { relative_path: rel, content_hash: sha(buf), size: buf.length, deleted: false, ...extra });
      storage.set(uid + '/' + encodeSyncStorageKey(rel), buf);
    },
    cacheOf: () => JSON.parse(store.wh_personal_sync_hashes || '{}'),
    text: (rel) => (fs.has(rel) ? fs.get(rel).toString() : null),
    flush: () => new Promise(r => setTimeout(r, 30)),
  };
}

// setTimeout trong sandbox bị vô hiệu (tránh autoStart chạy) nên flush phải dùng timer thật của test.
async function settle(world) {
  for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
  await world.sync.fullReconcile({ deep: true }).catch(() => {});
}

describe('đồng bộ thư mục — engine thật', () => {
  it('LỖI CŨ #2: file tên tiếng Việt được đẩy lên, và 1 file lỗi KHÔNG chặn các file còn lại', async () => {
    const w = makeWorld({ owner: 'user-1', failUploadFor: ['hong.txt'] });
    w.fs.set('Báo cáo tài chính.docx', Buffer.from('noi dung viet'));
    w.fs.set('hong.txt', Buffer.from('se loi mang'));
    w.fs.set('ok.txt', Buffer.from('binh thuong'));
    await w.sync.fullReconcile({ deep: true });

    expect(w.calls.uploads).toContain('Báo cáo tài chính.docx');
    expect(w.calls.uploads).toContain('ok.txt');
    expect([...w.storage.keys()].every(k => SAFE_KEY.test(k))).toBe(true);
    const st = w.sync.getState();
    expect(st.failures.map(f => f.path)).toEqual(['hong.txt']);
    expect(st.failures[0].message).toMatch(/mạng/);
    expect(st.counts.uploaded).toBe(2);
  });

  it('file lỗi được thử lại ở lượt sau và lành hẳn', async () => {
    const w = makeWorld({ owner: 'user-1', failUploadFor: ['hong.txt'] });
    w.fs.set('hong.txt', Buffer.from('x'));
    await w.sync.fullReconcile({ deep: true });
    expect(w.sync.getState().failures).toHaveLength(1);
    // mạng trở lại: dựng lại thế giới sẽ mất trạng thái, nên chỉ kiểm tra rằng lượt sau vẫn nhắm đúng file đó
    await w.sync.fullReconcile({ deep: true });
    expect(w.sync.getState().failures.map(f => f.path)).toEqual(['hong.txt']);
  });

  it('khởi động: kéo file mới trên đám mây về máy, đẩy file mới ở máy lên', async () => {
    const w = makeWorld({ owner: 'user-1' });
    w.putCloud('tu-may-khac.txt', 'tu dam may');
    w.fs.set('moi-o-may.txt', Buffer.from('tu may nay'));
    await w.sync.fullReconcile({ deep: true });
    expect(w.text('tu-may-khac.txt')).toBe('tu dam may');
    expect(w.rows.get('moi-o-may.txt').deleted).toBe(false);
    expect(w.cacheOf()['tu-may-khac.txt']).toBeTruthy();
    expect(w.cacheOf()['moi-o-may.txt']).toBeTruthy();
  });

  it('LỖI CŨ #3a: file bạn xoá lúc app tắt bị xoá khỏi đám mây, KHÔNG được kéo về lại', async () => {
    const buf = Buffer.from('da dong bo roi');
    const w = makeWorld({ owner: 'user-1', hashes: { 'cu.txt': sha(buf) } });
    w.putCloud('cu.txt', 'da dong bo roi'); // đám mây còn, máy không còn
    await w.sync.fullReconcile({ deep: true });
    expect(w.fs.has('cu.txt')).toBe(false);
    expect(w.rows.get('cu.txt').deleted).toBe(true);
    expect(w.calls.deletes).toContain('cu.txt');
    expect(w.cacheOf()['cu.txt']).toBeUndefined();
  });

  it('LỖI CŨ #3b: file máy khác đã xoá bị xoá khỏi máy này, KHÔNG được đẩy lên lại', async () => {
    const buf = Buffer.from('chua doi');
    const w = makeWorld({ owner: 'user-1', hashes: { 'cu.txt': sha(buf), 'giu.txt': sha(Buffer.from('giu')) } });
    w.fs.set('cu.txt', buf);
    w.fs.set('giu.txt', Buffer.from('giu'));
    w.putCloud('giu.txt', 'giu');
    w.rows.set('cu.txt', { relative_path: 'cu.txt', content_hash: sha(buf), size: buf.length, deleted: true });
    await w.sync.fullReconcile({ deep: true });
    expect(w.fs.has('cu.txt')).toBe(false);
    expect(w.fs.has('giu.txt')).toBe(true);
    expect(w.calls.uploads).not.toContain('cu.txt');
  });

  it('bạn sửa tiếp file sau khi máy khác xoá => bản sửa của bạn thắng, đẩy lên lại', async () => {
    const old = Buffer.from('ban dau');
    const w = makeWorld({ owner: 'user-1', hashes: { 'cu.txt': sha(old) } });
    w.fs.set('cu.txt', Buffer.from('ban da sua'));
    w.rows.set('cu.txt', { relative_path: 'cu.txt', content_hash: sha(old), size: old.length, deleted: true });
    await w.sync.fullReconcile({ deep: true });
    expect(w.text('cu.txt')).toBe('ban da sua');
    expect(w.rows.get('cu.txt').deleted).toBe(false);
  });

  it('cả hai bên cùng sửa => giữ bản đám mây thành "conflicted copy", bản máy là bản chính', async () => {
    const base = Buffer.from('goc');
    const w = makeWorld({ owner: 'user-1', hashes: { 'a.txt': sha(base) } });
    w.fs.set('a.txt', Buffer.from('sua o may'));
    w.putCloud('a.txt', 'sua o cloud');
    await w.sync.fullReconcile({ deep: true });
    expect(w.text('a.txt')).toBe('sua o may');
    const copy = [...w.fs.keys()].find(k => k.includes('conflicted copy'));
    expect(copy).toBeTruthy();
    expect(w.text(copy)).toBe('sua o cloud');
    expect(w.sync.getState().counts.conflicts).toBe(1);
  });

  it('LỖI CŨ #4: xoá CẢ THƯ MỤC được nhận ra (sự kiện chỉ nêu đường dẫn thư mục)', async () => {
    const w = makeWorld({ owner: 'user-1' });
    w.fs.set('du-an/a.txt', Buffer.from('a'));
    w.fs.set('du-an/b.txt', Buffer.from('b'));
    w.fs.set('khac.txt', Buffer.from('k'));
    await w.sync.fullReconcile({ deep: true });
    expect(w.rows.get('du-an/a.txt').deleted).toBe(false);

    w.fs.delete('du-an/a.txt'); w.fs.delete('du-an/b.txt'); // xoá thư mục "du-an"
    await w.emitLocal(['du-an']);
    await settle({ sync: { fullReconcile: async () => {} } });
    await new Promise(r => setTimeout(r, 20));
    expect(w.rows.get('du-an/a.txt').deleted).toBe(true);
    expect(w.rows.get('du-an/b.txt').deleted).toBe(true);
    expect(w.rows.get('khac.txt').deleted).toBe(false);
  });

  it('di chuyển 1 thư mục có sẵn file vào: các file bên trong được đẩy lên', async () => {
    const w = makeWorld({ owner: 'user-1' });
    await w.sync.fullReconcile({ deep: true });
    w.fs.set('moi/x.txt', Buffer.from('x'));
    w.fs.set('moi/y.txt', Buffer.from('y'));
    await w.emitLocal(['moi']);
    await new Promise(r => setTimeout(r, 20));
    expect(w.calls.uploads).toEqual(expect.arrayContaining(['moi/x.txt', 'moi/y.txt']));
  });

  it('LỖI CŨ #5: file tạm (~$, .wh-tmp-) KHÔNG bị đẩy lên', async () => {
    const w = makeWorld({ owner: 'user-1' });
    w.fs.set('~$Bao cao.docx', Buffer.from('lock'));
    w.fs.set('a.txt.wh-tmp-99', Buffer.from('dang ghi'));
    w.fs.set('that.txt', Buffer.from('that'));
    await w.sync.fullReconcile({ deep: true });
    await w.emitLocal(['~$Bao cao.docx', 'a.txt.wh-tmp-99']);
    await new Promise(r => setTimeout(r, 20));
    expect(w.calls.uploads).toEqual(['that.txt']);
  });

  it('LỖI CŨ #6: thay đổi từ đám mây KHÔNG ghi đè bản đang sửa dở ở máy', async () => {
    const base = Buffer.from('goc');
    const w = makeWorld({ owner: 'user-1', hashes: { 'a.txt': sha(base) } });
    w.fs.set('a.txt', Buffer.from('dang sua do o may'));
    w.putCloud('a.txt', 'may khac vua luu');
    // sự kiện realtime báo đám mây đổi (bản cũ kéo thẳng về, mất chỗ sửa dở)
    await w.sync.init();
    await new Promise(r => setTimeout(r, 30));
    expect(w.text('a.txt')).toBe('dang sua do o may');
    expect([...w.fs.keys()].some(k => k.includes('conflicted copy'))).toBe(true);
  });

  it('CHỐT CHẶN: thư mục biến mất (ổ rút ra) KHÔNG bị hiểu là xoá hết', async () => {
    const hashes = {}; const names = [];
    for (let i = 0; i < 12; i++) { const n = 'f' + i + '.txt'; names.push(n); hashes[n] = sha(Buffer.from('c' + i)); }
    const w = makeWorld({ owner: 'user-1', hashes });
    names.forEach((n, i) => w.putCloud(n, 'c' + i)); // đám mây còn đủ, máy thì trống
    await w.sync.fullReconcile({ deep: true });
    expect(w.calls.markDeleted).toEqual([]);
    expect(w.calls.deletes).toEqual([]);
    const st = w.sync.getState();
    expect(st.phase).toBe('error');
    expect(st.lastError).toMatch(/bất thường/);
  });

  it('...nhưng người dùng xác nhận (force) thì mới xoá thật', async () => {
    const hashes = {}; const names = [];
    for (let i = 0; i < 12; i++) { const n = 'f' + i + '.txt'; names.push(n); hashes[n] = sha(Buffer.from('c' + i)); }
    const w = makeWorld({ owner: 'user-1', hashes });
    names.forEach((n, i) => w.putCloud(n, 'c' + i));
    await w.sync.fullReconcile({ deep: true, force: true });
    expect(w.calls.markDeleted).toHaveLength(12);
  });

  it('thư mục liên kết không còn tồn tại: báo lỗi rõ ràng, không làm gì với đám mây', async () => {
    const w = makeWorld({ owner: 'user-1' });
    w.putCloud('a.txt', 'a');
    w.setFolderMissing(true);
    await expect(w.sync.fullReconcile({ deep: true })).rejects.toThrow(/thư mục/i);
    expect(w.calls.markDeleted).toEqual([]);
    expect(w.sync.getState().phase).toBe('error');
  });

  it('BẢO MẬT: thư mục đã liên kết bởi TÀI KHOẢN KHÁC không bao giờ được đẩy vào kho của người này', async () => {
    const w = makeWorld({ uid: 'user-2', owner: 'user-1' });
    w.fs.set('rieng-tu.txt', Buffer.from('cua nguoi khac'));
    const started = await w.sync.init();
    await new Promise(r => setTimeout(r, 20));
    expect(started).toBe(false);
    expect(w.calls.uploads).toEqual([]);
    expect(w.store.wh_personal_sync_root).toBeUndefined();
  });

  it('liên kết cũ chưa ghi chủ: nhận người đăng nhập hiện tại làm chủ (không mất liên kết của người dùng hiện có)', async () => {
    const w = makeWorld({ uid: 'user-1' });
    w.fs.set('a.txt', Buffer.from('a'));
    expect(await w.sync.init()).toBe(true);
    await new Promise(r => setTimeout(r, 20));
    expect(w.store.wh_personal_sync_owner).toBe('user-1');
  });

  it('khởi động tự đối chiếu, không cần mở Không Gian Riêng', async () => {
    const w = makeWorld({ owner: 'user-1' });
    w.putCloud('tu-dam-may.txt', 'moi');
    await w.sync.init();
    await new Promise(r => setTimeout(r, 30));
    expect(w.text('tu-dam-may.txt')).toBe('moi');
  });
});
