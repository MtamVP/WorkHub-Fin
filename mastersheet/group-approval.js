/* --- FILE: /mastersheet/group-approval.js ---
   Trang Toàn Nhóm > "Duyệt Lệnh": quản lý đặt QUY ĐỊNH DUYỆT LỆNH LỚN (ngưỡng % NAV và/hoặc số tiền, hạn dùng của đề xuất đã duyệt), xem hàng chờ duyệt,
   duyệt / từ chối đề xuất lệnh của thành viên, và xem lịch sử quyết định. Nguyên tắc hai người (không tự duyệt lệnh của mình) do /lib/approval-calc.js kiểm trên giao diện
   và do trigger DB finance_order_requests kiểm thật. Việc ghi lệnh yêu cầu đề xuất đã duyệt do api.js (addTransaction) ép.
   Dùng global của group.js (GR, grCall, grRender), group-limits.js (GL, glDate) và assets/risk.js (rkEsc, rkNum, rkVnd, rkKpi). */

const GQ = { state: 'idle', error: '', policy: null, rows: [], draft: null, saving: false, busy: '' };

function gqToday() { return new Date().toISOString().slice(0, 10); }
function gqManager() { return !!(typeof GL !== 'undefined' && GL.actor && GL.actor.isManager); }
function gqActor() {
    const a = (typeof GL !== 'undefined' && GL.actor) || {};
    return { isManager: !!a.isManager, isAdmin: !!a.isAdmin, actorId: a.actorId, canSelfApprove: !!(GQ.policy && (GQ.policy.selfApprovers || []).includes(a.actorId)) };
}
function gqName(id) {
    const m = GR.data && GR.data.members ? GR.data.members.find(x => x.id === id) : null;
    return m ? (m.nickname || String(m.email || '').split('@')[0]) : 'Thành viên';
}
function gqPending() { return GQ.rows.filter(r => ApprovalCalc.effectiveStatus(r, gqToday()) === 'pending'); }

function gqUpdateBadge() {
    const b = document.getElementById('grp-appr-badge');
    if (!b) return;
    const n = gqPending().length;
    b.textContent = n ? String(n) : '';
    b.style.display = n ? '' : 'none';
}

async function gqLoad(force) {
    if (GQ.state === 'loading') return;
    if (GQ.state === 'ok' && !force) { gqUpdateBadge(); if (GR.tab === 'approvals') grRender(); return; }
    GQ.state = 'loading'; GQ.error = '';
    if (GR.tab === 'approvals') grRender();
    try {
        const [policy, rows] = await Promise.all([grCall('getApprovalPolicy'), grCall('listAllOrderRequests', { days: 120 })]);
        GQ.policy = policy; GQ.rows = rows; GQ.draft = null; GQ.state = 'ok';
    } catch (e) { GQ.state = 'error'; GQ.error = e.message || String(e); }
    gqUpdateBadge();
    if (GR.tab === 'approvals') grRender();
}

// ---------- quy định ----------
function gqDraft() {
    if (!GQ.draft) { const p = GQ.policy || { active: false, thresholdPct: null, thresholdVnd: null, validDays: 3 }; GQ.draft = { active: !!p.active, thresholdPct: p.thresholdPct, thresholdVnd: p.thresholdVnd, validDays: p.validDays || 3 }; }
    return GQ.draft;
}
function gqSetDraft(key, v) {
    const d = gqDraft();
    if (key === 'active') d.active = !!v;
    else if (key === 'validDays') d.validDays = Number(v) || 3;
    else d[key] = (v === '' || v === null) ? null : Number(String(v).replace(/[.\s]/g, '').replace(',', '.'));
}
async function gqSavePolicy() {
    if (GQ.saving) return;
    GQ.saving = true;
    try {
        const msg = await grCall('saveApprovalPolicy', { policy: gqDraft(), email: (GL.actor && GL.actor.actorEmail) || '' });
        showToast(msg, 'success');
        GQ.saving = false;
        await gqLoad(true);
    } catch (e) { GQ.saving = false; showToast('Lỗi: ' + e.message, 'error'); }
}

async function gqSaveSelfApprovers() {
    const ids = [...document.querySelectorAll('.gq-selfapp:checked')].map(c => c.value);
    try { showToast(await grCall('setSelfApprovers', { ids, email: (GL.actor && GL.actor.actorEmail) || '' }), 'success'); await gqLoad(true); } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

// Chỉ admin thấy: chọn ai được miễn nguyên tắc hai người (tự duyệt lệnh của mình, vẫn phải ghi lý do)
function gqExemptHtml() {
    const sel = (GQ.policy && GQ.policy.selfApprovers) || [];
    const names = sel.map(gqName);
    let html = `<div class="ce-group-title" style="margin-top:22px">Ngoại lệ nguyên tắc hai người</div>
        <p class="tl-hint" style="margin:0 0 8px">Admin luôn được tự duyệt. ${sel.length ? 'Ngoài admin, đang được miễn: <b>' + names.map(rkEsc).join(', ') + '</b>.' : 'Hiện không ai khác được miễn.'} Người được miễn vẫn phải ghi lý do (≥ 10 ký tự) khi tự duyệt, và lịch sử gắn nhãn “tự duyệt”.</p>`;
    if (!gqActor().isAdmin) return html;
    const managers = (GR.data.members || []);
    return html + `<div class="gq-exempt">${managers.map(m => `<label class="tl-check"><input type="checkbox" class="gq-selfapp" value="${rkEsc(m.id)}" ${sel.includes(m.id) ? 'checked' : ''}> ${rkEsc(m.nickname || String(m.email || '').split('@')[0])}</label>`).join('')}</div>
        <div class="gs-actions"><button type="button" class="btn-save" onclick="gqSaveSelfApprovers()"><i class="fa-solid fa-floppy-disk"></i> Lưu danh sách miễn</button></div>`;
}

function gqPolicyHtml() {
    const manager = gqManager(), p = GQ.policy || { active: false };
    const summary = p.active
        ? `Đang <b>bật</b>: lệnh có giá trị ${[p.thresholdPct ? `trên <b>${rkNum(p.thresholdPct, 1)}% NAV</b>` : '', p.thresholdVnd ? `trên <b>${rkVnd(p.thresholdVnd)}</b>` : ''].filter(Boolean).join(' hoặc ')} phải được quản lý duyệt trước khi ghi; đề xuất đã duyệt có hiệu lực <b>${p.validDays} ngày</b>.`
        : 'Đang <b>tắt</b>: mọi lệnh ghi bình thường, không cần duyệt.';
    let html = `<div class="ce-group-title">Quy định duyệt lệnh lớn</div><p class="tl-hint" style="margin:0 0 10px">${summary}</p>`;
    if (!manager) return html + '<p class="tl-hint">Chỉ quản lý danh mục / admin được đổi quy định.</p>';
    const d = gqDraft();
    return html + `<form class="lm-form" onsubmit="event.preventDefault(); gqSavePolicy()">
        <label>Bật duyệt lệnh<select class="tl-select" onchange="gqSetDraft('active', this.value === '1')"><option value="0" ${d.active ? '' : 'selected'}>Tắt</option><option value="1" ${d.active ? 'selected' : ''}>Bật</option></select></label>
        <label>Ngưỡng % NAV<input type="number" class="tl-input num" min="0" max="100" step="0.5" value="${d.thresholdPct === null ? '' : d.thresholdPct}" placeholder="VD: 10" oninput="gqSetDraft('thresholdPct', this.value)"></label>
        <label>Ngưỡng số tiền (đ)<input type="number" class="tl-input num" min="0" step="1000000" value="${d.thresholdVnd === null ? '' : d.thresholdVnd}" placeholder="VD: 200000000" oninput="gqSetDraft('thresholdVnd', this.value)"></label>
        <label>Hạn dùng (ngày)<input type="number" class="tl-input num" min="1" max="30" step="1" value="${d.validDays}" oninput="gqSetDraft('validDays', this.value)"></label>
        <button type="submit" class="btn-save" ${GQ.saving ? 'disabled' : ''}><i class="fa-solid fa-floppy-disk"></i> Lưu quy định</button></form>
        <p class="tl-hint">Vượt <b>một trong hai</b> ngưỡng là cần duyệt (bỏ trống ngưỡng nào thì không dùng ngưỡng đó). Áp dụng cho cả lệnh mua và bán ghi mới; lệnh nhập từ sao kê (đã xảy ra) và lệnh điều chỉnh khi đối soát không phải duyệt. Đây là kiểm soát trong ứng dụng, nên phần đối soát hằng ngày vẫn là lớp kiểm độc lập.</p>`;
}

// ---------- hàng chờ và lịch sử ----------
function gqRowSummary(r) {
    return `<span class="txn-type-badge ${r.side === 'sell' ? 'sell' : 'buy'}">${r.side === 'sell' ? 'Bán' : 'Mua'}</span> <b>${rkEsc(r.symbol)}</b> ${rkNum(r.quantity, 0)} cp × ${rkNum(r.price_ref, 0)}`;
}
function gqPctText(r) { return r.order_pct === null || r.order_pct === undefined ? '—' : `${rkNum(r.order_pct, 1)}% NAV`; }

async function gqDecide(id, decision) {
    if (GQ.busy) return;
    const noteEl = document.getElementById('gq-note-' + id);
    const note = noteEl ? noteEl.value.trim() : '';
    const req = GQ.rows.find(r => r.id === id);
    const can = ApprovalCalc.canDecide(gqActor(), req, decision, note);
    if (!can.allowed) { showToast(can.reason, 'error'); return; }
    if (can.selfApproval && !confirm('Bạn đang tự duyệt lệnh của chính mình (ngoại lệ được cấp cho bạn). Lý do sẽ được lưu cùng quyết định. Tiếp tục?')) return;
    GQ.busy = id;
    try {
        const msg = await grCall('decideOrderRequest', { id, decision, note, email: (GL.actor && GL.actor.actorEmail) || '' });
        showToast(msg, 'success');
        GQ.busy = '';
        await gqLoad(true);
    } catch (e) { GQ.busy = ''; showToast('Lỗi: ' + e.message, 'error'); }
}
async function gqCancel(id) {
    if (!confirm('Huỷ đề xuất này?')) return;
    try { showToast(await grCall('cancelOrderRequest', { id }), 'success'); await gqLoad(true); } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}

function gqQueueHtml() {
    const rows = gqPending().slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    if (!rows.length) return '<div class="ce-group-title">Đang chờ duyệt</div><div class="tl-empty"><i class="fa-solid fa-circle-check"></i>Không có đề xuất nào đang chờ.</div>';
    const actor = gqActor();
    return `<div class="ce-group-title">Đang chờ duyệt (${rows.length})</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Thành viên</th><th>Lệnh đề xuất</th><th class="text-right">Giá trị</th><th>Lý do</th><th>Gửi lúc</th><th>Quyết định</th></tr></thead><tbody>
        ${rows.map(r => {
            const own = r.user_id === actor.actorId || r.created_by === actor.actorId;
            const act = !actor.isManager ? (own ? `<button type="button" class="tl-link tl-danger" onclick="gqCancel('${r.id}')">Huỷ đề xuất</button>` : '<span class="tl-hint" style="margin:0">Chờ quản lý</span>')
                : (own && !(actor.isAdmin || actor.canSelfApprove) ? '<span class="tl-hint" style="margin:0">Không tự duyệt lệnh của mình — nhờ quản lý khác</span> <button type="button" class="tl-link tl-danger" onclick="gqCancel(\'' + r.id + '\')">Huỷ</button>'
                    : `<div class="gq-act"><input type="text" id="gq-note-${r.id}" class="tl-input" maxlength="500" placeholder="${own ? 'Lý do tự duyệt (≥ 10 ký tự)' : 'Ghi chú (bắt buộc khi từ chối)'}">
                       <button type="button" class="btn-save" onclick="gqDecide('${r.id}', 'approved')" ${GQ.busy ? 'disabled' : ''}><i class="fa-solid fa-check"></i> Duyệt</button>
                       <button type="button" class="btn-tool" onclick="gqDecide('${r.id}', 'rejected')" ${GQ.busy ? 'disabled' : ''}><i class="fa-solid fa-xmark"></i> Từ chối</button></div>`);
            return `<tr><td><b>${rkEsc(gqName(r.user_id))}</b>${r.created_by && r.created_by !== r.user_id ? `<span class="symbol-sub">nhập bởi ${rkEsc(gqName(r.created_by))}</span>` : ''}</td><td>${gqRowSummary(r)}</td>
                <td class="text-right">${rkVnd(r.value)}<span class="symbol-sub">${gqPctText(r)}</span></td><td class="gq-reason">${rkEsc(r.reason)}</td><td>${glDate(r.created_at)}</td><td>${act}</td></tr>`;
        }).join('')}</tbody></table></div>`;
}

function gqHistoryHtml() {
    const today = gqToday();
    const rows = GQ.rows.filter(r => ApprovalCalc.effectiveStatus(r, today) !== 'pending').sort((a, b) => ((b.decided_at || b.created_at) < (a.decided_at || a.created_at) ? -1 : 1)).slice(0, 80);
    if (!rows.length) return '';
    return `<div class="ce-group-title">Lịch sử quyết định</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Thành viên</th><th>Lệnh</th><th class="text-right">Giá trị</th><th>Trạng thái</th><th>Người duyệt</th><th>Ghi chú</th><th>Hạn dùng</th></tr></thead><tbody>
        ${rows.map(r => { const st = ApprovalCalc.effectiveStatus(r, today), S = ApprovalCalc.STATUS[st] || { label: st, tone: 'mute' };
            const self = r.decided_by && (r.decided_by === r.user_id || r.decided_by === r.created_by);
            return `<tr><td>${rkEsc(gqName(r.user_id))}</td><td>${gqRowSummary(r)}</td><td class="text-right">${rkVnd(r.value)}<span class="symbol-sub">${gqPctText(r)}</span></td>
                <td><span class="tl-badge ${S.tone}">${S.label}</span>${self ? ' <span class="tl-badge warn" title="Admin tự duyệt lệnh của mình, có ghi lý do">tự duyệt</span>' : ''}</td>
                <td>${r.decided_by ? rkEsc(gqName(r.decided_by)) + `<span class="symbol-sub">${glDate(r.decided_at)}</span>` : '—'}</td><td class="gq-reason">${rkEsc(r.decision_note || '')}</td>
                <td>${r.valid_until && (st === 'approved' || st === 'expired') ? glDate(r.valid_until + 'T00:00:00') : '—'}</td></tr>`; }).join('')}</tbody></table></div>`;
}

function grApprovalHtml() {
    if (GQ.state === 'loading' || GQ.state === 'idle') return '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang tải đề xuất lệnh…</div>';
    if (GQ.state === 'error') return `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không tải được: ${rkEsc(GQ.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="gqLoad(true)">Thử lại</button></div>`;
    const s = ApprovalCalc.summarize(GQ.rows, gqToday());
    return `<div class="tl-kpis">${[
        rkKpi('Đang chờ duyệt', String(s.pending), s.pending ? 'cần quản lý xử lý' : 'không tồn đọng', s.pending ? 'tl-down' : ''),
        rkKpi('Đã duyệt, chưa dùng', String(s.approved), 'còn hạn'),
        rkKpi('Đã thực hiện', String(s.executed), '120 ngày qua'),
        rkKpi('Bị từ chối', String(s.rejected), '120 ngày qua'),
        rkKpi('Hết hạn / huỷ', String(s.expired + s.cancelled), 'không dùng tới'),
    ].join('')}</div>` + gqQueueHtml() + gqHistoryHtml() + `<div style="margin-top:22px">${gqPolicyHtml()}</div>` + gqExemptHtml();
}
