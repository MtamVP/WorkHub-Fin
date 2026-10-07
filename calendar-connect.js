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
// Đợt 5 -- vì sao "thêm sự kiện trong app" trước đây KHÔNG lên Google: việc đẩy chỉ chạy bên trong 1 lượt đồng bộ, mà lượt
// đó chỉ được kích hoạt khi bấm "Đồng bộ ngay"/mở bảng Tích hợp. Giờ: (a) mọi createEvent/updateEvent/deleteEvent thành công
// (api.js) gọi scheduleGoogleCalendarPush() -> sau ~4 giây tự đẩy; (b) đồng bộ nền mỗi 5 phút khi app đang mở (kéo từ Google
// về + đẩy những gì còn sót); (c) có khoá chống 2 lượt chạy chồng (chồng nhau = tạo trùng sự kiện trên Google); (d) sự kiện tạo
// mới dùng ID Google ổn định suy ra từ ID WorkHub nên thử lại sau khi rớt mạng không tạo trùng; (e) lỗi đẩy được báo ra thay vì
// chỉ console.warn; (f) giờ gửi kèm timeZone (bắt buộc với sự kiện lặp) và sự kiện cả ngày lưu theo mốc nửa đêm ĐỊA PHƯƠNG
// (trước đây lưu 00:00 UTC nên ở múi giờ phía tây UTC bị lùi sang ngày hôm trước và bị đẩy ngược lên như sự kiện có giờ).
// Chỉ lịch loại "Cá nhân" (events.calendar_type='personal') được đồng bộ -- lịch nhóm thì không.
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
const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;      // mở bảng Tích hợp: chỉ tự đồng bộ nếu lần cuối đã quá 5 phút
const BACKGROUND_SYNC_INTERVAL_MS = 5 * 60 * 1000;    // đồng bộ nền khi app đang mở
const BACKGROUND_FIRST_DELAY_MS = 15 * 1000;          // lượt đầu sau khi mở app (chờ đăng nhập xong)
const PUSH_DEBOUNCE_MS = 4000;                        // gộp nhiều thao tác liên tiếp thành 1 lượt đẩy

// Trạng thái đồng bộ của PHIÊN này (chỉ trong bộ nhớ) -- bảng Tích hợp đọc ra để hiện kết quả/lỗi gần nhất.
const calendarSyncState = { running: false, lastAt: null, lastError: null, lastResult: null };
let calendarSyncInFlight = null; // Promise của lượt đang chạy -- khoá chống chạy chồng

// callGAS/_dispatchAction (api.js) không bao giờ throw -- luôn trả {status,message,data},
// kể cả khi lỗi. Helper nhỏ này gói lại kiểm tra status + rút .data cho gọn, dùng cho
// mọi lệnh gọi callGAS mới ở phần đồng bộ 2 chiều bên dưới (tránh lặp lại cùng 1 đoạn
// kiểm tra ở chục chỗ khác nhau).
async function callGASData(action, params) {
  const res = await callGAS(action, params);
  if (res.status !== 'success') throw new Error(res.message || ('Lỗi thực hiện ' + action));
  return res.data;
}

function describeCalendarResult(result) {
  if (!result) return '';
  const parts = [];
  if (result.count) parts.push(result.count + ' sự kiện mới từ Google');
  if (result.updatedCount) parts.push(result.updatedCount + ' cập nhật từ Google');
  if (result.pushedCount) parts.push(result.pushedCount + ' đã đẩy lên Google');
  return parts.length ? parts.join(' · ') : 'Không có thay đổi mới';
}

function calendarStatusLineHtml() {
  if (calendarSyncState.running) {
    return `<div class="whint-line"><i class="fa-solid fa-spinner fa-spin"></i> Đang đồng bộ...</div>`;
  }
  const lines = [];
  if (calendarSyncState.lastError) {
    lines.push(`<div class="whint-line whint-line-bad"><i class="fa-solid fa-circle-exclamation"></i> ${escapeHtml(calendarSyncState.lastError)}</div>`);
  }
  const r = calendarSyncState.lastResult;
  if (r && r.failedCalendars && r.failedCalendars.length) {
    const f = r.failedCalendars[0];
    lines.push(`<div class="whint-line whint-line-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${r.failedCalendars.length} lịch chưa tải được từ Google (${escapeHtml(f.message)}); sự kiện của lịch đó được giữ nguyên, sẽ thử lại ở lần đồng bộ sau.</div>`);
  }
  if (r && r.pushFailed && r.pushFailed.length) {
    const first = r.pushFailed[0];
    lines.push(`<div class="whint-line whint-line-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${r.pushFailed.length} sự kiện chưa đẩy lên Google được — “${escapeHtml(first.title)}”: ${escapeHtml(first.message)}. Sẽ tự thử lại ở lần đồng bộ sau.</div>`);
  }
  if (r && !calendarSyncState.lastError) {
    lines.push(`<div class="whint-line"><i class="fa-solid fa-check"></i> ${escapeHtml(describeCalendarResult(r))}</div>`);
  }
  return lines.join('');
}

// Báo cho phần giao diện khác (vd. thanh trạng thái của Không Gian Riêng) rằng trạng thái đồng bộ/kết nối vừa đổi.
function notifyCalendarState() {
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('wh-calendar-sync', { detail: Object.assign({}, calendarSyncState) }));
    }
  } catch (e) { /* không chặn đồng bộ vì giao diện */ }
}

// Cập nhật tại chỗ dòng kết quả + thời điểm đồng bộ, không dựng lại cả panel (tránh nháy khi đồng bộ nền chạy).
function refreshCalendarStatusLine() {
  notifyCalendarState();
  const lineEl = document.getElementById('calendar-sync-status-line');
  if (lineEl) lineEl.innerHTML = calendarStatusLineHtml();
  const atEl = document.getElementById('calendar-last-synced-status');
  if (atEl && calendarSyncState.lastAt) atEl.textContent = new Date(calendarSyncState.lastAt).toLocaleString('vi-VN');
}

async function renderCalendarConnectionPanel() {
  await renderCalendarConnectionPanelInner();
  notifyCalendarState();
}

async function renderCalendarConnectionPanelInner() {
  const listEl = document.getElementById('personal-calendar-connect-panel');
  if (!listEl) return;

  listEl.innerHTML = `<div class="whint-loading"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải...</div>`;

  let connection = null;
  try {
    connection = await API.calendarConnection.get();
  } catch (err) {
    console.error('Lỗi tải trạng thái kết nối Calendar:', err);
  }

  if (!window.OAuthLoopback || !window.OAuthLoopback.isTauri()) {
    listEl.innerHTML = `<div class="whint-empty"><i class="fa-solid fa-desktop"></i><p>Kết nối Google Calendar chỉ hoạt động trong bản desktop app (không dùng được ở chế độ xem trình duyệt).</p></div>`;
    return;
  }

  const howItWorks = `
    <details class="whint-how">
      <summary>Đồng bộ hoạt động thế nào?</summary>
      <ul>
        <li><b>WorkHub → Google:</b> sự kiện bạn tạo, sửa hoặc xoá ở <b>Lịch</b> (loại <b>Cá nhân</b>) tự đẩy lên Google Calendar sau vài giây.</li>
        <li><b>Google → WorkHub:</b> sự kiện tạo bên Google tự về WorkHub mỗi 5 phút khi app đang mở, hoặc ngay khi bấm “Đồng bộ ngay”.</li>
        <li><b>Không đồng bộ:</b> Lịch nhóm (chỉ lịch Cá nhân) và danh sách người tham dự.</li>
        <li>Nếu cả hai nơi cùng sửa một sự kiện, bản trong WorkHub được giữ.</li>
      </ul>
    </details>`;

  if (connection) {
    const connectedAt = connection.connected_at ? new Date(connection.connected_at).toLocaleString('vi-VN') : '—';
    const syncedAt = connection.last_synced_at ? new Date(connection.last_synced_at).toLocaleString('vi-VN') : 'Chưa đồng bộ lần nào';
    const readOnlyNotice = hasWriteScope(connection) ? '' :
      `<div class="whint-line whint-line-warn"><i class="fa-solid fa-triangle-exclamation"></i> Kết nối cũ chỉ đọc được từ Google — kết nối lại để bật đồng bộ 2 chiều (sửa/xoá trong WorkHub cũng áp dụng lên Google).</div>`;
    const syncedCalendarIds = (connection.synced_calendar_ids && connection.synced_calendar_ids.length) ? connection.synced_calendar_ids : ['primary'];
    const calendarSummary = syncedCalendarIds.length <= 1 ? '1 lịch (Chính)' : syncedCalendarIds.length + ' lịch đã chọn';
    const googleEmail = connection.google_account_email || '';
    const workhubEmail = await getWorkhubLoginEmail();
    const accountHtml = googleEmail
      ? `<div class="whint-account"><i class="fa-brands fa-google"></i> <b>${escapeHtml(googleEmail)}</b></div>` +
        ((workhubEmail && workhubEmail.toLowerCase() !== googleEmail.toLowerCase())
          ? `<div class="whint-hint">Khác với email đăng nhập WorkHub (${escapeHtml(workhubEmail)}) — bình thường nếu bạn chủ ý dùng tài khoản Google khác. Bấm “Kết nối lại” để đổi.</div>` : '')
      : `<div class="whint-account"><i class="fa-brands fa-google"></i> Tài khoản Google: chưa rõ</div><div class="whint-hint">Bấm “Kết nối lại” để hiện email tài khoản đang đồng bộ.</div>`;
    const calendarListNotice = hasCalendarListScope(connection) ? '' :
      `<div class="whint-line whint-line-warn"><i class="fa-solid fa-triangle-exclamation"></i> Chưa có quyền xem danh sách lịch — kết nối lại (và giữ nguyên các quyền Google đề xuất) để dùng “Quản lý lịch”.</div>`;
    const lastAtText = calendarSyncState.lastAt ? new Date(calendarSyncState.lastAt).toLocaleString('vi-VN') : syncedAt;
    listEl.innerHTML = `
    <div class="whint-card">
      <div class="whint-head">
        <span class="whint-badge whint-badge-ok"><i class="fa-solid fa-circle-check"></i> Đã kết nối</span>
        ${accountHtml}
      </div>
      <dl class="whint-stats">
        <div><dt>Kết nối lúc</dt><dd>${escapeHtml(connectedAt)}</dd></div>
        <div><dt>Đồng bộ lần cuối</dt><dd id="calendar-last-synced-status">${escapeHtml(lastAtText)}</dd></div>
        <div><dt>Lịch đang đồng bộ</dt><dd>${escapeHtml(calendarSummary)}</dd></div>
      </dl>
      <div id="calendar-sync-status-line">${calendarStatusLineHtml()}</div>
      ${readOnlyNotice}
      <div class="whint-actions">
        <button type="button" class="btn btn-primary" id="calendar-sync-now-btn" onclick="syncGoogleCalendarNow()"><i class="fa-solid fa-rotate"></i> Đồng bộ ngay</button>
        <button type="button" class="btn btn-outline" onclick="toggleCalendarPicker()"><i class="fa-solid fa-sliders"></i> Quản lý lịch</button>
        <button type="button" class="btn btn-outline" onclick="connectGoogleCalendar()"><i class="fa-brands fa-google"></i> Kết nối lại</button>
        <button type="button" class="btn btn-outline whint-danger" onclick="disconnectGoogleCalendar()"><i class="fa-solid fa-link-slash"></i> Ngắt kết nối</button>
      </div>
      ${calendarListNotice}
      <div id="calendar-picker-body" class="whint-picker" style="display:none;"></div>
      ${howItWorks}
    </div>`;
    return;
  }

  listEl.innerHTML = `
    <div class="whint-card whint-card-empty">
      <span class="whint-badge whint-badge-off"><i class="fa-regular fa-circle"></i> Chưa kết nối</span>
      <p class="whint-lead">Kết nối để sự kiện lịch cá nhân tự động đồng bộ 2 chiều giữa WorkHub và Google Calendar của bạn.</p>
      <div class="whint-actions">
        <button type="button" class="btn btn-primary" onclick="connectGoogleCalendar()"><i class="fa-brands fa-google"></i> Kết nối Google Calendar</button>
      </div>
      ${howItWorks}
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

  body.innerHTML = `<div class="whint-loading"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải danh sách lịch...</div>`;
  try {
    const connection = await API.calendarConnection.get();
    if (!connection) { body.innerHTML = `<div class="whint-line">Chưa kết nối.</div>`; return; }
    if (!hasCalendarListScope(connection)) {
      body.innerHTML = `<div class="whint-line whint-line-warn"><i class="fa-solid fa-triangle-exclamation"></i> Cần kết nối lại để cấp quyền xem danh sách lịch. Bấm “Kết nối lại” ở trên rồi giữ nguyên các quyền Google đề xuất.</div>`;
      return;
    }
    const accessToken = await getValidAccessToken(connection);
    const calendars = await fetchCalendarList(accessToken);
    const selected = new Set((connection.synced_calendar_ids && connection.synced_calendar_ids.length) ? connection.synced_calendar_ids : ['primary']);
    body.innerHTML = '<div class="whint-picker-title">Chọn lịch Google muốn kéo về WorkHub</div>' + calendars.map(c => `
      <label class="whint-check">
        <input type="checkbox" value="${escapeHtml(c.id)}" ${(c.primary || selected.has(c.id)) ? 'checked' : ''} ${c.primary ? 'disabled' : ''}>
        <span>${escapeHtml(c.name)}${c.primary ? ' <small>(lịch chính, luôn bật)</small>' : ''}</span>
      </label>`).join('') +
      `<button type="button" class="btn btn-primary" style="margin-top:10px;" onclick="saveCalendarPicker()"><i class="fa-solid fa-floppy-disk"></i> Lưu lựa chọn</button>`;
  } catch (err) {
    body.innerHTML = `<div class="whint-line whint-line-bad"><i class="fa-solid fa-circle-exclamation"></i> ${escapeHtml(err.message || String(err))}</div>`;
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
    throw new Error('Phiên kết nối Google Calendar đã hết hạn và không thể tự làm mới — vào Không Gian Riêng → Tích hợp rồi bấm “Kết nối lại”.');
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
function buildRRule(recurrence, recurrenceEnd, allDay) {
  const freqMap = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' };
  const freq = freqMap[recurrence];
  if (!freq) return null;
  let rule = 'RRULE:FREQ=' + freq;
  if (recurrenceEnd) {
    if (allDay) {
      // Sự kiện cả ngày: Google đòi UNTIL dạng NGÀY (YYYYMMDD), UNTIL có giờ bị từ chối.
      const day = String(recurrenceEnd).slice(0, 10).replace(/-/g, '');
      if (/^\d{8}$/.test(day)) rule += ';UNTIL=' + day;
    } else {
      // Hết ngày recurrence_end theo GIỜ ĐỊA PHƯƠNG (cùng cách getEvents tính), đổi sang UTC. Trước đây cộng cứng 23:59:59Z
      // nên ở múi giờ phía tây UTC lần lặp cuối trong ngày kết thúc bị cắt mất.
      const untilDate = new Date(recurrenceEnd + 'T23:59:59');
      if (!isNaN(untilDate.getTime())) {
        const until = untilDate.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
        rule += ';UNTIL=' + until;
      }
    }
  }
  return rule;
}

function mapGoogleEventToRow(ev, email, groupKey, calendarId) {
  const isAllDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
  // Cả ngày: Google chỉ cho NGÀY. Lưu đúng nửa đêm ĐỊA PHƯƠNG dưới dạng mốc tuyệt đối (ISO, có 'Z'). Chuỗi trần
  // '...T00:00:00' bị DB (UTC) hiểu là 00:00 UTC -> ở múi giờ phía tây UTC sự kiện hiện lùi sang NGÀY HÔM TRƯỚC.
  const startTime = isAllDay ? new Date(ev.start.date + 'T00:00:00').toISOString() : ev.start.dateTime;
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
    endTime = new Date(endDateExclusive.getFullYear(), endDateExclusive.getMonth(), endDateExclusive.getDate(), 23, 59, 59).toISOString();
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
    source: 'google',
    // Sự kiện xuất hiện lại bên Google sau khi từng bị dọn (vd khôi phục từ thùng rác Google) phải hiện lại: upsert theo
    // google_event_id ghi đè dòng cũ, nếu không xoá mốc deleted_at thì dòng đó bị ẩn mãi mãi.
    deleted_at: null
  };
}

// Chiều ngược lại mapGoogleEventToRow(): map 1 dòng events (WorkHub) -> body gửi lên
// Google Calendar API. Đối xứng với xử lý mốc cả-ngày ở chiều kéo về: WorkHub lưu sự
// kiện cả-ngày là 00:00:00 -> 23:59:59 (đã lùi lại 1 ngày lúc kéo về), nên đẩy lên lại
// phải CỘNG lại 1 ngày cho end.date (Google coi end.date là mốc loại trừ). KHÔNG map
// attendees -- tránh vô tình gửi giấy mời Google Calendar thay người dùng. Sự kiện lặp
// (recurrence != 'none') kèm thêm RRULE -- xem buildRRule().
function getLocalTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
}

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
    // timeZone BẮT BUỘC với sự kiện lặp (Google từ chối "Missing time zone definition"), và giúp Google hiện đúng giờ.
    const timeZone = getLocalTimeZone();
    body.start = timeZone ? { dateTime: start.toISOString(), timeZone } : { dateTime: start.toISOString() };
    body.end = timeZone ? { dateTime: end.toISOString(), timeZone } : { dateTime: end.toISOString() };
  }
  if (event.recurrence && event.recurrence !== 'none') {
    const rule = buildRRule(event.recurrence, event.recurrence_end || event.recurrenceEnd, isAllDay);
    if (rule) body.recurrence = [rule];
  }
  return body;
}

// ID sự kiện Google do ta đặt, suy ra từ ID WorkHub: chỉ gồm 0-9 a-v (base32hex), 5..1024 ký tự. Vì ổn định theo sự kiện nên
// nếu lệnh tạo đã thành công bên Google nhưng mất kết nối trước khi kịp ghi liên kết về WorkHub, lần đẩy sau KHÔNG tạo bản
// thứ hai mà gặp 409 (đã tồn tại) rồi chuyển sang cập nhật chính bản đó.
function googleIdForWorkhubEvent(workhubEventId) {
  let hex = '';
  new TextEncoder().encode(String(workhubEventId)).forEach(b => { hex += b.toString(16).padStart(2, '0'); });
  return 'vh' + hex;
}

async function insertGoogleEvent(accessToken, calendarId, body) {
  const resp = await fetch(eventsEndpointFor(calendarId), {
    method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (resp.status === 409 && body.id) {
    // Đã có sự kiện mang ID này (lần đẩy trước thành công nhưng chưa kịp liên kết): cập nhật nó, kể cả khi từng bị huỷ.
    const { id, ...rest } = body;
    const revived = await updateGoogleEvent(accessToken, calendarId, id, Object.assign({}, rest, { status: 'confirmed' }));
    if (revived) return revived;
  }
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
  const outcome = { pushed: 0, failed: [] };
  if (!candidates || !candidates.length) return outcome;
  const syncedEntries = [];
  for (const ev of candidates) {
    const calendarId = ev.google_calendar_id || 'primary';
    try {
      if (ev.deleted_at) {
        if (ev.google_event_id) {
          await deleteGoogleEvent(accessToken, calendarId, ev.google_event_id);
          await callGASData('deleteGoogleSyncRow', { eventId: ev.id });
        }
        outcome.pushed += 1;
        continue;
      }
      const body = mapRowToGoogleEventBody(ev);
      if (!ev.google_event_id) {
        body.id = googleIdForWorkhubEvent(ev.id);
        const created = await insertGoogleEvent(accessToken, 'primary', body);
        const newVersion = await callGASData('linkGoogleEventId', { eventId: ev.id, googleEventId: created.id, googleCalendarId: 'primary' });
        syncedEntries.push({ eventId: ev.id, googleEventId: created.id, syncedVersion: newVersion || ev.version, googleUpdatedAt: created.updated });
      } else {
        const updated = await updateGoogleEvent(accessToken, calendarId, ev.google_event_id, body);
        if (updated) {
          syncedEntries.push({ eventId: ev.id, googleEventId: ev.google_event_id, syncedVersion: ev.version, googleUpdatedAt: updated.updated });
        }
      }
      outcome.pushed += 1;
    } catch (err) {
      console.warn('pushPendingLocalEvents: không đẩy được 1 sự kiện', ev.id, err);
      outcome.failed.push({ id: ev.id, title: ev.title || '(Không có tiêu đề)', message: (err && err.message) || String(err) });
    }
  }
  if (syncedEntries.length) await callGASData('markGoogleSyncedBatch', { entries: syncedEntries });
  return outcome;
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
function syncGoogleCalendarEvents() {
  // Khoá: nếu đang có 1 lượt chạy (nền / bấm tay / sau khi tạo sự kiện) thì dùng chung kết quả của nó. Hai lượt chạy chồng
  // nhau cùng thấy 1 sự kiện "chưa liên kết" và cùng tạo nó trên Google => trùng sự kiện.
  if (calendarSyncInFlight) return calendarSyncInFlight;
  calendarSyncState.running = true;
  refreshCalendarStatusLine();
  calendarSyncInFlight = runCalendarSyncOnce()
    .then(result => {
      calendarSyncState.lastAt = Date.now();
      calendarSyncState.lastResult = result;
      calendarSyncState.lastError = null;
      return result;
    })
    .catch(err => {
      calendarSyncState.lastError = (err && err.message) || String(err);
      throw err;
    })
    .finally(() => {
      calendarSyncState.running = false;
      calendarSyncInFlight = null;
      refreshCalendarStatusLine();
    });
  return calendarSyncInFlight;
}

async function runCalendarSyncOnce() {
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
  let pushFailed = [];
  const canPush = hasWriteScope(connection);
  if (canPush) {
    try {
      const pushOutcome = await pushPendingLocalEvents(accessToken, email, groupKey, windowStart, windowEnd);
      pushedCount = pushOutcome.pushed;
      pushFailed = pushOutcome.failed;
    } catch (err) {
      console.warn('syncGoogleCalendarEvents: đẩy thay đổi cục bộ lên Google thất bại', err);
      pushFailed = [{ id: '', title: 'Danh sách sự kiện cần đẩy', message: (err && err.message) || String(err) }];
    }
  }

  const calendarIds = (connection.synced_calendar_ids && connection.synced_calendar_ids.length)
    ? connection.synced_calendar_ids : ['primary'];

  const fetchedItems = []; // { ev, calendarId, qualifiedId }
  const activeIdsByCalendar = {};
  let anyTruncated = false;
  // Lịch tải lỗi (kể cả lỗi ở trang 2, 3...): KHÔNG được dọn lịch đó. Trước đây lỗi chỉ bị bỏ qua rồi bước dọn coi lịch là
  // "không còn sự kiện nào" => đánh dấu xoá mọi sự kiện đã liên kết của lịch (cả sự kiện tạo trong WorkHub đã đẩy lên), rồi
  // lượt đẩy kế tiếp xoá luôn chúng trên Google. Một lần Google trả lỗi tạm thời (401/403/5xx, rớt mạng) là đủ gây mất dữ liệu.
  const failedCalendars = []; // { calendarId, message, status }

  for (const calendarId of calendarIds) {
    activeIdsByCalendar[calendarId] = [];
    let pageToken = null;
    let pages = 0;
    do {
      let page;
      try {
        page = await fetchGoogleEventsPage(accessToken, calendarId, windowStart, windowEnd, pageToken);
      } catch (err) {
        console.warn('syncGoogleCalendarEvents: lỗi tải lịch ' + calendarId + ', bỏ qua lịch này (không dọn)', err);
        failedCalendars.push({ calendarId, message: (err && err.message) || String(err), status: (err && err.status) || null });
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

  if (failedCalendars.length === calendarIds.length && !fetchedItems.length) {   // không kéo được gì: báo lỗi thay vì báo "đã đồng bộ"
    const f = failedCalendars[0];
    throw new Error('Không tải được lịch Google' + (f.status === 401 || f.status === 403 ? ' (Google từ chối quyền truy cập — vào Không Gian Riêng → Tích hợp rồi bấm “Kết nối lại”)' : '') + ': ' + f.message);
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
    const failedSet = new Set(failedCalendars.map(f => f.calendarId));
    for (const calendarId of calendarIds) {
      if (failedSet.has(calendarId)) continue; // lịch tải lỗi: không biết sự kiện nào còn sống, không dọn
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

  return { count: newRows.length, updatedCount: pulledUpdates.length, pushedCount, pushFailed, truncated: anyTruncated, failedCalendars };
}

// Làm mới những gì đang hiển thị sau 1 lượt đồng bộ. redrawPanel: vẽ lại cả panel Tích hợp (chỉ khi người dùng vừa bấm tay /
// vừa kết nối -- trạng thái kết nối có thể đã đổi). Lượt nền thì chỉ cập nhật tại chỗ dòng kết quả (refreshCalendarStatusLine),
// để không phá bảng "Quản lý lịch" người dùng đang mở. reloadGrid: nạp lại lưới lịch khi có thay đổi thật.
function refreshCalendarViewsAfterSync(redrawPanel, reloadGrid) {
  if (redrawPanel) renderCalendarConnectionPanel();
  if (reloadGrid && typeof loadCalendarData === 'function' && document.getElementById('full-calendar-display')) {
    loadCalendarData({ quiet: true });
  }
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
    if (result.pushFailed && result.pushFailed.length) {
      showToast(`Đã đồng bộ nhưng ${result.pushFailed.length} sự kiện chưa đẩy lên Google được: ${result.pushFailed[0].message}`, 'warning');
    } else if (result.failedCalendars && result.failedCalendars.length) {
      showToast(`Đã đồng bộ nhưng ${result.failedCalendars.length} lịch chưa tải được từ Google: ${result.failedCalendars[0].message}`, 'warning');
    } else {
      showToast(`Đã đồng bộ: ${describeCalendarResult(result)}.${suffix}`, 'success');
    }
  } catch (err) {
    showToast('Đồng bộ Google Calendar thất bại: ' + (err.message || String(err)), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = oldHtml; }
    refreshCalendarViewsAfterSync(true, true);
  }
}

// Đồng bộ im lặng (nền / sau khi tạo sự kiện). reason: 'push' | 'background' | 'startup' | 'open'.
// Chưa kết nối / chưa đăng nhập / không phải bản desktop => không làm gì. Không bao giờ throw.
async function syncGoogleCalendarQuiet(reason) {
  if (!window.OAuthLoopback || !window.OAuthLoopback.isTauri()) return null;
  let connection = null;
  try {
    connection = await API.calendarConnection.get();
  } catch (err) {
    return null;
  }
  if (!connection) return null;
  try {
    const result = await syncGoogleCalendarEvents();
    const total = result.count + result.updatedCount + result.pushedCount;
    refreshCalendarViewsAfterSync(false, total > 0);
    if (result.pushFailed && result.pushFailed.length) {
      showToast('Chưa đẩy được lên Google Calendar: ' + result.pushFailed[0].message, 'warning');
    } else if (reason === 'push' && result.pushedCount > 0) {
      showToast('Đã đồng bộ sự kiện lên Google Calendar.', 'success');
    } else if (reason !== 'push' && (result.count + result.updatedCount) > 0) {
      showToast(`Google Calendar có ${result.count + result.updatedCount} thay đổi mới, đã cập nhật vào lịch.`, 'success');
    }
    return result;
  } catch (err) {
    console.warn('syncGoogleCalendarQuiet (' + reason + '): đồng bộ thất bại', err);
    refreshCalendarViewsAfterSync(false, false);
    if (reason === 'push') showToast('Chưa đẩy được lên Google Calendar: ' + (err.message || String(err)), 'warning');
    return null;
  }
}

// Gọi 1 lần lúc mở Personal Hub / bảng Tích hợp -- tự đồng bộ im lặng nếu lâu rồi chưa đồng bộ.
async function initCalendarAutoSync() {
  if (!window.OAuthLoopback || !window.OAuthLoopback.isTauri()) return;
  let connection = null;
  try {
    connection = await API.calendarConnection.get();
  } catch (err) {
    return;
  }
  if (!connection) return;
  const lastSynced = Math.max(
    connection.last_synced_at ? new Date(connection.last_synced_at).getTime() : 0,
    calendarSyncState.lastAt || 0
  );
  if (Date.now() - lastSynced < AUTO_SYNC_MIN_INTERVAL_MS) return;
  await syncGoogleCalendarQuiet('open');
}

// api.js gọi hàm này sau mỗi createEvent/updateEvent/deleteEvent thành công. Gộp nhiều thao tác sát nhau thành 1 lượt đẩy;
// nếu lúc hết giờ gộp mà đang có 1 lượt chạy (nên có thể chưa thấy thay đổi mới nhất) thì chờ nó xong rồi chạy thêm 1 lượt.
let calendarPushTimer = null;
function scheduleGoogleCalendarPush() {
  if (!window.OAuthLoopback || !window.OAuthLoopback.isTauri()) return;
  if (calendarPushTimer) clearTimeout(calendarPushTimer);
  calendarPushTimer = setTimeout(async () => {
    calendarPushTimer = null;
    if (calendarSyncInFlight) { try { await calendarSyncInFlight; } catch (e) { /* lượt trước lỗi không chặn lượt này */ } }
    syncGoogleCalendarQuiet('push');
  }, PUSH_DEBOUNCE_MS);
}
window.scheduleGoogleCalendarPush = scheduleGoogleCalendarPush;

// Đồng bộ nền khi app đang mở (kể cả khi chưa từng mở Không Gian Riêng): lượt đầu sau ~15 giây, rồi mỗi 5 phút.
let calendarBackgroundTimer = null;
function startCalendarBackgroundSync() {
  if (calendarBackgroundTimer || !window.OAuthLoopback || !window.OAuthLoopback.isTauri()) return;
  calendarBackgroundTimer = setInterval(() => { syncGoogleCalendarQuiet('background'); }, BACKGROUND_SYNC_INTERVAL_MS);
  setTimeout(() => { syncGoogleCalendarQuiet('startup'); }, BACKGROUND_FIRST_DELAY_MS);
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'complete') setTimeout(startCalendarBackgroundSync, 2000);
  else window.addEventListener('load', () => setTimeout(startCalendarBackgroundSync, 2000));
}
