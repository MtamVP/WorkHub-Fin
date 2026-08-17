window.WORKHUB_SYNC_CONFIG = {
    dbFile: 'sqlite:workhub-fin-cache.db',
    // Actions eligible for optimistic local UI patching on offline write (small allowlist —
    // everything else in MUTATING_ACTIONS still queues+replays correctly, it just won't
    // reflect in the UI instantly while offline).
    optimisticActions: ['saveTask', 'deleteTask', 'addAssetTransaction', 'deleteAssetTransaction'],
    describeAction: function (action, params) {
        var labels = {
            saveTask: 'Lưu công việc "' + (params.name || '') + '"',
            deleteTask: 'Xoá công việc',
            addAssetTransaction: 'Thêm giao dịch tài sản',
            deleteAssetTransaction: 'Xoá giao dịch tài sản',
            createProject: 'Tạo dự án "' + (params.name || '') + '"',
            updateProject: 'Cập nhật dự án',
            deleteProject: 'Xoá dự án',
            createEvent: 'Tạo sự kiện',
            updateEvent: 'Cập nhật sự kiện',
            deleteEvent: 'Xoá sự kiện'
        };
        return labels[action] || action;
    }
};
