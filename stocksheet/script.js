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

    const emptyState = document.getElementById('stock-empty-state');

    if (!symbol) {
        displayDiv.style.display = 'none';
        yearLabel.style.display = 'none';
        yearSelect.style.display = 'none';
        trendWrapper.style.display = 'none';
        if (emptyState) emptyState.style.display = 'flex';
        return;
    }

    if (emptyState) emptyState.style.display = 'none';
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

        if (response.status === 'success' && response.data && response.data.symbol) {
            renderStockDetail(response.data);
            showToast("Đã tải dữ liệu mã " + symbol, "success");
        } else {
            displayDiv.innerHTML = `<p style="color:var(--danger-color); text-align:center; padding:30px;">Chưa có dữ liệu định giá cho mã này.</p>`;
        }

        await loadTrendChart(symbol);
    } catch (e) {
        spinner.style.display = 'none';
        alert("Lỗi kết nối: " + e.message);
    }
}

// --- 3. VẼ GIAO DIỆN CHI TIẾT ĐỊNH GIÁ (stat card, không dùng bảng hàng-cột nữa) ---
function renderStockDetail(d) {
    d = d || {};
    const num = (v, digits) => (v === undefined || v === null || v === '') ? '--' : Number(v).toLocaleString('vi-VN', { maximumFractionDigits: digits !== undefined ? digits : 2 });

    document.getElementById('hero-symbol').textContent = d.symbol || '--';
    document.getElementById('hero-year').textContent = d.year ? `Năm ${d.year}` : '';
    document.getElementById('hero-price').textContent = num(d.price, 0);

    // Tách 2 nhóm — Quy mô & Lợi nhuận (3 ô) / Định giá (4 ô) — để mỗi hàng luôn chia hết, không lẻ dòng
    const scaleStats = [
        { icon: 'fa-building-columns', label: 'Vốn điều lệ', value: num(d.charter_capital, 0) },
        { icon: 'fa-scale-balanced', label: 'Vốn chủ sở hữu', value: num(d.equity, 0) },
        { icon: 'fa-sack-dollar', label: 'Lợi nhuận sau thuế', value: num(d.lnst, 0) }
    ];
    const valuationStats = [
        { icon: 'fa-book', label: 'Giá trị sổ sách', value: num(d.book_value) },
        { icon: 'fa-chart-line', label: 'EPS', value: num(d.eps) },
        { icon: 'fa-divide', label: 'P/E', value: num(d.pe) },
        { icon: 'fa-percent', label: 'P/B', value: num(d.pb) }
    ];
    const renderStatTiles = (stats) => stats.map(f => `
        <div class="stat-tile">
            <span class="stat-tile-icon"><i class="fa-solid ${f.icon}"></i></span>
            <span class="stat-tile-label">${f.label}</span>
            <span class="stat-tile-value">${f.value}</span>
        </div>`).join('');
    document.getElementById('fundamentals-grid-scale').innerHTML = renderStatTiles(scaleStats);
    document.getElementById('fundamentals-grid-valuation').innerHTML = renderStatTiles(valuationStats);

    const returnPe = Number(d.return_pe);
    const returnPb = Number(d.return_pb);
    document.getElementById('target-grid').innerHTML = `
        ${renderTargetCard('Theo P/E', d.target_pe, d.price_per_pe, returnPe, num)}
        ${renderTargetCard('Theo P/B', d.target_pb, d.price_per_pb, returnPb, num)}
    `;
}

function renderTargetCard(title, targetMultiple, priceTarget, returnPct, num) {
    const hasReturn = !isNaN(returnPct);
    const cls = !hasReturn ? '' : (returnPct > 0 ? 'pnl-up' : (returnPct < 0 ? 'pnl-down' : 'pnl-flat'));
    const icon = !hasReturn ? 'fa-minus' : (returnPct > 0 ? 'fa-arrow-up' : (returnPct < 0 ? 'fa-arrow-down' : 'fa-minus'));
    return `
        <div class="target-card">
            <div class="target-card-title">${title} <span class="target-multiple">(x${num(targetMultiple, 1)})</span></div>
            <div class="target-card-price">${num(priceTarget, 0)}</div>
            <div class="target-card-return"><span class="pnl-pill ${cls}"><i class="fa-solid ${icon}"></i>${hasReturn ? (returnPct > 0 ? '+' : '') + returnPct.toFixed(1) + '%' : '--'}</span></div>
        </div>`;
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
    // Đọc trên .asset-container (không phải <html>) vì bảng màu sáng cố định được khai báo trên
    // body/.asset-container — đọc từ <html> sẽ luôn ra giá trị theme tối cũ.
    const scope = document.querySelector('.asset-container') || document.documentElement;
    return getComputedStyle(scope).getPropertyValue(name).trim();
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