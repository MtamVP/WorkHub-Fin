// Shared PKCE + local-loopback-redirect helper, used by both SSO login
// (handleSsoLoginClick in script.js) and Google Calendar connect
// (calendar-connect.js). See src-tauri/src/lib.rs for the Rust side that
// actually opens the TCP listener and catches the redirect.
window.OAuthLoopback = (function () {
  const OAUTH_CALLBACK_URL = 'http://127.0.0.1:43781/callback';

  function isTauri() {
    return !!(window.__TAURI__ && window.__TAURI__.core);
  }

  function base64UrlEncode(bytes) {
    let binary = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomVerifier(length = 64) {
    const arr = new Uint8Array(length);
    crypto.getRandomValues(arr);
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let out = '';
    for (let i = 0; i < arr.length; i++) out += chars[arr[i] % chars.length];
    return out;
  }

  async function createPkcePair() {
    const codeVerifier = randomVerifier(64);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
    return { codeVerifier, codeChallenge: base64UrlEncode(digest), method: 'S256' };
  }

  function awaitRedirect(authUrl, { timeoutMs = 300000 } = {}) {
    if (!isTauri()) return Promise.reject(new Error('OAuth loopback flow chỉ chạy trong bản desktop app.'));
    const { core, event, opener } = window.__TAURI__;
    return new Promise((resolve, reject) => {
      let unlisten = null;
      let timer = null;
      // Nếu timeout bắn ĐÚNG lúc start_oauth_loopback còn đang chờ (Rust bị kẹt, cổng đã bị
      // chiếm, ...), cleanup() từng chạy khi 'unlisten' còn null (chưa kịp gán) -- outer
      // Promise coi như đã reject, nhưng chuỗi .then() vẫn tiếp tục chạy dở sau đó: start
      // cuối cùng resolve muộn -> event.listen() đăng ký listener MỚI -> opener.openUrl() mở
      // lại trình duyệt cho 1 luồng OAuth mà phía gọi tưởng đã chết. 'settled' chặn mọi tác
      // dụng phụ (đăng ký listener/mở URL) sau khi promise đã settle theo hướng nào đó rồi.
      let settled = false;
      const cleanup = () => {
        settled = true;
        if (timer) clearTimeout(timer);
        if (unlisten) unlisten();
        core.invoke('stop_oauth_loopback').catch(() => {});
      };
      core.invoke('start_oauth_loopback')
        .then(() => {
          if (settled) return null;
          return event.listen('oauth-loopback-callback', (evt) => {
            cleanup();
            resolve(evt.payload || '');
          });
        })
        .then((fn) => { if (fn && !settled) unlisten = fn; else if (fn) fn(); })
        .then(() => { if (!settled) return opener.openUrl(authUrl); })
        .catch((err) => { if (!settled) { cleanup(); reject(err); } });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('Hết thời gian chờ đăng nhập (5 phút).'));
      }, timeoutMs);
    });
  }

  function parseQueryString(qs) {
    const out = {};
    new URLSearchParams(qs).forEach((v, k) => { out[k] = v; });
    return out;
  }

  return { OAUTH_CALLBACK_URL, createPkcePair, awaitRedirect, parseQueryString, isTauri };
})();
