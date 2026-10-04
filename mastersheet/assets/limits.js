/* --- FILE: /mastersheet/assets/limits.js ---
   Giới hạn đầu tư (cá nhân): (1) kiểm tra từng lệnh TRƯỚC khi ghi -- vượt giới hạn thì hỏi lý do, hoặc chặn; (2) bảng "Giới hạn áp dụng cho bạn" ở tab Rủi Ro
   với mức sử dụng hiện tại; (3) tự đặt giới hạn cá nhân. Giới hạn chung của nhóm do quản lý đặt ở trang Toàn Nhóm. Phép tính ở /lib/limits-calc.js (có kiểm thử);
   việc chặn/ghi lý do được kiểm lại ở api.js (addTransaction) nên không thể lách bằng cách bỏ qua bước này trên giao diện.
   Dùng global của script.js: callGAS, targetEmail, userEmail, showToast, escapeAssetHtml. */

const LM = { rows: [], actor: null, state: 'idle', error: '', resolve: null };

const lmEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const lmNum = (v, d) => Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: d === undefined ? 1 : d });
const LM_MODE_CLS = { warn: 'info', reason: 'warn', block: 'bad' };

async function lmCall(action, params) {
    const r = await callGAS(action, Object.assign({ email: targetEmail }, params || {}));
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}

// ---------- 1) Cổng kiểm tra trước khi ghi lệnh ----------
// Trả null (cứ ghi, không cần gì thêm) | { reason } (ghi kèm lý do ngoại lệ) | false (dừng, người dùng huỷ hoặc bị chặn).
async function limitsGate(txn) {
    let chk;
    try {
        chk = await lmCall('checkTradeLimits', { trade: { type: txn.type, symbol: String(txn.symbol || '').trim().toUpperCase(), quantity: Number(txn.quantity) || 0, price: Number(txn.price) || 0, fee: Number(txn.fee) || 0, tax: Number(txn.tax) || 0 } });
    } catch (e) {
        return null;   // không kiểm được (mạng...) thì để máy chủ chặn khi ghi nếu thật sự vi phạm
    }
    if (!chk.violations.length && !(chk.near && chk.near.length)) return null;
    let actor = LM.actor;
    if (!actor) { try { actor = LM.actor = await lmCall('getLimitActor'); } catch (e) { actor = { isManager: false }; } }

    const gated = chk.violations.filter(v => v.mode !== 'warn');
    const hardBlocked = chk.blocked && !actor.isManager;
    // Chỉ cảnh báo nhẹ (gần chạm / chế độ cảnh báo) -> báo bằng toast rồi cứ ghi
    if (!gated.length && !hardBlocked) {
        const msgs = chk.violations.concat(chk.near || []).map(v => v.text);
        if (msgs.length) showToast('Lưu ý giới hạn: ' + msgs.join('; '), 'error');
        return null;
    }
    return new Promise((resolve) => {
        LM.resolve = resolve;
        const modal = document.getElementById('lim-modal');
        const lines = chk.violations.map(v => `<li class="lm-vio ${v.mode}"><span class="tl-badge ${LM_MODE_CLS[v.mode]}">${lmEsc(LimitsCalc.MODES[v.mode].label)}</span> ${lmEsc(v.text)} <small>(hiện ${lmNum(v.before, 1)} → sau lệnh ${lmNum(v.after, 1)})</small></li>`).join('');
        document.getElementById('lim-modal-title').innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color: var(--warning-color);"></i> Lệnh này vượt giới hạn đầu tư`;
        document.getElementById('lim-modal-body').innerHTML = `
            <ul class="lm-list">${lines}</ul>
            ${hardBlocked
                ? '<div class="conc-warn"><i class="fa-solid fa-ban"></i><span>Giới hạn này đang ở chế độ <b>chặn</b>: bạn không thể ghi lệnh. Liên hệ quản lý danh mục nếu cần ngoại lệ.</span></div>'
                : `<div class="txn-field txn-field-wide"><label for="lim-reason">${chk.blocked ? 'Lý do ghi đè (quản lý, bắt buộc)' : 'Lý do ngoại lệ (bắt buộc)'}</label>
                   <textarea id="lim-reason" rows="3" maxlength="500" placeholder="Vì sao lệnh này vẫn hợp lý dù vượt giới hạn? Ai đã biết/đồng ý?" oninput="document.getElementById('lim-ok').disabled = this.value.trim().length < 3"></textarea>
                   <span class="tl-hint" style="margin:0">Lý do được lưu cùng lệnh và hiện ở trang Toàn Nhóm > Giới Hạn để quản lý xem lại.</span></div>`}`;
        document.getElementById('lim-modal-footer').innerHTML = `<button type="button" class="btn-tool" onclick="limitsGateDone(false)">${hardBlocked ? 'Đóng' : 'Huỷ lệnh'}</button>` +
            (hardBlocked ? '' : '<button type="button" class="btn-save" id="lim-ok" disabled onclick="limitsGateDone(true)"><i class="fa-solid fa-check"></i> Vẫn ghi lệnh</button>');
        modal.classList.add('open');
    });
}

function limitsGateDone(ok) {
    const modal = document.getElementById('lim-modal');
    const reason = ok ? String((document.getElementById('lim-reason') || {}).value || '').trim() : '';
    modal.classList.remove('open');
    const r = LM.resolve; LM.resolve = null;
    if (r) r(ok && reason.length >= 3 ? { reason } : false);
}

// ---------- 2) Bảng giới hạn áp dụng cho bạn ----------
async function loadLimitsPanel(force) {
    const box = document.getElementById('lm-panel');
    if (!box) return;
    if (LM.state === 'loading') return;
    if (LM.state === 'ok' && !force) { renderLimitsPanel(); return; }
    LM.state = 'loading';
    box.innerHTML = '<div class="tl-empty" style="padding:14px"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải giới hạn…</div>';
    try {
        const [rows, holdingsResp, cd, actor] = await Promise.all([
            lmCall('listLimits'), callGAS('getHoldingsView', { email: targetEmail }), callGAS('getCashDebt', { email: targetEmail }), lmCall('getLimitActor').catch(() => ({ isManager: false })),
        ]);
        LM.rows = rows; LM.actor = actor;
        LM.holdings = ((holdingsResp && holdingsResp.data) || []).map(h => ({ symbol: h.symbol, value: h.marketValue }));
        LM.cash = Number(cd && cd.data ? cd.data.cash : 0) || 0; LM.debt = Number(cd && cd.data ? cd.data.debt : 0) || 0;
        LM.me = actor.targetId;
        LM.state = 'ok';
    } catch (e) { LM.state = 'error'; LM.error = e.message || String(e); }
    renderLimitsPanel();
}

function lmValueText(i) {
    const u = LimitsCalc.KINDS[i.kind].unit;
    if (i.kind === 'max_position_vnd') return `${lmNum(i.current, 0)} / ${lmNum(i.threshold, 0)} đ`;
    if (i.kind === 'max_leverage') return `${lmNum(i.current, 2)}× / ${lmNum(i.threshold, 2)}×`;
    if (i.kind === 'blocked_symbol') return i.held ? 'Đang giữ' : 'Không giữ';
    return `${lmNum(i.current, 1)}% / ${lmNum(i.threshold, 1)}% ${u.indexOf('NAV') !== -1 ? '' : ''}`;
}

function renderLimitsPanel() {
    const box = document.getElementById('lm-panel');
    if (!box) return;
    if (LM.state === 'loading' || LM.state === 'idle') return;
    if (LM.state === 'error') { box.innerHTML = `<div class="tl-empty text-danger" style="padding:14px">Không tải được giới hạn: ${lmEsc(LM.error)}</div>`; return; }
    const limits = LimitsCalc.applicable(LM.rows, LM.me, 'member');
    const ev = LimitsCalc.evaluate(limits, { holdings: LM.holdings, cash: LM.cash, debt: LM.debt });
    const mine = LM.rows.filter(r => r.scope === 'user' && r.user_id === LM.me);
    let html = '';
    if (!limits.length) {
        html += '<div class="tl-empty" style="padding:14px"><i class="fa-solid fa-gauge-high"></i>Chưa có giới hạn nào áp dụng cho bạn. Quản lý đặt giới hạn chung ở trang Toàn Nhóm; bạn cũng có thể tự đặt giới hạn riêng bên dưới.</div>';
    } else {
        const sorted = ev.items.slice().sort((a, b) => (b.status === 'breach') - (a.status === 'breach') || (b.usage === Infinity ? 1e9 : b.usage) - (a.usage === Infinity ? 1e9 : a.usage));
        html += `<div class="rk-meta">${ev.breaches.length ? `<b class="tl-down">${ev.breaches.length} giới hạn đang vượt</b> · ` : ''}${ev.warns.length ? `${ev.warns.length} gần chạm · ` : ''}${limits.length} giới hạn đang hiệu lực · mẫu số là NAV (gồm tiền mặt)</div>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table lm-table"><thead><tr><th>Đối tượng</th><th>Giới hạn</th><th class="text-right">Hiện tại / ngưỡng</th><th>Mức dùng</th><th>Trạng thái</th><th>Chế độ</th><th>Nguồn</th></tr></thead><tbody>
        ${sorted.map(i => `<tr><td><b>${lmEsc(i.subject)}</b></td><td>${lmEsc(LimitsCalc.KINDS[i.kind].label)}</td><td class="text-right">${lmValueText(i)}</td>
            <td><span class="rk-pair"><b>${i.usage === Infinity ? '∞' : lmNum(i.usage * 100, 0) + '%'}</b><span class="rk-bar ${i.status === 'breach' ? 'over' : (i.status === 'warn' ? 'risk' : '')}"><i style="width:${Math.min(100, i.usage === Infinity ? 100 : i.usage * 100).toFixed(1)}%"></i></span></span></td>
            <td><span class="tl-badge ${i.status === 'breach' ? 'bad' : (i.status === 'warn' ? 'warn' : 'ok')}">${i.status === 'breach' ? 'Vượt' : (i.status === 'warn' ? 'Gần chạm' : 'Trong mức')}</span></td>
            <td><span class="tl-badge ${LM_MODE_CLS[i.mode]}">${lmEsc(LimitsCalc.MODES[i.mode].label)}</span></td><td>${i.scope === 'user' ? 'Cá nhân' : 'Nhóm'}</td></tr>`).join('')}
        </tbody></table></div>`;
    }
    html += `<details class="tl-details"${mine.length ? ' open' : ''}><summary>Giới hạn cá nhân của bạn (${mine.length})</summary>
        ${mine.length ? `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Giới hạn</th><th>Đối tượng</th><th class="text-right">Ngưỡng</th><th>Chế độ</th><th>Bật</th><th></th></tr></thead><tbody>
        ${mine.map(r => `<tr><td>${lmEsc(LimitsCalc.KINDS[r.kind].label)}</td><td>${lmEsc(r.symbol || r.sector || 'Tất cả')}</td><td class="text-right">${r.kind === 'blocked_symbol' ? '—' : lmNum(r.value, 2) + ' ' + lmEsc(LimitsCalc.KINDS[r.kind].unit)}</td>
            <td><span class="tl-badge ${LM_MODE_CLS[r.mode]}">${lmEsc(LimitsCalc.MODES[r.mode].label)}</span></td>
            <td><input type="checkbox" ${r.active ? 'checked' : ''} onchange="lmToggle('${r.id}', this.checked)" aria-label="Bật giới hạn"></td>
            <td><button type="button" class="tl-link tl-danger" onclick="lmRemove('${r.id}')"><i class="fa-solid fa-trash"></i></button></td></tr>`).join('')}</tbody></table></div>` : ''}
        <form class="lm-form" onsubmit="lmAdd(event)">
            <label>Loại<select id="lm-kind" class="tl-select" onchange="lmKindChanged()">${Object.keys(LimitsCalc.KINDS).map(k => `<option value="${k}">${lmEsc(LimitsCalc.KINDS[k].label)}</option>`).join('')}</select></label>
            <label id="lm-subject-wrap">Mã / ngành (tuỳ chọn)<input type="text" id="lm-subject" class="tl-input" placeholder="VD: FPT hoặc Ngân hàng" maxlength="40"></label>
            <label id="lm-value-wrap"><span id="lm-value-label">Ngưỡng (% NAV)</span><input type="number" id="lm-value" class="tl-input num" step="any" min="0" placeholder="25"></label>
            <label>Chế độ<select id="lm-mode" class="tl-select"><option value="reason">Phải ghi lý do</option><option value="warn">Chỉ cảnh báo</option><option value="block">Chặn</option></select></label>
            <button type="submit" class="btn-tool"><i class="fa-solid fa-plus"></i> Thêm</button>
        </form>
        <p class="tl-hint">Giới hạn cá nhân chỉ có thể <b>siết chặt thêm</b> so với giới hạn của nhóm: khi cả hai cùng áp dụng, mức chặt hơn được dùng. Chế độ “Chặn” với giới hạn của chính bạn vẫn cho quản lý ghi đè.</p></details>`;
    box.innerHTML = html;
    lmKindChanged();
}

function lmKindChanged() {
    const k = document.getElementById('lm-kind'); if (!k) return;
    const kind = k.value, K = LimitsCalc.KINDS[kind];
    document.getElementById('lm-subject-wrap').style.display = (K.subject === 'portfolio') ? 'none' : '';
    document.getElementById('lm-subject').placeholder = K.subject === 'sector' ? 'VD: Ngân hàng (bỏ trống = mọi ngành)' : (kind === 'blocked_symbol' ? 'Mã cần cấm, VD: ABC' : 'VD: FPT (bỏ trống = mọi mã)');
    document.getElementById('lm-value-wrap').style.display = kind === 'blocked_symbol' ? 'none' : '';
    document.getElementById('lm-value-label').textContent = `Ngưỡng (${K.unit})`;
}

async function lmAdd(e) {
    e.preventDefault();
    const kind = document.getElementById('lm-kind').value, K = LimitsCalc.KINDS[kind];
    const subject = document.getElementById('lm-subject').value.trim();
    const limit = { scope: 'user', kind, value: document.getElementById('lm-value').value, mode: document.getElementById('lm-mode').value };
    if (K.subject === 'symbol') limit.symbol = subject.toUpperCase();
    else if (K.subject === 'sector') limit.sector = subject;
    try {
        const msg = await lmCall('saveLimit', { limit });
        showToast(msg, 'success');
        await loadLimitsPanel(true);
    } catch (err) { showToast('Lỗi: ' + err.message, 'error'); }
}
async function lmToggle(id, on) {
    try { await lmCall('setLimitActive', { id, active: on }); await loadLimitsPanel(true); } catch (err) { showToast('Lỗi: ' + err.message, 'error'); }
}
async function lmRemove(id) {
    if (!confirm('Xoá giới hạn này?')) return;
    try { await lmCall('removeLimit', { id }); await loadLimitsPanel(true); } catch (err) { showToast('Lỗi: ' + err.message, 'error'); }
}
