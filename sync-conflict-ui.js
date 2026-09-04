(function () {
    function describeAction(action, params) {
        if (window.WORKHUB_SYNC_CONFIG && typeof window.WORKHUB_SYNC_CONFIG.describeAction === 'function') {
            return window.WORKHUB_SYNC_CONFIG.describeAction(action, params);
        }
        return action;
    }

    function updateBadge(count) {
        var anchor = document.getElementById('observation-toggle-btn');
        if (!anchor) return;
        var badge = document.getElementById('sync-conflict-badge');
        if (!count) {
            if (badge) badge.remove();
            return;
        }
        if (!badge) {
            badge = document.createElement('span');
            badge.id = 'sync-conflict-badge';
            badge.style.cssText = 'position:absolute; top:-4px; right:-4px; background:#e53e3e; color:#fff; ' +
                'font-size:10px; line-height:1; border-radius:999px; padding:2px 5px; font-weight:600;';
            anchor.style.position = anchor.style.position || 'relative';
            anchor.appendChild(badge);
        }
        badge.textContent = String(count);
        badge.title = count + ' thay đổi ngoại tuyến chưa đồng bộ được';
    }

    async function refreshBadge() {
        if (!window.WorkHubSync) return;
        try {
            var conflicts = await window.WorkHubSync.debugDumpConflicts();
            updateBadge(conflicts.length);
        } catch (e) { /* WorkHubSync not ready yet, ignore */ }
    }

    async function renderConflictList() {
        var container = document.getElementById('sync-conflict-list');
        if (!container || !window.WorkHubSync) return;
        var conflicts;
        try {
            conflicts = await window.WorkHubSync.debugDumpConflicts();
        } catch (e) {
            // debugDumpConflicts() đọc thẳng SQLite cục bộ (tauri-plugin-sql) -- file bị khoá/
            // hỏng là lỗi thật có thể xảy ra trên app desktop. Trước đây không bắt lỗi ở đây
            // (khác refreshBadge() đã có try/catch cho cùng loại lệnh gọi), khiến modal mở ra
            // trống trơn, không có gì báo lỗi ngoài 1 unhandled rejection trong console.
            container.innerHTML = '<p style="padding:12px 0; color:var(--danger-color,#e53e3e);">' +
                'Không đọc được danh sách xung đột (lỗi cơ sở dữ liệu cục bộ). Thử mở lại sau.</p>';
            return;
        }
        if (!conflicts.length) {
            container.innerHTML = '<p style="padding:12px 0;">Không có xung đột nào.</p>';
            return;
        }
        container.innerHTML = conflicts.map(function (c) {
            var params = {};
            try { params = JSON.parse(c.params_json); } catch (e) {}
            return (
                '<div class="sync-conflict-row" style="border:1px solid var(--border-color,#e2e8f0); border-radius:8px; padding:10px 12px; margin-bottom:10px;">' +
                '<div style="font-weight:600; margin-bottom:4px;">' + escapeHtml(describeAction(c.action, params)) + '</div>' +
                '<div style="font-size:12.5px; color:var(--danger-color,#e53e3e); margin-bottom:8px;">' + escapeHtml(c.error_message) + '</div>' +
                '<div style="display:flex; gap:8px;">' +
                '<button type="button" class="btn btn-sm" onclick="window.WorkHubSyncUI.resolve(\'' + c.id + '\', \'reedit\')">Sửa lại</button>' +
                '<button type="button" class="btn btn-sm btn-secondary" onclick="window.WorkHubSyncUI.resolve(\'' + c.id + '\', \'discard\')">Bỏ qua</button>' +
                '</div>' +
                '</div>'
            );
        }).join('');
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    async function resolve(conflictId, action) {
        if (!window.WorkHubSync) return;
        // Trước đây không bắt lỗi ở đây -- discardConflict() ghi thẳng vào SQLite cục bộ, lỗi
        // hoàn toàn có thể xảy ra (file khoá/hỏng). Khi đó promise reject NGAY, người dùng bấm
        // "Sửa lại"/"Bỏ qua" không thấy gì phản hồi, và dòng xung đột + badge vẫn giữ nguyên
        // trạng thái cũ không rõ lý do.
        try {
            await window.WorkHubSync.discardConflict(conflictId);
        } catch (e) {
            if (typeof window.showToast === 'function') {
                window.showToast('Không xoá được xung đột (lỗi cơ sở dữ liệu cục bộ). Thử lại sau.', 'error');
            }
            return;
        }
        if (action === 'reedit') {
            if (typeof window.showToast === 'function') {
                window.showToast('Đã xoá xung đột — hãy mở lại mục này và sửa dựa trên dữ liệu mới nhất.', 'info');
            }
            if (typeof window.loadProjectOverview === 'function') window.loadProjectOverview({ quiet: true });
            if (typeof window.loadCalendarData === 'function') window.loadCalendarData({ quiet: true });
        }
        renderConflictList();
        refreshBadge();
    }

    window.WorkHubSyncUI = { resolve: resolve };

    function openConflictModal() {
        renderConflictList();
        if (typeof window.openAppModal === 'function') window.openAppModal('sync-conflict-modal');
    }

    window.addEventListener('workhub-sync-conflict', function () {
        refreshBadge();
        if (typeof Swal === 'undefined') return;
        Swal.fire({
            toast: true,
            position: 'top-end',
            icon: 'warning',
            title: 'Có thay đổi ngoại tuyến không đồng bộ được',
            showConfirmButton: true,
            confirmButtonText: 'Xem chi tiết',
            timer: 6000,
            timerProgressBar: true
        }).then(function (r) {
            if (r.isConfirmed) openConflictModal();
        });
    });

    function wireBadgeClick() {
        var anchor = document.getElementById('observation-toggle-btn');
        if (!anchor) return;
        anchor.addEventListener('click', function () {
            var badge = document.getElementById('sync-conflict-badge');
            if (badge) openConflictModal();
        }, true);
    }

    function start() {
        wireBadgeClick();
        refreshBadge();
        setInterval(refreshBadge, 60 * 1000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
