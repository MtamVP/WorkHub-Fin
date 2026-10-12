// Ma trận quyền (RLS) của mọi bảng Finance và bảng dùng chung: dữ liệu cho bộ kiểm RLS thật (tests/rls/finance-rls.rls.test.js, chạy tay) và cho test tĩnh trong CI
// (tests/unit/rls-matrix.test.js: bảng mới có RLS mà chưa khai báo ở đây thì CI báo đỏ).
// kind:
//   'team-read-owner-write' : nhóm finance/admin ĐỌC được mọi dòng; chỉ chủ (hoặc quản lý tài sản) ghi (cột chủ = owner)
//   'owner-private'         : chỉ chủ đọc/ghi (owner)
//   'team-read-server-write': nhóm finance/admin ĐỌC; client KHÔNG ghi được (chỉ máy chủ/service role)
//   'manager-write'         : nhóm đọc; chỉ quản lý tài sản / admin ghi
//   'server-only'           : client không đọc cũng không ghi (RLS bật, không có chính sách)
//   'shared'                : bảng dùng chung các app (kiểm riêng, không nằm trong phép thử nhóm finance)
const T = (table, kind, owner) => ({ table, kind, owner: owner || null });
const MATRIX = [
  T('finance_assets', 'team-read-owner-write', 'user_id'), T('finance_transactions', 'team-read-owner-write', 'user_id'), T('finance_cash_flows', 'team-read-owner-write', 'user_id'),
  T('finance_corporate_actions', 'team-read-owner-write', 'user_id'), T('finance_holdings_price', 'team-read-owner-write', 'user_id'), T('finance_nav_history', 'team-read-owner-write', 'user_id'),
  T('finance_watchlist', 'team-read-owner-write', 'user_id'), T('finance_allocation_targets', 'team-read-owner-write', 'user_id'), T('finance_decisions', 'team-read-owner-write', 'user_id'),
  T('finance_sim_runs', 'team-read-owner-write', 'user_id'), T('finance_ideas', 'team-read-owner-write', 'user_id'), T('finance_idea_comments', 'team-read-owner-write', 'user_id'),
  T('finance_idea_votes', 'team-read-owner-write', 'user_id'), T('finance_forecasts', 'team-read-owner-write', 'user_id'), T('finance_vb_valuations', 'team-read-owner-write', 'user_id'),
  T('finance_reconciliations', 'team-read-owner-write', 'user_id'), T('finance_limit_exceptions', 'team-read-owner-write', 'user_id'), T('finance_order_requests', 'team-read-owner-write', 'user_id'),
  T('finance_event_dismissals', 'team-read-owner-write', 'user_id'), T('finance_notes', 'owner-private', 'user_id'), T('finance_stocks', 'team-read-owner-write', 'user_id'),
  T('finance_stock_valuations', 'team-read-owner-write', 'user_id'), T('finance_alert_prefs', 'owner-private', 'user_id'),
  T('finance_bt_runs', 'owner-private', 'user_id'), T('finance_digest_state', 'owner-private', 'user_id'),
  T('finance_limits', 'manager-write'), T('finance_restricted_symbols', 'manager-write'), T('finance_approval_policy', 'manager-write'), T('finance_policy_weights', 'manager-write'),
  T('finance_approval_audit', 'manager-write'), T('finance_data_health', 'manager-write'), T('finance_thesis_conditions', 'team-read-owner-write'), T('finance_stock_quarters', 'team-read-owner-write'),
  T('finance_benchmark_prices', 'manager-write'),
  T('finance_bt_index', 'team-read-server-write'), T('finance_price_days', 'team-read-server-write'), T('finance_pit_fundamentals', 'team-read-server-write'), T('finance_pit_market_daily', 'team-read-server-write'),
  T('finance_pit_news', 'team-read-server-write'), T('finance_news_events', 'team-read-server-write'), T('finance_insider_trades', 'team-read-server-write'), T('finance_shareholders', 'team-read-server-write'),
  T('finance_ownership_sync', 'team-read-server-write'), T('finance_financials_cache', 'team-read-server-write'), T('finance_market_snapshot', 'team-read-server-write'),
  T('finance_stock_meta', 'team-read-server-write'), T('finance_stock_ratios', 'team-read-server-write'), T('finance_sector_stats', 'team-read-server-write'), T('finance_rates', 'team-read-server-write'),
  T('finance_compliance_log', 'team-read-server-write'), T('finance_function_runs', 'team-read-server-write'), T('finance_thesis_log', 'team-read-server-write'),
  T('finance_valuation_alert_state', 'team-read-server-write'), T('finance_valuation_history', 'team-read-server-write'),
  T('finance_alert_log', 'server-only'), T('cron_guard_state', 'server-only'),
  T('butler_usage', 'owner-private', 'user_id'), T('butler_log', 'owner-private', 'user_id'),
  // dùng chung các app: kiểm hành vi riêng (audit_log chỉ admin đọc, personal_* chỉ chủ, users đọc công khai có chủ ý...)
  T('audit_log', 'shared'), T('app_settings', 'shared'), T('calendar_connections', 'shared'), T('calendar_google_sync', 'shared'), T('events', 'shared'), T('files', 'shared'), T('fin_roles', 'shared'),
  T('lounge_players', 'shared'), T('member_roles', 'shared'), T('messages', 'shared'), T('org_units', 'shared'), T('personal_items', 'shared'), T('personal_sync_files', 'shared'),
  T('project_milestones', 'shared'), T('projects', 'shared'), T('sci_journals', 'shared'), T('sci_roles', 'shared'), T('system_logs', 'shared'), T('task_assignees', 'shared'),
  T('task_comments', 'shared'), T('tasks', 'shared'), T('user_status', 'shared'), T('users', 'shared'),
];
// Chính sách đọc "using (true)" CÓ CHỦ Ý (ghi lý do): bảng nào ngoài danh sách này mà có chính sách đọc mở cho mọi người là lỗi cấu hình
const OPEN_READ_ALLOWED = {
  users: 'đăng nhập bằng biệt danh cần đổi biệt danh -> email trước khi có phiên (xem fn_resolve_login: sẽ siết khi cả 3 app dùng RPC)',
  org_units: 'sơ đồ tổ chức hiển thị cho mọi người dùng; chưa siết cùng users',
  app_settings: 'cài đặt dùng chung, mọi người dùng đăng nhập đọc (ghi cũng đang mở cho người đăng nhập: cần xem lại)',
  lounge_players: 'tính năng giải trí',
};
module.exports = { MATRIX, OPEN_READ_ALLOWED };
