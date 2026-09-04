(function () {
    var POLL_MS = 5 * 60 * 1000;
    var GROUP_KEY = 'finance';

    // toISOString().slice(0,10) trước đây lấy ngày theo UTC -- mốc "sang ngày mới" (reset
    // danh sách đã nhắc) rơi vào 7h sáng giờ VN (UTC+7) thay vì đúng nửa đêm giờ máy người
    // dùng. localDateKey() lấy ngày theo giờ máy (local), khớp đúng "hôm nay" người dùng
    // đang thấy trên lịch, giống cách getDueDateBadge() (script.js) tính "hôm nay".
    function localDateKey() {
        var d = new Date();
        var y = d.getFullYear();
        var m = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + day;
    }
    function todayKey() {
        return 'wh_notified_task_ids_' + localDateKey();
    }
    function personalTodayKey() {
        return 'wh_notified_personal_events_' + localDateKey();
    }
    function loadNotifiedFrom(key) {
        try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
        catch (e) { return new Set(); }
    }
    function saveNotifiedTo(key, set) {
        localStorage.setItem(key, JSON.stringify(Array.from(set)));
    }
    function loadNotified() { return loadNotifiedFrom(todayKey()); }
    function saveNotified(set) { saveNotifiedTo(todayKey(), set); }

    async function ensureTauriPermission() {
        var n = window.__TAURI__.notification;
        var granted = await n.isPermissionGranted();
        if (!granted) {
            var perm = await n.requestPermission();
            granted = perm === 'granted';
        }
        return granted;
    }

    function fire(title, body) {
        if (window.__TAURI__ && window.__TAURI__.notification) {
            window.__TAURI__.notification.sendNotification({ title: title, body: body });
        } else if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(title, { body: body });
        }
    }

    // Xin quyền thông báo 1 lần, tách riêng khỏi check() -- trước đây chỉ nằm trong check(),
    // mà check() early-return TRƯỚC khi tới đoạn xin quyền nếu chưa có email/currentUser
    // trong localStorage, nghĩa là nếu người dùng chưa từng đăng nhập qua field đó thì
    // KHÔNG CÓ chỗ nào trong cả file từng xin quyền -- mọi fire() sau này (kể cả từ
    // checkPersonalEvents(), vốn không tự xin quyền) đều no-op âm thầm vĩnh viễn.
    async function ensureNotificationPermission() {
        if (window.__TAURI__ && window.__TAURI__.notification) {
            return ensureTauriPermission();
        } else if ('Notification' in window && Notification.permission === 'default') {
            var perm = await Notification.requestPermission();
            return perm === 'granted';
        }
        return 'Notification' in window && Notification.permission === 'granted';
    }

    async function check() {
        var email = localStorage.getItem('userEmail') || localStorage.getItem('currentUser');
        if (!email || typeof window.callGAS !== 'function') return;
        if (!(await ensureNotificationPermission())) return;

        var res = await window.callGAS('listMyTasks', { email: email, groupKey: GROUP_KEY });
        if (res.status !== 'success' || !Array.isArray(res.data)) return;

        var notified = loadNotified();
        var changed = false;
        var now = Date.now();
        var soonMs = 24 * 60 * 60 * 1000;

        res.data.forEach(function (t) {
            if (!t.dueDate || t.status === 'Done') return;
            // t.dueDate là chuỗi chỉ có ngày "YYYY-MM-DD" (api.js: task.due_date.slice(0,10))
            // -- new Date() suông parse dạng chỉ-ngày theo UTC nửa đêm, không phải local nửa
            // đêm, khiến task tưởng quá hạn sớm hơn thực tế bằng đúng lệch múi giờ (7 tiếng ở
            // VN). Nối 'T00:00:00' để ép parse theo local, giống 3 chỗ khác trong cùng
            // codebase xử lý đúng field này: script.js:4934 getDueDateBadge(), api.js dòng
            // ~724 và ~1816.
            var due = new Date(t.dueDate + 'T00:00:00').getTime();
            if (isNaN(due)) return;
            // 2 khoá riêng (':overdue'/':soon') thay vì chỉ notified.has(t.id) -- trước đây
            // dùng chung 1 khoá cho cả 2 loại thông báo nên 1 task đã báo "Sắp đến hạn" buổi
            // sáng thì đến chiều CÙNG NGÀY chuyển sang quá hạn thật sẽ bị nhánh guard chặn ở
            // đầu forEach, không bao giờ báo "Công việc quá hạn" nữa cho tới khi qua ngày mới.
            if (due < now) {
                if (notified.has(t.id + ':overdue')) return;
                fire('Công việc quá hạn', t.name || '');
                notified.add(t.id + ':overdue');
                changed = true;
            } else if (due - now <= soonMs) {
                if (notified.has(t.id + ':soon')) return;
                fire('Sắp đến hạn', t.name || '');
                notified.add(t.id + ':soon');
                changed = true;
            }
        });

        if (changed) saveNotified(notified);
    }

    // Nhắc việc riêng (Lịch riêng trong Personal Hub) — hoàn toàn tách biệt với deadline
    // công việc nhóm ở trên: cùng cơ chế thông báo desktop, khác nguồn dữ liệu
    // (personal_items type='calendar_event', riêng tư theo auth.uid(), không qua GROUP_KEY).
    async function checkPersonalEvents() {
        if (typeof window.callGAS !== 'function') return;
        var res = await window.callGAS('getPersonalItems', { type: 'calendar_event' });
        if (res.status !== 'success' || !Array.isArray(res.data)) return;

        var notified = loadNotifiedFrom(personalTodayKey());
        var changed = false;
        var now = Date.now();

        res.data.forEach(function (ev) {
            var data = ev.data || {};
            if (!data.start || notified.has(ev.id)) return;
            var start = new Date(data.start).getTime();
            if (isNaN(start) || start < now) return;
            var reminderMs = (Number(data.reminderMinutesBefore) || 0) * 60 * 1000;
            var triggerAt = start - reminderMs;
            if (now >= triggerAt) {
                fire('Nhắc việc riêng', ev.title || '');
                notified.add(ev.id);
                changed = true;
            }
        });

        if (changed) saveNotifiedTo(personalTodayKey(), notified);
    }

    async function start() {
        // Xin quyền thông báo TRƯỚC, đợi xong mới chạy check()/checkPersonalEvents() --
        // trước đây gọi 2 hàm này song song không đợi nhau, nên checkPersonalEvents() (vốn
        // không tự xin quyền) có thể gọi fire() trong lúc quyền còn đang chờ xác nhận từ
        // check(), làm rớt thông báo sự kiện cá nhân ngay lúc mở app.
        await ensureNotificationPermission();
        check();
        checkPersonalEvents();
        setInterval(check, POLL_MS);
        setInterval(checkPersonalEvents, POLL_MS);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
