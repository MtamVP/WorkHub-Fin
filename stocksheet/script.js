/* --- FILE: /stocksheet/script.js --- */

document.addEventListener('DOMContentLoaded', function() {
    loadStockList();
});

// 1. TẢI DANH SÁCH CỔ PHIẾU VÀO DROPDOWN
async function loadStockList() {
    const select = document.getElementById('stock-select');
    select.innerHTML = '<option>Đang tải...</option>';
    
    try {
        const response = await callGAS('getStockList');
        if (response.status === 'success') {
            const stocks = response.data;
            let html = '<option value="">-- Chọn mã cổ phiếu --</option>';
            stocks.forEach(stock => {
                html += `<option value="${stock}">${stock}</option>`;
            });
            select.innerHTML = html;
        } else {
            select.innerHTML = '<option>Lỗi tải danh sách</option>';
        }
    } catch (e) {
        console.error(e);
        select.innerHTML = '<option>Lỗi kết nối</option>';
    }
}

// 2. TẢI CHI TIẾT VÀ VẼ BẢNG
async function loadStockDetail() {
    const symbol = document.getElementById('stock-select').value;
    const displayDiv = document.getElementById('sheet-display');
    const spinner = document.getElementById('loading-spinner');

    if (!symbol) {
        displayDiv.style.display = 'none';
        return;
    }

    // Hiển thị loading
    displayDiv.style.display = 'none';
    spinner.style.display = 'block';

    try {
        // Gửi request lấy dữ liệu
        const response = await callGAS('getStockDetail', { symbol: symbol });
        
        spinner.style.display = 'none';
        displayDiv.style.display = 'block';

        if (response.status === 'success') {
            renderTable(response.data);
            showToast("Đã tải dữ liệu mã " + symbol, "success");
        } else {
            displayDiv.innerHTML = `<p style="color:var(--danger-color); text-align:center;">Lỗi: ${response.message}</p>`;
        }
    } catch (e) {
        spinner.style.display = 'none';
        alert("Lỗi kết nối: " + e.message);
    }
}

// 3. HÀM VẼ BẢNG HTML (GIAO DIỆN HIỆN ĐẠI - MODERN UI)
function renderTable(data) {
    const table = document.getElementById('stock-table');
    let html = '';

    // --- Dòng 1: Header Chính [Mã CP, TÊN CỔ PHIẾU, Năm] ---
    // Sử dụng class 'stock-main-header' thay vì style inline màu vàng
    html += `
        <tr class="stock-main-header">
            <td class="text-center text-bold">${data[0][0]}</td>
            <td class="text-bold" style="text-transform: uppercase;">${data[0][1]}</td>
            <td class="text-right text-bold">${data[0][2]}</td>
        </tr>
    `;

    // --- Dòng 2 -> 9: Các chỉ số (Vốn, LNST, Giá...) ---
    for (let i = 1; i <= 8; i++) {
        let row = data[i];
        
        // Cột A: STT (nhỏ, màu nhạt), Cột C: Giá trị (căn phải)
        html += `
            <tr>
                <td class="text-center" style="width: 50px; color: var(--text-secondary);">${row[0]}</td>
                <td style="font-weight: 500;">${row[1]}</td>
                <td class="text-right">${row[2]}</td>
            </tr>
        `;
    }

    // --- Dòng 10: Header Target (Phân cách) ---
    // Sử dụng class 'target-header' để tạo dải màu xám ngăn cách
    let rowTargetHeader = data[9];
    html += `
        <tr class="target-header">
            <td></td>
            <td colspan="2"> ${rowTargetHeader[1]}</td>
        </tr>
    `;

    // --- Dòng 11 -> 15: Phần Target Data ---
    for (let i = 10; i < 16; i++) {
        let row = data[i];
        let label = row[1] || "";
        let value = row[2] || "";
        let valClass = 'text-right'; // Mặc định căn phải

        // Xử lý tô màu cho dòng "Return (%)"
        if (label.includes("Return")) {
            valClass += ' text-bold';
            // Xóa ký tự % và dấu phẩy để check số (Hỗ trợ format Việt Nam 10,5%)
            let numVal = parseFloat(value.toString().replace('%','').replace(',','.'));
            
            if (!isNaN(numVal)) {
                if (numVal > 0) valClass += ' text-success'; // Xanh
                else if (numVal < 0) valClass += ' text-danger'; // Đỏ
            }
        } else {
             // Các dòng Price target, PE, PB cho đậm chữ lên một chút
             valClass += ' text-bold';
        }

        html += `
            <tr>
                <td></td>
                <td style="color: var(--text-secondary);">${label}</td>
                <td class="${valClass}">${value}</td>
            </tr>
        `;
    }

    table.innerHTML = html;
}

// --- 4. HÀM HIỂN THỊ THÔNG BÁO (TOAST) ---
function showToast(message, type = 'success') {
    // Xóa toast cũ nếu có
    const existingToast = document.querySelector('.toast-notification');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    const icon = type === 'success' ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-circle-exclamation"></i>';
    toast.innerHTML = `${icon} <span>${message}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}