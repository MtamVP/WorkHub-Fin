/* --- FILE: /mastersheet/assets/insights.js ---
   Bàn Tài Sản: độ tươi của giá, phân bổ theo ngành + cảnh báo tập trung, hiệu quả theo từng mã,
   tóm tắt so với VN-Index, xuất CSV / in PDF. Dùng các global của script.js (callGAS, targetEmail,
   escapeAssetHtml, formatVnd, showToast) và FinCalc (lib/finance-calc.js). */

let lastHoldings = [];
let lastSymbolPerf = [];

// Gọi từ loadHoldings() mỗi lần danh mục được tải lại
function onHoldingsLoaded(holdings) {
    lastHoldings = holdings || [];
    renderSectorBlock(lastHoldings);
    renderPriceStatus();
    renderAlertEmailBar();
}

function renderPriceAge(h) {
    const lab = FinCalc.priceAgeLabel(h.priceMeta);
    return `<span class="price-age ${lab.cls}" title="${escapeAssetHtml(lab.title)}">${escapeAssetHtml(lab.text)}</span>`;
}

// --- Dòng trạng thái bộ lấy giá tự động (phía trên bảng Danh Mục) ---
async function renderPriceStatus() {
    const el = document.getElementById('price-status');
    if (!el) return;
    try {
        const resp = await callGAS('getPriceFetchStatus', {});
        const s = FinCalc.priceStatusSummary(resp.data);
        const icon = { ok: 'fa-circle-check', warn: 'fa-triangle-exclamation', bad: 'fa-circle-exclamation', none: 'fa-circle-question' }[s.level];
        el.className = 'price-status ' + s.level;
        el.title = s.title;
        el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${escapeAssetHtml(s.text)}</span>`;
    } catch (e) {
        el.className = 'price-status none';
        el.innerHTML = '';
    }
}

// --- Phân bổ theo ngành + cảnh báo tập trung (trong thẻ "Cơ Cấu Danh Mục") ---
function renderSectorBlock(holdings) {
    const box = document.getElementById('sector-block');
    if (!box) return;
    const sectors = FinCalc.sectorAllocation(holdings);
    if (!sectors.length) { box.innerHTML = ''; return; }

    const warnings = FinCalc.concentrationWarnings(holdings);
    const warnHtml = warnings.map(w => {
        const what = w.type === 'symbol' ? `Mã <b>${escapeAssetHtml(w.label)}</b>` : `Ngành <b>${escapeAssetHtml(w.label)}</b>`;
        return `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>${what} chiếm ${w.pct.toFixed(1)}% danh mục (ngưỡng ${w.limit}%)</span></div>`;
    }).join('');

    const rows = sectors.map((s, i) => {
        const color = i < ALLOCATION_COLOR_VARS.length ? cssVar(ALLOCATION_COLOR_VARS[i]) : cssVar('--series-other');
        const syms = s.symbols.map(escapeAssetHtml).join(', ');
        return `<div class="sector-row" title="${syms}">
            <span class="sector-name">${escapeAssetHtml(s.sector)}</span>
            <span class="sector-bar"><i style="width:${Math.min(s.pct, 100).toFixed(1)}%;background:${color};"></i></span>
            <span class="sector-pct">${s.pct.toFixed(1)}%</span>
        </div>`;
    }).join('');

    box.innerHTML = `<div class="sector-title">Theo ngành</div>${warnHtml}${rows}`;
}

// --- Tóm tắt vượt/thua VN-Index (trên biểu đồ so sánh) ---
function renderBenchmarkSummary(summary) {
    const el = document.getElementById('benchmark-summary');
    if (!el) return;
    if (!summary) { el.innerHTML = ''; return; }
    const fmt = (v) => `${v > 0 ? '+' : (v < 0 ? '−' : '')}${Math.abs(v).toFixed(2)}%`;
    const cls = (v) => v > 0 ? 'pnl-up' : (v < 0 ? 'pnl-down' : 'pnl-flat');
    const d = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
    el.innerHTML = `
        <span class="bm-chip"><span class="bm-k">Danh mục (TWR)</span><span class="bm-v ${cls(summary.portfolioPct)}">${fmt(summary.portfolioPct)}</span></span>
        <span class="bm-chip"><span class="bm-k">VN-Index</span><span class="bm-v ${cls(summary.indexPct)}">${fmt(summary.indexPct)}</span></span>
        <span class="bm-chip bm-excess"><span class="bm-k">${summary.excessPct >= 0 ? 'Vượt' : 'Thua'} VN-Index</span><span class="bm-v ${cls(summary.excessPct)}">${fmt(summary.excessPct)}</span></span>
        <span class="bm-range">${d(summary.from)} → ${d(summary.to)} · loại ngày nạp/rút vốn</span>`;
}

// --- Hiệu quả theo từng mã (kể cả mã đã bán hết) ---
async function loadSymbolPerformance() {
    const tbody = document.getElementById('symperf-body');
    if (!tbody) return;
    try {
        const resp = await callGAS('getSymbolPerformance', { email: targetEmail });
        if (resp.status !== 'success') throw new Error(resp.message);
        lastSymbolPerf = resp.data || [];
        if (!lastSymbolPerf.length) {
            tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><i class="fa-solid fa-chart-column"></i>Chưa có giao dịch để phân tích.</td></tr>';
            return;
        }
        const maxAbs = Math.max(...lastSymbolPerf.map(r => Math.abs(r.totalPnl)), 1);
        tbody.innerHTML = lastSymbolPerf.map(r => {
            const sym = escapeAssetHtml(r.symbol);
            const sub = VN_NAMES[String(r.symbol || '').toUpperCase()];
            const barW = (Math.abs(r.totalPnl) / maxAbs * 100).toFixed(1);
            const dir = r.totalPnl > 0 ? 'pnl-up' : (r.totalPnl < 0 ? 'pnl-down' : 'pnl-flat');
            const num = (v) => signedVnd(v);
            const status = r.held
                ? (r.noPrice ? '<span class="sp-tag warn" title="Mã đang giữ nhưng chưa có giá thị trường — lãi/lỗ chưa chốt chưa được tính">Chưa có giá</span>' : '<span class="sp-tag held">Đang giữ</span>')
                : '<span class="sp-tag closed">Đã bán hết</span>';
            const xirrTxt = r.xirrPct === null ? '<span class="text-muted" title="Cần ít nhất 90 ngày kể từ lệnh đầu tiên — ngắn hơn thì lãi suất quy năm chỉ là nhiễu">—</span>'
                : `<span class="${r.xirrPct >= 0 ? 'pnl-up' : 'pnl-down'}">${r.xirrPct >= 0 ? '+' : '−'}${Math.min(Math.abs(r.xirrPct), 9999).toFixed(1)}%</span>`;
            return `<tr>
                <td><span class="symbol-name">${sym}${sub ? `<span class="symbol-sub">${escapeAssetHtml(sub)}</span>` : ''}</span></td>
                <td>${status}</td>
                <td class="text-right">${Math.round(r.bought).toLocaleString('en-US')}</td>
                <td class="text-right ${r.realized > 0 ? 'pnl-up' : (r.realized < 0 ? 'pnl-down' : '')}">${num(r.realized)}</td>
                <td class="text-right ${r.unrealized > 0 ? 'pnl-up' : (r.unrealized < 0 ? 'pnl-down' : '')}">${r.noPrice ? '—' : num(r.unrealized)}</td>
                <td class="text-right">${r.dividends ? num(r.dividends) : '—'}</td>
                <td class="text-right"><span class="sp-total ${dir}"><b>${num(r.totalPnl)}</b><span class="sp-bar"><i class="${dir}" style="width:${barW}%"></i></span></span></td>
                <td class="text-right ${dir}">${r.returnPct === null ? '—' : `${r.returnPct >= 0 ? '+' : '−'}${Math.abs(r.returnPct).toFixed(1)}%`}</td>
                <td class="text-right" title="Lãi suất quy năm theo dòng tiền thực (XIRR)">${xirrTxt}</td>
            </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty-state text-danger">Lỗi: ${escapeAssetHtml(e.message)}</td></tr>`;
    }
}

function signedVnd(v) {
    const n = Math.round(Number(v) || 0);
    return (n > 0 ? '+' : (n < 0 ? '−' : '')) + Math.abs(n).toLocaleString('en-US');
}

// --- XUẤT BÁO CÁO ---
function fileStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function downloadCsvFile(filename, rows) {
    const blob = new Blob([FinCalc.buildCsv(rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Đã xuất ${filename}`, 'success');
}

function exportHoldingsCsv() {
    if (!lastHoldings.length) { showToast('Chưa có danh mục để xuất.', 'error'); return; }
    const rows = [['Mã', 'Ngành', 'Khối lượng', 'Giá vốn BQ', 'Giá TT', 'Ngày giá', 'Giá mục tiêu', 'Upside %', 'Cắt lỗ', 'GT vốn', 'GTTT', 'Tỷ trọng %', 'Lãi/lỗ chưa chốt', 'Lãi/lỗ chưa chốt %']];
    const total = lastHoldings.reduce((s, h) => s + (Number(h.marketValue) || 0), 0);
    lastHoldings.forEach(h => rows.push([
        h.symbol, FinCalc.sectorOf(h.symbol), h.quantity, Math.round(h.avgCost), h.marketPrice,
        h.priceMeta && h.priceMeta.date ? h.priceMeta.date : '',
        h.targetPrice || '', h.upsidePct === null || h.upsidePct === undefined ? '' : h.upsidePct.toFixed(1),
        h.stopLoss || '', Math.round(h.costValue), Math.round(h.marketValue),
        total > 0 ? ((h.marketValue / total) * 100).toFixed(1) : '',
        Math.round(h.unrealizedPnl), h.unrealizedPct.toFixed(1)
    ]));
    downloadCsvFile(`danh-muc-${fileStamp()}.csv`, rows);
}

async function exportLedgerCsv() {
    try {
        const resp = await callGAS('listAssetTransactions', { email: targetEmail });
        if (resp.status !== 'success') throw new Error(resp.message);
        const txns = resp.data || [];
        if (!txns.length) { showToast('Chưa có lệnh giao dịch để xuất.', 'error'); return; }
        const rows = [['Ngày', 'Loại', 'Mã', 'Khối lượng', 'Giá', 'Phí', 'Giá trị', 'Lãi/lỗ đã chốt (FIFO)', 'Ghi chú']];
        txns.slice().reverse().forEach(t => rows.push([
            t.trade_date, t.type === 'buy' ? 'Mua' : 'Bán', t.symbol, t.quantity, t.price, t.fee || 0,
            Math.round((Number(t.quantity) || 0) * (Number(t.price) || 0)),
            t.type === 'sell' && t.realized_pnl !== null && t.realized_pnl !== undefined ? Math.round(t.realized_pnl) : '',
            t.note || ''
        ]));
        downloadCsvFile(`so-lenh-${fileStamp()}.csv`, rows);
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
    }
}

function exportSymbolPerfCsv() {
    if (!lastSymbolPerf.length) { showToast('Chưa có dữ liệu hiệu quả theo mã.', 'error'); return; }
    const rows = [['Mã', 'Trạng thái', 'Tổng vốn mua', 'Tiền thu bán', 'Phí', 'Lãi đã chốt', 'Lãi chưa chốt', 'Cổ tức tiền', 'Tổng lãi/lỗ', 'Lợi nhuận % trên vốn mua', 'XIRR %']];
    lastSymbolPerf.forEach(r => rows.push([
        r.symbol, r.held ? (r.noPrice ? 'Đang giữ (chưa có giá)' : 'Đang giữ') : 'Đã bán hết',
        Math.round(r.bought), Math.round(r.sold), Math.round(r.fees), Math.round(r.realized),
        r.noPrice ? '' : Math.round(r.unrealized), Math.round(r.dividends), Math.round(r.totalPnl),
        r.returnPct === null ? '' : r.returnPct.toFixed(1), r.xirrPct === null ? '' : r.xirrPct.toFixed(1)
    ]));
    downloadCsvFile(`hieu-qua-theo-ma-${fileStamp()}.csv`, rows);
}

// In / lưu PDF tab đang mở (hộp thoại in của hệ thống có sẵn "Lưu dạng PDF"); giao diện in nằm ở finance-shared.css (@media print)
function printCurrentTab() {
    window.print();
}

// --- Email cảnh báo giá khi app đã tắt (Edge Function send-price-alerts, chạy mỗi giờ trong phiên giao dịch) ---
let alertPrefs = null;

async function renderAlertEmailBar() {
    const el = document.getElementById('alert-email-bar');
    if (!el) return;
    // Tuỳ chọn gắn với tài khoản đang đăng nhập -- không hiện khi quản lý đang xem dữ liệu của người khác
    if (targetEmail !== userEmail) { el.innerHTML = ''; return; }
    if (!alertPrefs) {
        try {
            const resp = await callGAS('getAlertPrefs', { email: userEmail });
            if (resp.status !== 'success') throw new Error(resp.message);
            alertPrefs = resp.data || { emailEnabled: false };
        } catch (e) { el.innerHTML = ''; return; }
    }
    const on = !!alertPrefs.emailEnabled;
    const hint = `Gửi email tới ${userEmail} khi giá thị trường chạm giá mục tiêu hoặc ngưỡng cắt lỗ của mã bạn đang giữ. Mỗi mức chỉ báo 1 lần/ngày.`;
    el.innerHTML = `
        <label class="alert-email-toggle" title="${escapeAssetHtml(hint)}">
            <input type="checkbox" id="alert-email-checkbox" ${on ? 'checked' : ''} onchange="toggleAlertEmail(this)">
            <span><i class="fa-solid fa-envelope"></i> Gửi email khi giá chạm mục tiêu / cắt lỗ <b>(cả khi đã tắt app)</b></span>
        </label>
        ${on ? '<button type="button" class="btn-tool" onclick="sendTestAlertEmailUI(this)"><i class="fa-solid fa-paper-plane"></i> Gửi email thử</button>' : ''}`;
}

async function toggleAlertEmail(box) {
    const enabled = box.checked;
    box.disabled = true;
    try {
        const resp = await callGAS('setAlertPrefs', { email: userEmail, enabled });
        if (resp.status !== 'success') throw new Error(resp.message);
        alertPrefs = { emailEnabled: enabled };
        showToast(resp.message, 'success');
    } catch (e) {
        box.checked = !enabled;
        showToast('Lỗi: ' + e.message, 'error');
    }
    renderAlertEmailBar();
}

async function sendTestAlertEmailUI(btn) {
    btn.disabled = true;
    try {
        const resp = await callGAS('sendTestAlertEmail', {});
        if (resp.status !== 'success') throw new Error(resp.message);
        showToast(resp.message, 'success');
    } catch (e) {
        showToast('Không gửi được email thử: ' + e.message, 'error');
    }
    btn.disabled = false;
}
