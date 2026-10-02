// Personal Hub: "Kết nối Calendar" tab. Đợt 1 (connection-only), đợt 2 (kéo về 1 chiều) và
// đợt 3 (đồng bộ 2 CHIỀU thật: đẩy + kéo) đã xong. Đợt 4 (này): mở rộng phạm vi --
// (a) đồng bộ thêm các LỊCH PHỤ ngoài 'primary' (người dùng tự chọn qua "Quản lý lịch"),
// (b) đẩy SỰ KIỆN LẶP (daily/weekly/monthly) của WorkHub lên Google dưới dạng RRULE (trước đó
// bị loại hẳn khỏi danh sách đẩy), (c) sửa 1 lỗi nhỏ: applyGooglePullUpdate trước đây không
// cập nhật lại attendees khi Google đổi danh sách người tham dự của 1 sự kiện ĐÃ liên kết sẵn
// (chỉ đúng ở lần kéo về ĐẦU TIÊN) -- nay cập nhật đủ. KHÔNG đẩy attendees từ WorkHub lên
// Google (giữ nguyên quyết định của đợt 3: tránh vô tình gửi giấy mời thay người dùng) --
// đây vẫn là phạm vi cố tình để ngoài, cần 1 lượt xác nhận UX riêng nếu muốn bật sau này.
// Depends on oauth-loopback.js (PKCE + loopback redirect) and api.js
// (API.calendarConnection / callGAS('saveCalendarConnection', ...)).
//
// File này BẮT BUỘC giống hệt byte-for-byte cả 3 app (fin/sci/org) -- CI
// "cross-app-drift" fail nếu khác nhau dù chỉ 1 ký tự. Vì vậy không được đọc bất kỳ
// biến toàn cục đặc thù từng app nào (vd. tên biến "user hiện tại" org dùng
// `chatUser`, fin dùng `CURRENT_USER` -- khác nhau giữa 3 app) -- luôn tự lấy user
// qua sbClient.auth.getUser() và group qua API.auth.getUserGroup(email).
//
// Chính sách xung đột khi CẢ 2 bên đều đổi kể từ lần đồng bộ trước: LOCAL THẮNG (đơn
// giản hơn cách "giữ cả 2 bản" của personal-sync.js -- hợp lý vì lịch cá nhân 1 người
// dùng, cửa sổ xung đột hẹp). Thứ tự đồng bộ: ĐẨY trước, KÉO sau -- để lúc kéo thấy
// đúng google_updated_at mới nhất của những gì mình vừa đẩy, tránh tự kéo lại chính
// mình như 1 "thay đổi bên Google" thừa.
//
// Đa lịch: sự kiện MỚI tạo trong WorkHub luôn đẩy lên lịch 'primary' (không có UI chọn
// lịch đích cho từng sự kiện) -- các lịch phụ chỉ là nguồn bổ sung được KÉO VỀ. Sự kiện đã
// liên kết sẵn với 1 lịch phụ (vd tạo trực tiếp trên Google ở lịch đó) vẫn đẩy cập nhật
// đúng NGƯỢC VỀ lịch gốc của nó (không phải luôn về primary), xem google_calendar_id.
//
// Sự kiện lặp: WorkHub lưu 1 DÒNG MASTER duy nhất (recurrence + recurrence_end), không
// materialize từng lần lặp thành dòng riêng -- khớp tự nhiên với mô hình RRULE của Google
// (1 sự kiện master + RRULE). Khi KÉO VỀ, Google đã tự khai triển sự kiện lặp thành từng
// instance riêng (singleEvents=true, mỗi instance có recurringEventId trỏ về id master) --
// nếu instance đó là của 1 sự kiện lặp mà CHÍNH WorkHub đã đẩy lên (đã có sẵn 1 dòng master),
// phải bỏ qua, không tạo thêm N dòng instance trùng lặp với dòng master đã có.
const GOOGLE_CLIENT_ID = '825025516269-gmictbckj5c8ameatht1bbj6tqct6tqq.apps.googleusercontent.com';
const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
// calendarList.list (UI "Quản lý lịch") KHÔNG nằm trong quyền của calendar.events -- cần thêm
// calendar.calendarlist.readonly. 'openid email' để Google trả id_token chứa email tài khoản đã
// chọn (hiện trong panel, không cần gọi thêm API nào). Người dùng có thể bỏ tick từng quyền ở
// màn hình đồng ý của Google -- mọi chỗ dùng đều phải chịu được việc thiếu quyền (xem hasWriteScope
// / hasCalendarListScope / google_account_email có thể null).
const GOOGLE_CALENDARLIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const GOOGLE_OAUTH_SCOPES = [GOOGLE_CALENDAR_SCOPE, GOOGLE_CALENDARLIST_SCOPE, 'openid', 'email'].join(' ');
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// Google BẮT BUỘC gửi client_secret ở endpoint token kể cả với client loại Desktop + PKCE (lỗi "client_secret is
// missing" nếu thiếu). Với app cài trên máy nó không được coi là bí mật thật, nhưng repo này CÔNG KHAI nên giá trị
// KHÔNG được commit: scripts/sync-web.mjs ghi nó vào google-oauth-secret.js (chỉ trong tauri-dist) từ biến môi
// trường GOOGLE_OAUTH_CLIENT_SECRET lúc đóng gói. Thiếu biến đó thì build vẫn chạy nhưng kết nối Calendar sẽ lỗi.
function withGoogleClientSecret(fields) {
  const secret = (typeof window !== 'undefined' && window.__WH_GOOGLE_CLIENT_SECRET) || '';
  if (secret) fields.client_secret = secret;
  return fields;
}
const GOOGLE_CALENDAR_LIST_ENDPOINT = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';

function eventsEndpointFor(calendarId) {
  return 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarId || 'primary') + '/events';
}

// Cửa sổ thời gian kéo sự kiện về mỗi lần đồng bộ -- đủ dùng cho "sắp tới" mà
// không kéo vô hạn về quá khứ/tương lai. Có thể mở rộng sau nếu cần.
const SYNC_WINDOW_PAST_DAYS = 30;
const SYNC_WINDOW_FUTURE_DAYS = 180;
const SYNC_MAX_PAGES = 4; // 4 x 250 = tối đa 1000 sự kiện/lần đồng bộ/lịch, đủ cho lịch bình thường
const AUTO_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 phút

// callGAS/_dispatchAction (api.js) không bao giờ throw -- luôn trả {status,message,data},
// kể cả khi lỗi. Helper nhỏ này gói lại kiểm tra status + rút .data cho gọn, dùng cho
// mọi lệnh gọi callGAS mới ở phần đồng bộ 2 chiều bên dưới (tránh lặp lại cùng 1 đoạn
// kiểm tra ở chục chỗ khác nhau).
async function callGASData(action, params) {
  const res = await callGAS(action, params);
  if (res.status !== 'success') throw new Error(res.message || ('Lỗi thực hiện ' + action));
  return res.data;
}

async function renderCalendarConnectionPanel() {
  const listEl = document.getElementById('personal-calendar-connect-panel');
  if (!listEl) return;

  listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>Đang tải...</p></div>`;

  let connection = null;
  try {
    connection = await API.calendarConnection.get();
  } catch (err) {
    console.error('Lỗi tải trạng thái kết nối Calendar:', err);
  }

  if (!window.OAuthLoopback || !window.OAuthLoopback.isTauri()) {
    listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-desktop"></i><p>Kết nối Google Calendar chỉ hoạt động trong bản desktop app (không dùng được ở chế độ xem trình duyệt).</p></div>`;
    return;
  }

  if (connection) {
    const connectedAt = connection.connected_at ? new Date(connection.connected_at).toLocaleString('vi-VN') : '';
    const syncedAt = connection.last_synced_at ? new Date(connection.last_synced_at).toLocaleString('vi-VN') : 'Chưa đồng bộ lần nào';
    const readOnlyNotice = hasWriteScope(connection) ? '' :
      `<div class="sync-folder-status" style="color:var(--warning-color,#c07800)"><i class="fa-solid fa-triangle-exclamation"></i> Kết nối cũ chỉ đọc được từ Google -- kết nối lại để bật đồng bộ 2 chiều (sửa/xoá trong WorkHub cũng áp dụng lên Google).</div>`;
    const syncedCalendarIds = (connection.synced_calendar_ids && connection.synced_calendar_ids.length) ? connection.synced_calendar_ids : ['primary'];
    const calendarSummary = syncedCalendarIds.length <= 1 ? '1 lịch (Chính)' : syncedCalendarIds.length + ' lịch đã chọn';
    const googleEmail = connection.google_account_email || '';
    const workhubEmail = await getWorkhubLoginEmail();
    const accountLine = googleEmail
      ? `<div class="sync-folder-status"><i class="fa-brands fa-google"></i> Tài khoản Google: <b>${escapeHtml(googleEmail)}</b></div>` +
        ((workhubEmail && workhubEmail.toLowerCase() !== googleEmail.toLowerCase())
          ? `<div class="sync-folder-status">Khác với email đăng nhập WorkHub (${escapeHtml(workhubEmail)}) — bình thường nếu bạn chủ ý dùng tài khoản Google khác. Bấm "Kết nối lại" để đổi.</div>` : '')
      : `<div class="sync-folder-status"><i class="fa-brands fa-google"></i> Tài khoản Google: chưa rõ — bấm "Kết nối lại" để hiện email tài khoản đang đồng bộ.</div>`;
    const calendarListNotice = hasCalendarListScope(connection) ? '' :
      `<div class="sync-folder-status" style="color:var(--warning-color,#c07800)"><i class="fa-solid fa-triangle-exclamation"></i> Chưa có quyền xem danh sách lịch — kết nối lại (và giữ nguyên các quyền Google đề xuất) để dùng "Quản lý lịch".</div>`;
    listEl.innerHTML = `
    <div class="sync-folder-panel">
      <div class="sync-folder-header">
        <div>
          <div class="sync-folder-path"><i class="fa-solid fa-calendar-check"></i> Google Calendar đã kết nối</div>
          ${accountLine}
          <div class="sync-folder-status">Kết nối lúc: ${escapeHtml(connectedAt)}</div>
          <div class="sync-folder-status" id="calendar-last-synced-status">Đồng bộ lần cuối: ${escapeHtml(syncedAt)}</div>
          ${readOnlyNotice}
        </div>
        <div class="sync-folder-actions">
          <button type="button" class="btn btn-outline" id="calendar-sync-now-btn" onclick="syncGoogleCalendarNow()"><i class="fa-solid fa-rotate"></i> Đồng bộ ngay</button>
          <button type="button" class="btn btn-outline" onclick="connectGoogleCalendar()"><i class="fa-brands fa-google"></i> Kết nối lại</button>
          <button type="button" class="btn btn-outline" onclick="disconnectGoogleCalendar()"><i class="fa-solid fa-link-slash"></i> Ngắt kết nối</button>
        </div>
      </div>
    </div>
    <div class="sync-folder-panel" style="margin-top:10px;">
      <div class="sync-folder-header">
        <div>
          <div class="sync-folder-path"><i class="fa-solid fa-calendar-days"></i> Lịch đang đồng bộ</div>
          <div class="sync-folder-status">${escapeHtml(calendarSummary)}</div>
          ${calendarListNotice}
        </div>
        <div class="sync-folder-actions">
          <button type="button" class="btn btn-outline" onclick="toggleCalendarPicker()"><i class="fa-solid fa-sliders"></i> Quản lý lịch</button>
        </div>
      </div>
      <div id="calendar-picker-body" style="display:none; margin-top:10px;"></div>
    </div>`;
    return;
  }

  listEl.innerHTML = `
    <div class="empty-state">
      <i class="fa-solid fa-calendar-plus"></i>
      <p>Chưa kết nối Google Calendar. Kết nối để tự động đồng bộ 2 chiều sự kiện lịch cá nhân giữa WorkHub và Google Calendar của bạn.</p>
      <button type="button" class="btn btn-primary" onclick="connectGoogleCalendar()"><i class="fa-brands fa-google"></i> Kết nối Google Calendar</button>
    </div>`;
}

// Scope calendar.events (ghi được) so với calendar.readonly (chỉ đọc, từ đợt 2) --
// kết nối cũ cấp trước khi có đợt này sẽ không chứa 'calendar.events' trong chuỗi
// scope, tự nhận diện qua substring này thay vì so sánh scope y hệt (Google có thể trả
// nhiều scope cách nhau bằng dấu cách nếu người dùng cấp thêm quyền khác).
function hasWriteScope(connection) {
  return !!(connection && connection.scope && connection.scope.indexOf('calendar.events') !== -1);
}

// "Quản lý lịch" cần calendar.calendarlist.readonly -- kết nối cấp trước khi có quyền này (hoặc
// người dùng bỏ tick quyền đó) sẽ bị Google từ chối calendarList.list bằng lỗi 403.
function hasCalendarListScope(connection) {
  return !!(connection && connection.scope && connection.scope.indexOf('calendar.calendarlist') !== -1);
}

// Email tài khoản WorkHub đang đăng nhập -- chỉ dùng làm login_hint gợi ý cho Google và để so sánh
// hiển thị. Tự lấy qua sbClient (không đọc biến toàn cục riêng từng app, xem comment đầu file).
async function getWorkhubLoginEmail() {
  try {
    const { data } = await sbClient.auth.getUser();
    const email = data && data.user && data.user.email ? String(data.user.email).trim() : '';
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
  } catch (e) {
    return '';
  }
}

// id_token là JWT; payload (đoạn giữa, base64url) chứa claim "email". Token nhận thẳng từ endpoint
// token của Google qua TLS nên chỉ cần ĐỌC claim để hiển thị -- không dùng nó để xác thực/phân quyền
// gì cả, nên không cần kiểm chữ ký. Trả về null nếu thiếu/không đọc được (vd người dùng bỏ quyền email).
function decodeIdTokenEmail(idToken) {
  try {
    if (!idToken) return null;
    const parts = String(idToken).split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload.email || payload.email_verified === false) return null;
    return String(payload.email);
  } catch (e) {
    return null;
  }
}

async function connectGoogleCalendar() {
  if (!GOOGLE_CLIENT_ID) { showToast('Chưa cấu hình GOOGLE_CLIENT_ID.', 'warning'); return; }
  if (!window.OAuthLoopback || !window.OAuthLoopback.isTauri()) {
    showToast('Kết nối Google Calendar chỉ khả dụng trên bản desktop app.', 'warning'); return;
  }
  try {
    const { codeVerifier, codeChallenge, method } = await window.OAuthLoopback.createPkcePair();
    const previousConnection = await API.calendarConnection.get().catch(() => null);
    const workhubEmail = await getWorkhubLoginEmail();
    const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', window.OAuthLoopback.OAUTH_CALLBACK_URL);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', GOOGLE_OAUTH_SCOPES);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', method);
    authUrl.searchParams.set('access_type', 'offline');
    // select_account: luôn hiện bộ chọn tài khoản (không âm thầm dùng tài khoản đang đăng nhập sẵn
    // trong trình duyệt). login_hint chỉ là GỢI Ý email đăng nhập WorkHub -- người dùng vẫn đổi được.
    authUrl.searchParams.set('prompt', 'select_account consent');
    if (workhubEmail) authUrl.searchParams.set('login_hint', workhubEmail);

    const queryString = await window.OAuthLoopback.awaitRedirect(authUrl.toString());
    const params = window.OAuthLoopback.parseQueryString(queryString);
    if (params.error) throw new Error(params.error);
    if (!params.code) throw new Error('Không nhận được mã xác thực từ Google.');

    const tokenResp = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(withGoogleClientSecret({
        client_id: GOOGLE_CLIENT_ID, code: params.code, code_verifier: codeVerifier,
        grant_type: 'authorization_code', redirect_uri: window.OAuthLoopback.OAUTH_CALLBACK_URL
      }))
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok) throw new Error(tokenJson.error_description || tokenJson.error || 'Google từ chối yêu cầu token.');

    const expiresAt = new Date(Date.now() + (tokenJson.expires_in || 3600) * 1000).toISOString();
    const googleEmail = decodeIdTokenEmail(tokenJson.id_token);
    await callGAS('saveCalendarConnection', {
      access_token: tokenJson.access_token, refresh_token: tokenJson.refresh_token || null,
      expires_at: expiresAt, scope: tokenJson.scope || GOOGLE_CALENDAR_SCOPE,
      google_account_email: googleEmail
    });
    // Đổi sang TÀI KHOẢN GOOGLE KHÁC so với lần kết nối trước: danh sách lịch phụ đã chọn thuộc về
    // tài khoản cũ nên không còn ý nghĩa -- đưa về chỉ lịch chính.
    const switchedAccount = !!(googleEmail && previousConnection && previousConnection.google_account_email &&
      previousConnection.google_account_email.toLowerCase() !== googleEmail.toLowerCase());
    if (switchedAccount) {
      try { await callGASData('setSyncedCalendars', { calendarIds: ['primary'] }); } catch (e) { /* không chặn kết nối */ }
    }
    showToast(googleEmail
      ? ('Đã kết nối Google Calendar (' + googleEmail + ')' + (switchedAccount ? ' — tài khoản đã đổi, danh sách lịch phụ được đặt lại.' : '.'))
      : 'Đã kết nối Google Calendar.', 'success');
    // Đồng bộ ngay lần đầu kết nối -- không bắt người dùng tự bấm "Đồng bộ ngay" thêm 1 lần.
    await syncGoogleCalendarNow();
  } catch (err) {
    showToast('Kết nối Google Calendar thất bại: ' + (err.message || String(err)), 'error');
  }
}

async function disconnectGoogleCalendar() {
  try {
    await callGAS('disconnectCalendarConnection', {});
    showToast('Đã ngắt kết nối Google Calendar.', 'success');
    renderCalendarConnectionPanel();
  } catch (err) {
    showToast('Ngắt kết nối thất bại: ' + (err.message || String(err)), 'error');
  }
}

// ---------------------------------------------------------------------------
// QUẢN LÝ LỊCH ĐỒNG BỘ (đa lịch)
// ---------------------------------------------------------------------------

async function fetchCalendarList(accessToken) {
  const resp = await fetch(GOOGLE_CALENDAR_LIST_ENDPOINT, { headers: { Authorization: 'Bearer ' + accessToken } });
  const json = await resp.json();
  if (!resp.ok) throw new Error((json.error && json.error.message) || 'Không tải được danh sách lịch.');
  return (json.items || [])
    .filter(c => c.id)
    .map(c => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary }));
}

async function toggleCalendarPicker() {
  const body = document.getElementById('calendar-picker-body');
  if (!body) return;
  const show = body.style.display === 'none';
  body.style.display = show ? 'block' : 'none';
  if (!show) return;

  body.innerHTML = `<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i></div>`;
  try {
    const connection = await API.calendarConnection.get();
    if (!connection) { body.innerHTML = `<div class="empty-state">Chưa kết nối.</div>`; return; }
    if (!hasCalendarListScope(connection)) {
      body.innerHTML = `<div class="empty-state">Cần kết nối lại để cấp quyền xem danh sách lịch. Bấm "Kết nối lại" ở trên rồi giữ nguyên các quyền Google đề xuất.</div>`;
      return;
    }
    const accessToken = await getValidAccessToken(connection);
    const calendars = await fetchCalendarList(accessToken);
    const selected = new Set((connection.synced_calendar_ids && connection.synced_calendar_ids.length) ? connection.synced_calendar_ids : ['primary']);
    body.innerHTML = calendars.map(c => `
      <label style="display:flex; align-items:center; gap:8px; padding:6px 0;">
        <input type="checkbox" value="${escapeHtml(c.id)}" ${(c.primary || selected.has(c.id)) ? 'checked' : ''} ${c.primary ? 'disabled' : ''}>
        <span>${escapeHtml(c.name)}${c.primary ? ' <small>(lịch chính, luôn bật)</small>' : ''}</span>
      </label>`).join('') +
      `<button type="button" class="btn btn-primary" style="margin-top:8px;" onclick="saveCalendarPicker()"><i class="fa-solid fa-floppy-disk"></i> Lưu lựa chọn</button>`;
  } catch (err) {
    body.innerHTML = `<div class="empty-state" style="color:var(--danger-color,#c0392b)">${escapeHtml(err.message || String(err))}</div>`;
  }
}

async function saveCalendarPicker() {
  const body = document.getElementById('calendar-picker-body');
  if (!body) return;
  const checked = Array.from(body.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
  if (!checked.includes('primary')) checked.push('primary');
  try {
    await callGASData('setSyncedCalendars', { calendarIds: checked });
    showToast('Đã lưu lựa chọn lịch đồng bộ.', 'success');
    renderCalendarConnectionPanel();
    await syncGoogleCalendarNow();
  } catch (err) {
    showToast('Lỗi: ' + (err.message || String(err)), 'error');
  }
}

// ---------------------------------------------------------------------------
// ĐỒNG BỘ SỰ KIỆN (2 chiều: WorkHub <-> Google)
// ---------------------------------------------------------------------------

// Trả về access_token còn hạn dùng -- tự refresh qua GOOGLE_TOKEN_ENDPOINT nếu đã
// hết hạn (trừ hao 2 phút). Google thường KHÔNG trả refresh_token mới mỗi lần
// refresh -- phải giữ lại refresh_token cũ khi lưu, không được ghi đè bằng null.
async function getValidAccessToken(connection) {
  const expiresAt = connection.expires_at ? new Date(connection.expires_at).getTime() : 0;
  const bufferMs = 2 * 60 * 1000;
  if (expiresAt && expiresAt - bufferMs > Date.now()) {
    return connection.access_token;
  }
  if (!connection.refresh_token) {
    throw new Error('Phiên kết nối Google Calendar đã hết hạn và không thể tự làm mới -- vui lòng kết nối lại.');
  }
  const resp = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(withGoogleClientSecret({
      client_id: GOOGLE_CLIENT_ID, refresh_token: connection.refresh_token, grant_type: 'refresh_token'
    }))
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error_description || json.error || 'Google từ chối yêu cầu làm mới token.');

  const newExpiresAt = new Date(Date.now() + (json.expires_in || 3600) * 1000).toISOString();
  await callGAS('saveCalendarConnection', {
    access_token: json.access_token,
    refresh_token: json.refresh_token || connection.refresh_token, // giữ token cũ nếu Google không trả cái mới
    expires_at: newExpiresAt,
    scope: json.scope || connection.scope
  });
  return json.access_token;
}

// Daily/weekly/monthly (mô hình lặp đơn giản của WorkHub) -> RRULE Google hiểu được.
// Không hỗ trợ interval tuỳ chỉnh ("mỗi 2 tuần") hay chọn thứ trong tuần -- khớp đúng
// những gì form tạo sự kiện lặp của WorkHub hiện có, không hơn không kém.
function buildRRule(recurrence, recurrenceEnd) {
  const freqMap = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' };
  const freq = freqMap[recurrence];
  if (!freq) return null;
  let rule = 'RRULE:FREQ=' + freq;
  if (recurrenceEnd) {
    const untilDate = new Date(recurrenceEnd + 'T23:59:59Z');
    if (!isNaN(untilDate.getTime())) {
      const until = untilDate.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      rule += ';UNTIL=' + until;
    }
  }
  return rule;
}

function mapGoogleEventToRow(ev, email, groupKey, calendarId) {
  const isAllDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
  const startTime = isAllDay ? ev.start.date + 'T00:00:00' : ev.start.dateTime;
  const endRaw = ev.end || ev.start;
  // Google's end.date cho sự kiện cả-ngày là MỐC LOẠI TRỪ (ngày SAU ngày cuối cùng thật
  // sự của sự kiện) -- vd. sự kiện 1 ngày (5/9) có end.date='2026-09-06', không phải
  // '2026-09-05'. Lấy thẳng end.date làm cuối ngày sẽ khiến 1 sự kiện 1-ngày hiện chiếm
  // 2 ngày trên lịch WorkHub -- phải lùi lại 1 ngày trước khi gán 23:59:59.
  let endTime;
  if (isAllDay) {
    const endDateStr = endRaw.date || ev.start.date;
    const endDateExclusive = new Date(endDateStr + 'T00:00:00');
    endDateExclusive.setDate(endDateExclusive.getDate() - 1);
    const y = endDateExclusive.getFullYear();
    const m = String(endDateExclusive.getMonth() + 1).padStart(2, '0');
    const d = String(endDateExclusive.getDate()).padStart(2, '0');
    endTime = `${y}-${m}-${d}T23:59:59`;
  } else {
    endTime = endRaw.dateTime || startTime;
  }
  const attendees = Array.isArray(ev.attendees)
    ? ev.attendees.map(a => a.email).filter(Boolean).join(',')
    : null;
  const qualifiedId = (!calendarId || calendarId === 'primary') ? ev.id : calendarId + ':' + ev.id;
  return {
    id: 'GCAL_' + qualifiedId,
    title: ev.summary || '(Không có tiêu đề)',
    start_time: startTime,
    end_time: endTime,
    description: ev.description || null,
    location: ev.location || null,
    calendar_type: 'personal',
    group_key: groupKey,
    created_by: email,
    recurrence: 'none', // Google đã tự khai triển sự kiện lặp (singleEvents=true) -- mỗi dòng là 1 lần cụ thể
    recurrence_end: null,
    attendees: attendees,
    google_event_id: qualifiedId,
    google_calendar_id: calendarId || 'primary',
    source: 'google'
  };
}

// Chiều ngược lại mapGoogleEventToRow(): map 1 dòng events (WorkHub) -> body gửi lên
// Google Calendar API. Đối xứng với xử lý mốc cả-ngày ở chiều kéo về: WorkHub lưu sự
// kiện cả-ngày là 00:00:00 -> 23:59:59 (đã lùi lại 1 ngày lúc kéo về), nên đẩy lên lại
// phải CỘNG lại 1 ngày cho end.date (Google coi end.date là mốc loại trừ). KHÔNG map
// attendees -- tránh vô tình gửi giấy mời Google Calendar thay người dùng. Sự kiện lặp
// (recurrence != 'none') kèm thêm RRULE -- xem buildRRule().
function mapRowToGoogleEventBody(event) {
  const start = new Date(event.start_time);
  const end = new Date(event.end_time);
  const isAllDay = start.getHours() === 0 && start.getMinutes() === 0 && start.getSeconds() === 0
    && end.getHours() === 23 && end.getMinutes() === 59 && end.getSeconds() === 59;
  const body = {
    summary: event.title || '(Không có tiêu đề)',
    description: event.description || '',
    location: event.location || ''
  };
  const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (isAllDay) {
    const endExclusive = new Date(end);
    endExclusive.setDate(endExclusive.getDate() + 1);
    body.start = { date: fmtDate(start) };
    body.end = { date: fmtDate(endExclusive) };
  } else {
    body.start = { dateTime: start.toISOString() };
    body.end = { dateTime: end.toISOString() };
  }
  if (event.recurrence && event.recurrence !== 'none') {
    const rule = buildRRule(event.recurrence, event.recurrence_end || event.recurrenceEnd);
    if (rule) body.recurrence = [rule];
  }
  return body;
}

async function insertGoogleEvent(accessToken, calendarId, body) {
  const resp = await fetch(eventsEndpointFor(calendarId), {
    method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error((json.error && json.error.message) || 'Tạo sự kiện trên Google Calendar thất bại.');
  return json;
}

async function updateGoogleEvent(accessToken, calendarId, googleEventId, body) {
  const resp = await fetch(eventsEndpointFor(calendarId) + '/' + encodeURIComponent(googleEventId), {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (resp.status === 404 || resp.status === 410) return null; // đã bị xoá bên Google từ trước, coi như xong
  const json = await resp.json();
  if (!resp.ok) throw new Error((json.error && json.error.message) || 'Cập nhật sự kiện trên Google Calendar thất bại.');
  return json;
}

async function deleteGoogleEvent(accessToken, calendarId, googleEventId) {
  const resp = await fetch(eventsEndpointFor(calendarId) + '/' + encodeURIComponent(googleEventId), {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (resp.ok || resp.status === 404 || resp.status === 410 || resp.status === 204) return;
  let msg = 'Xoá sự kiện trên Google Calendar thất bại.';
  try { const json = await resp.json(); msg = (json.error && json.error.message) || msg; } catch (e) { /* body rỗng, giữ msg mặc định */ }
  throw new Error(msg);
}

// Đẩy các thay đổi cục bộ (tạo/sửa/xoá sự kiện cá nhân -- kể cả sự kiện lặp, xem
// getPersonalEventsForPush) lên Google Calendar. Sự kiện MỚI (chưa từng liên kết) luôn
// tạo ở lịch 'primary'; sự kiện ĐÃ liên kết sẵn cập nhật/xoá đúng NGƯỢC VỀ lịch gốc của
// nó (google_calendar_id). Trả về số sự kiện đã đẩy thành công.
async function pushPendingLocalEvents(accessToken, email, groupKey, windowStart, windowEnd) {
  const candidates = await callGASData('getPersonalEventsForPush', { email, groupKey, windowStart, windowEnd });
  if (!candidates || !candidates.length) return 0;
  const syncedEntries = [];
  let pushedCount = 0;
  for (const ev of candidates) {
    const calendarId = ev.google_calendar_id || 'primary';
    try {
      if (ev.deleted_at) {
        if (ev.google_event_id) {
          await deleteGoogleEvent(accessToken, calendarId, ev.google_event_id);
          await callGASData('deleteGoogleSyncRow', { eventId: ev.id });
        }
        continue;
      }
      const body = mapRowToGoogleEventBody(ev);
      if (!ev.google_event_id) {
        const created = await insertGoogleEvent(accessToken, 'primary', body);
        const newVersion = await callGASData('linkGoogleEventId', { eventId: ev.id, googleEventId: created.id, googleCalendarId: 'primary' });
        syncedEntries.push({ eventId: ev.id, googleEventId: created.id, syncedVersion: newVersion || ev.version, googleUpdatedAt: created.updated });
      } else {
        const updated = await updateGoogleEvent(accessToken, calendarId, ev.google_event_id, body);
        if (updated) {
          syncedEntries.push({ eventId: ev.id, googleEventId: ev.google_event_id, syncedVersion: ev.version, googleUpdatedAt: updated.updated });
        }
      }
      pushedCount += 1;
    } catch (err) {
      console.warn('pushPendingLocalEvents: bỏ qua 1 sự kiện lỗi', ev.id, err);
    }
  }
  if (syncedEntries.length) await callGASData('markGoogleSyncedBatch', { entries: syncedEntries });
  return pushedCount;
}

async function fetchGoogleEventsPage(accessToken, calendarId, timeMin, timeMax, pageToken) {
  const url = new URL(eventsEndpointFor(calendarId));
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '250');
  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const resp = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
  const json = await resp.json();
  if (!resp.ok) {
    const msg = (json.error && json.error.message) || 'Google Calendar API từ chối yêu cầu.';
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }
  return json;
}

// Đồng bộ 2 chiều, đa lịch: ĐẨY thay đổi cục bộ lên Google trước (nếu kết nối có scope
// ghi), rồi KÉO sự kiện về TỪNG lịch đã chọn (chỉ áp những gì THẬT SỰ do Google đổi), bỏ
// qua các instance tự sinh của sự kiện lặp mà chính WorkHub vừa đẩy lên, rồi dọn theo
// TỪNG lịch riêng (không gộp activeIds của lịch khác). Không đọc biến toàn cục
// app-specific -- xem comment đầu file.
async function syncGoogleCalendarEvents() {
  const connection = await API.calendarConnection.get();
  if (!connection) throw new Error('Chưa kết nối Google Calendar.');

  const { data: userRes } = await sbClient.auth.getUser();
  const email = userRes && userRes.user ? userRes.user.email : null;
  if (!email) throw new Error('Không xác định được người dùng hiện tại.');
  const groupKey = await API.auth.getUserGroup(email);

  const accessToken = await getValidAccessToken(connection);

  const now = Date.now();
  const windowStart = new Date(now - SYNC_WINDOW_PAST_DAYS * 86400000).toISOString();
  const windowEnd = new Date(now + SYNC_WINDOW_FUTURE_DAYS * 86400000).toISOString();

  let pushedCount = 0;
  const canPush = hasWriteScope(connection);
  if (canPush) {
    try {
      pushedCount = await pushPendingLocalEvents(accessToken, email, groupKey, windowStart, windowEnd);
    } catch (err) {
      console.warn('syncGoogleCalendarEvents: đẩy thay đổi cục bộ lên Google thất bại', err);
    }
  }

  const calendarIds = (connection.synced_calendar_ids && connection.synced_calendar_ids.length)
    ? connection.synced_calendar_ids : ['primary'];

  const fetchedItems = []; // { ev, calendarId, qualifiedId }
  const activeIdsByCalendar = {};
  let anyTruncated = false;

  for (const calendarId of calendarIds) {
    activeIdsByCalendar[calendarId] = [];
    let pageToken = null;
    let pages = 0;
    do {
      let page;
      try {
        page = await fetchGoogleEventsPage(accessToken, calendarId, windowStart, windowEnd, pageToken);
      } catch (err) {
        console.warn('syncGoogleCalendarEvents: lỗi tải lịch ' + calendarId + ', bỏ qua lịch này', err);
        break; // không chặn các lịch khác vì 1 lịch lỗi (vd bị thu hồi quyền truy cập)
      }
      const items = page.items || [];
      for (const ev of items) {
        if (ev.status === 'cancelled') continue;
        if (!ev.start || (!ev.start.date && !ev.start.dateTime)) continue; // sự kiện thiếu mốc thời gian, bỏ qua
        const qualifiedId = (calendarId === 'primary') ? ev.id : calendarId + ':' + ev.id;
        fetchedItems.push({ ev, calendarId, qualifiedId });
        activeIdsByCalendar[calendarId].push(qualifiedId);
      }
      pageToken = page.nextPageToken || null;
      pages += 1;
      if (pageToken && pages >= SYNC_MAX_PAGES) anyTruncated = true;
    } while (pageToken && pages < SYNC_MAX_PAGES);
  }

  // Bỏ qua các instance lẻ Google tự sinh (singleEvents=true) của 1 sự kiện lặp mà CHÍNH
  // WorkHub đã đẩy lên (đã có sẵn 1 dòng master riêng) -- tránh tạo trùng.
  const recurringInstanceParentIds = [...new Set(
    fetchedItems.filter(f => f.ev.recurringEventId).map(f => f.ev.recurringEventId)
  )];
  const recurringMasterIds = recurringInstanceParentIds.length
    ? await callGASData('getRecurringMasterGoogleIds', { googleEventIds: recurringInstanceParentIds })
    : [];
  const recurringMasterSet = new Set(recurringMasterIds);
  const effectiveItems = fetchedItems.filter(f => !(f.ev.recurringEventId && recurringMasterSet.has(f.ev.recurringEventId)));

  const allActiveIds = effectiveItems.map(f => f.qualifiedId);
  const syncStateMap = allActiveIds.length
    ? await callGASData('getGoogleSyncState', { googleEventIds: allActiveIds })
    : {};
  const newRows = [];
  const pulledUpdates = [];
  for (const { ev, calendarId, qualifiedId } of effectiveItems) {
    const syncState = syncStateMap[qualifiedId];
    if (!syncState) {
      newRows.push(mapGoogleEventToRow(ev, email, groupKey, calendarId));
      continue;
    }
    const googleUpdatedAt = ev.updated ? new Date(ev.updated).getTime() : 0;
    const storedUpdatedAt = syncState.google_updated_at ? new Date(syncState.google_updated_at).getTime() : 0;
    if (googleUpdatedAt > storedUpdatedAt) {
      pulledUpdates.push({ eventId: syncState.event_id, ev, calendarId, qualifiedId });
    }
  }

  const newSyncEntries = [];
  // callGAS/_dispatchAction (api.js) không bao giờ throw -- luôn trả {status,message,data},
  // kể cả khi lỗi. callGASData() ở trên đã tự throw khi status lỗi, đúng quy ước mọi nơi
  // khác trong app đang dùng, nếu không lỗi ghi DB sẽ âm thầm bị nuốt và người dùng thấy
  // toast "đồng bộ thành công" giả.
  if (newRows.length) {
    await callGASData('upsertGoogleEvents', { rows: newRows });
    const versionMap = await callGASData('getEventsVersionsByGoogleId', { googleEventIds: newRows.map(r => r.google_event_id) });
    for (const r of newRows) {
      const v = versionMap[r.google_event_id];
      if (!v) continue;
      const found = effectiveItems.find(f => f.qualifiedId === r.google_event_id);
      newSyncEntries.push({ eventId: v.id, googleEventId: r.google_event_id, syncedVersion: v.version, googleUpdatedAt: found && found.ev.updated });
    }
  }

  for (const { eventId, ev, calendarId, qualifiedId } of pulledUpdates) {
    try {
      const mapped = mapGoogleEventToRow(ev, email, groupKey, calendarId);
      const newVersion = await callGASData('applyGooglePullUpdate', {
        eventId,
        fields: { title: mapped.title, start_time: mapped.start_time, end_time: mapped.end_time, description: mapped.description, location: mapped.location, attendees: mapped.attendees }
      });
      newSyncEntries.push({ eventId, googleEventId: qualifiedId, syncedVersion: newVersion, googleUpdatedAt: ev.updated });
    } catch (err) {
      console.warn('syncGoogleCalendarEvents: áp cập nhật kéo về thất bại cho sự kiện', ev.id, err);
    }
  }
  if (newSyncEntries.length) await callGASData('markGoogleSyncedBatch', { entries: newSyncEntries });

  // Bỏ qua bước dọn (prune) nếu có lịch bị cắt bớt trang (còn sự kiện chưa kéo hết) --
  // nếu không, những sự kiện thật ở các trang chưa kéo sẽ bị hiểu nhầm là "đã xoá bên
  // Google" và bị xoá oan. Dọn theo TỪNG lịch riêng, không gộp activeIds của lịch khác.
  if (!anyTruncated) {
    for (const calendarId of calendarIds) {
      await callGASData('pruneGoogleEvents', {
        email, groupKey, calendarId,
        activeGoogleIds: activeIdsByCalendar[calendarId] || [],
        windowStart, windowEnd
      });
    }
  } else {
    console.warn('syncGoogleCalendarEvents: có lịch với hơn ' + (SYNC_MAX_PAGES * 250) + ' sự kiện trong cửa sổ đồng bộ -- bỏ qua bước dọn để tránh xoá oan sự kiện thật ở các trang chưa kéo về.');
  }
  await callGASData('touchCalendarSync', {});

  return { count: newRows.length, updatedCount: pulledUpdates.length, pushedCount, truncated: anyTruncated };
}

// Wrapper có UI: khoá nút + spinner trong lúc chạy, toast kết quả, vẽ lại panel kết
// nối, và làm mới lịch đang mở (nếu có) để thấy ngay không cần tải lại trang.
async function syncGoogleCalendarNow() {
  const btn = document.getElementById('calendar-sync-now-btn');
  const oldHtml = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang đồng bộ...'; }
  try {
    const result = await syncGoogleCalendarEvents();
    const suffix = result.truncated ? ' (lịch quá nhiều sự kiện, có thể chưa dọn hết sự kiện cũ)' : '';
    const parts = [`${result.count} sự kiện mới`, `${result.updatedCount} cập nhật từ Google`];
    if (result.pushedCount) parts.push(`${result.pushedCount} đã đẩy lên Google`);
    showToast(`Đã đồng bộ: ${parts.join(', ')}.${suffix}`, 'success');
  } catch (err) {
    showToast('Đồng bộ Google Calendar thất bại: ' + (err.message || String(err)), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = oldHtml; }
    renderCalendarConnectionPanel();
    if (typeof loadCalendarData === 'function' && document.getElementById('full-calendar-display')) {
      loadCalendarData({ quiet: true });
    }
  }
}

// Gọi 1 lần lúc mở Personal Hub -- tự đồng bộ im lặng (không khoá nút, không toast
// lỗi ồn ào) nếu đã kết nối và lâu rồi chưa đồng bộ. Không chặn UI: chạy nền.
async function initCalendarAutoSync() {
  if (!window.OAuthLoopback || !window.OAuthLoopback.isTauri()) return;
  let connection = null;
  try {
    connection = await API.calendarConnection.get();
  } catch (err) {
    return;
  }
  if (!connection) return;
  const lastSynced = connection.last_synced_at ? new Date(connection.last_synced_at).getTime() : 0;
  if (Date.now() - lastSynced < AUTO_SYNC_MIN_INTERVAL_MS) return;
  try {
    const result = await syncGoogleCalendarEvents();
    renderCalendarConnectionPanel();
    if (typeof loadCalendarData === 'function' && document.getElementById('full-calendar-display')) {
      loadCalendarData({ quiet: true });
    }
    const total = result.count + result.updatedCount + result.pushedCount;
    if (total > 0) showToast(`Đã tự động đồng bộ ${total} thay đổi với Google Calendar.`, 'success');
  } catch (err) {
    console.warn('initCalendarAutoSync: đồng bộ nền thất bại', err);
  }
}
