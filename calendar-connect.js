// Personal Hub: "Kết nối Calendar" tab. Đợt 1 (connection-only) đã xong -- OAuth
// PKCE + lưu/xoá token. Đợt này thêm phần đồng bộ sự kiện thật: 1 CHIỀU, Google ->
// WorkHub (scope OAuth cấp cho app chỉ là calendar.readonly, không ghi ngược lên
// Google được -- xem GOOGLE_CALENDAR_SCOPE bên dưới).
// Depends on oauth-loopback.js (PKCE + loopback redirect) and api.js
// (API.calendarConnection / callGAS('saveCalendarConnection', ...)).
//
// File này BẮT BUỘC giống hệt byte-for-byte cả 3 app (fin/sci/org) -- CI
// "cross-app-drift" fail nếu khác nhau dù chỉ 1 ký tự. Vì vậy không được đọc bất kỳ
// biến toàn cục đặc thù từng app nào (vd. tên biến "user hiện tại" org dùng
// `chatUser`, fin dùng `CURRENT_USER` -- khác nhau giữa 3 app) -- luôn tự lấy user
// qua sbClient.auth.getUser() và group qua API.auth.getUserGroup(email).

const GOOGLE_CLIENT_ID = '825025516269-gmictbckj5c8ameatht1bbj6tqct6tqq.apps.googleusercontent.com';
const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_EVENTS_ENDPOINT = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

// Cửa sổ thời gian kéo sự kiện về mỗi lần đồng bộ -- đủ dùng cho "sắp tới" mà
// không kéo vô hạn về quá khứ/tương lai. Có thể mở rộng sau nếu cần.
const SYNC_WINDOW_PAST_DAYS = 30;
const SYNC_WINDOW_FUTURE_DAYS = 180;
const SYNC_MAX_PAGES = 4; // 4 x 250 = tối đa 1000 sự kiện/lần đồng bộ, đủ cho lịch bình thường
const AUTO_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 phút

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
    listEl.innerHTML = `
    <div class="sync-folder-panel">
      <div class="sync-folder-header">
        <div>
          <div class="sync-folder-path"><i class="fa-solid fa-calendar-check"></i> Google Calendar đã kết nối</div>
          <div class="sync-folder-status">Kết nối lúc: ${escapeHtml(connectedAt)}</div>
          <div class="sync-folder-status" id="calendar-last-synced-status">Đồng bộ lần cuối: ${escapeHtml(syncedAt)}</div>
        </div>
        <div class="sync-folder-actions">
          <button type="button" class="btn btn-outline" id="calendar-sync-now-btn" onclick="syncGoogleCalendarNow()"><i class="fa-solid fa-rotate"></i> Đồng bộ ngay</button>
          <button type="button" class="btn btn-outline" onclick="disconnectGoogleCalendar()"><i class="fa-solid fa-link-slash"></i> Ngắt kết nối</button>
        </div>
      </div>
    </div>`;
    return;
  }

  listEl.innerHTML = `
    <div class="empty-state">
      <i class="fa-solid fa-calendar-plus"></i>
      <p>Chưa kết nối Google Calendar. Kết nối để tự động kéo sự kiện lịch cá nhân (Google) của bạn về đây (chỉ đọc -- sửa/xoá sự kiện vẫn phải làm trên Google Calendar).</p>
      <button type="button" class="btn btn-primary" onclick="connectGoogleCalendar()"><i class="fa-brands fa-google"></i> Kết nối Google Calendar</button>
    </div>`;
}

async function connectGoogleCalendar() {
  if (!GOOGLE_CLIENT_ID) { showToast('Chưa cấu hình GOOGLE_CLIENT_ID.', 'warning'); return; }
  if (!window.OAuthLoopback || !window.OAuthLoopback.isTauri()) {
    showToast('Kết nối Google Calendar chỉ khả dụng trên bản desktop app.', 'warning'); return;
  }
  try {
    const { codeVerifier, codeChallenge, method } = await window.OAuthLoopback.createPkcePair();
    const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', window.OAuthLoopback.OAUTH_CALLBACK_URL);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', GOOGLE_CALENDAR_SCOPE);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', method);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    const queryString = await window.OAuthLoopback.awaitRedirect(authUrl.toString());
    const params = window.OAuthLoopback.parseQueryString(queryString);
    if (params.error) throw new Error(params.error);
    if (!params.code) throw new Error('Không nhận được mã xác thực từ Google.');

    const tokenResp = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, code: params.code, code_verifier: codeVerifier,
        grant_type: 'authorization_code', redirect_uri: window.OAuthLoopback.OAUTH_CALLBACK_URL
      })
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok) throw new Error(tokenJson.error_description || tokenJson.error || 'Google từ chối yêu cầu token.');

    const expiresAt = new Date(Date.now() + (tokenJson.expires_in || 3600) * 1000).toISOString();
    await callGAS('saveCalendarConnection', {
      access_token: tokenJson.access_token, refresh_token: tokenJson.refresh_token || null,
      expires_at: expiresAt, scope: tokenJson.scope || GOOGLE_CALENDAR_SCOPE
    });
    showToast('Đã kết nối Google Calendar.', 'success');
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
// ĐỒNG BỘ SỰ KIỆN (1 chiều: Google -> WorkHub)
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
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, refresh_token: connection.refresh_token, grant_type: 'refresh_token'
    })
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

function mapGoogleEventToRow(ev, email, groupKey) {
  const isAllDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
  const startTime = isAllDay ? ev.start.date + 'T00:00:00' : ev.start.dateTime;
  const endRaw = ev.end || ev.start;
  const endTime = isAllDay ? (endRaw.date || ev.start.date) + 'T23:59:59' : (endRaw.dateTime || startTime);
  const attendees = Array.isArray(ev.attendees)
    ? ev.attendees.map(a => a.email).filter(Boolean).join(',')
    : null;
  return {
    id: 'GCAL_' + ev.id,
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
    google_event_id: ev.id,
    source: 'google'
  };
}

async function fetchGoogleEventsPage(accessToken, timeMin, timeMax, pageToken) {
  const url = new URL(GOOGLE_EVENTS_ENDPOINT);
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

// Kéo sự kiện Google Calendar về, upsert vào bảng events, rồi dọn các sự kiện đã
// đồng bộ trước đó nhưng không còn xuất hiện (bị xoá/huỷ bên phía Google). Không
// đọc biến toàn cục app-specific -- xem comment đầu file.
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

  const rows = [];
  let pageToken = null;
  let pages = 0;
  do {
    const page = await fetchGoogleEventsPage(accessToken, windowStart, windowEnd, pageToken);
    const items = page.items || [];
    for (const ev of items) {
      if (ev.status === 'cancelled') continue;
      if (!ev.start || (!ev.start.date && !ev.start.dateTime)) continue; // sự kiện thiếu mốc thời gian, bỏ qua
      rows.push(mapGoogleEventToRow(ev, email, groupKey));
    }
    pageToken = page.nextPageToken || null;
    pages += 1;
  } while (pageToken && pages < SYNC_MAX_PAGES);

  if (rows.length) {
    await callGAS('upsertGoogleEvents', { rows });
  }
  await callGAS('pruneGoogleEvents', {
    email, groupKey,
    activeGoogleIds: rows.map(r => r.google_event_id),
    windowStart, windowEnd
  });
  await callGAS('touchCalendarSync', {});

  return { count: rows.length };
}

// Wrapper có UI: khoá nút + spinner trong lúc chạy, toast kết quả, vẽ lại panel kết
// nối, và làm mới lịch đang mở (nếu có) để thấy ngay không cần tải lại trang.
async function syncGoogleCalendarNow() {
  const btn = document.getElementById('calendar-sync-now-btn');
  const oldHtml = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang đồng bộ...'; }
  try {
    const result = await syncGoogleCalendarEvents();
    showToast(`Đã đồng bộ ${result.count} sự kiện từ Google Calendar.`, 'success');
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
    if (result.count > 0) showToast(`Đã tự động đồng bộ ${result.count} sự kiện từ Google Calendar.`, 'success');
  } catch (err) {
    console.warn('initCalendarAutoSync: đồng bộ nền thất bại', err);
  }
}
