// Personal Hub: "Kết nối Calendar" tab. Connection-only round -- no event
// pull/push sync logic here yet (that's a separate follow-up round, same
// "core then completion" split already used for local-folder-sync).
// Depends on oauth-loopback.js (PKCE + loopback redirect) and api.js
// (API.calendarConnection / callGAS('saveCalendarConnection', ...)).

const GOOGLE_CLIENT_ID = '825025516269-gmictbckj5c8ameatht1bbj6tqct6tqq.apps.googleusercontent.com';
const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

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
    listEl.innerHTML = `
    <div class="sync-folder-panel">
      <div class="sync-folder-header">
        <div>
          <div class="sync-folder-path"><i class="fa-solid fa-calendar-check"></i> Google Calendar đã kết nối</div>
          <div class="sync-folder-status">Kết nối lúc: ${escapeHtml(connectedAt)}</div>
        </div>
        <div class="sync-folder-actions">
          <button type="button" class="btn btn-outline" onclick="disconnectGoogleCalendar()"><i class="fa-solid fa-link-slash"></i> Ngắt kết nối</button>
        </div>
      </div>
    </div>`;
    return;
  }

  listEl.innerHTML = `
    <div class="empty-state">
      <i class="fa-solid fa-calendar-plus"></i>
      <p>Chưa kết nối Google Calendar. Kết nối để đồng bộ lịch cá nhân của bạn (chỉ đọc, chưa đồng bộ sự kiện — tính năng này sẽ hoàn thiện ở bản cập nhật sau).</p>
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
    renderCalendarConnectionPanel();
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
