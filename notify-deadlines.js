(function () {
    var POLL_MS = 5 * 60 * 1000;
    var GROUP_KEY = 'finance';

    function todayKey() {
        return 'wh_notified_task_ids_' + new Date().toISOString().slice(0, 10);
    }
    function personalTodayKey() {
        return 'wh_notified_personal_events_' + new Date().toISOString().slice(0, 10);
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

    async function check() {
        var email = localStorage.getItem('userEmail') || localStorage.getItem('currentUser');
        if (!email || typeof window.callGAS !== 'function') return;

        if (window.__TAURI__ && window.__TAURI__.notification) {
            var ok = await ensureTauriPermission();
            if (!ok) return;
        } else if ('Notification' in window && Notification.permission === 'default') {
            await Notification.requestPermission();
        }

        var res = await window.callGAS('listMyTasks', { email: email, groupKey: GROUP_KEY });
        if (res.status !== 'success' || !Array.isArray(res.data)) return;

        var notified = loadNotified();
        var changed = false;
        var now = Date.now();
        var soonMs = 24 * 60 * 60 * 1000;

        res.data.forEach(function (t) {
            if (!t.dueDate || t.status === 'Done' || notified.has(t.id)) return;
            var due = new Date(t.dueDate).getTime();
            if (isNaN(due)) return;
            if (due < now) {
                fire('Công việc quá hạn', t.name || '');
                notified.add(t.id);
                changed = true;
            } else if (due - now <= soonMs) {
                fire('Sắp đến hạn', t.name || '');
                notified.add(t.id);
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

    function start() {
        check();
        checkPersonalEvents();
        setInterval(check, POLL_MS);
        setInterval(checkPersonalEvents, POLL_MS);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
