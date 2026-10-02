// Logic thuần của đồng bộ thư mục (lib/sync-decision.js): khoá lưu trữ, file tạm, bảng quyết định 3 chiều,
// chốt chặn xoá hàng loạt, và thông báo lỗi. Những ca này là các lỗi thật của bản cũ (file đã xoá hồi sinh,
// tên tiếng Việt bị từ chối, thư mục biến mất bị coi là xoá hết).
import { describe, it, expect } from 'vitest';
import {
  encodeSyncStorageKey,
  decodeSyncStorageKey,
  isTempSyncPath,
  decideSyncAction,
  isSuspiciousMassDelete,
  describeSyncError,
} from '../../lib/sync-decision.js';

describe('encodeSyncStorageKey', () => {
  it('giữ nguyên khoá chỉ gồm ký tự an toàn (tương thích file đã đồng bộ từ trước)', () => {
    expect(encodeSyncStorageKey('C01_046_20240815.pdf')).toBe('C01_046_20240815.pdf');
    expect(encodeSyncStorageKey('Bao cao/Q3 (final).docx')).toBe('Bao cao/Q3 (final).docx');
  });

  it('mã hoá chữ tiếng Việt thành khoá mà Storage chấp nhận', () => {
    const key = encodeSyncStorageKey('Báo cáo tài chính.docx');
    expect(key).toBe('B!e1!o c!e1!o t!e0!i ch!ed!nh.docx');
    // chỉ còn ký tự nằm trong tập Storage cho phép
    expect(key).toMatch(/^[A-Za-z0-9_\-.',!*&$@=;:+() /]+$/);
  });

  it('mã hoá cả ký tự ngoài mặt phẳng cơ bản (emoji) và dấu ? gây hỏng URL', () => {
    expect(encodeSyncStorageKey('a😀b')).toBe('a!1f600!b');
    expect(encodeSyncStorageKey('hoi?.txt')).toBe('hoi!3f!.txt');
  });

  it('không nhập nhằng: ký tự thoát ! có sẵn trong tên cũng bị mã hoá', () => {
    expect(encodeSyncStorageKey('Xong!.txt')).toBe('Xong!21!.txt');
    expect(decodeSyncStorageKey(encodeSyncStorageKey('Xong!.txt'))).toBe('Xong!.txt');
    expect(decodeSyncStorageKey(encodeSyncStorageKey('a!21!b'))).toBe('a!21!b');
  });

  it('giải mã khớp ngược với mã hoá', () => {
    for (const name of ['Đồ án/Báo cáo (v2).pdf', 'x/y/z.txt', 'a😀~b?c#d%e!f.md']) {
      expect(decodeSyncStorageKey(encodeSyncStorageKey(name))).toBe(name);
    }
  });

  it('giữ dấu / phân cấp thư mục', () => {
    expect(encodeSyncStorageKey('Thư mục/file.txt')).toBe('Th!1b0! m!1ee5!c/file.txt');
  });
});

describe('isTempSyncPath', () => {
  it('nhận ra file tạm của chính engine, Office, LibreOffice, trình duyệt', () => {
    expect(isTempSyncPath('a.txt.wh-tmp-1234')).toBe(true);
    expect(isTempSyncPath('docs/~$Bao cao.docx')).toBe(true);
    expect(isTempSyncPath('.~lock.sheet.ods#')).toBe(true);
    expect(isTempSyncPath('video.mp4.crdownload')).toBe(true);
    expect(isTempSyncPath('big.zip.part')).toBe(true);
  });

  it('không nhầm file thường', () => {
    expect(isTempSyncPath('docs/Bao cao.docx')).toBe(false);
    expect(isTempSyncPath('notes.tmp.txt')).toBe(false);
    expect(isTempSyncPath('part-1.txt')).toBe(false);
  });
});

describe('decideSyncAction', () => {
  const H = (c) => c.repeat(8);
  const a = H('a'), b = H('b'), c = H('c');

  it('giống nhau hai phía => chỉ ghi nhận', () => {
    expect(decideSyncAction({ local: a, last: null, remote: a })).toBe('record');
    expect(decideSyncAction({ local: a, last: b, remote: a })).toBe('record');
  });

  it('không có ở đâu cả => quên (hoặc không làm gì nếu chưa từng theo dõi)', () => {
    expect(decideSyncAction({ local: null, last: a, remote: null })).toBe('forget');
    expect(decideSyncAction({ local: null, last: null, remote: null })).toBe('noop');
  });

  it('file mới chỉ có ở máy => đẩy lên; chỉ có ở đám mây => kéo về', () => {
    expect(decideSyncAction({ local: a, last: null, remote: null })).toBe('push');
    expect(decideSyncAction({ local: null, last: null, remote: a })).toBe('pull');
  });

  it('LỖI CŨ: file đã đồng bộ rồi bị máy khác xoá => xoá bản ở máy, KHÔNG hồi sinh', () => {
    expect(decideSyncAction({ local: a, last: a, remote: null })).toBe('delete-local');
  });

  it('...trừ khi bạn đã sửa tiếp sau lần đồng bộ cuối => giữ bản của bạn và đẩy lại', () => {
    expect(decideSyncAction({ local: b, last: a, remote: null })).toBe('push');
  });

  it('LỖI CŨ: bạn xoá file lúc app tắt => xoá trên đám mây, KHÔNG kéo về lại', () => {
    expect(decideSyncAction({ local: null, last: a, remote: a })).toBe('delete-remote');
  });

  it('...trừ khi nơi khác đã sửa tiếp => kéo bản mới về', () => {
    expect(decideSyncAction({ local: null, last: a, remote: b })).toBe('pull');
  });

  it('chỉ đám mây đổi => kéo; chỉ máy đổi => đẩy', () => {
    expect(decideSyncAction({ local: a, last: a, remote: b })).toBe('pull');
    expect(decideSyncAction({ local: b, last: a, remote: a })).toBe('push');
  });

  it('cả hai cùng đổi (hoặc chưa từng đồng bộ mà khác nhau) => xung đột', () => {
    expect(decideSyncAction({ local: b, last: a, remote: c })).toBe('conflict');
    expect(decideSyncAction({ local: b, last: null, remote: c })).toBe('conflict');
  });
});

describe('isSuspiciousMassDelete', () => {
  it('thư mục trống trong khi đang theo dõi nhiều file => đáng ngờ (ổ rút ra, đổi tên thư mục)', () => {
    expect(isSuspiciousMassDelete(25, 25, 0)).toBe(true);
    expect(isSuspiciousMassDelete(5, 5, 0)).toBe(true);
  });

  it('xoá vài file lẻ là bình thường', () => {
    expect(isSuspiciousMassDelete(1, 25, 24)).toBe(false);
    expect(isSuspiciousMassDelete(3, 4, 1)).toBe(false);
    expect(isSuspiciousMassDelete(1, 1, 0)).toBe(false); // chỉ có 1 file và bạn xoá nó
    expect(isSuspiciousMassDelete(0, 25, 0)).toBe(false); // không có gì để xoá thì không có gì để chặn
  });

  it('xoá >= 10 file và quá nửa số đang theo dõi => giữ lại để hỏi', () => {
    expect(isSuspiciousMassDelete(15, 20, 5)).toBe(true);
    expect(isSuspiciousMassDelete(10, 40, 30)).toBe(false);
  });

  it('chưa theo dõi gì (lần đầu) không bao giờ bị chặn', () => {
    expect(isSuspiciousMassDelete(0, 0, 0)).toBe(false);
  });
});

describe('describeSyncError', () => {
  it('dịch các lỗi hay gặp sang câu dễ hiểu', () => {
    expect(describeSyncError(new Error('Invalid key: Báo cáo.docx'))).toMatch(/ký tự/);
    expect(describeSyncError(new Error('The object exceeded the maximum allowed size'))).toMatch(/quá lớn/);
    expect(describeSyncError(new TypeError('Failed to fetch'))).toMatch(/mạng/);
    expect(describeSyncError({ message: 'new row violates row-level security policy' })).toMatch(/đăng nhập/);
    expect(describeSyncError('The process cannot access the file because it is being used by another process. (os error 32)')).toMatch(/chương trình khác/);
  });

  it('lỗi lạ giữ nguyên nội dung gốc', () => {
    expect(describeSyncError(new Error('boom'))).toBe('boom');
  });
});
