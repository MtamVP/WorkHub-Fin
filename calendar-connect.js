// Personal Hub: "Kết nối Calendar" tab. Đợt 1 (connection-only) và đợt 2 (kéo về 1
// chiều) đã xong. Đợt 3 (này): đồng bộ 2 CHIỀU thật -- đẩy thay đổi cục bộ lên Google
// VÀ kéo thay đổi từ Google về, cùng 1 lần đồng bộ. Cần scope ghi được
// (calendar.events) -- xem GOOGLE_CALENDAR_SCOPE bên dưới; các kết nối CŨ chỉ có scope
// calendar.readonly (từ đợt 2) sẽ tự phát hiện qua hasWriteScope() và CHỈ kéo về như
// cũ cho tới khi người dùng bấm kết nối lại để cấp thêm quyền ghi.
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
// mình như 1 "thay đổi bên Google" thừa. Phạm vi cố tình để ngoài đợt này: chỉ đồng bộ
// sự kiện calendar_type='personal' + recurrence='none' (bỏ qua nhóm/lặp lại -- dựng
// RRULE để đẩy sự kiện lặp lên Google để dịp khác); không map attendees (tránh vô tình
// gửi giấy mời Google Calendar thay người dùng).

const GOOGLE_CLIENT_ID = '825025516269-gmictbckj5c8ameatht1bbj6tqct6tqq.apps.googleusercontent.com';
const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_EVENTS_ENDPOINT = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

// Cửa sổ thời gian kéo sự kiện về mỗi lần đồng bộ -- đủ dùng cho "sắp tới" mà
// không kéo vô hạn về quá khứ/tương lai. Có thể mở rộng sau nếu cần.
const SYNC_WINDOW_PAST_DAYS = 30;
const SYNC_WINDOW_FUTURE_DAYS = 180;
const SYNC_MAX_PAGES = 4; // 4 x 250 = tối đa 1000 sự kiện/lần đồng bộ, đủ cho lịch bình thường
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
    listEl.innerHTML = `
    <div class="sync-folder-panel">
      <div class="sync-folder-header">
        <div>
          <div class="sync-folder-path"><i class="fa-solid fa-calendar-check"></i> Google Calendar đã kết nối</div>
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

// Chiều ngược lại mapGoogleEventToRow(): map 1 dòng events (WorkHub) -> body gửi lên
// Google Calendar API. Đối xứng với xử lý mốc cả-ngày ở chiều kéo về: WorkHub lưu sự
// kiện cả-ngày là 00:00:00 -> 23:59:59 (đã lùi lại 1 ngày lúc kéo về), nên đẩy lên lại
// phải CỘNG lại 1 ngày cho end.date (Google coi end.date là mốc loại trừ). KHÔNG map
// attendees -- tránh vô tình gửi giấy mời Google Calendar thay người dùng.
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
  return body;
}

async function insertGoogleEvent(accessToken, body) {
  const resp = await fetch(GOOGLE_EVENTS_ENDPOINT, {
    method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error((json.error && json.error.message) || 'Tạo sự kiện trên Google Calendar thất bại.');
  return json;
}

async function updateGoogleEvent(accessToken, googleEventId, body) {
  const resp = await fetch(GOOGLE_EVENTS_ENDPOINT + '/' + encodeURIComponent(googleEventId), {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (resp.status === 404 || resp.status === 410) return null; // đã bị xoá bên Google từ trước, coi như xong
  const json = await resp.json();
  if (!resp.ok) throw new Error((json.error && json.error.message) || 'Cập nhật sự kiện trên Google Calendar thất bại.');
  return json;
}

async function deleteGoogleEvent(accessToken, googleEventId) {
  const resp = await fetch(GOOGLE_EVENTS_ENDPOINT + '/' + encodeURIComponent(googleEventId), {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (resp.ok || resp.status === 404 || resp.status === 410 || resp.status === 204) return;
  let msg = 'Xoá sự kiện trên Google Calendar thất bại.';
  try { const json = await resp.json(); msg = (json.error && json.error.message) || msg; } catch (e) { /* body rỗng, giữ msg mặc định */ }
  throw new Error(msg);
}

// Đẩy các thay đổi cục bộ (tạo/sửa/xoá sự kiện cá nhân, không lặp lại) lên Google
// Calendar. Trả về số sự kiện đã đẩy thành công.
async function pushPendingLocalEvents(accessToken, email, groupKey, windowStart, windowEnd) {
  const candidates = await callGASData('getPersonalEventsForPush', { email, groupKey, windowStart, windowEnd });
  if (!candidates || !candidates.length) return 0;
  const syncedEntries = [];
  let pushedCount = 0;
  for (const ev of candidates) {
    try {
      if (ev.deleted_at) {
        if (ev.google_event_id) {
          await deleteGoogleEvent(accessToken, ev.google_event_id);
          await callGASData('deleteGoogleSyncRow', { eventId: ev.id });
        }
        continue;
      }
      const body = mapRowToGoogleEventBody(ev);
      if (!ev.google_event_id) {
        const created = await insertGoogleEvent(accessToken, body);
        const newVersion = await callGASData('linkGoogleEventId', { eventId: ev.id, googleEventId: created.id });
        syncedEntries.push({ eventId: ev.id, googleEventId: created.id, syncedVersion: newVersion || ev.version, googleUpdatedAt: created.updated });
      } else {
        const updated = await updateGoogleEvent(accessToken, ev.google_event_id, body);
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

// Đồng bộ 2 chiều: ĐẨY thay đổi cục bộ lên Google trước (nếu kết nối có scope ghi),
// rồi KÉO sự kiện Google Calendar về (chỉ áp những gì THẬT SỰ do Google đổi -- sự
// kiện vừa đẩy ở bước trên đã có bookkeeping mới, không bị coi là "Google đổi" nữa),
// rồi dọn các sự kiện đã liên kết trước đó nhưng không còn xuất hiện bên Google (bị
// xoá/huỷ). Không đọc biến toàn cục app-specific -- xem comment đầu file.
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

  const fetchedItems = [];
  const activeGoogleIds = [];
  let pageToken = null;
  let pages = 0;
  let truncated = false;
  do {
    const page = await fetchGoogleEventsPage(accessToken, windowStart, windowEnd, pageToken);
    const items = page.items || [];
    for (const ev of items) {
      if (ev.status === 'cancelled') continue;
      if (!ev.start || (!ev.start.date && !ev.start.dateTime)) continue; // sự kiện thiếu mốc thời gian, bỏ qua
      fetchedItems.push(ev);
      activeGoogleIds.push(ev.id);
    }
    pageToken = page.nextPageToken || null;
    pages += 1;
    if (pageToken && pages >= SYNC_MAX_PAGES) truncated = true;
  } while (pageToken && pages < SYNC_MAX_PAGES);

  // Phân loại từng sự kiện Google lấy được: chưa từng đồng bộ (chèn mới, id GCAL_*)
  // hay đã liên kết sẵn (chỉ áp cập nhật nếu Google thật sự đổi mới hơn lần đồng bộ
  // trước -- tránh đụng vào dòng events một cách vô ích, kích hoạt trigger tăng version
  // mà chẳng để làm gì).
  const syncStateMap = activeGoogleIds.length
    ? await callGASData('getGoogleSyncState', { googleEventIds: activeGoogleIds })
    : {};
  const newRows = [];
  const pulledUpdates = [];
  for (const ev of fetchedItems) {
    const syncState = syncStateMap[ev.id];
    if (!syncState) {
      newRows.push(mapGoogleEventToRow(ev, email, groupKey));
      continue;
    }
    const googleUpdatedAt = ev.updated ? new Date(ev.updated).getTime() : 0;
    const storedUpdatedAt = syncState.google_updated_at ? new Date(syncState.google_updated_at).getTime() : 0;
    if (googleUpdatedAt > storedUpdatedAt) {
      pulledUpdates.push({ eventId: syncState.event_id, ev });
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
      const ev = fetchedItems.find(e => e.id === r.google_event_id);
      newSyncEntries.push({ eventId: v.id, googleEventId: r.google_event_id, syncedVersion: v.version, googleUpdatedAt: ev && ev.updated });
    }
  }

  for (const { eventId, ev } of pulledUpdates) {
    try {
      const mapped = mapGoogleEventToRow(ev, email, groupKey);
      const newVersion = await callGASData('applyGooglePullUpdate', {
        eventId,
        fields: { title: mapped.title, start_time: mapped.start_time, end_time: mapped.end_time, description: mapped.description, location: mapped.location }
      });
      newSyncEntries.push({ eventId, googleEventId: ev.id, syncedVersion: newVersion, googleUpdatedAt: ev.updated });
    } catch (err) {
      console.warn('syncGoogleCalendarEvents: áp cập nhật kéo về thất bại cho sự kiện', ev.id, err);
    }
  }
  if (newSyncEntries.length) await callGASData('markGoogleSyncedBatch', { entries: newSyncEntries });

  // Bỏ qua bước dọn (prune) nếu trang bị cắt bớt (còn sự kiện chưa kéo hết) -- nếu không,
  // những sự kiện thật ở các trang chưa kéo (id không có trong activeGoogleIds) sẽ bị
  // hiểu nhầm là "đã xoá bên Google" và bị xoá oan.
  if (!truncated) {
    await callGASData('pruneGoogleEvents', { email, groupKey, activeGoogleIds, windowStart, windowEnd });
  } else {
    console.warn('syncGoogleCalendarEvents: lịch có hơn ' + (SYNC_MAX_PAGES * 250) + ' sự kiện trong cửa sổ đồng bộ -- bỏ qua bước dọn để tránh xoá oan sự kiện thật ở các trang chưa kéo về.');
  }
  await callGASData('touchCalendarSync', {});

  return { count: newRows.length, updatedCount: pulledUpdates.length, pushedCount, truncated };
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
