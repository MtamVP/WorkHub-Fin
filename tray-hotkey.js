(function () {
    function wire() {
        if (!window.__TAURI__ || !window.__TAURI__.event) return;
        window.__TAURI__.event.listen('quick-add-task', function () {
            if (typeof window.openAddTask === 'function') window.openAddTask();
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})();
