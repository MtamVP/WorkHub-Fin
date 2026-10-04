/* --- FILE: /lib/save-file.js ---
   Lưu file ra đĩa, dùng chung cho trang Danh Mục (xuất CSV/Excel) và Toàn Nhóm (báo cáo nhóm). Global: bytesToBase64, saveBytesToDisk. */

// ---------------------------------------------------------------------------------------------
// Lưu file: app desktop -> hộp thoại "Lưu thành" của hệ điều hành; trình duyệt -> tải xuống thường.
// Ghi qua lệnh sync_write_file có sẵn (root = thư mục người dùng vừa chọn, relative = tên file) nên không cần cấp thêm quyền ghi đĩa.
// ---------------------------------------------------------------------------------------------
function bytesToBase64(u8) {
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
}

async function saveBytesToDisk(filename, bytes, mime) {
    if (window.__TAURI__ && window.__TAURI__.dialog && window.__TAURI__.dialog.save && window.__TAURI__.core) {
        const ext = (filename.split('.').pop() || '').toLowerCase();
        const path = await window.__TAURI__.dialog.save({ defaultPath: filename, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
        if (!path) return false;                                   // người dùng bấm Huỷ
        const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
        const dir = cut >= 0 ? path.slice(0, cut) || path.slice(0, cut + 1) : '.';
        const name = cut >= 0 ? path.slice(cut + 1) : path;
        await window.__TAURI__.core.invoke('sync_write_file', { root: dir, relativePath: name, contentBase64: bytesToBase64(bytes) });
        return path;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return filename;
}
