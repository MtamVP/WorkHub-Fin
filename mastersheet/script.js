/* --- FILE: /mastersheet/script.js --- */

document.addEventListener('DOMContentLoaded', function() {
    console.log("Page Loaded. Initializing...");
    
    // 1. Tải danh sách thành viên vào dropdown
    loadMemberList();
    
    // 2. Tự động tải bảng tổng hợp (QUAN TRỌNG: Phải gọi hàm này)
    loadTeamSummary();
});

// --- 1. TẢI DANH SÁCH THÀNH VIÊN ---
async function loadMemberList() {
    const select = document.getElementById('member-select');
    if(!select) return;
    
    select.innerHTML = '<option>Đang tải...</option>';
    
    try {
        const response = await callGAS('getMemberList');
        if (response.status === 'success') {
            const members = response.data;
            let html = '<option value="">-- Chọn thành viên (Email) --</option>';
            members.forEach(mem => {
                html += `<option value="${mem}">${mem}</option>`;
            });
            select.innerHTML = html;
        } else {
            select.innerHTML = '<option>Lỗi tải danh sách</option>';
        }
    } catch (e) {
        console.error("Lỗi loadMemberList:", e);
        select.innerHTML = '<option>Lỗi kết nối</option>';
    }
}

// --- 2. TẢI CHI TIẾT THÀNH VIÊN (KHI CHỌN DROPDOWN) ---
async function loadMemberDetail() {
    const email = document.getElementById('member-select').value;
    const displayDiv = document.getElementById('sheet-display');
    const spinner = document.getElementById('loading-spinner');

    if (!email) {
        displayDiv.style.display = 'none';
        return;
    }

    displayDiv.style.display = 'none';
    spinner.style.display = 'block';

    try {
        const response = await callGAS('getMemberDetail', { email: email });
        
        spinner.style.display = 'none';
        displayDiv.style.display = 'block';

        if (response.status === 'success') {
            renderMemberTable(response.data);
            showToast("Đã tải dữ liệu thành viên: " + email, "success");
        } else {
            displayDiv.innerHTML = `<p style="color:var(--danger-color); text-align:center;">Lỗi: ${response.message}</p>`;
        }
    } catch (e) {
        spinner.style.display = 'none';
        alert("Lỗi kết nối: " + e.message);
    }
}

// --- 3. HÀM VẼ BẢNG CHI TIẾT THÀNH VIÊN ---
function renderMemberTable(data) {
    const table = document.getElementById('member-table');
    let html = '';

    data.forEach((row, index) => {
        let trClass = '';
        let tdStyle = 'padding: 8px 12px; border: 1px solid var(--border-color); font-size: 0.95rem;';

        // Header Email
        if (index === 0) {
            html += `<tr><td colspan="10" style="background:var(--primary-color); color:var(--card-bg); font-weight:bold; font-size:1.1rem; padding:10px;">${row[0]}</td></tr>`;
            return;
        }

        // Header Cột
        if (index === 1) {
            trClass = 'background:var(--primary-color); color:var(--card-bg); font-weight:bold; text-align:center;';
            tdStyle += 'border: 1px solid var(--primary-hover);';
        }

        // Highlight các dòng Tổng/NAV
        let firstCell = (row[1] || "").toString().toLowerCase();
        if (firstCell.includes('tổng') || firstCell.includes('tiền') || firstCell.includes('nav') || firstCell.includes('dư nợ')) {
             trClass = 'background:color-mix(in srgb, var(--gold) 10%, var(--card-bg)); font-weight:bold;';
             if (firstCell.includes('nav')) trClass += ' color:var(--gold); font-size:1rem; border-top: 2px solid var(--gold);';
        }

        html += `<tr style="${trClass}">`;

        row.forEach((cell, cellIndex) => {
            let align = 'left';
            if (cellIndex === 0) align = 'center';
            if (cellIndex >= 2) align = 'right';

            // Tô màu Lãi/Lỗ
            let colorStyle = '';
            if (cellIndex === 9 && index > 1) {
                let valNum = parseFloat(cell.toString().replace(/,/g, '').replace(/\./g, '').replace(/[^\d-]/g, ''));
                if (valNum > 0) colorStyle = 'color: var(--success-color); font-weight:bold;';
                if (valNum < 0) colorStyle = 'color: var(--danger-color); font-weight:bold;';
            }

            html += `<td style="${tdStyle} text-align:${align}; ${colorStyle}">${cell}</td>`;
        });

        html += `</tr>`;
    });

    table.innerHTML = html;
}

// --- 4. [QUAN TRỌNG] HÀM TẢI DỮ LIỆU TỔNG HỢP TEAM (NAV & CHART) ---
async function loadTeamSummary() {
    const tbody = document.getElementById('team-table-body');
    if (!tbody) {
        console.warn("Không tìm thấy element #team-table-body");
        return;
    }

    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px;"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải dữ liệu tổng hợp...</td></tr>';
    
    try {
        console.log("Calling getTeamSummary...");
        const response = await callGAS('getTeamSummary');
        console.log("Team Data Response:", response); // [DEBUG] Xem kết quả trả về

        if (response.status === 'success') {
            const data = response.data; 
            
            if (!data || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px;">Chưa có dữ liệu tổng hợp trong MasterSheet.</td></tr>';
                return;
            }

            // A. VẼ BẢNG
            let html = '';
            let chartLabels = [];
            let chartValues = [];
            // Bộ màu theo palette Cream thay vì màu rainbow mặc định của chart lib
            let colors = chartPalette();

            data.forEach(item => {
                let rowStyle = '';
                let name = item.name || "Unknown";
                let navStr = item.nav || "0";
                let percentStr = item.percent || "0%";

                // Kiểm tra dòng TỔNG CỘNG
                if(name.toUpperCase().includes('TỔNG')) {
                    rowStyle = 'background:color-mix(in srgb, var(--gold) 12%, var(--card-bg)); font-weight:bold; border-top: 2px solid var(--border-color);';
                    // Không push dòng tổng vào chart
                } else {
                    // Push thành viên vào chart
                    chartLabels.push(name.split('@')[0]); // Lấy tên ngắn gọn

                    // Parse NAV để vẽ chart (Xóa dấu chấm/phẩy, giữ số)
                    let rawNav = navStr.toString().replace(/[^0-9-]/g, '');
                    let navNum = parseFloat(rawNav);
                    if(navNum > 0) chartValues.push(navNum); // Chỉ vẽ số dương
                }

                html += `
                    <tr style="${rowStyle}">
                        <td style="padding:10px; border-bottom:1px solid var(--border-color);">${name}</td>
                        <td style="padding:10px; border-bottom:1px solid var(--border-color); text-align:right; font-weight:bold;">${navStr}</td>
                        <td style="padding:10px; border-bottom:1px solid var(--border-color); text-align:center;">${percentStr}</td>
                    </tr>
                `;
            });
            tbody.innerHTML = html;

            // B. VẼ BIỂU ĐỒ TRÒN
            if(chartValues.length > 0) {
                renderChart(chartLabels, chartValues, colors);
            } else {
                console.warn("Không có dữ liệu hợp lệ để vẽ biểu đồ");
            }

        } else {
            tbody.innerHTML = `<tr><td colspan="3" style="color:var(--danger-color); text-align:center; padding:20px;">Lỗi API: ${response.message}</td></tr>`;
        }
    } catch (e) {
        console.error("Lỗi loadTeamSummary:", e);
        tbody.innerHTML = `<tr><td colspan="3" style="color:var(--danger-color); text-align:center; padding:20px;">Lỗi kết nối: ${e.message}</td></tr>`;
    }
}

// --- UTILS: đọc màu thật từ CSS variable (canvas không hiểu var(--x) trực tiếp) ---
function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Bộ màu chart theo đúng palette Cream (gold/sage/terracotta...) thay vì rainbow mặc định
function chartPalette() {
    return [cssVar('--gold'), cssVar('--sage'), cssVar('--terracotta'), cssVar('--info-color'), cssVar('--gold-light'), cssVar('--text-secondary')];
}

// --- 5. HÀM VẼ BIỂU ĐỒ (CHART.JS) ---
let teamChartInstance = null;

function renderChart(labels, data, colors) {
    const canvas = document.getElementById('teamChart');
    if (!canvas) {
        console.warn("Không tìm thấy canvas #teamChart");
        return;
    }

    const ctx = canvas.getContext('2d');
    
    // Hủy biểu đồ cũ nếu đã tồn tại để vẽ mới
    if (teamChartInstance) {
        teamChartInstance.destroy();
    }

    teamChartInstance = new Chart(ctx, {
        type: 'doughnut', // 'pie' hoặc 'doughnut' nhìn hiện đại hơn
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: colors,
                borderWidth: 2,
                borderColor: cssVar('--card-bg'),
                hoverOffset: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false, // Để chart co giãn theo div cha
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        boxWidth: 12,
                        padding: 15,
                        font: { size: 11 },
                        color: cssVar('--text-primary')
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let value = context.raw;
                            // Format tiền Việt Nam
                            return ' ' + value.toLocaleString('vi-VN') + ' VND';
                        }
                    }
                },
                title: {
                    display: false,
                    text: 'Cơ Cấu Tài Sản Team'
                }
            }
        }
    });
}

// --- UTILS ---
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    const icon = type === 'success' ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-circle-exclamation"></i>';
    toast.innerHTML = `${icon} <span>${message}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}