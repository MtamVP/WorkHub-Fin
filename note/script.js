
// Các màu pastel ngẫu nhiên cho tờ note
const noteColors = ['#fef9c3', '#dcfce7', '#dbeafe', '#fce7f3', '#f3e8ff', '#ffedd5'];
document.addEventListener('DOMContentLoaded', function() {
    // Hiển thị ngày hôm nay
    const todayStr = new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' });
    document.getElementById('today-date').innerText = todayStr;

    loadNotes();
    loadFinanceUsers(); // Tải sẵn user vào dropdown
});

// --- TẢI DANH SÁCH USER ---
async function loadFinanceUsers() {
    const select = document.getElementById('note-author');
    try {
        const response = await callGAS('getFinanceUsers');
        if (response.status === 'success') {
            let html = '<option value="">-- Chọn tên bạn --</option>';
            let checkboxHtml = '';
            response.data.forEach(user => {
                html += `<option value="${user.name}">${user.name} (${user.email})</option>`;
                checkboxHtml += `
                    <label style="display:block; margin-bottom:5px; cursor:pointer;">
                        <input type="checkbox" name="email-recipient" value="${user.email}" style="margin-right:8px;">
                        ${user.name} (${user.email})
                    </label>
                `;
            });
            select.innerHTML = html;
            document.getElementById('email-recipients-container').innerHTML = checkboxHtml;
            
            // Auto-select nếu đã lưu trong localStorage từ các màn hình khác
            const savedEmail = localStorage.getItem('userEmail');
            if(savedEmail) {
                Array.from(select.options).forEach(opt => {
                    if(opt.text.includes(savedEmail)) opt.selected = true;
                });
            }
        }
    } catch (e) {
        console.error(e);
        select.innerHTML = '<option value="">Lỗi tải danh sách</option>';
    }
}

// --- TẢI BẢNG NOTE TRONG NGÀY ---
async function loadNotes() {
    const board = document.getElementById('notes-board');
    const spinner = document.getElementById('board-loading');
    
    board.style.display = 'none';
    spinner.style.display = 'block';

    try {
        const response = await callGAS('getFinanceNotes');
        spinner.style.display = 'none';
        board.style.display = 'flex';

        if (response.status === 'success') {
            const notes = response.data;
            if (notes.length === 0) {
                board.innerHTML = `<p style="width:100%; text-align:center; color:var(--text-secondary); font-weight:600; font-size:1.2rem; margin-top:50px;">Chưa có note nào được dán hôm nay</p>`;
                return;
            }

            let html = '';
            notes.forEach((note, index) => {
                // Tạo độ nghiêng ngẫu nhiên (-3deg đến 3deg)
                const rotation = Math.floor(Math.random() * 7) - 3; 
                
                // [MỚI] Tạo hiệu ứng dán lần lượt (stagger)
                // Note đầu tiên dán ngay (0s), note thứ 2 dán sau 0.1s, note thứ 3 sau 0.2s...
                const delay = Math.min(index * 0.1, 1.5); // Giới hạn delay tối đa 1.5s để khỏi đợi lâu
                
                // [MỚI] Chuyển transform: rotate thành biến CSS --rot và thêm animation-delay
                html += `
                    <div class="sticky-note" style="background-color: ${note.color}; --rot: ${rotation}deg; animation-delay: ${delay}s;">
                        <div class="pin"></div>
                        <div class="note-header">
                            <div>
                                <i class="fa-solid fa-user-pen"></i> ${note.author}
                            </div>
                            <div>
                                <span>${note.time}</span>
                                <i class="fa-solid fa-trash" style="cursor:pointer; margin-left:10px; color:#c0392b;" onclick="deleteNote('${note.id}')" title="Xóa note này"></i>
                            </div>
                        </div>
                        <div class="note-body">${note.content}</div>
                    </div>
                `;
            });
            board.innerHTML = html;
        } else {
            showToast("Lỗi tải bảng: " + response.message, "error");
        }
    } catch (e) {
        spinner.style.display = 'none';
        showToast("Lỗi kết nối server", "error");
    }
}

// --- GỬI NOTE MỚI ---
async function submitNote() {
    const authorSelect = document.getElementById('note-author');
    const contentInput = document.getElementById('note-content');
    const btn = document.getElementById('btn-submit-note');

    const author = authorSelect.options[authorSelect.selectedIndex].text.split(' (')[0]; // Lấy Tên, bỏ Email
    const authorEmail = authorSelect.options[authorSelect.selectedIndex].text.split('(')[1]?.replace(')','');
    const content = contentInput.value.trim();

    if (!authorSelect.value) return showToast("Vui lòng chọn tên người dán note!", "error");
    if (!content) return showToast("Nội dung không được để trống!", "error");

    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang dán...';
    btn.disabled = true;

    // Chọn ngẫu nhiên 1 màu pastel
    const randomColor = noteColors[Math.floor(Math.random() * noteColors.length)];

    const payload = { author: author, content: content, color: randomColor };

    try {
        const response = await callGAS('addFinanceNote', payload);
        if (response.status === 'success') {
            showToast("Đã dán note lên bảng!", "success");
            
            // Gửi email bằng EmailJS
            const checkboxes = document.querySelectorAll('input[name="email-recipient"]:checked');
            if (checkboxes.length > 0) {
                const recipients = Array.from(checkboxes).map(cb => cb.value).join(',');
                try {
                    await emailjs.send("service_6a3y0jj", "template_6ou2xre", {
                        to_email: recipients,
                        from_name: author,
                        reply_to: authorEmail || "",
                        message: content,
                        date: new Date().toLocaleDateString('vi-VN')
                    });
                    showToast("Đã gửi email thông báo!", "success");
                } catch (emailErr) {
                    console.error("Lỗi gửi email:", emailErr);
                    showToast("Gửi email thất bại. Vui lòng kiểm tra lại cấu hình EmailJS.", "error");
                }
            }

            closeNoteModal();
            contentInput.value = ""; // Clear form
            document.querySelectorAll('input[name="email-recipient"]').forEach(cb => cb.checked = false); // Clear checkbox
            loadNotes(); // Reload bảng
        } else {
            showToast("Lỗi: " + response.message, "error");
        }
    } catch (e) {
        showToast("Lỗi kết nối", "error");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// --- MODAL CONTROL ---
function openNoteModal() { document.getElementById('note-modal').style.display = 'flex'; }
function closeNoteModal() { document.getElementById('note-modal').style.display = 'none'; }

function selectAllEmails(el) {
    const checkboxes = document.querySelectorAll('input[name="email-recipient"]');
    const isAllChecked = Array.from(checkboxes).every(cb => cb.checked);
    checkboxes.forEach(cb => cb.checked = !isAllChecked);
    el.innerText = isAllChecked ? "Chọn tất cả" : "Bỏ chọn tất cả";
}

// --- XÓA NOTE ---
async function deleteNote(id) {
    if (!confirm("Bạn có chắc chắn muốn xóa note này?")) return;
    try {
        const response = await callGAS('deleteFinanceNote', { id: id });
        if (response.status === 'success') {
            showToast("Đã xóa note!", "success");
            loadNotes(); // Tải lại bảng
        } else {
            showToast("Lỗi: " + response.message, "error");
        }
    } catch (e) {
        showToast("Lỗi kết nối", "error");
    }
}

// --- TOAST ---
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    const icon = type === 'success' ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-xmark"></i>';
    toast.innerHTML = `${icon} <span>${message}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}