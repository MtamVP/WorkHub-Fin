/* --- FILE: /mastersheet/script.js --- */

const ALLOCATION_COLOR_VARS = ['--series-1', '--series-2', '--series-3', '--series-4'];

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
        // Header Email
        if (index === 0) {
            html += `<tr class="table-email-row"><td colspan="10">${escapeAssetHtml(row[0])}</td></tr>`;
            return;
        }

        // Header Cột
        let rowClass = '';
        if (index === 1) rowClass = 'table-header-row';

        // Highlight các dòng Tổng/NAV
        let firstCell = (row[1] || "").toString().toLowerCase();
        if (firstCell.includes('tổng') || firstCell.includes('tiền') || firstCell.includes('nav') || firstCell.includes('dư nợ')) {
            rowClass = 'table-highlight-row' + (firstCell.includes('nav') ? ' table-nav-row' : '');
        }

        html += `<tr class="${rowClass}">`;

        row.forEach((cell, cellIndex) => {
            let alignClass = cellIndex === 0 ? 'text-center' : (cellIndex >= 2 ? 'text-right' : '');

            // Tô màu Lãi/Lỗ
            let colorClass = '';
            if (cellIndex === 9 && index > 1) {
                let valNum = parseFloat(cell.toString().replace(/,/g, '').replace(/\./g, '').replace(/[^\d-]/g, ''));
                if (valNum > 0) colorClass = 'text-success';
                if (valNum < 0) colorClass = 'text-danger';
            }

            html += `<td class="${alignClass} ${colorClass}">${escapeAssetHtml(cell)}</td>`;
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

    tbody.innerHTML = '<tr><td colspan="3" class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải dữ liệu tổng hợp...</td></tr>';
    
    try {
        console.log("Calling getTeamSummary...");
        const response = await callGAS('getTeamSummary');
        console.log("Team Data Response:", response); // [DEBUG] Xem kết quả trả về

        if (response.status === 'success') {
            const data = response.data; 
            
            if (!data || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Chưa có dữ liệu tổng hợp trong MasterSheet.</td></tr>';
                renderChart([], [], []);
                return;
            }

            // A. CẬP NHẬT KPI TEAM
            const kpiCount = document.getElementById('team-kpi-count');
            const kpiNav = document.getElementById('team-kpi-nav');
            const memberRows = data.filter(item => !(item.name || '').toUpperCase().includes('TỔNG'));
            const totalRow = data.find(item => (item.name || '').toUpperCase().includes('TỔNG'));
            if (kpiCount) kpiCount.textContent = memberRows.length;
            if (kpiNav) kpiNav.textContent = (totalRow ? totalRow.nav : '0') + ' ₫';

            // B. Gán màu cho từng thành viên (chỉ những người có NAV dương mới vào biểu đồ) —
            // dùng chung index để chấm màu trong bảng khớp đúng với lát cắt trên biểu đồ.
            const chartMembers = memberRows
                .map(item => ({
                    name: item.name || 'Unknown',
                    navNum: parseFloat((item.nav || '0').toString().replace(/[^0-9-]/g, '')) || 0
                }))
                .filter(m => m.navNum > 0);
            const colorByName = {};
            chartMembers.forEach((m, i) => { colorByName[m.name] = allocationColorFor(i); });

            // C. VẼ BẢNG
            let html = '';
            data.forEach(item => {
                let name = item.name || "Unknown";
                let navStr = item.nav || "0";
                let percentStr = item.percent || "0%";

                if (name.toUpperCase().includes('TỔNG')) {
                    html += `<tr class="table-total-row"><td>${escapeAssetHtml(name)}</td><td class="text-right">${escapeAssetHtml(navStr)}</td><td class="text-center">${escapeAssetHtml(percentStr)}</td></tr>`;
                } else {
                    const dotColor = colorByName[name] || cssVar('--border-color');
                    html += `<tr>
                        <td><span class="symbol-cell"><span class="symbol-dot" style="background:${dotColor};"></span><span class="symbol-name">${escapeAssetHtml(name)}</span></span></td>
                        <td class="text-right">${escapeAssetHtml(navStr)}</td>
                        <td class="text-center">${escapeAssetHtml(percentStr)}</td>
                    </tr>`;
                }
            });
            tbody.innerHTML = html;

            // D. VẼ BIỂU ĐỒ TRÒN + LEGEND
            renderChart(
                chartMembers.map(m => m.name.split('@')[0]),
                chartMembers.map(m => m.navNum),
                chartMembers.map((m, i) => allocationColorFor(i))
            );

        } else {
            tbody.innerHTML = `<tr><td colspan="3" class="empty-state text-danger">Lỗi API: ${escapeAssetHtml(response.message)}</td></tr>`;
        }
    } catch (e) {
        console.error("Lỗi loadTeamSummary:", e);
        tbody.innerHTML = `<tr><td colspan="3" class="empty-state text-danger">Lỗi kết nối: ${escapeAssetHtml(e.message)}</td></tr>`;
    }
}

// --- UTILS: đọc màu thật từ CSS variable (canvas không hiểu var(--x) trực tiếp) ---
function cssVar(name) {
    // Đọc trên .asset-container (không phải <html>) vì bảng màu sáng cố định và bảng màu category
    // được khai báo trên body/.asset-container — đọc từ <html> sẽ luôn ra giá trị theme tối cũ.
    const scope = document.querySelector('.asset-container') || document.documentElement;
    return getComputedStyle(scope).getPropertyValue(name).trim();
}

// Màu chart lấy từ bộ categorical palette đã validate (--series-1..4 + --series-other), cùng bộ với trang Nhập liệu
function allocationColorFor(idx) {
    if (idx < ALLOCATION_COLOR_VARS.length) return cssVar(ALLOCATION_COLOR_VARS[idx]);
    return cssVar('--series-other');
}

// --- 5. HÀM VẼ BIỂU ĐỒ (CHART.JS) + LEGEND — cùng bố cục với Cơ Cấu Danh Mục ở trang Nhập liệu ---
let teamChartInstance = null;

function renderChart(labels, data, colors) {
    const canvas = document.getElementById('teamChart');
    const legendBox = document.getElementById('team-legend');
    if (!canvas || !legendBox) return;
    if (teamChartInstance) { teamChartInstance.destroy(); teamChartInstance = null; }

    if (!data || data.length === 0) {
        canvas.style.display = 'none';
        legendBox.innerHTML = '<div class="allocation-empty"><i class="fa-solid fa-chart-pie" style="display:block; font-size:1.6rem; margin-bottom:8px; opacity:.4;"></i>Chưa có dữ liệu để vẽ cơ cấu.</div>';
        return;
    }
    canvas.style.display = 'block';

    const total = data.reduce((s, v) => s + v, 0);
    const ctx = canvas.getContext('2d');

    teamChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: colors,
                borderWidth: 2,
                borderColor: cssVar('--card-bg'),
                hoverOffset: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => ` ${ctx.label}: ${ctx.raw.toLocaleString('vi-VN')} ₫ (${((ctx.raw / total) * 100).toFixed(1)}%)`
                    }
                }
            }
        }
    });

    legendBox.innerHTML = labels.map((label, i) => `
        <div class="allocation-legend-item">
            <span class="allocation-legend-dot" style="background:${colors[i]};"></span>
            <span class="allocation-legend-name">${escapeAssetHtml(label)}</span>
            <span class="allocation-legend-pct">${((data[i] / total) * 100).toFixed(1)}%</span>
        </div>`).join('');
}

// --- UTILS ---
function escapeAssetHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    const icon = type === 'success' ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-circle-exclamation"></i>';
    toast.innerHTML = `${icon} <span>${message}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}