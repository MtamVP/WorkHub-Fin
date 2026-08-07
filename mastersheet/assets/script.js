/* --- FILE: /mastersheet/assets/script.js --- */

let userEmail = 'Khách';
let navChartInstance = null;
let allocationChartInstance = null;
const TAB_LOADED = { holdings: false, ledger: false, performance: false };
const ALLOCATION_COLOR_VARS = ['--series-1', '--series-2', '--series-3', '--series-4'];

document.addEventListener('DOMContentLoaded', async function () {
    userEmail = localStorage.getItem('userEmail') || 'Khách';
    const userDisplay = document.getElementById('user-display');
    if (userDisplay) userDisplay.innerHTML = `<i class="fa-solid fa-user"></i> ${userEmail}`;

    setupCashDebtListeners();
    await loadCashDebt();
    await loadKpis();
    await loadHoldings();

    const txnForm = document.getElementById('txn-form');
    if (txnForm) txnForm.addEventListener('submit', handleTxnSubmit);

    const dateInput = document.getElementById('txn-date');
    if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
});

// --- TAB SWITCHING ---
function switchAssetTab(tab) {
    ['holdings', 'ledger', 'performance'].forEach(t => {
        const panel = document.getElementById('tab-' + t);
        const btn = document.querySelector(`.view-toggle-btn[data-tab="${t}"]`);
        if (panel) panel.style.display = t === tab ? 'block' : 'none';
        if (btn) btn.classList.toggle('active', t === tab);
    });

    if (tab === 'ledger' && !TAB_LOADED.ledger) { loadLedger(); TAB_LOADED.ledger = true; }
    if (tab === 'performance' && !TAB_LOADED.performance) { loadPerformanceChart(); TAB_LOADED.performance = true; }
}

// --- TIỀN MẶT / DƯ NỢ ---
async function loadCashDebt() {
    try {
        const response = await callGAS('getCashDebt', { email: userEmail });
        const cd = response.data || { cash: 0, debt: 0 };
        const inpCash = document.getElementById('inp-cash');
        const inpDebt = document.getElementById('inp-debt');
        if (inpCash) inpCash.value = Number(cd.cash || 0).toLocaleString('en-US');
        if (inpDebt) inpDebt.value = Number(cd.debt || 0).toLocaleString('en-US');
    } catch (e) {
        console.error('Lỗi loadCashDebt:', e);
    }
}

function setupCashDebtListeners() {
    ['inp-cash', 'inp-debt'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', function (e) {
            let val = e.target.value.replace(/,/g, '').replace(/[^0-9.]/g, '');
            e.target.value = val ? parseFloat(val).toLocaleString('en-US') : '';
        });
        el.addEventListener('change', async function () {
            const cash = parseMoney(document.getElementById('inp-cash').value);
            const debt = parseMoney(document.getElementById('inp-debt').value);
            try {
                await callGAS('setCashDebt', { email: userEmail, cash, debt });
                showToast('Đã cập nhật tiền mặt/dư nợ', 'success');
                await loadKpis();
                if (TAB_LOADED.performance) loadPerformanceChart();
            } catch (err) {
                showToast('Lỗi: ' + err.message, 'error');
            }
        });
    });
}

// --- KPI ---
async function loadKpis() {
    try {
        const response = await callGAS('getAssetSummaryKpis', { email: userEmail });
        const k = response.data || {};
        setKpi('kpi-nav', k.nav, true);
        setKpi('kpi-unrealized', k.unrealizedPnl, true, true);
        setKpi('kpi-realized', k.realizedPnl, true, true);
        setKpi('kpi-market-value', k.marketValue, true);
    } catch (e) {
        console.error('Lỗi loadKpis:', e);
    }
}

function setKpi(id, value, isMoney, colorByValue) {
    const el = document.getElementById(id);
    if (!el) return;
    const num = Number(value) || 0;
    el.textContent = (isMoney ? formatVnd(num) : num);
    el.classList.remove('text-success', 'text-danger');
    const card = document.getElementById('kpi-card-' + id.replace('kpi-', ''));
    if (card) card.classList.remove('kpi-positive', 'kpi-negative');
    if (colorByValue) {
        if (num > 0) { el.classList.add('text-success'); if (card) card.classList.add('kpi-positive'); }
        else if (num < 0) { el.classList.add('text-danger'); if (card) card.classList.add('kpi-negative'); }
    }
}

// --- DANH MỤC (holdings, computed từ sổ lệnh) ---
async function loadHoldings() {
    const tbody = document.getElementById('holdings-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải...</td></tr>';

    try {
        const response = await callGAS('getHoldingsView', { email: userEmail });
        const holdings = response.data || [];

        if (holdings.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fa-solid fa-layer-group"></i>Chưa có danh mục nào — thêm lệnh mua ở tab "Sổ Lệnh".</td></tr>';
            renderAllocationChart([]);
            return;
        }

        tbody.innerHTML = holdings.map((h, idx) => {
            const dotColor = allocationColorFor(idx);
            const pnl = renderPnlPill(h.unrealizedPnl, h.unrealizedPct);
            return `
                <tr>
                    <td><span class="symbol-cell"><span class="symbol-dot" style="background:${dotColor};"></span><span class="symbol-name">${escapeAssetHtml(h.symbol)}</span></span></td>
                    <td class="text-right">${Number(h.quantity).toLocaleString('en-US')}</td>
                    <td class="text-right">${Number(h.avgCost).toLocaleString('en-US')}</td>
                    <td class="text-right">
                        <input type="text" class="price-input" data-symbol="${escapeAssetHtml(h.symbol)}"
                            value="${Number(h.marketPrice).toLocaleString('en-US')}"
                            onchange="handleMarketPriceChange(this)">
                    </td>
                    <td class="text-right">${Number(h.costValue).toLocaleString('en-US')}</td>
                    <td class="text-right">${Number(h.marketValue).toLocaleString('en-US')}</td>
                    <td class="text-right">${pnl}</td>
                </tr>`;
        }).join('');

        renderAllocationChart(holdings);
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-state text-danger">Lỗi: ${e.message}</td></tr>`;
    }
}

function renderPnlPill(pnl, pct) {
    const num = Number(pnl) || 0;
    const cls = num > 0 ? 'pnl-up' : (num < 0 ? 'pnl-down' : 'pnl-flat');
    const icon = num > 0 ? 'fa-arrow-up' : (num < 0 ? 'fa-arrow-down' : 'fa-minus');
    return `<span class="pnl-pill ${cls}"><i class="fa-solid ${icon}"></i>${num.toLocaleString('en-US')} (${(Number(pct) || 0).toFixed(1)}%)</span>`;
}

function allocationColorFor(idx) {
    if (idx < ALLOCATION_COLOR_VARS.length) return cssVar(ALLOCATION_COLOR_VARS[idx]);
    return cssVar('--series-other');
}

// --- CƠ CẤU DANH MỤC (donut theo % giá trị thị trường) ---
function renderAllocationChart(holdings) {
    const canvas = document.getElementById('allocationChart');
    const legendBox = document.getElementById('allocation-legend');
    if (!canvas || !legendBox) return;
    if (allocationChartInstance) { allocationChartInstance.destroy(); allocationChartInstance = null; }

    const withValue = (holdings || []).filter(h => h.marketValue > 0);
    if (withValue.length === 0) {
        canvas.style.display = 'none';
        legendBox.innerHTML = '<div class="allocation-empty"><i class="fa-solid fa-chart-pie" style="display:block; font-size:1.6rem; margin-bottom:8px; opacity:.4;"></i>Chưa có dữ liệu để vẽ cơ cấu.</div>';
        return;
    }
    canvas.style.display = 'block';

    // Gộp các mã ngoài top 4 vào "Khác" — giữ chart dễ đọc, không sinh thêm hue mới (đúng nguyên tắc categorical palette)
    const sorted = [...withValue].sort((a, b) => b.marketValue - a.marketValue);
    const top = sorted.slice(0, 4);
    const rest = sorted.slice(4);
    const restTotal = rest.reduce((s, h) => s + h.marketValue, 0);

    const labels = top.map(h => h.symbol);
    const values = top.map(h => h.marketValue);
    const colors = top.map((_, i) => allocationColorFor(i));
    if (restTotal > 0) {
        labels.push('Khác');
        values.push(restTotal);
        colors.push(cssVar('--series-other'));
    }

    const total = values.reduce((s, v) => s + v, 0);

    const ctx = canvas.getContext('2d');
    allocationChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: cssVar('--card-bg'), hoverOffset: 6 }] },
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
            <span class="allocation-legend-pct">${((values[i] / total) * 100).toFixed(1)}%</span>
        </div>`).join('');
}

async function handleMarketPriceChange(input) {
    const symbol = input.dataset.symbol;
    const price = parseMoney(input.value);
    input.value = price.toLocaleString('en-US');
    try {
        await callGAS('setMarketPrice', { email: userEmail, symbol, price });
        showToast(`Đã cập nhật giá TT của ${symbol}`, 'success');
        await loadHoldings();
        await loadKpis();
        if (TAB_LOADED.performance) loadPerformanceChart();
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
    }
}

// --- SỔ LỆNH ---
async function loadLedger() {
    const tbody = document.getElementById('ledger-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải...</td></tr>';

    try {
        const response = await callGAS('listAssetTransactions', { email: userEmail });
        const txns = response.data || [];

        if (txns.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><i class="fa-solid fa-receipt"></i>Chưa có lệnh giao dịch nào.</td></tr>';
            return;
        }

        tbody.innerHTML = txns.map(t => {
            const typeLabel = t.type === 'buy'
                ? '<span class="txn-type-badge buy"><i class="fa-solid fa-arrow-down"></i>Mua</span>'
                : '<span class="txn-type-badge sell"><i class="fa-solid fa-arrow-up"></i>Bán</span>';
            const pnlCell = t.realized_pnl === null || t.realized_pnl === undefined
                ? '<span style="color:var(--text-muted);">—</span>'
                : renderPnlPill(t.realized_pnl, 0).replace(/\s\(0\.0%\)/, '');
            return `
                <tr>
                    <td>${t.trade_date}</td>
                    <td>${typeLabel}</td>
                    <td class="text-bold">${escapeAssetHtml(t.symbol)}</td>
                    <td class="text-right">${Number(t.quantity).toLocaleString('en-US')}</td>
                    <td class="text-right">${Number(t.price).toLocaleString('en-US')}</td>
                    <td class="text-right">${Number(t.fee || 0).toLocaleString('en-US')}</td>
                    <td class="text-right">${pnlCell}</td>
                    <td>${escapeAssetHtml(t.note || '')}</td>
                    <td><button class="icon-btn danger" title="Xóa" onclick="deleteTxn('${t.id}')"><i class="fa-solid fa-trash"></i></button></td>
                </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty-state text-danger">Lỗi: ${e.message}</td></tr>`;
    }
}

async function handleTxnSubmit(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const originalHtml = btn.innerHTML;

    const txn = {
        type: document.getElementById('txn-type').value,
        symbol: document.getElementById('txn-symbol').value,
        quantity: document.getElementById('txn-quantity').value,
        price: document.getElementById('txn-price').value,
        fee: document.getElementById('txn-fee').value || 0,
        tradeDate: document.getElementById('txn-date').value,
        note: document.getElementById('txn-note').value
    };

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...';

    try {
        const response = await callGAS('addAssetTransaction', { email: userEmail, txn });
        if (response.status === 'success') {
            showToast(response.message, 'success');
            e.target.reset();
            document.getElementById('txn-date').value = new Date().toISOString().slice(0, 10);
            await loadLedger();
            await loadHoldings();
            await loadKpis();
            if (TAB_LOADED.performance) loadPerformanceChart();
        } else {
            showToast('Lỗi: ' + response.message, 'error');
        }
    } catch (err) {
        showToast('Lỗi: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

async function deleteTxn(id) {
    if (!confirm('Xóa lệnh giao dịch này? Khối lượng/giá vốn của danh mục sẽ được tính lại.')) return;
    try {
        const response = await callGAS('deleteAssetTransaction', { email: userEmail, id });
        showToast(response.message, 'success');
        await loadLedger();
        await loadHoldings();
        await loadKpis();
        if (TAB_LOADED.performance) loadPerformanceChart();
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
    }
}

// --- HIỆU SUẤT (NAV chart) ---
async function loadPerformanceChart() {
    try {
        const response = await callGAS('getNavHistory', { email: userEmail });
        const history = response.data || [];
        renderNavChart(history);
        renderPerfStats(history);
    } catch (e) {
        console.error('Lỗi loadPerformanceChart:', e);
    }
}

function renderPerfStats(history) {
    const returnEl = document.getElementById('perf-total-return');
    const pctEl = document.getElementById('perf-total-return-pct');
    if (!returnEl || !pctEl) return;

    if (!history || history.length < 2) {
        returnEl.textContent = '--';
        pctEl.textContent = '--';
        return;
    }

    const first = Number(history[0].nav) || 0;
    const last = Number(history[history.length - 1].nav) || 0;
    const diff = last - first;
    const pct = first !== 0 ? (diff / first) * 100 : 0;

    returnEl.textContent = formatVnd(diff);
    returnEl.classList.toggle('text-success', diff > 0);
    returnEl.classList.toggle('text-danger', diff < 0);
    pctEl.textContent = (pct > 0 ? '+' : '') + pct.toFixed(2) + '%';
    pctEl.classList.toggle('text-success', pct > 0);
    pctEl.classList.toggle('text-danger', pct < 0);
}

function renderNavChart(history) {
    const box = document.getElementById('nav-chart-box');
    if (!box) return;
    if (navChartInstance) { navChartInstance.destroy(); navChartInstance = null; }

    if (!history || history.length === 0) {
        box.innerHTML = '<div class="perf-chart-empty"><i class="fa-solid fa-chart-area"></i>Chưa có dữ liệu NAV — lưu tiền mặt/dư nợ hoặc thêm lệnh giao dịch để bắt đầu ghi nhận.</div>';
        return;
    }

    // Nếu lần trước rơi vào trạng thái rỗng, canvas đã bị thay bằng .perf-chart-empty — phục hồi lại canvas trước khi vẽ
    if (!document.getElementById('navChart')) {
        box.innerHTML = '<canvas id="navChart"></canvas>';
    }
    const canvas = document.getElementById('navChart');
    const ctx = canvas.getContext('2d');

    navChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: history.map(h => h.snapshot_date),
            datasets: [{
                label: 'NAV',
                data: history.map(h => Number(h.nav) || 0),
                borderColor: cssVar('--finance-accent'),
                backgroundColor: 'color-mix(in srgb, var(--finance-accent) 18%, transparent)',
                fill: true,
                tension: 0.3,
                pointRadius: history.length > 30 ? 0 : 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => ' ' + ctx.raw.toLocaleString('vi-VN') + ' VND'
                    }
                }
            },
            scales: {
                x: { ticks: { color: cssVar('--text-secondary') }, grid: { color: cssVar('--border-color') } },
                y: {
                    ticks: {
                        color: cssVar('--text-secondary'),
                        callback: (val) => Number(val).toLocaleString('vi-VN')
                    },
                    grid: { color: cssVar('--border-color') }
                }
            }
        }
    });
}

// --- UTILS ---
function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function formatVnd(num) {
    return Number(num).toLocaleString('vi-VN') + ' ₫';
}

function parseMoney(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    return parseFloat(value.toString().replace(/,/g, '')) || 0;
}

function escapeAssetHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function showToast(message, type = 'success') {
    const existing = document.querySelector('.toast-notification');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    const icon = type === 'success' ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-circle-exclamation"></i>';
    toast.innerHTML = `${icon} <span>${message}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}
