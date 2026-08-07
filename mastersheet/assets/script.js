/* --- FILE: /mastersheet/assets/script.js --- */

let userEmail = 'Khách';
let navChartInstance = null;
const TAB_LOADED = { holdings: false, ledger: false, performance: false };

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
    if (colorByValue) {
        if (num > 0) el.classList.add('text-success');
        else if (num < 0) el.classList.add('text-danger');
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
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Chưa có danh mục nào — thêm lệnh mua ở tab "Sổ Lệnh".</td></tr>';
            return;
        }

        tbody.innerHTML = holdings.map(h => {
            const pnlClass = h.unrealizedPnl > 0 ? 'text-success' : (h.unrealizedPnl < 0 ? 'text-danger' : '');
            return `
                <tr>
                    <td class="text-bold">${escapeAssetHtml(h.symbol)}</td>
                    <td class="text-right">${Number(h.quantity).toLocaleString('en-US')}</td>
                    <td class="text-right">${Number(h.avgCost).toLocaleString('en-US')}</td>
                    <td class="text-right">
                        <input type="text" class="price-input" data-symbol="${escapeAssetHtml(h.symbol)}"
                            value="${Number(h.marketPrice).toLocaleString('en-US')}"
                            onchange="handleMarketPriceChange(this)">
                    </td>
                    <td class="text-right">${Number(h.costValue).toLocaleString('en-US')}</td>
                    <td class="text-right">${Number(h.marketValue).toLocaleString('en-US')}</td>
                    <td class="text-right ${pnlClass}">${Number(h.unrealizedPnl).toLocaleString('en-US')} (${h.unrealizedPct.toFixed(1)}%)</td>
                </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-state text-danger">Lỗi: ${e.message}</td></tr>`;
    }
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
            tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Chưa có lệnh giao dịch nào.</td></tr>';
            return;
        }

        tbody.innerHTML = txns.map(t => {
            const typeLabel = t.type === 'buy' ? '<span class="txn-type-badge buy">Mua</span>' : '<span class="txn-type-badge sell">Bán</span>';
            const pnlCell = t.realized_pnl === null || t.realized_pnl === undefined
                ? ''
                : `<span class="${t.realized_pnl > 0 ? 'text-success' : (t.realized_pnl < 0 ? 'text-danger' : '')}">${Number(t.realized_pnl).toLocaleString('en-US')}</span>`;
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
    } catch (e) {
        console.error('Lỗi loadPerformanceChart:', e);
    }
}

function renderNavChart(history) {
    const canvas = document.getElementById('navChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (navChartInstance) navChartInstance.destroy();

    if (!history || history.length === 0) {
        return;
    }

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
