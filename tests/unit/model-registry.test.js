import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import R from '../../lib/model-registry.js';

const root = path.resolve(__dirname, '../..');
const exists = (p) => fs.existsSync(path.join(root, p));

describe('sổ đăng ký mô hình', () => {
  it('mọi mô hình có đủ trường, tệp kiểm thử và tệp số chuẩn đều tồn tại thật', () => {
    expect(R.validate(R.MODELS, exists)).toEqual([]);
  });
  it('mỗi mô hình trỏ tới tệp nguồn có thật (lib hoặc Edge Function)', () => {
    R.MODELS.forEach((m) => m.lib.split(',').map((s) => s.trim()).forEach((f) => expect(exists(f), m.id + ' -> ' + f).toBe(true)));
  });
  it('phát hiện mô hình thiếu kiểm thử, thiếu giới hạn, id trùng, tệp không tồn tại', () => {
    const base = R.MODELS[0];
    expect(R.validate([Object.assign({}, base, { validation: { tests: [] } })])).toContain(base.id + ': chưa có kiểm thử');
    expect(R.validate([Object.assign({}, base, { limits: '' })])).toContain(base.id + ': thiếu limits');
    expect(R.validate([base, base])).toContain('id bị trùng');
    expect(R.validate([Object.assign({}, base, { validation: { tests: ['tests/unit/khong-co.js'] } })], exists).join('|')).toMatch(/không thấy tệp kiểm thử/);
  });
  it('mô hình nào cũng nêu giới hạn đã biết (không có mô hình "hoàn hảo")', () => {
    R.MODELS.forEach((m) => expect(m.limits.length).toBeGreaterThan(20));
  });
  it('byArea gom đủ mọi mô hình', () => {
    const g = R.byArea();
    expect(Object.values(g).reduce((s, a) => s + a.length, 0)).toBe(R.MODELS.length);
  });
});
