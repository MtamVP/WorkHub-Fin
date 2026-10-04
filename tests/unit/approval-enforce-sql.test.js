// Trigger DB ép duyệt lệnh (finance-approval-enforce-migration.sql) lặp lại luật của lib/approval-calc.js bằng SQL. Không chạy được SQL trong Vitest, nên test này giữ
// những hằng số/điều kiện quan trọng không trôi lệch giữa hai nơi (kiểm hành vi thật đã làm bằng DO block trên DB, xem đầu file migration).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ApprovalCalc = require('../../lib/approval-calc.js');
const sql = fs.readFileSync(path.resolve(__dirname, '../../finance-approval-enforce-migration.sql'), 'utf8');

describe('finance-approval-enforce-migration.sql khớp ApprovalCalc', () => {
  it('dung sai giá +5% giống PRICE_TOLERANCE', () => {
    expect(sql).toContain('r.value * ' + (1 + ApprovalCalc.PRICE_TOLERANCE).toFixed(2));
  });
  it('ngưỡng tính như needsApproval: % NAV hoặc số tiền, lớn hơn chứ không phải bằng', () => {
    expect(sql).toContain('v_pct > pol.threshold_pct + 1e-9');
    expect(sql).toContain('v_val > pol.threshold_vnd + 1e-9');
    expect(sql).toContain('need := v_val > 0 and (by_pct or by_vnd)');
  });
  it('chọn đề xuất cũ trước (decided_at) như matchApproval và tiêu thụ ngay', () => {
    expect(sql).toContain('order by coalesce(r.decided_at, r.created_at) asc');
    expect(sql).toMatch(/update public\.finance_order_requests set status = 'executed', txn_id = new\.id/);
  });
  it('lệnh nhập sao kê vượt ngưỡng được ghi dòng kiểm tra kind import; điều chỉnh đối soát khớp ghi chú của reconcile.js', () => {
    expect(sql).toContain("'import')");
    expect(sql).toContain("like 'Đối soát%'");
    const rc = fs.readFileSync(path.resolve(__dirname, '../../mastersheet/assets/reconcile.js'), 'utf8');
    expect(rc).toContain('Đối soát ${rcDate(RC.asOf)}');
  });
  it('service role (không có người dùng) bỏ qua, và có thông điệp APPROVAL_REQUIRED mà giao diện nhận ra', () => {
    expect(sql).toContain('if me is null then return new; end if;');
    expect(sql).toContain("'APPROVAL_REQUIRED: ");
    const ui = fs.readFileSync(path.resolve(__dirname, '../../mastersheet/assets/script.js'), 'utf8');
    expect(ui).toContain('APPROVAL_REQUIRED');
  });
});
