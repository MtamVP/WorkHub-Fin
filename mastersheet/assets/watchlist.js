/* --- FILE: /mastersheet/assets/watchlist.js ---
   Tab "Theo Dõi": mã CHƯA mua nhưng muốn canh giá. Giá thị trường do cron fetch-stock-prices cập nhật như mã đang giữ;
   email cảnh báo (send-price-alerts) báo khi giá <= giá muốn mua. Dùng global của script.js (callGAS, targetEmail, showToast, escapeAssetHtml). */

let lastWatchlist = [];

async function loadWatchlist() {
    const tbody = document.getElementById('watch-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải...</td></tr>';
    try {
        const resp = await callGAS('getWatchlist', { email: targetEmail });
        if (resp.status !== 'success') throw new Error(resp.message);
        lastWatchlist = resp.data || [];
        renderWatchlist();
        loadWatchSignals();
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty-state text-danger">Lỗi: ${escapeAssetHtml(e.message)}</td></tr>`;
    }
}

// Mã đang theo dõi vừa lọt vào nhóm "Rẻ và chất lượng" của bộ lọc thị trường (lib/market-screener.js). Tải nền, thiếu dữ liệu thì bỏ nhãn.
let watchSignals = {};
async function loadWatchSignals() {
    if (typeof MarketScreener === 'undefined' || !lastWatchlist.length) return;
    try {
        const resp = await callGAS('getMarketUniverse', {});
        if (resp.status !== 'success' || !resp.data) return;
        const u = resp.data, rows = MarketScreener.buildRows(u.snapshot || [], u.stats || {}, u.meta || {});
        watchSignals = MarketScreener.matches(rows, lastWatchlist.map(w => w.symbol));
        renderWatchlist();
    } catch (e) { /* không có ảnh chụp thị trường: không hiện nhãn */ }
}

function watchPctText(p) {
    if (p === null || p === undefined) return '—';
    return `${p > 0 ? '+' : (p < 0 ? '−' : '')}${Math.abs(p).toFixed(1)}%`;
}
function watchPctClass(p) { return p > 0 ? 'pnl-up' : (p < 0 ? 'pnl-down' : 'pnl-flat'); }

function renderWatchlist() {
    const tbody = document.getElementById('watch-body');
    if (!tbody) return;
    if (!lastWatchlist.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><i class="fa-solid fa-eye"></i>Chưa theo dõi mã nào — thêm mã bạn muốn mua ở form phía trên.</td></tr>';
        return;
    }
    const fmt = (n) => Number(n).toLocaleString('en-US');
    tbody.innerHTML = lastWatchlist.map(w => {
        const sym = escapeAssetHtml(w.symbol);
        const sub = VN_NAMES[String(w.symbol || '').toUpperCase()];
        const age = typeof renderPriceAge === 'function' && w.price > 0 ? renderPriceAge(w) : '';
        const signal = w.signal === 'buy' ? '<span class="tl-badge ok" title="Giá thị trường đang ≤ giá muốn mua"><i class="fa-solid fa-bell"></i> Tới giá mua</span>' : '';
        const sg = watchSignals[String(w.symbol || '').toUpperCase()];
        const cheapQ = sg ? `<span class="tl-badge ${sg.flags && sg.flags.length ? 'warn' : 'ok'}" title="${escapeAssetHtml(`Đạt mẫu "${sg.label}" của bộ lọc thị trường: định giá thuộc 40% rẻ nhất ngành (phân vị ${Math.round(sg.valuationPct)}), ROE ${sg.roe === null ? '—' : (sg.roe * 100).toFixed(1) + '%'}, vốn hoá từ 1.000 tỷ, thanh khoản từ 5 tỷ/ngày.${sg.flags && sg.flags.length ? ' Cần soát: ' + sg.flags.join('; ') + '.' : ''} Đây là tín hiệu để xem xét, không phải khuyến nghị mua.`)}"><i class="fa-solid fa-magnifying-glass-dollar"></i> Rẻ và chất lượng</span>` : '';
        const held = w.held ? '<span class="tl-badge info" title="Bạn đang giữ mã này — cảnh báo mua sẽ không gửi">Đang giữ</span>' : '';
        const targetTitle = w.targetSource === 'valuation' ? `Từ Định Giá CP (năm ${w.targetYear}). Nhập giá để ghi đè.` : (w.targetSource === 'manual' ? 'Giá mục tiêu nhập tay. Xoá trống để quay về giá từ Định Giá CP.' : 'Chưa có — nhập giá hoặc lưu định giá ở trang Định Giá CP.');
        return `<tr class="${w.signal === 'buy' ? 'tl-row-signal' : ''}">
            <td><span class="symbol-name">${sym}${sub ? `<span class="symbol-sub">${escapeAssetHtml(sub)}</span>` : ''}</span><div style="margin-top:4px;display:flex;gap:5px;flex-wrap:wrap;">${signal}${cheapQ}${held}</div></td>
            <td class="text-right"><span class="price-wrap"><span class="price-cell"><b>${w.price > 0 ? fmt(w.price) : '—'}</b></span>${age}</span></td>
            <td class="text-right"><input type="text" class="price-input level-input" data-id="${w.id}" data-kind="buyBelow" value="${w.buyBelow > 0 ? fmt(w.buyBelow) : ''}" placeholder="—" title="Báo khi giá thị trường ≤ mức này. Xoá trống để tắt." onchange="handleWatchEdit(this)"></td>
            <td class="text-right ${watchPctClass(w.buyGapPct === null ? null : -w.buyGapPct)}" title="Giá hiện tại so với giá muốn mua (âm = đã rẻ hơn mức muốn mua)">${w.buyGapPct === null ? '—' : watchPctText(w.buyGapPct)}</td>
            <td class="text-right"><input type="text" class="price-input level-input" data-id="${w.id}" data-kind="targetPrice" value="${w.targetSource === 'manual' ? fmt(w.targetPrice) : ''}" placeholder="${w.targetSource === 'valuation' ? fmt(w.targetPrice) : '—'}" title="${escapeAssetHtml(targetTitle)}" onchange="handleWatchEdit(this)"></td>
            <td class="text-right ${watchPctClass(w.upsidePct)}">${watchPctText(w.upsidePct)}</td>
            <td class="text-right ${watchPctClass(w.sinceAddedPct)}" title="${w.addedPrice > 0 ? 'Giá lúc thêm: ' + fmt(w.addedPrice) : ''}">${watchPctText(w.sinceAddedPct)}</td>
            <td><input type="text" class="tl-input" style="width:100%;min-width:120px" data-id="${w.id}" data-kind="note" value="${escapeAssetHtml(w.note)}" maxlength="300" placeholder="Ghi chú…" onchange="handleWatchEdit(this)"></td>
            <td style="white-space:nowrap;"><button class="btn-tool" title="Mở form Mua mã này" onclick="buyFromWatch('${escapeAssetHtml(w.symbol)}', ${w.price || 0})"><i class="fa-solid fa-cart-plus"></i> Mua</button>
                <button class="icon-btn danger" title="Bỏ theo dõi" onclick="removeWatch('${w.id}', '${sym}')"><i class="fa-solid fa-trash"></i></button></td>
        </tr>`;
    }).join('');
}

async function handleWatchSubmit(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const html = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang thêm...';
    try {
        const item = {
            symbol: document.getElementById('watch-symbol').value,
            buyBelow: parseMoney(document.getElementById('watch-buy').value),
            targetPrice: parseMoney(document.getElementById('watch-target').value),
            note: document.getElementById('watch-note').value
        };
        const resp = await callGAS('addWatchlistItem', { email: targetEmail, item });
        if (resp.status !== 'success') throw new Error(resp.message);
        showToast(escapeAssetHtml(resp.message), 'success');
        e.target.reset();
        await loadWatchlist();
    } catch (err) {
        showToast('Lỗi: ' + escapeAssetHtml(err.message), 'error');
    } finally {
        btn.disabled = false; btn.innerHTML = html;
    }
}

async function handleWatchEdit(input) {
    const kind = input.dataset.kind;
    const raw = input.value.trim();
    const value = kind === 'note' ? raw : (raw === '' ? 0 : parseMoney(raw));
    try {
        const resp = await callGAS('updateWatchlistItem', { email: targetEmail, id: input.dataset.id, patch: { [kind]: value } });
        if (resp.status !== 'success') throw new Error(resp.message);
        await loadWatchlist();
    } catch (e) {
        showToast('Lỗi: ' + escapeAssetHtml(e.message), 'error');
    }
}

async function removeWatch(id, symbol) {
    if (!confirm('Bỏ theo dõi ' + symbol + '?')) return;
    try {
        const resp = await callGAS('removeWatchlistItem', { email: targetEmail, id });
        if (resp.status !== 'success') throw new Error(resp.message);
        showToast(escapeAssetHtml(resp.message), 'success');
        await loadWatchlist();
    } catch (e) {
        showToast('Lỗi: ' + escapeAssetHtml(e.message), 'error');
    }
}

// Chuyển sang Sổ Lệnh với form Mua điền sẵn mã + giá hiện tại (không tự lưu lệnh)
function buyFromWatch(symbol, price) {
    switchAssetTab('ledger');
    switchLedgerSubTab('trades');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const buyBtn = document.querySelector('#txn-form .seg button[data-v="buy"]');
    if (buyBtn) pickTxnType(buyBtn);
    set('txn-symbol', symbol);
    if (price > 0) set('txn-price', price);
    updateTxnFeePreview();
    const q = document.getElementById('txn-quantity');
    if (q) q.focus();
    showToast('Đã điền sẵn mã ' + escapeAssetHtml(symbol) + ' — nhập khối lượng rồi bấm Lưu lệnh', 'success');
}

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('watch-form');
    if (form) form.addEventListener('submit', handleWatchSubmit);
});
