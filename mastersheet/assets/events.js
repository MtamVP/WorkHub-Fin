/* --- FILE: /mastersheet/assets/events.js ---
   Sự kiện doanh nghiệp tự gợi ý (Sổ Lệnh > Hành Động DN): cổ tức tiền, cổ phiếu thưởng / cổ tức bằng cổ phiếu, quyền mua phát hành thêm
   của CÁC MÃ BẠN NẮM, lấy từ nguồn thị trường (Edge Function stock-events) và đối chiếu với sổ lệnh (lib/corporate-events.js).
   App chỉ GỢI Ý: mỗi khoản chỉ được ghi khi bạn bấm xác nhận. Dùng global của script.js: callGAS, targetEmail, showToast, escapeAssetHtml,
   switchAssetTab, switchLedgerSubTab, loadHoldings, loadCorporateActions, loadCashFlows, loadCashDebt, LEDGER_SUB_LOADED. */

const CE = {
    state: 'idle',        // idle | loading | ok | error
    error: '',
    items: [], events: [], summary: null, errors: {}, fetchedAt: null,
    afterTax: true,
    busy: false,
};

const ceEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const ceNum = (v) => Number(v).toLocaleString('vi-VN', { maximumFractionDigits: 0 });
const ceDate = (iso) => { const p = String(iso || '').split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : ''; };
const ceMoney = (v) => `${ceNum(v)} đ`;

async function ceCall(action, params) {
    const r = await callGAS(action, Object.assign({ email: targetEmail }, params || {}));
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}

// Gọi 1 lần khi danh mục tải xong: lấy sự kiện ngầm để hiện thông báo, không chặn giao diện
let ceBootstrapped = false;
function initCorpEvents() {
    if (ceBootstrapped) return;
    ceBootstrapped = true;
    loadCorpEvents(true);
}

async function loadCorpEvents(silent) {
    CE.state = 'loading';
    if (!silent) renderCorpEvents();
    try {
        const d = await ceCall('loadCorporateEvents');
        CE.items = d.items || []; CE.events = d.events || []; CE.summary = d.summary || null;
        CE.errors = d.errors || {}; CE.fetchedAt = d.fetchedAt || null;
        CE.state = 'ok'; CE.error = '';
    } catch (e) {
        CE.state = 'error'; CE.error = e.message || String(e);
    }
    renderCorpEventsBanner();
    renderCorpEvents();
    if (typeof TodayUI !== 'undefined') TodayUI.onEvents();                  // thẻ "Hôm nay": có sự kiện mới thì tóm tắt lại
}

// ---------- thông báo ở tab Danh Mục + chấm trên tab Sổ Lệnh ----------
function renderCorpEventsBanner() {
    const box = document.getElementById('ce-banner');
    const badge = document.getElementById('ce-badge');
    const pending = CE.state === 'ok' && CE.summary ? CE.summary.pending : 0;
    if (badge) { badge.style.display = pending ? '' : 'none'; badge.textContent = pending || ''; }
    if (!box) return;
    if (!pending) { box.innerHTML = ''; box.style.display = 'none'; return; }
    const s = CE.summary;
    const parts = [];
    if (s.pendingCash > 0) parts.push(`cổ tức tiền khoảng <b>${ceMoney(s.pendingCash)}</b>`);
    if (s.pendingBonusSymbols.length) parts.push(`cổ phiếu thưởng/cổ tức CP của <b>${s.pendingBonusSymbols.map(ceEsc).join(', ')}</b>`);
    box.style.display = '';
    box.innerHTML = `<i class="fa-solid fa-gift"></i><span>Có <b>${pending}</b> sự kiện doanh nghiệp bạn được hưởng nhưng chưa ghi vào sổ${parts.length ? ': ' + parts.join(' và ') : ''}. Chưa ghi thì giá vốn và lãi/lỗ đang sai.</span>
        <button type="button" class="btn-tool" onclick="openCorpEvents()">Xem và ghi</button>`;
}

function openCorpEvents() {
    switchAssetTab('ledger');
    switchLedgerSubTab('corporate');
    const card = document.getElementById('ce-card');
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- vẽ ----------
function ceDetail(p) {
    const ev = p.event;
    if (p.kind === 'cash_dividend') {
        const tax = Math.round(p.taxRate * 100);
        return `<div><b>${ceNum(p.quantity)}</b> cp × ${ceNum(p.dps)} đ = <b>${ceMoney(p.gross)}</b></div>
            <div class="ce-sub">Thực nhận khoảng <b>${ceMoney(p.net)}</b> sau thuế TNCN ${tax}% · thanh toán ${ceDate(p.flowDate)}${ev.period ? ` · đợt ${ev.period}/${ev.divYear || ''}` : ''}</div>`;
    }
    if (p.kind === 'stock_dividend' || p.kind === 'bonus') {
        return `<div>Tỷ lệ 100:${ceNum(p.ratioPct)} → <b>+${ceNum(p.bonusShares)} cp</b></div>
            <div class="ce-sub">${ceNum(p.quantity)} → ${ceNum(p.quantityAfter)} cp · giá vốn bình quân giảm tương ứng, tổng vốn không đổi${p.quantity * (p.ratioPct / 100) % 1 > 1e-9 ? ' · phần lẻ công ty chứng khoán sẽ làm tròn xuống' : ''}</div>`;
    }
    return `<div>Được mua <b>${ceNum(p.rightsShares)} cp</b> giá <b>${ceNum(p.issuePrice)} đ</b></div>
        <div class="ce-sub">Cần ${ceMoney(p.cost)} nếu mua hết${p.deadline ? ` · hạn ${ceDate(p.deadline)}` : ''}. Mua hay không là quyết định của bạn: nếu mua, ghi lệnh mua ở tab Giao Dịch CP.</div>`;
}

function ceRow(p, mode) {
    const ev = p.event;
    const id = ceEsc(ev.id);
    const kindCls = { cash_dividend: 'ok', stock_dividend: 'info', bonus: 'info', rights: 'warn' }[p.kind];
    let action = '';
    if (mode === 'pending') {
        action = `<button type="button" class="btn-tool ce-apply" onclick="applyCorpEvent('${id}')"><i class="fa-solid fa-check"></i> Ghi</button>
            <button type="button" class="tl-link" title="Không ghi sự kiện này và không hiện lại" onclick="dismissCorpEvent('${id}')">Bỏ qua</button>`;
    } else if (mode === 'upcoming') {
        action = `<span class="tl-badge mute" title="Chỉ ghi được khi tới ngày này">Ghi được từ ${ceDate(p.due)}</span>`;
    } else if (mode === 'info') {
        action = `<button type="button" class="tl-link" onclick="dismissCorpEvent('${id}')">Ẩn</button>`;
    } else if (mode === 'recorded') {
        action = `<span class="tl-badge ok"><i class="fa-solid fa-check"></i> Đã ghi</span>`;
    } else {
        action = `<button type="button" class="tl-link" onclick="restoreCorpEvent('${id}')">Hiện lại</button>`;
    }
    return `<tr>
        <td><span class="tl-badge ${kindCls}">${ceEsc(p.label)}</span></td>
        <td class="text-bold">${ceEsc(p.symbol)}</td>
        <td title="Ngày giao dịch không hưởng quyền: mua từ ngày này trở đi thì không được nhận">${ceDate(ev.exDate)}</td>
        <td class="ce-detail">${ceDetail(p)}</td>
        <td class="text-right ce-actions">${action}</td>
    </tr>`;
}

function ceTable(items, mode) {
    return `<div class="spreadsheet-wrapper"><table class="excel-table asset-table ce-table">
        <thead><tr><th>Loại</th><th>Mã</th><th>Không hưởng quyền từ</th><th>Bạn được nhận</th><th></th></tr></thead>
        <tbody>${items.map(p => ceRow(p, mode)).join('')}</tbody></table></div>`;
}

function renderCorpEvents() {
    const card = document.getElementById('ce-card');
    if (!card) return;
    const body = document.getElementById('ce-body');
    const meta = document.getElementById('ce-meta');
    if (CE.state === 'loading' || CE.state === 'idle') {
        body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang lấy sự kiện doanh nghiệp từ thị trường…</div>';
        meta.textContent = '';
        return;
    }
    if (CE.state === 'error') {
        body.innerHTML = `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không lấy được sự kiện: ${ceEsc(CE.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="loadCorpEvents()">Thử lại</button></div>`;
        meta.textContent = '';
        return;
    }
    const by = (st) => CE.items.filter(p => p.status === st);
    const pending = by('pending'), upcoming = by('upcoming'), info = by('info'), recorded = by('recorded'), dismissed = by('dismissed');
    const when = CE.fetchedAt ? new Date(CE.fetchedAt) : null;
    meta.textContent = when ? `Cập nhật ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')} ${ceDate(when.toISOString().slice(0, 10))}` : '';
    const failed = Object.keys(CE.errors || {});
    let html = '';
    if (failed.length) html += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không lấy được sự kiện của: ${failed.map(ceEsc).join(', ')}. Bấm “Kiểm tra lại” để thử lại.</span></div>`;
    if (!CE.items.length) {
        html += '<div class="tl-empty"><i class="fa-solid fa-gift"></i>Chưa có sự kiện nào cho các mã bạn từng giao dịch (kể từ lệnh đầu tiên).</div>';
    }
    if (pending.length) {
        html += `<div class="ce-group-title">Cần ghi vào sổ <span class="tl-badge bad">${pending.length}</span></div>${ceTable(pending, 'pending')}`;
    } else if (CE.items.length) {
        html += '<div class="tl-empty" style="padding:14px"><i class="fa-solid fa-circle-check" style="color:var(--success-color);opacity:1"></i>Không có sự kiện nào đang chờ ghi.</div>';
    }
    if (upcoming.length) html += `<div class="ce-group-title">Sắp tới <span class="tl-badge mute">${upcoming.length}</span></div>${ceTable(upcoming, 'upcoming')}`;
    if (info.length) html += `<div class="ce-group-title">Quyền mua phát hành thêm (thông tin)</div>${ceTable(info, 'info')}`;
    if (recorded.length) html += `<details class="tl-details"><summary>Đã ghi (${recorded.length})</summary>${ceTable(recorded, 'recorded')}</details>`;
    if (dismissed.length) html += `<details class="tl-details"><summary>Đã bỏ qua (${dismissed.length})</summary>${ceTable(dismissed, 'dismissed')}</details>`;
    body.innerHTML = html;

    const applyAll = document.getElementById('ce-apply-all');
    if (applyAll) {
        applyAll.style.display = pending.length ? '' : 'none';
        applyAll.querySelector('span').textContent = `Ghi tất cả (${pending.length})`;
        applyAll.disabled = CE.busy;
    }
    const tax = document.getElementById('ce-aftertax');
    if (tax) tax.checked = CE.afterTax;
}

// ---------- thao tác ----------
function ceSetAfterTax(box) { CE.afterTax = !!box.checked; }

async function ceRefreshAfterWrite() {
    await loadCorpEvents(true);
    if (typeof loadHoldings === 'function') loadHoldings();
    if (typeof loadCashDebt === 'function') loadCashDebt();
    if (typeof loadCorporateActions === 'function' && LEDGER_SUB_LOADED.corporate) loadCorporateActions();
    if (typeof loadCashFlows === 'function' && LEDGER_SUB_LOADED.cashflow) loadCashFlows();
}

async function ceApply(ids) {
    if (CE.busy || !ids.length) return;
    CE.busy = true; renderCorpEvents();
    try {
        const out = await ceCall('applyCorporateEvents', { events: CE.events, ids, opts: { afterTax: CE.afterTax } });
        showToast(out.message, 'success');
    } catch (e) {
        showToast('Lỗi: ' + (e.message || e), 'error');
    }
    CE.busy = false;
    await ceRefreshAfterWrite();
}

function applyCorpEvent(id) { ceApply([id]); }

function applyAllCorpEvents() {
    const ids = CE.items.filter(p => p.status === 'pending' && p.kind !== 'rights').map(p => p.event.id);
    if (!ids.length) return;
    const cash = CE.items.filter(p => p.status === 'pending' && p.kind === 'cash_dividend').reduce((s, p) => s + (CE.afterTax ? p.net : p.gross), 0);
    if (!window.confirm(`Ghi ${ids.length} sự kiện vào sổ?${cash > 0 ? `\nTiền mặt sẽ được cộng thêm khoảng ${ceMoney(cash)}.` : ''}\nBạn có thể xoá từng khoản ở tab Dòng Tiền / Hành Động DN nếu cần.`)) return;
    ceApply(ids);
}

async function dismissCorpEvent(id) {
    const ev = CE.events.find(e => e.id === id);
    if (!ev) return;
    try {
        await ceCall('dismissCorporateEvent', { event: ev });
        await loadCorpEvents(true);
    } catch (e) { showToast('Lỗi: ' + (e.message || e), 'error'); }
}

async function restoreCorpEvent(id) {
    try {
        await ceCall('restoreCorporateEvent', { eventId: id });
        await loadCorpEvents(true);
    } catch (e) { showToast('Lỗi: ' + (e.message || e), 'error'); }
}
