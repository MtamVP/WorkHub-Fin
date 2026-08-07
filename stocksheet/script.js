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

// 2. KHI CHỌN MÃ: tải danh sách năm có dữ liệu, rồi tải chi tiết + biểu đồ xu hướng
async function loadStockDetail() {
    const symbol = document.getElementById('stock-select').value;
    const displayDiv = document.getElementById('sheet-display');
    const spinner = document.getElementById('loading-spinner');
    const yearLabel = document.getElementById('stock-year-label');
    const yearSelect = document.getElementById('stock-year-select');
    const trendWrapper = document.getElementById('trend-chart-wrapper');

    if (!symbol) {
        displayDiv.style.display = 'none';
        yearLabel.style.display = 'none';
        yearSelect.style.display = 'none';
        trendWrapper.style.display = 'none';
        return;
    }

    displayDiv.style.display = 'none';
    spinner.style.display = 'block';

    try {
        // Nếu người dùng vừa đổi mã (chưa có danh sách năm cho mã này), tải lại danh sách năm
        if (yearSelect.dataset.symbol !== symbol) {
            const yearsResp = await callGAS('getStockYears', { symbol: symbol });
            const years = yearsResp.data || [];
            yearSelect.dataset.symbol = symbol;
            yearSelect.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
            yearLabel.style.display = years.length ? 'inline-flex' : 'none';
            yearSelect.style.display = years.length ? 'inline-block' : 'none';
        }

        const selectedYear = yearSelect.value || '';
        const response = await callGAS('getStockDetail', { symbol: symbol, year: selectedYear });

        spinner.style.display = 'none';
        displayDiv.style.display = 'block';

        if (response.status === 'success') {
            renderTable(buildTableRows(response.data));
            showToast("Đã tải dữ liệu mã " + symbol, "success");
        } else {
            displayDiv.innerHTML = `<p style="color:var(--danger-color); text-align:center;">Lỗi: ${response.message}</p>`;
        }

        await loadTrendChart(symbol);
    } catch (e) {
        spinner.style.display = 'none';
        alert("Lỗi kết nối: " + e.message);
    }
}

// Chuyển object định giá (đã lưu trong finance_stock_valuations.data) thành mảng 16 dòng
// đúng thứ tự mà renderTable() (được viết cho định dạng bảng cũ) đang mong đợi.
function buildTableRows(d) {
    d = d || {};
    const num = (v) => (v === undefined || v === null || v === '') ? '' : Number(v).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
    return [
        [d.symbol || '', d.symbol || '', d.year || ''],
        [1, 'Vốn điều lệ', num(d.charter_capital)],
        [2, 'Vốn chủ sở hữu', num(d.equity)],
        [3, 'Lợi nhuận sau thuế', num(d.lnst)],
        [4, 'Giá trị sổ sách', num(d.book_value)],
        [5, 'EPS', num(d.eps)],
        [6, 'Giá cổ phiếu hiện tại', num(d.price)],
        [7, 'P/E', num(d.pe)],
        [8, 'P/B', num(d.pb)],
        [9, 'Target', ''],
        [10, 'Target P/E', num(d.target_pe)],
        [11, 'Target P/B', num(d.target_pb)],
        [12, 'Price Target (P/E)', num(d.price_per_pe)],
        [13, 'Price Target (P/B)', num(d.price_per_pb)],
        [14, 'Return theo P/E', num(d.return_pe) + '%'],
        [15, 'Return theo P/B', num(d.return_pb) + '%']
    ];
}

// 2b. BIỂU ĐỒ XU HƯỚNG ĐỊNH GIÁ QUA CÁC NĂM
let trendChartInstance = null;
async function loadTrendChart(symbol) {
    const wrapper = document.getElementById('trend-chart-wrapper');
    try {
        const response = await callGAS('getStockHistory', { symbol: symbol });
        const history = response.data || [];
        if (history.length < 2) { wrapper.style.display = 'none'; return; }
        wrapper.style.display = 'block';

        const canvas = document.getElementById('valuationTrendChart');
        const ctx = canvas.getContext('2d');
        if (trendChartInstance) trendChartInstance.destroy();

        const labels = history.map(h => h.year);
        const peData = history.map(h => Number(h.data && h.data.pe) || 0);
        const pbData = history.map(h => Number(h.data && h.data.pb) || 0);
        const priceData = history.map(h => Number(h.data && h.data.price) || 0);

        trendChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    { label: 'P/E', data: peData, borderColor: cssVar('--finance-accent'), yAxisID: 'y', tension: 0.3 },
                    { label: 'P/B', data: pbData, borderColor: cssVar('--info-color'), yAxisID: 'y', tension: 0.3 },
                    { label: 'Giá (VND)', data: priceData, borderColor: cssVar('--success-color'), yAxisID: 'y1', tension: 0.3 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: cssVar('--text-primary') } } },
                scales: {
                    x: { ticks: { color: cssVar('--text-secondary') }, grid: { color: cssVar('--border-color') } },
                    y: { type: 'linear', position: 'left', ticks: { color: cssVar('--text-secondary') }, grid: { color: cssVar('--border-color') } },
                    y1: { type: 'linear', position: 'right', ticks: { color: cssVar('--text-secondary') }, grid: { drawOnChartArea: false } }
                }
            }
        });
    } catch (e) {
        console.error('Lỗi loadTrendChart:', e);
        wrapper.style.display = 'none';
    }
}

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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