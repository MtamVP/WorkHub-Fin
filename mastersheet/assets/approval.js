/* --- FILE: /mastersheet/assets/approval.js ---
   Duyệt lệnh lớn, phía người đặt lệnh: (1) cổng kiểm tra trước khi ghi -- lệnh vượt ngưỡng của nhóm phải có đề xuất đã được quản lý duyệt, chưa có thì mời
   gửi đề xuất kèm lý do thay vì ghi; (2) danh sách "Đề xuất lệnh của tôi" ở Sổ Lệnh với trạng thái, hạn dùng và nút điền sẵn vào form khi đã được duyệt.
   Quy tắc ở /lib/approval-calc.js (có kiểm thử); việc ép thật nằm ở api.js (addTransaction). Quản lý duyệt ở Toàn Nhóm > Duyệt Lệnh.
   Dùng global của script.js / limits.js: callGAS, targetEmail, showToast, escapeAssetHtml, pickTxnType. Dùng lại khung #lim-modal. */

const AP = { rows: [], policy: null, state: 'idle', pending: null, ideas: null };

const apEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const apNum = (v, d) => Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: d === undefined ? 0 : d });
const apVnd = (v) => apNum(Math.round(Number(v) || 0), 0) + ' đ';
const apToday = () => new Date().toISOString().slice(0, 10);
function apDate(iso) { const d = new Date(iso); return isNaN(d) ? '' : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; }

async function apCall(action, params) {
    const r = await callGAS(action, Object.assign({ email: targetEmail }, params || {}));
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}

// ---------- 1) Cổng trước khi ghi lệnh ----------
// Trả null (cứ ghi) hoặc false (dừng: đã mở khung mời gửi đề xuất). Không kiểm được (mạng...) thì để api.js chặn khi ghi nếu thật sự cần.
async function approvalGate(txn) {
    const trade = { type: txn.type === 'sell' ? 'sell' : 'buy', symbol: String(txn.symbol || '').trim().toUpperCase(), quantity: Number(txn.quantity) || 0, price: Number(txn.price) || 0 };
    if (!trade.symbol || !(trade.quantity > 0) || !(trade.price > 0)) return null;
    let chk;
    try { chk = await apCall('checkTradeApproval', { trade }); } catch (e) { return null; }
    if (!chk || !chk.needed || chk.match) return null;
    apShowRequest(trade, chk);
    return false;
}

function apShowRequest(trade, chk) {
    AP.pending = { trade, chk };
    const dup = AP.rows.find(r => r.status === 'pending' && r.symbol === trade.symbol && r.side === trade.type);
    const planReason = (document.getElementById('txn-plan-reason') || {}).value || '';
    const why = [chk.byPct ? `${apNum(chk.pct, 1)}% NAV (ngưỡng ${apNum(chk.policy.thresholdPct, 1)}%)` : '', chk.byVnd ? `${apVnd(chk.value)} (ngưỡng ${apVnd(chk.policy.thresholdVnd)})` : ''].filter(Boolean).join(' và ');
    document.getElementById('lim-modal-title').innerHTML = '<i class="fa-solid fa-stamp" style="color: var(--warning-color);"></i> Lệnh lớn cần quản lý duyệt';
    document.getElementById('lim-modal-body').innerHTML = `
        <div class="ap-box">Lệnh <b>${trade.type === 'sell' ? 'bán' : 'mua'} ${apEsc(trade.symbol)}</b> ${apNum(trade.quantity)} cổ × ${apNum(trade.price)} = <b>${apVnd(chk.value)}</b> vượt ngưỡng duyệt của nhóm: ${apEsc(why)}.
            Lệnh <b>chưa được ghi</b>. Gửi đề xuất cho quản lý; khi được duyệt (hiệu lực ${chk.policy.validDays} ngày) bạn quay lại ghi đúng lệnh này.</div>
        ${dup ? `<div class="conc-warn"><i class="fa-solid fa-circle-info"></i><span>Bạn đã có một đề xuất ${trade.type === 'sell' ? 'bán' : 'mua'} ${apEsc(trade.symbol)} đang chờ duyệt (${apVnd(dup.value)}). Gửi thêm sẽ tạo đề xuất thứ hai.</span></div>` : ''}
        <div class="txn-field txn-field-wide" id="ap-idea-wrap" style="display:none"><label for="ap-idea">Ý tưởng đầu tư liên quan (tuỳ chọn — để theo dõi hành trình từ ý tưởng tới lệnh)</label><select id="ap-idea" class="tl-select"><option value="">Không gắn ý tưởng</option></select></div>
        <div class="txn-field txn-field-wide"><label for="ap-reason">Lý do đề xuất (bắt buộc, ít nhất 10 ký tự)</label>
            <textarea id="ap-reason" rows="4" maxlength="1000" placeholder="Luận điểm đầu tư, vì sao cỡ lệnh này, điểm cắt lỗ / giá mục tiêu…" oninput="document.getElementById('ap-send').disabled = this.value.trim().length < 10">${apEsc(planReason)}</textarea>
            <span class="tl-hint" style="margin:0">Quản lý đọc lý do này để duyệt hoặc từ chối. Người duyệt phải là người khác bạn.</span></div>`;
    document.getElementById('lim-modal-footer').innerHTML = '<button type="button" class="btn-tool" onclick="apClose()">Đóng</button>'
        + `<button type="button" class="btn-save" id="ap-send" ${planReason.trim().length >= 10 ? '' : 'disabled'} onclick="apSend()"><i class="fa-solid fa-paper-plane"></i> Gửi đề xuất</button>`;
    document.getElementById('lim-modal').classList.add('open');
    apLoadIdeas(trade);
}

// Ý tưởng đang mở của đúng mã (đã duyệt / vào danh mục / chờ phản biện); chỉ có đúng một thì chọn sẵn
async function apLoadIdeas(trade) {
    try {
        if (!AP.ideas) AP.ideas = (await apCall('listIdeas')).ideas || [];
        const list = AP.ideas.filter(i => String(i.symbol).toUpperCase() === trade.symbol && ['approved', 'in_portfolio', 'review'].includes(i.status) && i.direction !== 'avoid');
        const sel = document.getElementById('ap-idea'), wrap = document.getElementById('ap-idea-wrap');
        if (!sel || !wrap || !list.length || !AP.pending) return;
        sel.innerHTML = '<option value="">Không gắn ý tưởng</option>' + list.map(i => `<option value="${apEsc(i.id)}">${apEsc(i.title)}</option>`).join('');
        if (list.length === 1) sel.value = list[0].id;
        wrap.style.display = '';
    } catch (e) { /* không lấy được ý tưởng: bỏ qua phần tuỳ chọn này */ }
}

function apClose() { document.getElementById('lim-modal').classList.remove('open'); AP.pending = null; }

async function apSend() {
    const p = AP.pending;
    if (!p) return;
    const btn = document.getElementById('ap-send');
    const reason = String((document.getElementById('ap-reason') || {}).value || '').trim();
    if (btn) btn.disabled = true;
    try {
        const ideaSel = document.getElementById('ap-idea');
        const msg = await apCall('createOrderRequest', { request: { symbol: p.trade.symbol, side: p.trade.type, quantity: p.trade.quantity, price: p.trade.price, reason, ideaId: ideaSel && ideaSel.value ? ideaSel.value : undefined } });
        apClose();
        showToast(msg, 'success');
        apLoadMine();
    } catch (e) { if (btn) btn.disabled = false; showToast('Lỗi: ' + e.message, 'error'); }
}

// Mở khung đề xuất từ ô "Kiểm tra trước lệnh" (người dùng chủ động gửi trước khi ghi lệnh)
async function apOpenFromForm() {
    const g = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const trade = { type: g('txn-type') === 'sell' ? 'sell' : 'buy', symbol: String(g('txn-symbol')).trim().toUpperCase(), quantity: Number(g('txn-quantity')) || 0, price: Number(g('txn-price')) || 0 };
    if (!trade.symbol || !(trade.quantity > 0) || !(trade.price > 0)) { showToast('Nhập mã, khối lượng và giá của lệnh trước khi gửi đề xuất.', 'error'); return; }
    let chk;
    try { chk = await apCall('checkTradeApproval', { trade }); } catch (e) { showToast('Lỗi: ' + e.message, 'error'); return; }
    if (!chk.policyActive) { showToast('Nhóm chưa bật quy định duyệt lệnh.', 'error'); return; }
    if (!chk.needed) { showToast('Lệnh này dưới ngưỡng duyệt nên không cần đề xuất.', 'success'); return; }
    if (chk.match) { showToast('Bạn đã có đề xuất được duyệt cho lệnh này; cứ ghi lệnh.', 'success'); return; }
    apShowRequest(trade, chk);
}

// ---------- 2) Đề xuất của tôi ----------
async function apLoadMine() {
    const box = document.getElementById('ap-my');
    if (!box || typeof ApprovalCalc === 'undefined') return;
    try {
        const [rows, policy] = await Promise.all([apCall('listOrderRequests', { limit: 40 }), apCall('getApprovalPolicy')]);
        AP.rows = rows; AP.policy = policy; AP.state = 'ok';
    } catch (e) { AP.state = 'error'; box.style.display = 'none'; return; }
    apRenderMine();
}

function apRenderMine() {
    const box = document.getElementById('ap-my'), body = document.getElementById('ap-my-body'), sum = document.getElementById('ap-my-sum');
    if (!box || !body) return;
    const today = apToday();
    // Quy định tắt và chưa từng có đề xuất: không làm rối giao diện
    if (!(AP.policy && AP.policy.active) && !AP.rows.length) { box.style.display = 'none'; return; }
    box.style.display = '';
    const s = ApprovalCalc.summarize(AP.rows, today);
    sum.textContent = `Đề xuất lệnh lớn của tôi (${s.pending ? s.pending + ' chờ duyệt' : (s.approved ? s.approved + ' đã duyệt' : AP.rows.length)})`;
    const pol = AP.policy && AP.policy.active
        ? `<p class="tl-hint" style="margin:0 0 8px">Lệnh ${[AP.policy.thresholdPct ? 'trên <b>' + apNum(AP.policy.thresholdPct, 1) + '% NAV</b>' : '', AP.policy.thresholdVnd ? 'trên <b>' + apVnd(AP.policy.thresholdVnd) + '</b>' : ''].filter(Boolean).join(' hoặc ')} cần quản lý duyệt trước khi ghi. Đề xuất đã duyệt có hiệu lực ${AP.policy.validDays} ngày.</p>`
        : '<p class="tl-hint" style="margin:0 0 8px">Nhóm đang tắt quy định duyệt lệnh.</p>';
    if (!AP.rows.length) { body.innerHTML = pol + '<div class="tl-empty" style="padding:10px">Bạn chưa có đề xuất nào.</div>'; return; }
    body.innerHTML = pol + `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Gửi lúc</th><th>Lệnh</th><th class="text-right">Giá trị</th><th>Trạng thái</th><th>Ghi chú của quản lý</th><th></th></tr></thead><tbody>
        ${AP.rows.map(r => { const st = ApprovalCalc.effectiveStatus(r, today), S = ApprovalCalc.STATUS[st] || { label: st, tone: 'mute' };
            const usable = st === 'approved';
            return `<tr><td>${apDate(r.created_at)}</td><td><span class="txn-type-badge ${r.side === 'sell' ? 'sell' : 'buy'}">${r.side === 'sell' ? 'Bán' : 'Mua'}</span> <b>${apEsc(r.symbol)}</b> ${apNum(r.quantity)} × ${apNum(r.price_ref)}</td>
                <td class="text-right">${apVnd(r.value)}${r.order_pct === null || r.order_pct === undefined ? '' : `<span class="symbol-sub">${apNum(r.order_pct, 1)}% NAV</span>`}</td>
                <td><span class="tl-badge ${S.tone}">${S.label}</span>${usable ? `<span class="symbol-sub">dùng được tới ${apDate(r.valid_until + 'T00:00:00')}</span>` : ''}</td>
                <td class="gq-reason">${apEsc(r.decision_note || '')}</td>
                <td>${usable ? `<button type="button" class="btn-tool" onclick="apFill('${r.id}')"><i class="fa-solid fa-arrow-up-right-from-square"></i> Điền vào form</button> ` : ''}${st === 'pending' || st === 'approved' ? `<button type="button" class="tl-link tl-danger" onclick="apCancel('${r.id}')">Huỷ</button>` : ''}</td></tr>`; }).join('')}
        </tbody></table></div>`;
}

function apFill(id) {
    const r = AP.rows.find(x => x.id === id);
    if (!r) return;
    const btn = document.querySelector('#txn-form .seg button[data-v="' + (r.side === 'sell' ? 'sell' : 'buy') + '"]');
    if (btn && typeof pickTxnType === 'function') pickTxnType(btn);
    const set = (el, v) => { const e = document.getElementById(el); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); } };
    set('txn-symbol', r.symbol); set('txn-quantity', r.quantity); set('txn-price', r.price_ref);
    const form = document.getElementById('txn-form');
    if (form && form.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('Đã điền lệnh đã duyệt vào form — kiểm tra giá thực tế rồi bấm Lưu lệnh (giá trị được phép lệch tối đa +5% so với đã duyệt).', 'success');
}

async function apCancel(id) {
    if (!confirm('Huỷ đề xuất này?')) return;
    try { showToast(await apCall('cancelOrderRequest', { id }), 'success'); apLoadMine(); } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}
