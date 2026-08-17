(function () {
    var POLL_MS = 5 * 60 * 1000;
    var GROUP_KEY = 'finance';

    function todayKey() {
        return 'wh_notified_task_ids_' + new Date().toISOString().slice(0, 10);
    }
    function loadNotified() {
        try { return new Set(JSON.parse(localStorage.getItem(todayKey()) || '[]')); }
        catch (e) { return new Set(); }
    }
    function saveNotified(set) {
        localStorage.setItem(todayKey(), JSON.stringify(Array.from(set)));
    }

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

    function start() {
        check();
        setInterval(check, POLL_MS);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
