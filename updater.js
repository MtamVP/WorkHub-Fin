// updater.js - Cập nhật ứng dụng WorkHub (plugin updater + process của Tauri).
// Hai đường vào: (1) 3 giây sau khi mở app tự kiểm tra và hỏi có cập nhật ngay không (như trước); (2) menu tài khoản > "Kiểm tra cập nhật" mở hộp #update-modal để kiểm tra, xem ghi chú,
// tải và cài bất cứ lúc nào mà không phải thoát ra vào lại. Trong lúc app mở, cứ 4 giờ kiểm tra ngầm một lần: có bản mới thì hiện chấm "Mới" ở menu tài khoản, KHÔNG bật hộp thoại làm gián đoạn.
// Logic thuần (so phiên bản, lời báo, tiến độ, đổi lỗi sang tiếng người dùng) ở lib/update-check.js (UpdateCheck). Trên trình duyệt web không có Tauri: hộp chỉ báo "chỉ có ở app desktop".
const WorkHubUpdater = (function () {
    const BG_CHECK_MS = 4 * 3600000, BG_TICK_MS = 30 * 60000;
    const U = { phase: 'idle', update: null, current: '', checkedAt: 0, downloaded: 0, total: 0, error: '', busy: false };
    const tauri = () => (window.__TAURI__ && window.__TAURI__.updater ? window.__TAURI__ : null);
    const $ = (id) => document.getElementById(id);
    const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };
    const setText = (id, t) => { const el = $(id); if (el) el.textContent = t; };

    async function readVersion() {
        try { if (window.__TAURI__ && window.__TAURI__.app && window.__TAURI__.app.getVersion) U.current = await window.__TAURI__.app.getVersion(); } catch (e) { /* không đọc được thì chỉ không hiện số phiên bản */ }
        return U.current;
    }
    // Chấm "Mới" ở menu tài khoản khi có bản cập nhật chờ (đã tìm thấy, đang tải hoặc đã tải xong chưa khởi động lại)
    function badge() {
        const on = U.phase === 'available' || U.phase === 'ready' || U.phase === 'downloading';
        show('update-badge', on);
        const b = $('user-badge'); if (b && b.classList) b.classList.toggle('has-update', on);
    }
    function render() {
        setText('update-current', U.current ? 'v' + U.current : '—');
        const busy = U.phase === 'checking' || U.phase === 'downloading';
        let head = '', detail = '';
        if (U.phase === 'web') { head = 'Chỉ có trong ứng dụng desktop'; detail = 'Trang web luôn là bản mới nhất mỗi khi bạn tải lại trang.'; }
        else if (U.phase === 'checking') { head = 'Đang kiểm tra…'; }
        else if (U.phase === 'latest') { const r = UpdateCheck.describeResult(U.current, null); head = r.headline; detail = r.detail + (U.checkedAt ? ' Kiểm tra lúc ' + new Date(U.checkedAt).toLocaleTimeString('vi-VN') + '.' : ''); }
        else if (U.phase === 'available') { const r = UpdateCheck.describeResult(U.current, U.update); head = r.headline; detail = r.detail + ' Bấm "Tải và cài đặt"; nên lưu việc đang làm trước.'; }
        else if (U.phase === 'downloading') { head = 'Đang tải bản cập nhật…'; detail = 'Vui lòng không tắt ứng dụng.'; }
        else if (U.phase === 'ready') { head = 'Đã tải và cài xong'; detail = 'Khởi động lại ứng dụng để dùng bản mới.'; }
        else if (U.phase === 'error') { head = 'Chưa cập nhật được'; detail = U.error; }
        else { head = 'Bấm "Kiểm tra lại" để xem có bản mới không.'; }
        setText('update-status', head); setText('update-detail', detail);
        const notes = U.update && (U.phase === 'available' || U.phase === 'downloading') ? UpdateCheck.notesBrief(U.update.body, 900) : '';
        setText('update-notes', notes); show('update-notes', !!notes);
        const downloading = U.phase === 'downloading', p = UpdateCheck.progress(U.downloaded, U.total);
        show('update-progress-wrap', downloading);
        const bar = $('update-bar'); if (bar) bar.style.width = (p.percent === null ? (downloading ? 100 : 0) : p.percent) + '%';
        setText('update-progress-text', downloading ? p.text : '');
        show('update-install-btn', U.phase === 'available' || (U.phase === 'error' && !!U.update));
        show('update-restart-btn', U.phase === 'ready');
        const cb = $('update-check-btn'); if (cb) cb.disabled = busy || U.phase === 'web' || U.phase === 'ready';
        const ib = $('update-install-btn'); if (ib) ib.disabled = busy;
    }

    // Kiểm tra bản mới; không làm gì khi đang kiểm, đang tải hoặc đã tải xong (giữ nguyên trạng thái). Trả về pha sau khi kiểm: 'latest' | 'available' | 'error' | 'web'.
    async function check() {
        if (U.phase === 'downloading' || U.phase === 'ready' || U.phase === 'checking') return U.phase;
        const T = tauri();
        if (!T) { U.phase = 'web'; render(); return U.phase; }
        U.phase = 'checking'; U.error = ''; render();
        try {
            await readVersion();
            const up = await T.updater.check();
            const r = UpdateCheck.describeResult(U.current, up);
            U.update = r.kind === 'available' ? up : null;
            U.phase = r.kind;
            U.checkedAt = Date.now();
        } catch (e) {
            U.phase = 'error'; U.error = UpdateCheck.friendlyError(e); U.update = null;
            console.warn('Lỗi khi kiểm tra cập nhật:', e);
        }
        badge(); render();
        return U.phase;
    }
    async function install() {
        if (!U.update || U.phase === 'downloading') return;
        U.phase = 'downloading'; U.downloaded = 0; U.total = 0; U.error = ''; badge(); render();
        try {
            await U.update.downloadAndInstall((ev) => {
                if (ev.event === 'Started') U.total = (ev.data && ev.data.contentLength) || 0;
                else if (ev.event === 'Progress') U.downloaded += (ev.data && ev.data.chunkLength) || 0;
                render();
            });
            U.phase = 'ready';
        } catch (e) {
            U.phase = 'error'; U.error = UpdateCheck.friendlyError(e);
            console.warn('Lỗi khi tải bản cập nhật:', e);
        }
        badge(); render();
    }
    async function restart() {
        const P = window.__TAURI__ && window.__TAURI__.process;
        if (P && P.relaunch) { await P.relaunch(); return; }
        setText('update-detail', 'Vui lòng tắt và mở lại ứng dụng để áp dụng bản cập nhật.');
    }
    function openModal() {
        if (typeof openAppModal === 'function') openAppModal('update-modal');
        readVersion().then(render);
        render();
        if (U.phase !== 'downloading' && U.phase !== 'ready' && (U.phase === 'idle' || U.phase === 'error' || UpdateCheck.shouldAutoCheck(U.checkedAt, Date.now(), 60000))) check();
    }

    // Lúc mở app: kiểm tra và hỏi ngay như trước. Lỗi lúc khởi động (ví dụ chưa có mạng) im lặng, không bật hộp lỗi; hộp trong menu mới báo lỗi.
    async function startupCheck() {
        const phase = await check();
        if (phase !== 'available' || !U.update) return;
        const result = await Swal.fire({
            title: 'Có Phiên Bản Mới!',
            text: `WorkHub có bản cập nhật v${U.update.version}. Bạn có muốn tải và cài đặt ngay không?`,
            icon: 'info', showCancelButton: true, confirmButtonText: 'Cập nhật ngay', cancelButtonText: 'Để sau',
            confirmButtonColor: '#3085d6', cancelButtonColor: '#d33',
        });
        if (result.isConfirmed) { openModal(); await install(); }
    }
    function backgroundTick() {
        if (typeof document !== 'undefined' && document.hidden) return;
        if (UpdateCheck.shouldAutoCheck(U.checkedAt, Date.now(), BG_CHECK_MS)) check();
    }
    function start() {
        setTimeout(startupCheck, 3000);                                              // chờ app tải xong để không làm chậm màn hình khởi động
        setInterval(backgroundTick, BG_TICK_MS);
    }
    return { U, check, install, restart, openModal, startupCheck, backgroundTick, start, render, badge };
})();

// Giữ tên cũ cho mã khác còn gọi
function checkForAppUpdates() { return WorkHubUpdater.startupCheck(); }
function openUpdateModal() { return WorkHubUpdater.openModal(); }
window.addEventListener('DOMContentLoaded', () => WorkHubUpdater.start());
