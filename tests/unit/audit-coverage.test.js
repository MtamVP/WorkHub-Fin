// Audit log: mọi bảng Finance có trigger kiểm toán đều phải đọc được trong trang Nhật Ký Kiểm Toán (nhãn + bộ lọc), và bản mở rộng 12/10/2026
// phải bỏ cột nặng / bỏ qua cột nhiễu (nhật ký kiểm toán giữ vĩnh viễn: ảnh chụp mô phỏng ~30 KB không được nhân đôi vào mỗi lần sửa).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');

// Bảng có trg_audit_* trên Supabase thật (kiểm ngày 12/10/2026), gồm 5 bảng của audit-log-finance-extension-migration.sql
const AUDITED = ['events', 'fin_roles', 'finance_approval_audit', 'finance_approval_policy', 'finance_cash_flows', 'finance_corporate_actions', 'finance_forecasts',
  'finance_idea_comments', 'finance_idea_votes', 'finance_ideas', 'finance_limit_exceptions', 'finance_limits', 'finance_order_requests', 'finance_policy_weights',
  'finance_reconciliations', 'finance_restricted_symbols', 'finance_thesis_conditions', 'finance_transactions', 'finance_vb_valuations', 'member_roles', 'messages',
  'org_units', 'project_milestones', 'projects', 'tasks', 'users',
  'finance_sim_runs', 'finance_decisions', 'finance_bt_runs', 'finance_assets', 'finance_allocation_targets'];

describe('Audit log: nhãn và bộ lọc phủ mọi bảng đã gắn trigger', () => {
  const script = read('script.js'), html = read('index.html');
  const labels = script.slice(script.indexOf('const AUDIT_LOG_ENTITY_LABELS'), script.indexOf('const AUDIT_LOG_OP_LABELS'));
  const filter = html.slice(html.indexOf('id="audit-log-filter-entity"'), html.indexOf('</select>', html.indexOf('id="audit-log-filter-entity"')));
  AUDITED.forEach((t) => {
    it(t, () => {
      expect(labels, 'nhãn ' + t).toMatch(new RegExp('\\b' + t + ':'));
      expect(filter, 'bộ lọc ' + t).toContain('value="' + t + '"');
    });
  });
});

describe('audit-log-finance-extension-migration.sql', () => {
  const sql = read('audit-log-finance-extension-migration.sql');
  it('gắn trigger đủ 5 bảng với hàm slim, bỏ ảnh chụp và cột nhiễu của sim-watch', () => {
    ['finance_sim_runs', 'finance_decisions', 'finance_bt_runs', 'finance_assets', 'finance_allocation_targets'].forEach((t) => expect(sql).toContain("('" + t + "'"));
    expect(sql).toMatch(/\('finance_sim_runs',\s*'snapshot,watch',\s*'updated_at,watch,watched_at'\)/);
    expect(sql).toMatch(/\('finance_bt_runs',\s*'summary'/);
    expect(sql).toMatch(/\('finance_assets',[^)]*'nav,/);
    expect(sql).toContain('fn_audit_row_change_slim');
  });
  it('hàm slim là SECURITY DEFINER và lấy người thực hiện từ auth.uid() ở máy chủ', () => {
    expect(sql).toMatch(/fn_audit_row_change_slim\(\)[\s\S]*security definer/i);
    expect(sql).toContain('auth.uid()');
  });
});
