/* --- FILE: /mastersheet/assets/script.js --- */

let userEmail = 'Khách';
// targetEmail = tài khoản đang được xem/chỉnh sửa dữ liệu — mặc định là chính mình,
// chỉ đổi được nếu userEmail có vai trò 'asset_manager' (xem /roles/).
let targetEmail = 'Khách';
let isAssetManager = false;
let navChartInstance = null;
let allocationChartInstance = null;
let benchmarkChartInstance = null;
const TAB_LOADED = { holdings: false, ledger: false, performance: false };
const LEDGER_SUB_LOADED = { cashflow: false, corporate: false };
const ALLOCATION_COLOR_VARS = ['--series-1', '--series-2', '--series-3', '--series-4'];

document.addEventListener('DOMContentLoaded', async function () {
    userEmail = localStorage.getItem('userEmail') || 'Khách';
    targetEmail = userEmail;
    const userDisplay = document.getElementById('user-display');
    if (userDisplay) userDisplay.innerHTML = `<i class="fa-solid fa-user"></i> ${userEmail}`;

    let canManageReferenceData = false;
    try {
        const rolesResp = await callGAS('getMyFinRoles', { email: userEmail });
        const myRoles = rolesResp.data || [];
        // platform_lead/chief_assistant là vai trò toàn quyền — DB (current_user_has_fin_role) đã coi
        // họ như có mọi vai trò, nên UI cũng phải mở khóa các khung dành cho asset_manager tương ứng.
        isAssetManager = myRoles.includes('asset_manager') || myRoles.includes('platform_lead') || myRoles.includes('chief_assistant');
        // executive_member chỉ được quản trị dữ liệu tham chiếu (giá VN-Index), không có toàn quyền asset_manager
        canManageReferenceData = isAssetManager || myRoles.includes('executive_member');
    } catch (e) {
        console.error('Lỗi getMyFinRoles:', e);
    }
    await setupTargetUserSwitcher();

    const benchmarkPanel = document.getElementById('benchmark-admin-panel');
    if (benchmarkPanel && canManageReferenceData) benchmarkPanel.style.display = 'block';

    setupCashDebtListeners();
    await loadCashDebt();
    await loadKpis();
    await loadHoldings();

    const txnForm = document.getElementById('txn-form');
    if (txnForm) txnForm.addEventListener('submit', handleTxnSubmit);
    const cashflowForm = document.getElementById('cashflow-form');
    if (cashflowForm) cashflowForm.addEventListener('submit', handleCashFlowSubmit);
    const corpActionForm = document.getElementById('corpaction-form');
    if (corpActionForm) corpActionForm.addEventListener('submit', handleCorpActionSubmit);
    const benchmarkForm = document.getElementById('benchmark-form');
    if (benchmarkForm) benchmarkForm.addEventListener('submit', handleBenchmarkSubmit);

    const today = new Date().toISOString().slice(0, 10);
    ['txn-date', 'cf-date', 'ca-date', 'bm-date'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = today;
    });
});

// --- ĐANG CHỈNH SỬA DỮ LIỆU CỦA AI (chỉ hiện với vai trò asset_manager) ---
async function setupTargetUserSwitcher() {
    const wrap = document.getElementById('target-user-switcher');
    const select = document.getElementById('target-user-select');
    if (!wrap || !select || !isAssetManager) return;

    try {
        const membersResp = await callGAS('getMemberList');
        const members = membersResp.data || [];
        select.innerHTML = members.map(email =>
            `<option value="${escapeAssetHtml(email)}" ${email === userEmail ? 'selected' : ''}>${escapeAssetHtml(email)}${email === userEmail ? ' (Tôi)' : ''}</option>`
        ).join('');
        wrap.style.display = 'flex';
        select.addEventListener('change', async () => {
            targetEmail = select.value;
            TAB_LOADED.ledger = false; TAB_LOADED.performance = false;
            switchAssetTab('holdings');
            await loadCashDebt();
            await loadKpis();
            await loadHoldings();
        });
    } catch (e) {
        console.error('Lỗi getMemberList:', e);
    }
}

// --- TAB SWITCHING ---
function switchAssetTab(tab) {
    ['holdings', 'ledger', 'performance'].forEach(t => {
        const panel = document.getElementById('tab-' + t);
        const btn = document.querySelector(`.view-toggle-btn[data-tab="${t}"]`);
        if (panel) panel.style.display = t === tab ? 'block' : 'none';
        if (btn) btn.classList.toggle('active', t === tab);
    });

    if (tab === 'ledger' && !TAB_LOADED.ledger) { loadLedger(); TAB_LOADED.ledger = true; }
    if (tab === 'performance' && !TAB_LOADED.performance) { loadPerformanceChart(); loadPerformanceMetrics(); TAB_LOADED.performance = true; }
}

// --- SỔ LỆNH: chuyển sub-tab (Giao Dịch CP / Dòng Tiền / Hành Động DN) ---
function switchLedgerSubTab(sub) {
    ['trades', 'cashflow', 'corporate'].forEach(t => {
        const panel = document.getElementById('ledger-sub-' + t);
        const btn = document.querySelector(`.ledger-sub-toggle .view-toggle-btn[data-subtab="${t}"]`);
        if (panel) panel.style.display = t === sub ? 'block' : 'none';
        if (btn) btn.classList.toggle('active', t === sub);
    });
    if (sub === 'cashflow' && !LEDGER_SUB_LOADED.cashflow) { loadCashFlows(); LEDGER_SUB_LOADED.cashflow = true; }
    if (sub === 'corporate' && !LEDGER_SUB_LOADED.corporate) { loadCorporateActions(); LEDGER_SUB_LOADED.corporate = true; }
}

// --- TIỀN MẶT / DƯ NỢ ---
async function loadCashDebt() {
    try {
        const response = await callGAS('getCashDebt', { email: targetEmail });
        const cd = response.data || { cash: 0, debt: 0 };
        const inpCash = document.getElementById('inp-cash');
        const inpDebt = document.getElementById('inp-debt');
        if (inpCash) inpCash.value = Number(cd.cash || 0).toLocaleString('en-US');
        if (inpDebt) inpDebt.value = Number(cd.debt || 0).toLocaleString('en-US');
        updateNetCapital(Number(cd.cash || 0), Number(cd.debt || 0));
    } catch (e) {
        console.error('Lỗi loadCashDebt:', e);
    }
}

function updateNetCapital(cash, debt) {
    const el = document.getElementById('disp-net-capital');
    if (!el) return;
    const net = (Number(cash) || 0) - (Number(debt) || 0);
    el.textContent = formatVnd(net);
    el.classList.remove('text-success', 'text-danger');
    el.classList.add(net >= 0 ? 'text-success' : 'text-danger');
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
            updateNetCapital(cash, debt);
            try {
                await callGAS('setCashDebt', { email: targetEmail, cash, debt });
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
        const response = await callGAS('getAssetSummaryKpis', { email: targetEmail });
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
        const response = await callGAS('getHoldingsView', { email: targetEmail });
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
        await callGAS('setMarketPrice', { email: targetEmail, symbol, price });
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
        const response = await callGAS('listAssetTransactions', { email: targetEmail });
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
        const response = await callGAS('addAssetTransaction', { email: targetEmail, txn });
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
        const response = await callGAS('deleteAssetTransaction', { email: targetEmail, id });
        showToast(response.message, 'success');
        await loadLedger();
        await loadHoldings();
        await loadKpis();
        if (TAB_LOADED.performance) loadPerformanceChart();
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
    }
}

// --- DÒNG TIỀN (nạp vốn / rút vốn / cổ tức) — tách khỏi lãi/lỗ đầu tư ---
const CASH_FLOW_LABELS = {
    deposit: '<span class="txn-type-badge buy"><i class="fa-solid fa-arrow-down"></i>Nạp vốn</span>',
    withdrawal: '<span class="txn-type-badge sell"><i class="fa-solid fa-arrow-up"></i>Rút vốn</span>',
    dividend: '<span class="txn-type-badge buy"><i class="fa-solid fa-coins"></i>Cổ tức</span>'
};

function toggleCashFlowSymbolField() {
    const type = document.getElementById('cf-type').value;
    const field = document.getElementById('cf-symbol-field');
    if (field) field.style.display = type === 'dividend' ? 'flex' : 'none';
}

async function loadCashFlows() {
    const tbody = document.getElementById('cashflow-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải...</td></tr>';
    try {
        const response = await callGAS('listCashFlows', { email: targetEmail });
        const flows = response.data || [];
        if (flows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><i class="fa-solid fa-money-bill-transfer"></i>Chưa có dòng tiền nào.</td></tr>';
            return;
        }
        tbody.innerHTML = flows.map(f => `
            <tr>
                <td>${f.flow_date}</td>
                <td>${CASH_FLOW_LABELS[f.flow_type] || f.flow_type}</td>
                <td class="text-bold">${escapeAssetHtml(f.symbol || '—')}</td>
                <td class="text-right">${formatVnd(Number(f.amount))}</td>
                <td>${escapeAssetHtml(f.note || '')}</td>
                <td><button class="icon-btn danger" title="Xóa" onclick="deleteCashFlowRow('${f.id}')"><i class="fa-solid fa-trash"></i></button></td>
            </tr>`).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state text-danger">Lỗi: ${e.message}</td></tr>`;
    }
}

async function handleCashFlowSubmit(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const originalHtml = btn.innerHTML;
    const flow = {
        flowType: document.getElementById('cf-type').value,
        amount: document.getElementById('cf-amount').value,
        symbol: document.getElementById('cf-symbol').value,
        flowDate: document.getElementById('cf-date').value,
        note: document.getElementById('cf-note').value
    };
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...';
    try {
        const response = await callGAS('addCashFlow', { email: targetEmail, flow });
        if (response.status === 'success') {
            showToast(response.message, 'success');
            e.target.reset();
            document.getElementById('cf-date').value = new Date().toISOString().slice(0, 10);
            toggleCashFlowSymbolField();
            await loadCashFlows();
            await loadCashDebt();
            await loadKpis();
            if (TAB_LOADED.performance) { loadPerformanceChart(); loadPerformanceMetrics(); }
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

async function deleteCashFlowRow(id) {
    if (!confirm('Xóa dòng tiền này? Số dư tiền mặt sẽ được hoàn tác tương ứng.')) return;
    try {
        const response = await callGAS('deleteCashFlow', { email: targetEmail, id });
        showToast(response.message, 'success');
        await loadCashFlows();
        await loadCashDebt();
        await loadKpis();
        if (TAB_LOADED.performance) { loadPerformanceChart(); loadPerformanceMetrics(); }
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
    }
}

// --- HÀNH ĐỘNG DOANH NGHIỆP (tách/gộp cổ phiếu, cổ tức cổ phiếu) — điều chỉnh FIFO hồi tố ---
const CORP_ACTION_LABELS = { split: 'Tách/gộp CP', stock_dividend: 'Cổ tức CP' };

function toggleCorpActionRatioLabel() {
    const type = document.getElementById('ca-type').value;
    const label = document.getElementById('ca-ratio-label');
    if (!label) return;
    label.textContent = type === 'stock_dividend'
        ? 'Tỷ lệ thập phân (vd thưởng 10% → nhập 0.1)'
        : 'Tỷ lệ mới/cũ (vd tách 1:2 → nhập 2)';
}

async function loadCorporateActions() {
    const tbody = document.getElementById('corpaction-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải...</td></tr>';
    try {
        const response = await callGAS('listCorporateActions', { email: targetEmail });
        const actions = response.data || [];
        if (actions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><i class="fa-solid fa-building-columns"></i>Chưa có hành động doanh nghiệp nào.</td></tr>';
            return;
        }
        tbody.innerHTML = actions.map(a => `
            <tr>
                <td>${a.ex_date}</td>
                <td class="text-bold">${escapeAssetHtml(a.symbol)}</td>
                <td>${CORP_ACTION_LABELS[a.action_type] || a.action_type}</td>
                <td class="text-right">${a.action_type === 'stock_dividend' ? (Number(a.ratio) * 100).toFixed(1) + '%' : Number(a.ratio).toLocaleString('en-US')}</td>
                <td>${escapeAssetHtml(a.note || '')}</td>
                <td><button class="icon-btn danger" title="Xóa" onclick="deleteCorpActionRow('${a.id}')"><i class="fa-solid fa-trash"></i></button></td>
            </tr>`).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state text-danger">Lỗi: ${e.message}</td></tr>`;
    }
}

async function handleCorpActionSubmit(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const originalHtml = btn.innerHTML;
    const action = {
        symbol: document.getElementById('ca-symbol').value,
        actionType: document.getElementById('ca-type').value,
        ratio: document.getElementById('ca-ratio').value,
        exDate: document.getElementById('ca-date').value,
        note: document.getElementById('ca-note').value
    };
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...';
    try {
        const response = await callGAS('addCorporateAction', { email: targetEmail, action });
        if (response.status === 'success') {
            showToast(response.message, 'success');
            e.target.reset();
            document.getElementById('ca-date').value = new Date().toISOString().slice(0, 10);
            toggleCorpActionRatioLabel();
            await loadCorporateActions();
            await loadHoldings();
            await loadKpis();
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

async function deleteCorpActionRow(id) {
    if (!confirm('Xóa hành động doanh nghiệp này? Khối lượng/giá vốn FIFO sẽ được tính lại.')) return;
    try {
        const response = await callGAS('deleteCorporateAction', { email: targetEmail, id });
        showToast(response.message, 'success');
        await loadCorporateActions();
        await loadHoldings();
        await loadKpis();
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
    }
}

async function handleBenchmarkSubmit(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...';
    try {
        const priceDate = document.getElementById('bm-date').value;
        const closeValue = document.getElementById('bm-value').value;
        const response = await callGAS('upsertBenchmarkPrice', { email: targetEmail, indexCode: 'VNINDEX', priceDate, closeValue });
        if (response.status === 'success') {
            showToast(response.message, 'success');
            document.getElementById('bm-value').value = '';
            if (TAB_LOADED.performance) loadPerformanceMetrics();
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

// --- HIỆU SUẤT (NAV chart) ---
async function loadPerformanceChart() {
    try {
        const response = await callGAS('getNavHistory', { email: targetEmail });
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

// --- RỦI RO & HIỆU SUẤT (Sharpe, Max Drawdown, biến động, so sánh VN-Index) ---
async function loadPerformanceMetrics() {
    try {
        const response = await callGAS('getPerformanceMetrics', { email: targetEmail });
        const m = response.data || {};

        const sharpeEl = document.getElementById('perf-sharpe');
        if (sharpeEl) {
            sharpeEl.textContent = m.sharpe === null || m.sharpe === undefined ? '--' : m.sharpe.toFixed(2);
            sharpeEl.classList.toggle('text-success', m.sharpe > 0);
            sharpeEl.classList.toggle('text-danger', m.sharpe < 0);
        }
        const maxddEl = document.getElementById('perf-maxdd');
        if (maxddEl) {
            maxddEl.textContent = m.maxDrawdown === null || m.maxDrawdown === undefined ? '--' : (m.maxDrawdown * 100).toFixed(1) + '%';
            maxddEl.classList.toggle('text-danger', m.maxDrawdown < 0);
        }
        const volEl = document.getElementById('perf-vol');
        if (volEl) volEl.textContent = m.volatility === null || m.volatility === undefined ? '--' : (m.volatility * 100).toFixed(1) + '%';

        renderBenchmarkChart(m.benchmark);
    } catch (e) {
        console.error('Lỗi loadPerformanceMetrics:', e);
    }
}

function renderBenchmarkChart(benchmark) {
    const wrapper = document.getElementById('benchmark-chart-wrapper');
    if (!wrapper) return;
    if (benchmarkChartInstance) { benchmarkChartInstance.destroy(); benchmarkChartInstance = null; }

    if (!benchmark || benchmark.length < 2) {
        wrapper.style.display = 'none';
        return;
    }
    wrapper.style.display = 'block';
    const canvas = document.getElementById('benchmarkChart');
    const ctx = canvas.getContext('2d');

    benchmarkChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: benchmark.map(b => b.date),
            datasets: [
                {
                    label: 'Danh mục', data: benchmark.map(b => b.portfolioIndexed),
                    borderColor: cssVar('--finance-accent'), backgroundColor: 'transparent',
                    tension: 0.3, pointRadius: benchmark.length > 30 ? 0 : 3
                },
                {
                    label: 'VN-Index', data: benchmark.map(b => b.benchmarkIndexed),
                    borderColor: cssVar('--series-1'), backgroundColor: 'transparent',
                    borderDash: [5, 4], tension: 0.3, pointRadius: benchmark.length > 30 ? 0 : 3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true, labels: { color: cssVar('--text-secondary') } },
                tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.raw.toFixed(2)}` } }
            },
            scales: {
                x: { ticks: { color: cssVar('--text-secondary') }, grid: { color: cssVar('--border-color') } },
                y: { ticks: { color: cssVar('--text-secondary') }, grid: { color: cssVar('--border-color') } }
            }
        }
    });
}

// --- UTILS ---
function cssVar(name) {
    // Đọc trên .asset-container (không phải <html>) vì bảng màu sáng cố định và bảng màu category
    // được khai báo trên body/.asset-container — đọc từ <html> sẽ luôn ra giá trị theme tối cũ.
    const scope = document.querySelector('.asset-container') || document.documentElement;
    return getComputedStyle(scope).getPropertyValue(name).trim();
}

function formatVnd(num) {
    // VND không có phần thập phân — làm tròn để tránh nhiễu số lẻ do tính toán
    // dấu phẩy động (vd 0.01) khiến chuỗi hiển thị dài ra và tràn khỏi thẻ KPI.
    return Math.round(Number(num) || 0).toLocaleString('vi-VN') + ' ₫';
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
