// updater.js - Auto Updater cho WorkHub
// Yêu cầu: plugin-updater và plugin-process (nếu cần relaunch)

async function checkForAppUpdates() {
    // Kiểm tra xem có chạy trong môi trường Tauri không
    if (!window.__TAURI__ || !window.__TAURI__.updater) {
        console.log('Không tìm thấy API Updater (Có thể đang chạy trên trình duyệt web thay vì app desktop).');
        return;
    }

    try {
        console.log('Đang kiểm tra bản cập nhật mới...');
        const update = await window.__TAURI__.updater.check();

        if (update) {
            console.log(`Có bản cập nhật mới: ${update.version}`);
            
            // Hỏi ý kiến người dùng
            const result = await Swal.fire({
                title: 'Có Phiên Bản Mới!',
                text: `WorkHub có bản cập nhật v${update.version}. Bạn có muốn tải và cài đặt ngay không?`,
                icon: 'info',
                showCancelButton: true,
                confirmButtonText: 'Cập nhật ngay',
                cancelButtonText: 'Để sau',
                confirmButtonColor: '#3085d6',
                cancelButtonColor: '#d33',
            });

            if (result.isConfirmed) {
                let downloaded = 0;
                let contentLength = 0;

                // Hiện thông báo đang tải
                Swal.fire({
                    title: 'Đang tải bản cập nhật...',
                    html: `<b>0%</b><br>Vui lòng không tắt ứng dụng.`,
                    allowOutsideClick: false,
                    allowEscapeKey: false,
                    showConfirmButton: false,
                    didOpen: () => {
                        Swal.showLoading();
                    }
                });

                // Bắt đầu tải và cài đặt
                await update.downloadAndInstall((event) => {
                    const swalHtml = Swal.getHtmlContainer();
                    const b = swalHtml.querySelector('b');
                    
                    switch (event.event) {
                        case 'Started':
                            contentLength = event.data.contentLength;
                            break;
                        case 'Progress':
                            downloaded += event.data.chunkLength;
                            if (b) {
                                if (contentLength) {
                                    const percent = Math.round((downloaded / contentLength) * 100);
                                    b.textContent = `${percent}%`;
                                } else {
                                    // Trước đây nếu contentLength không có (vd. server trả về tải
                                    // dạng chunked/không rõ tổng dung lượng), % đứng yên ở "0%"
                                    // mãi trong lúc tải thật sự vẫn đang chạy -- người dùng tưởng
                                    // ứng dụng treo. Không có tổng để tính % thì hiện số MB đã tải
                                    // thay vì để mốc 0% gây hiểu lầm.
                                    b.textContent = `${(downloaded / 1048576).toFixed(1)} MB đã tải`;
                                }
                            }
                            break;
                        case 'Finished':
                            if (b) b.textContent = '100% - Đang cài đặt...';
                            break;
                    }
                });

                Swal.fire({
                    title: 'Hoàn tất!',
                    text: 'Đã cài đặt xong bản cập nhật. Ứng dụng sẽ khởi động lại.',
                    icon: 'success',
                    timer: 3000,
                    showConfirmButton: false
                });

                setTimeout(async () => {
                    if (window.__TAURI__.process && window.__TAURI__.process.relaunch) {
                        await window.__TAURI__.process.relaunch();
                    } else {
                        // Nếu không có plugin process, yêu cầu người dùng tự mở lại
                        Swal.fire('Thành công', 'Vui lòng tắt và mở lại ứng dụng để áp dụng bản cập nhật.', 'success');
                    }
                }, 3000);
            }
        } else {
            console.log('Bạn đang dùng phiên bản mới nhất.');
        }
    } catch (error) {
        console.error('Lỗi khi kiểm tra cập nhật:', error);
        Swal.fire({
            title: 'Lỗi cập nhật',
            text: String(error),
            icon: 'error'
        });
    }
}

// Tự động kiểm tra sau khi app load xong 3 giây để tránh làm chậm màn hình khởi động
window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        checkForAppUpdates();
    }, 3000);
});
