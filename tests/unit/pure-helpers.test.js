// Enterprise-readiness mục 4 -- test hàm logic thuần trong lib/pure-helpers.js.
// import/export (ESM): Vitest tự transform mọi file test qua Vite bất kể "type" trong
// package.json, và bản thân gói "vitest" từ chối bị require() (CJS) -- xem lỗi thật gặp
// phải khi thử require() ở đây trước đó. lib/pure-helpers.js vẫn viết CommonJS
// (module.exports) như quy ước cả app; import mặc định của Node/Vite đọc named exports từ
// module.exports là hành vi chuẩn, không cần đổi gì bên đó.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  timeAgoVietnamese,
  getProgressBarColor,
  orgUnitDepth,
  orgUnitLabel,
  formatPersonalTimeAgo,
  sortPersonalItemsCache,
} from '../../lib/pure-helpers.js';

describe('timeAgoVietnamese', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-02T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('trả "Chưa hoạt động" khi rỗng hoặc không parse được', () => {
    expect(timeAgoVietnamese(null)).toBe('Chưa hoạt động');
    expect(timeAgoVietnamese('not-a-date')).toBe('Chưa hoạt động');
  });
  it('trả "Vừa mới đây" dưới 45 giây', () => {
    expect(timeAgoVietnamese(new Date('2026-09-02T11:59:20Z'))).toBe('Vừa mới đây');
  });
  it('trả phút khi dưới 1 giờ', () => {
    expect(timeAgoVietnamese(new Date('2026-09-02T11:55:00Z'))).toBe('Hoạt động 5 phút trước');
  });
  it('trả giờ khi dưới 1 ngày', () => {
    expect(timeAgoVietnamese(new Date('2026-09-02T09:00:00Z'))).toBe('Hoạt động 3 giờ trước');
  });
  it('trả ngày khi từ 1 ngày trở lên', () => {
    expect(timeAgoVietnamese(new Date('2026-08-30T12:00:00Z'))).toBe('Hoạt động 3 ngày trước');
  });
});

describe('getProgressBarColor', () => {
  it('trả biến CSS var theo ngưỡng phần trăm', () => {
    expect(getProgressBarColor(100)).toBe('var(--success-color)');
    expect(getProgressBarColor(50)).toBe('var(--gold)');
    expect(getProgressBarColor(1)).toBe('var(--warning-color)');
    expect(getProgressBarColor(0)).toBe('var(--border-color)');
  });
});

describe('orgUnitDepth / orgUnitLabel', () => {
  const unitsById = new Map([
    ['root', { id: 'root', name: 'Phòng Ban', parent_id: null }],
    ['child', { id: 'child', name: 'Tổ Con', parent_id: 'root' }],
    ['grandchild', { id: 'grandchild', name: 'Nhóm Nhỏ', parent_id: 'child' }],
  ]);

  it('tính đúng độ sâu theo chuỗi parent_id', () => {
    expect(orgUnitDepth('root', unitsById)).toBe(0);
    expect(orgUnitDepth('child', unitsById)).toBe(1);
    expect(orgUnitDepth('grandchild', unitsById)).toBe(2);
  });
  it('không lặp vô hạn khi có chu trình (self-parent)', () => {
    const cyclic = new Map([['a', { id: 'a', name: 'A', parent_id: 'a' }]]);
    expect(orgUnitDepth('a', cyclic)).toBe(1); // dừng lại nhờ Set `seen`, không treo
  });
  it('gắn tiền tố thụt lề theo độ sâu', () => {
    expect(orgUnitLabel(unitsById.get('grandchild'), unitsById)).toBe('— — Nhóm Nhỏ');
    expect(orgUnitLabel(unitsById.get('root'), unitsById)).toBe('Phòng Ban');
  });
});

describe('formatPersonalTimeAgo', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-02T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('rỗng khi thiếu hoặc không parse được', () => {
    expect(formatPersonalTimeAgo('')).toBe('');
    expect(formatPersonalTimeAgo('not-a-date')).toBe('');
  });
  it('"vừa xong" dưới 60 giây, không có tiền tố "Hoạt động"', () => {
    expect(formatPersonalTimeAgo('2026-09-02T11:59:30Z')).toBe('vừa xong');
  });
  it('trả cụm trần theo đơn vị phù hợp', () => {
    expect(formatPersonalTimeAgo('2026-09-02T11:55:00Z')).toBe('5 phút trước');
    expect(formatPersonalTimeAgo('2026-09-02T09:00:00Z')).toBe('3 giờ trước');
    expect(formatPersonalTimeAgo('2026-08-30T12:00:00Z')).toBe('3 ngày trước');
  });
});

describe('sortPersonalItemsCache', () => {
  it('ghim lên trước, trong mỗi nhóm sắp theo updated_at giảm dần', () => {
    const items = [
      { id: 1, pinned: false, updated_at: '2026-09-01T00:00:00Z' },
      { id: 2, pinned: true, updated_at: '2026-08-01T00:00:00Z' },
      { id: 3, pinned: false, updated_at: '2026-09-02T00:00:00Z' },
      { id: 4, pinned: true, updated_at: '2026-08-15T00:00:00Z' },
    ];
    expect(sortPersonalItemsCache(items).map(i => i.id)).toEqual([4, 2, 3, 1]);
  });
  it('không sửa mảng gốc (immutable)', () => {
    const items = [{ id: 1, pinned: false, updated_at: '2026-01-01' }];
    const sorted = sortPersonalItemsCache(items);
    expect(sorted).not.toBe(items);
  });
});
