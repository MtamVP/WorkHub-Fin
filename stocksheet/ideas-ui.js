/* --- FILE: /stocksheet/ideas-ui.js ---
   Nghiên Cứu > "Ý tưởng": quy trình ý tưởng đầu tư của nhóm -- ghi ý tưởng, nghiên cứu, gửi phản biện, thành viên khác bình luận/phản biện/bỏ phiếu, quản lý duyệt hoặc bác,
   đưa vào danh mục, theo dõi kết quả so với VN-Index và đóng lại; kèm bảng thành tích từng thành viên. Quy tắc ở /lib/ideas.js (có kiểm thử), việc kiểm quyền ở api.js.
   Dùng global của script.js: state (các mã đã định giá), call, showToast, VU (ValuationUI), VC (ValuationCalc), DecisionJournal. */

const ID = {
    state: 'idle',            // idle | loading | ok | error
    error: '',
    raw: null,                // { ideas, votes, comments, members }
    ideas: [],                // đã normalize
    marks: { prices: {}, index: null },
    evals: {},
    actor: null,
    filter: 'all', query: '',
    detail: null,             // { id, idea, comments, votes }
    form: null,               // đang soạn
};
const ID_FILTERS = [['all', 'Tất cả'], ['mine', 'Của tôi'], ['review', 'Chờ phản biện'], ['approved', 'Đã duyệt'], ['in_portfolio', 'Đang giữ'], ['open', 'Đang mở'], ['closed', 'Đã đóng'], ['rejected', 'Bị bác']];

const idEsc = (s) => VU.esc(s === null || s === undefined ? '' : String(s));
const idPct = (v, d, sign) => (v === null || v === undefined || !isFinite(v)) ? '—' : `${sign && v > 0 ? '+' : (v < 0 ? '−' : '')}${Math.abs(v).toLocaleString('vi-VN', { minimumFractionDigits: d === undefined ? 1 : d, maximumFractionDigits: d === undefined ? 1 : d })}%`;
const idCls = (v) => v > 0 ? 'pnl-up' : (v < 0 ? 'pnl-down' : 'pnl-flat');
const idDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };
const idAgo = (iso) => { const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000); return isNaN(d) ? '' : (d <= 0 ? 'hôm nay' : d + ' ngày trước'); };
const idName = (userId) => (ID.raw && ID.raw.members[userId]) || 'Thành viên';

async function loadIdeas(force) {
    const root = document.getElementById('id-root');
    if (!root) return;
    if (ID.state === 'loading') return;
    if (ID.state === 'ok' && !force) { renderIdeas(); return; }
    ID.state = 'loading';
    root.innerHTML = '<div class="vl-empty"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải ý tưởng…</div>';
    try {
        const [raw, actor] = await Promise.all([call('listIdeas'), call('getLimitActor', { email: localStorage.getItem('userEmail') || '' }).catch(() => ({ isManager: false, actorId: null }))]);
        ID.raw = raw; ID.actor = actor;
        ID.ideas = raw.ideas.map(IdeaFlow.normalize);
        const symbols = [...new Set(ID.ideas.filter(i => i.status !== 'closed').map(i => i.symbol))];
        ID.marks = symbols.length ? await call('getIdeaMarks', { symbols }).catch(() => ({ prices: {}, index: null })) : { prices: {}, index: null };
        idEvaluate();
        ID.state = 'ok';
    } catch (e) { ID.state = 'error'; ID.error = e.message || String(e); }
    renderIdeas();
}

function idEvaluate() {
    ID.evals = {};
    ID.ideas.forEach(i => {
        const m = ID.marks.prices[i.symbol];
        ID.evals[i.id] = IdeaFlow.evaluate(i, { nowPrice: m ? m.price : null, indexNow: ID.marks.index });
    });
}

function idMine(i) { return !!(ID.actor && ID.actor.actorId && i.userId === ID.actor.actorId); }
function idVotesOf(id) { return (ID.raw.votes || []).filter(v => v.idea_id === id); }
function idCommentsOf(id) { return (ID.raw.comments || []).filter(c => c.idea_id === id); }

function idFiltered() {
    const q = ID.query.trim().toUpperCase();
    return ID.ideas.filter(i => {
        if (q && i.symbol.indexOf(q) === -1 && i.title.toUpperCase().indexOf(q) === -1) return false;
        switch (ID.filter) {
            case 'mine': return idMine(i);
            case 'open': return IdeaFlow.OPEN_STATUSES.includes(i.status);
            case 'all': return true;
            default: return i.status === ID.filter;
        }
    }).sort((a, b) => (IdeaFlow.STATUSES[a.status].order === 2 ? -1 : 0) - (IdeaFlow.STATUSES[b.status].order === 2 ? -1 : 0) || (a.updatedAt < b.updatedAt ? 1 : -1));
}

function idPill(status) { const s = IdeaFlow.STATUSES[status]; return `<span class="tl-badge ${s.tone}">${idEsc(s.label)}</span>`; }

function renderIdeas() {
    const root = document.getElementById('id-root');
    if (!root) return;
    if (ID.state === 'loading' || ID.state === 'idle') return;
    if (ID.state === 'error') { root.innerHTML = `<div class="vl-empty">Không tải được ý tưởng: ${idEsc(ID.error)}<br><button type="button" class="btn-refresh" style="margin-top:10px" onclick="loadIdeas(true)">Thử lại</button></div>`; return; }
    const all = ID.ideas;
    const count = (f) => f(all).length;
    const waiting = count(a => a.filter(i => i.status === 'review'));
    const approvedNotIn = count(a => a.filter(i => i.status === 'approved'));
    const closed = all.filter(i => i.status === 'closed' && ID.evals[i.id] && ID.evals[i.id].status === 'closed');
    const wins = closed.filter(i => ID.evals[i.id].win).length;
    const rows = idFiltered();
    let html = `<div class="vl-summary">
        <div class="vl-sum"><span class="vl-sum-label">Ý tưởng đang mở</span><span class="vl-sum-value">${count(a => a.filter(i => IdeaFlow.OPEN_STATUSES.includes(i.status)))}<small>${all.length} tổng cộng</small></span></div>
        <div class="vl-sum"><span class="vl-sum-label">Chờ phản biện</span><span class="vl-sum-value">${waiting}<small>cần thành viên xem</small></span></div>
        <div class="vl-sum"><span class="vl-sum-label">Đã duyệt, chưa vào danh mục</span><span class="vl-sum-value">${approvedNotIn}<small>chờ quyết định mua</small></span></div>
        <div class="vl-sum"><span class="vl-sum-label">Tỷ lệ ý tưởng đúng</span><span class="vl-sum-value">${closed.length ? idPct(wins / closed.length * 100, 0) : '—'}<small>${closed.length} ý tưởng đã đóng</small></span></div>
    </div>
    <div class="vl-filters" role="group" aria-label="Lọc ý tưởng">${ID_FILTERS.map(f => `<button type="button" class="vl-chip" aria-pressed="${ID.filter === f[0]}" onclick="idSetFilter('${f[0]}')">${f[1]}</button>`).join('')}
        <input type="search" class="vl-search" id="id-search" placeholder="Tìm mã hoặc tiêu đề…" aria-label="Tìm ý tưởng" value="${idEsc(ID.query)}" oninput="idSearch(this.value)">
        <button type="button" class="btn-save" onclick="openIdeaForm()"><i class="fa-solid fa-plus"></i> Ý tưởng mới</button></div>`;
    html += rows.length ? `<div class="spreadsheet-wrapper vl-table-wrap"><table class="vl-ov id-table"><thead><tr><th class="left">Mã · ý tưởng</th><th class="left">Trạng thái</th><th>Giá ghi nhận → mục tiêu</th><th>Kết quả</th><th>Tự tin</th><th>Phiếu</th><th>Thảo luận</th></tr></thead><tbody>
        ${rows.map(i => idRow(i)).join('')}</tbody></table></div>` : '<div class="stock-empty-state"><i class="fa-solid fa-lightbulb"></i><p>Chưa có ý tưởng nào khớp. Bấm “Ý tưởng mới” để ghi lại luận điểm đầu tiên của bạn.</p></div>';
    html += idScoreboardHtml();
    html += idCapabilityHtml();
    html += '<p class="vl-hint">Mọi ý tưởng — kể cả bị bác — được theo dõi kết quả so với VN-Index kể từ lúc ghi nhận giá, để nhóm biết cả quyết định duyệt lẫn bác đúng hay sai. Kết quả chỉ để học hỏi, không phải khuyến nghị đầu tư.</p>';
    root.innerHTML = html;
}

function idRow(i) {
    const e = ID.evals[i.id] || { status: 'nodata' };
    const t = IdeaFlow.voteTally(idVotesOf(i.id));
    const cm = idCommentsOf(i.id);
    const open = IdeaFlow.openChallenges(cm, i.userId).length;
    const up = i.entry > 0 && i.target > 0 ? (i.target / i.entry - 1) * 100 : null;
    return `<tr class="vl-row" tabindex="0" role="link" data-idea="${idEsc(i.id)}" onclick="openIdea('${idEsc(i.id)}')" onkeydown="if(event.key==='Enter'){openIdea('${idEsc(i.id)}')}">
        <td class="left"><span class="vl-sym">${idEsc(i.symbol)}</span>${i.direction === 'avoid' ? ' <span class="vl-tag vl-tag-watch">Tránh</span>' : ''}${idMine(i) ? ' <span class="vl-tag">Của tôi</span>' : ''}
            <div class="id-title">${idEsc(i.title)}</div><div class="id-sub">${idEsc(idName(i.userId))} · ${idAgo(i.createdAt)}</div></td>
        <td class="left">${idPill(i.status)}${open ? ` <span class="tl-badge bad" title="Phản biện chưa được tác giả trả lời">${open} chưa trả lời</span>` : ''}</td>
        <td>${i.entry > 0 ? VU.vnd(i.entry) : '—'} → ${i.target > 0 ? VU.vnd(i.target) : '—'}${up !== null ? `<span class="vl-px-src">${idPct(up, 0, true)}</span>` : ''}</td>
        <td>${e.status === 'nodata' ? '—' : `<span class="pnl-pill ${idCls(e.returnPct)}">${idPct(e.returnPct, 1, true)}</span>${e.alphaPct !== null ? `<span class="vl-px-src" title="So với VN-Index cùng kỳ">alpha ${idPct(e.alphaPct, 1, true)}</span>` : ''}`}</td>
        <td>${i.conviction ? `${i.conviction}/5` : '—'}</td>
        <td>${t.total ? `<span class="${t.leaning === 'for' ? 'pnl-up' : (t.leaning === 'against' ? 'pnl-down' : '')}">${t.for}👍 ${t.against}👎</span>` : '—'}</td>
        <td>${cm.length ? `${cm.length} <i class="fa-regular fa-comment"></i>` : '—'}</td></tr>`;
}

function idScoreboardHtml() {
    const sb = IdeaFlow.scoreboard(ID.ideas, ID.evals, ID.raw.members);
    if (!sb.length) return '';
    return `<div class="vl-card" style="margin-top:18px"><h3 class="vl-card-title"><i class="fa-solid fa-ranking-star" aria-hidden="true"></i> Thành tích theo thành viên <span class="vl-muted">ý tưởng đã đóng mới tính tỷ lệ thắng</span></h3>
        <div class="spreadsheet-wrapper vl-table-wrap"><table class="vl-ov id-table"><thead><tr><th class="left">Thành viên</th><th>Ý tưởng</th><th>Được duyệt</th><th>Đã đóng</th><th>Tỷ lệ thắng</th><th>Lợi suất TB (đã đóng)</th><th>Alpha TB (đã đóng)</th><th>Đang mở: lợi suất TB</th></tr></thead><tbody>
        ${sb.map(s => `<tr><td class="left"><b>${idEsc(s.name)}</b></td><td>${s.total}</td><td>${s.approvalRatePct === null ? '—' : idPct(s.approvalRatePct, 0)}</td><td>${s.closed}</td><td>${s.winRatePct === null ? '—' : idPct(s.winRatePct, 0)}</td>
            <td class="${idCls(s.avgClosedReturnPct)}">${idPct(s.avgClosedReturnPct, 1, true)}</td><td class="${idCls(s.avgClosedAlphaPct)}">${idPct(s.avgClosedAlphaPct, 1, true)}</td><td class="${idCls(s.avgOpenReturnPct)}">${idPct(s.avgOpenReturnPct, 1, true)}</td></tr>`).join('')}
        </tbody></table></div><p class="vl-hint">Tỷ lệ duyệt = số ý tưởng được duyệt ÷ số ý tưởng đã có quyết định. Mẫu nhỏ cho kết quả rất nhiễu; chỉ nên đọc xu hướng khi mỗi người có từ vài chục ý tưởng đã đóng.</p></div>`;
}

// Bản đồ năng lực: ai giỏi ngành nào (alpha TB của các ý tưởng họ đề xuất) và phiếu bầu của ai hay đúng. Phép tính ở IdeaFlow.capability (có kiểm thử).
function idCapabilityHtml() {
    const cap = IdeaFlow.capability(ID.ideas, ID.evals, ID.raw.votes, ID.raw.members, typeof FinCalc !== 'undefined' ? FinCalc.sectorOf : null);
    if (!cap.rows.length && !cap.voting.length) return '';
    const cell = (r) => `<span class="id-cap ${r.n >= cap.minSectorN ? (r.avgAlpha > 0 ? 'up' : 'down') : 'weak'}" title="${idEsc(r.name)}: ${r.n} ý tưởng, ${idPct(r.beatPct, 0)} thắng VN-Index${r.n < cap.minSectorN ? ' (mẫu nhỏ)' : ''}">${idEsc(r.name)} <b>${idPct(r.avgAlpha, 1, true)}</b> <small>${r.n}</small></span>`;
    let html = `<div class="vl-card" style="margin-top:18px"><h3 class="vl-card-title"><i class="fa-solid fa-map" aria-hidden="true"></i> Bản đồ năng lực <span class="vl-muted">alpha trung bình so với VN-Index của ý tưởng do từng người đề xuất, theo ngành</span></h3>`;
    html += cap.sectors.length ? `<div class="spreadsheet-wrapper vl-table-wrap"><table class="vl-ov id-table"><thead><tr><th class="left">Ngành</th><th>Ý tưởng</th><th class="left">Ai đề xuất (alpha · số ý tưởng)</th><th class="left">Nên nghe</th></tr></thead><tbody>
        ${cap.sectors.slice(0, 12).map(sc => `<tr><td class="left"><b>${idEsc(sc.sector)}</b></td><td>${sc.n}</td><td class="left id-caps">${sc.authors.map(cell).join(' ')}</td>
            <td class="left">${sc.best ? `<span class="pnl-up">${idEsc(sc.best.name)}</span>` : '<span class="vl-muted">chưa đủ dữ liệu</span>'}${sc.weakest ? ` <span class="vl-muted">· thận trọng với ý kiến của ${idEsc(sc.weakest.name)}</span>` : ''}</td></tr>`).join('')}
        </tbody></table></div><p class="vl-hint">Một người cần ít nhất ${cap.minSectorN} ý tưởng trong một ngành mới được gọi là “nên nghe” ở ngành đó; dưới mức này chỉ là dấu hiệu (chữ mờ). Alpha tính theo chiều của ý tưởng, kể cả ý tưởng bị bác. Không phải xếp hạng con người: mỗi người có thời điểm và phong cách khác nhau.</p>` : '<p class="vl-hint">Chưa có ý tưởng nào có đủ giá để tính alpha.</p>';
    if (cap.voting.length) html += `<h4 class="id-sub">Phiếu bầu của ai hay đúng?</h4><div class="spreadsheet-wrapper vl-table-wrap"><table class="vl-ov id-table"><thead><tr><th class="left">Thành viên</th><th>Số phiếu đã có kết quả</th><th>Đúng</th><th>Ủng hộ đúng</th><th>Phản đối đúng</th></tr></thead><tbody>
        ${cap.voting.map(v => `<tr><td class="left"><b>${idEsc(v.name)}</b></td><td>${v.n}</td><td class="${v.n >= 8 ? idCls(v.accuracyPct - 50) : ''}">${idPct(v.accuracyPct, 0)}</td><td>${v.forAccPct === null ? '—' : idPct(v.forAccPct, 0) + ` <small>(${v.forN})</small>`}</td><td>${v.againstAccPct === null ? '—' : idPct(v.againstAccPct, 0) + ` <small>(${v.againstN})</small>`}</td></tr>`).join('')}
        </tbody></table></div><p class="vl-hint">Ủng hộ đúng khi ý tưởng sau đó hơn VN-Index; phản đối đúng khi kém. Không tính phiếu cho ý tưởng của chính mình và phiếu trắng. 50% = ngang tung đồng xu; cần nhiều phiếu mới đáng kể.</p>`;
    return html + '</div>';
}

function idSetFilter(f) { ID.filter = f; renderIdeas(); }
function idSearch(v) { ID.query = v; const pos = document.getElementById('id-search'); renderIdeas(); const el = document.getElementById('id-search'); if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } void pos; }

// ---------- chi tiết ----------
async function openIdea(id) {
    ID.detail = { id, idea: null, comments: [], votes: [], loading: true };
    renderIdeaDetail();
    document.getElementById('id-modal').classList.add('open');
    try {
        const d = await call('getIdea', { id });
        ID.detail = { id, idea: IdeaFlow.normalize(d.idea), comments: d.comments, votes: d.votes, loading: false };
    } catch (e) { ID.detail = { id, error: e.message || String(e), loading: false }; }
    renderIdeaDetail();
}
function closeIdeaModal() { document.getElementById('id-modal').classList.remove('open'); ID.detail = null; }

function idFieldRow(label, value) { return `<div class="id-kv"><span>${label}</span><b>${value}</b></div>`; }

function renderIdeaDetail() {
    const d = ID.detail;
    const title = document.getElementById('id-modal-title'), body = document.getElementById('id-modal-body');
    if (!d) return;
    if (d.loading) { title.textContent = 'Đang tải…'; body.innerHTML = '<div class="vl-empty"><i class="fa-solid fa-spinner fa-spin"></i></div>'; return; }
    if (d.error) { title.textContent = 'Lỗi'; body.innerHTML = `<div class="vl-empty">${idEsc(d.error)}</div>`; return; }
    const i = d.idea, e = IdeaFlow.evaluate(i, { nowPrice: (ID.marks.prices[i.symbol] || {}).price, indexNow: ID.marks.index });
    const mine = idMine(i), mgr = !!(ID.actor && ID.actor.isManager);
    const tally = IdeaFlow.voteTally(d.votes);
    const myVote = d.votes.find(v => ID.actor && v.user_id === ID.actor.actorId);
    const r = IdeaFlow.readiness(i);
    title.innerHTML = `<span class="vl-sym">${idEsc(i.symbol)}</span> ${idEsc(i.title)} ${idPill(i.status)}`;
    const statusOpts = Object.keys(IdeaFlow.TRANSITIONS[i.status] || {}).filter(to => {
        const rule = IdeaFlow.TRANSITIONS[i.status][to];
        return rule === 'either' ? (mine || mgr) : (rule === 'author' ? mine : mgr);
    });
    body.innerHTML = `
      <div class="id-grid">
        <div class="id-col">
          <div class="id-card"><div class="id-h">Luận điểm</div><p class="id-text">${idEsc(i.thesis) || '<span class="vl-muted">Chưa viết luận điểm</span>'}</p></div>
          <div class="id-card"><div class="id-h">Chất xúc tác</div><p class="id-text">${idEsc(i.catalysts) || '—'}</p></div>
          <div class="id-card"><div class="id-h">Rủi ro chính</div><p class="id-text">${idEsc(i.risks) || '<span class="vl-muted">Chưa ghi rủi ro</span>'}</p></div>
          ${i.decisionNote ? `<div class="id-card"><div class="id-h">${i.status === 'rejected' ? 'Lý do bác' : 'Ghi chú duyệt'} <small>${idEsc(idName(i.decidedBy))} · ${idDate(i.decidedAt)}</small></div><p class="id-text">${idEsc(i.decisionNote)}</p></div>` : ''}
          <div class="id-card"><div class="id-h">Thảo luận</div>${idThreadHtml(d, i)}${idCommentForm(i, mine)}</div>
        </div>
        <div class="id-col">
          <div class="id-card"><div class="id-h">Con số</div>
            ${idFieldRow('Giá ghi nhận', i.entry > 0 ? VU.vnd(i.entry) : '—')}${idFieldRow('Giá muốn mua', i.buyBelow > 0 ? VU.vnd(i.buyBelow) : '—')}${idFieldRow('Giá mục tiêu', i.target > 0 ? `${VU.vnd(i.target)} <small>${idPct((i.target / i.entry - 1) * 100, 0, true)}</small>` : '—')}
            ${idFieldRow('Cắt lỗ / điều kiện sai', i.stop > 0 ? VU.vnd(i.stop) : '—')}${idFieldRow('Thời hạn', i.horizonMonths ? i.horizonMonths + ' tháng' : '—')}${idFieldRow('Mức tự tin', i.conviction ? i.conviction + '/5' : '—')}
            ${i.valuation ? idFieldRow('Định giá lúc ghi', `Hợp lý ${VU.vnd(i.valuation.fair)} · ${idEsc(i.valuation.verdict || '')}`) : ''}
          </div>
          <div class="id-card"><div class="id-h">Kết quả ${i.status === 'closed' ? '(lúc đóng)' : '(đến hôm nay)'}</div>
            ${e.status === 'nodata' ? '<span class="vl-muted">Chưa có giá hiện tại</span>' : `${idFieldRow(i.direction === 'avoid' ? 'Né được' : 'Lợi suất', `<span class="${idCls(e.returnPct)}">${idPct(e.returnPct, 1, true)}</span>`)}
              ${e.indexPct !== null ? idFieldRow('VN-Index cùng kỳ', idPct(e.indexPct, 1, true)) + idFieldRow('Alpha', `<span class="${idCls(e.alphaPct)}">${idPct(e.alphaPct, 1, true)}</span>`) : ''}
              ${e.progressPct !== undefined ? idFieldRow('Tiến độ tới mục tiêu', idPct(e.progressPct, 0)) : ''}${idFieldRow('Số ngày', e.days + ' ngày')}
              ${e.aboveTarget ? '<div class="id-flag ok">Giá đã đạt mục tiêu</div>' : ''}${e.belowStop ? '<div class="id-flag bad">Giá đã chạm ngưỡng cắt lỗ</div>' : ''}${e.overdue ? '<div class="id-flag warn">Đã quá thời hạn dự kiến</div>' : ''}`}
            ${i.status === 'closed' ? `<div class="id-sub" style="margin-top:6px">Lý do đóng: ${idEsc(IdeaFlow.CLOSE_REASONS[i.closeReason] || '')}${i.closeNote ? ' — ' + idEsc(i.closeNote) : ''}</div>` : ''}
          </div>
          ${i.status === 'review' || tally.total ? `<div class="id-card"><div class="id-h">Phiếu <small>${tally.for} ủng hộ · ${tally.against} phản đối · ${tally.abstain} trung lập</small></div>
            ${d.votes.map(v => `<div class="id-vote ${v.vote}"><b>${idEsc(idName(v.user_id))}</b> ${idEsc(IdeaFlow.VOTES[v.vote])}${v.reason ? `: ${idEsc(v.reason)}` : ''}</div>`).join('') || '<span class="vl-muted">Chưa có phiếu</span>'}
            ${i.status === 'review' && !mine ? `<div class="id-voteform"><input type="text" id="id-vote-reason" maxlength="300" placeholder="Lý do (bắt buộc nếu phản đối)" value="${idEsc(myVote ? myVote.reason : '')}">
              <div class="id-vbtns">${['for', 'against', 'abstain'].map(v => `<button type="button" class="vl-chip" aria-pressed="${myVote && myVote.vote === v}" onclick="idVote('${v}')">${IdeaFlow.VOTES[v]}</button>`).join('')}</div></div>` : ''}
          </div>` : ''}
          <div class="id-card"><div class="id-h">Hồ sơ <small>${r.score}/100</small></div><div class="id-meter"><i style="width:${r.score}%" class="${r.score >= 70 ? 'ok' : 'warn'}"></i></div>${r.missing.length ? `<p class="vl-hint" style="margin:6px 0 0">Còn thiếu: ${idEsc(r.missing.join(', '))}</p>` : '<p class="vl-hint" style="margin:6px 0 0">Hồ sơ đầy đủ.</p>'}</div>
          ${statusOpts.length || (mine && ['idea', 'research', 'rejected'].includes(i.status)) ? `<div class="id-card"><div class="id-h">Hành động</div>
            ${mine && ['idea', 'research', 'rejected'].includes(i.status) ? `<button type="button" class="btn-refresh" onclick="openIdeaForm('${idEsc(i.id)}')"><i class="fa-solid fa-pen"></i> Sửa ý tưởng</button>` : ''}
            ${statusOpts.length ? `<div class="id-actform"><select id="id-to" onchange="idToChanged()">${statusOpts.map(to => `<option value="${to}">${idEsc(IdeaFlow.STATUSES[to].label)}</option>`).join('')}</select>
              <select id="id-close-reason" style="display:none">${Object.keys(IdeaFlow.CLOSE_REASONS).map(k => `<option value="${k}">${idEsc(IdeaFlow.CLOSE_REASONS[k])}</option>`).join('')}</select>
              <textarea id="id-note" rows="2" maxlength="500" placeholder="Ghi chú / lý do (bắt buộc khi bác hoặc tự duyệt)"></textarea>
              <button type="button" class="btn-save" onclick="idApplyStatus()"><i class="fa-solid fa-check"></i> Chuyển trạng thái</button></div>` : ''}
            ${i.status === 'approved' && (mine || mgr) ? `<button type="button" class="btn-refresh" style="margin-top:8px" onclick="idWatch('${idEsc(i.id)}')"><i class="fa-solid fa-eye"></i> Thêm vào Theo Dõi (giá muốn mua + mục tiêu)</button>` : ''}
            ${mine || mgr ? `<button type="button" class="vl-link id-del" onclick="idRemove('${idEsc(i.id)}')">Xoá ý tưởng</button>` : ''}
          </div>` : ''}
        </div>
      </div>`;
    idToChanged();
}

function idToChanged() {
    const sel = document.getElementById('id-to'); if (!sel) return;
    const cr = document.getElementById('id-close-reason'); if (cr) cr.style.display = sel.value === 'closed' ? '' : 'none';
}

function idThreadHtml(d, i) {
    if (!d.comments.length) return '<p class="vl-hint" style="margin-top:0">Chưa có thảo luận. Thành viên khác nên đặt câu hỏi phản biện trước khi quản lý duyệt.</p>';
    return `<div class="id-thread">${d.comments.map(c => `<div class="id-cm ${c.kind}"><div class="id-cm-h"><b>${idEsc(idName(c.user_id))}</b>${c.user_id === i.userId ? ' <span class="vl-tag">Tác giả</span>' : ''} <span class="tl-badge ${c.kind === 'challenge' ? 'warn' : (c.kind === 'answer' ? 'ok' : 'mute')}">${idEsc(IdeaFlow.COMMENT_KINDS[c.kind])}</span> <small>${idDate(c.created_at)}</small>
        ${ID.actor && (c.user_id === ID.actor.actorId || ID.actor.isManager) ? `<button type="button" class="vl-link id-del" onclick="idDeleteComment('${idEsc(c.id)}')" aria-label="Xoá">Xoá</button>` : ''}</div><div class="id-text">${idEsc(c.text)}</div></div>`).join('')}</div>`;
}

function idCommentForm(i, mine) {
    if (i.status === 'closed') return '';
    return `<div class="id-cform"><select id="id-ckind">${mine ? '<option value="answer">Trả lời phản biện</option><option value="comment">Bình luận</option>' : '<option value="challenge">Phản biện (đặt câu hỏi khó)</option><option value="comment">Bình luận</option>'}</select>
        <textarea id="id-ctext" rows="2" maxlength="2000" placeholder="${mine ? 'Trả lời hoặc bổ sung thông tin…' : 'Điều gì có thể làm luận điểm này sai? Con số nào bạn chưa tin?'}"></textarea>
        <button type="button" class="btn-refresh" onclick="idSendComment()"><i class="fa-solid fa-paper-plane"></i> Gửi</button></div>`;
}

async function idRefreshDetail(id) { await loadIdeas(true); if (ID.detail !== null || id) await openIdea(id); }

async function idSendComment() {
    const d = ID.detail; if (!d || !d.idea) return;
    const text = document.getElementById('id-ctext').value;
    try { showToast(await call('addIdeaComment', { id: d.id, kind: document.getElementById('id-ckind').value, text }), 'success'); await idRefreshDetail(d.id); }
    catch (e) { showToast(e.message, 'error'); }
}
async function idDeleteComment(cid) {
    const d = ID.detail; if (!d) return;
    if (!window.confirm('Xoá bình luận này?')) return;
    try { await call('deleteIdeaComment', { commentId: cid }); await idRefreshDetail(d.id); } catch (e) { showToast(e.message, 'error'); }
}
async function idVote(v) {
    const d = ID.detail; if (!d) return;
    try { showToast(await call('voteIdea', { id: d.id, vote: v, reason: document.getElementById('id-vote-reason').value }), 'success'); await idRefreshDetail(d.id); }
    catch (e) { showToast(e.message, 'error'); }
}
async function idApplyStatus() {
    const d = ID.detail; if (!d || !d.idea) return;
    const to = document.getElementById('id-to').value;
    const data = { note: document.getElementById('id-note').value };
    if (to === 'closed') data.reason = document.getElementById('id-close-reason').value;
    if (to === 'in_portfolio' && !window.confirm('Đánh dấu ý tưởng này đã được đưa vào danh mục thật? (Hãy ghi lệnh mua ở trang Danh Mục nếu chưa ghi.)')) return;
    try { showToast(await call('setIdeaStatus', { id: d.id, to, data }), 'success'); await idRefreshDetail(d.id); }
    catch (e) { showToast(e.message, 'error'); }
}
async function idWatch(id) {
    const i = ID.ideas.find(x => x.id === id); if (!i) return;
    if (!(i.buyBelow > 0) && !(i.target > 0)) { showToast('Ý tưởng chưa có giá muốn mua hoặc giá mục tiêu', 'error'); return; }
    try { showToast(await call('pushStockToPortfolio', { symbol: i.symbol, targetPrice: i.target || 0, buyBelow: i.buyBelow || 0 }), 'success'); } catch (e) { showToast(e.message, 'error'); }
}
async function idRemove(id) {
    if (!window.confirm('Xoá ý tưởng này cùng toàn bộ thảo luận và phiếu? Không hoàn tác được. (Ý tưởng đã duyệt nên được ĐÓNG thay vì xoá.)')) return;
    try { showToast(await call('removeIdea', { id }), 'success'); closeIdeaModal(); await loadIdeas(true); } catch (e) { showToast(e.message, 'error'); }
}

// ---------- form tạo / sửa ----------
function idDraftFrom(i) {
    return { id: i ? i.id : null, symbol: i ? i.symbol : '', direction: i ? i.direction : 'long', title: i ? i.title : '', thesis: i ? i.thesis : '', catalysts: i ? i.catalysts : '', risks: i ? i.risks : '',
        buyBelow: i ? i.buyBelow : null, target: i ? i.target : null, stop: i ? i.stop : null, horizonMonths: i ? i.horizonMonths : 12, conviction: i ? i.conviction : null, valuation: i ? i.valuation : null, tags: i ? i.tags : [], entry: i ? i.entry : null };
}

function openIdeaForm(id) {
    const i = id ? ID.ideas.find(x => x.id === id) : null;
    ID.form = idDraftFrom(i);
    const f = ID.form;
    document.getElementById('idf-modal-title').innerHTML = `<i class="fa-solid fa-lightbulb" style="color: var(--gold);"></i> ${i ? 'Sửa ý tưởng' : 'Ý tưởng mới'}`;
    const num = (v) => v === null || v === undefined ? '' : v;
    document.getElementById('idf-modal-body').innerHTML = `
        <div class="id-form">
          <label>Mã cổ phiếu<input type="text" id="idf-symbol" list="idf-symbols" maxlength="12" value="${idEsc(f.symbol)}" ${i ? 'readonly' : ''} style="text-transform:uppercase" oninput="idfChanged()"></label>
          <datalist id="idf-symbols">${state.items.map(x => `<option value="${idEsc(x.symbol)}">`).join('')}</datalist>
          <label>Hướng<select id="idf-direction" onchange="idfChanged()"><option value="long"${f.direction === 'long' ? ' selected' : ''}>Mua (kỳ vọng tăng)</option><option value="avoid"${f.direction === 'avoid' ? ' selected' : ''}>Tránh / không mua</option></select></label>
          <label class="wide">Tiêu đề (một câu: vì sao đáng chú ý)<input type="text" id="idf-title" maxlength="140" value="${idEsc(f.title)}" oninput="idfChanged()"></label>
          <label class="wide">Luận điểm (≥ 60 ký tự: kiếm tiền bằng cách nào, vì sao thị trường đang định giá sai)<textarea id="idf-thesis" rows="4" maxlength="3000" oninput="idfChanged()">${idEsc(f.thesis)}</textarea></label>
          <label class="wide">Chất xúc tác (điều gì làm thị trường nhìn ra, khi nào)<textarea id="idf-catalysts" rows="2" maxlength="1000" oninput="idfChanged()">${idEsc(f.catalysts)}</textarea></label>
          <label class="wide">Rủi ro chính (≥ 20 ký tự: điều gì làm luận điểm sai)<textarea id="idf-risks" rows="2" maxlength="1500" oninput="idfChanged()">${idEsc(f.risks)}</textarea></label>
          <label>Giá muốn mua<input type="number" id="idf-buy" step="any" min="0" value="${num(f.buyBelow)}" oninput="idfChanged()"></label>
          <label>Giá mục tiêu<input type="number" id="idf-target" step="any" min="0" value="${num(f.target)}" oninput="idfChanged()"></label>
          <label>Cắt lỗ / điều kiện sai<input type="number" id="idf-stop" step="any" min="0" value="${num(f.stop)}" oninput="idfChanged()"></label>
          <label>Thời hạn (tháng)<input type="number" id="idf-horizon" step="1" min="1" max="120" value="${num(f.horizonMonths)}" oninput="idfChanged()"></label>
          <label>Mức tự tin (1–5)<input type="number" id="idf-conviction" step="1" min="1" max="5" value="${num(f.conviction)}" oninput="idfChanged()"></label>
          <label>Thẻ (cách nhau dấu phẩy)<input type="text" id="idf-tags" maxlength="120" value="${idEsc((f.tags || []).join(', '))}"></label>
        </div>
        <div class="id-assist"><button type="button" class="btn-refresh" onclick="idfFillFromValuation()"><i class="fa-solid fa-wand-magic-sparkles"></i> Điền từ Định Giá</button><span class="vl-hint" id="idf-note" style="margin:0"></span></div>
        <div class="id-card"><div class="id-h">Mức đầy đủ của hồ sơ <small id="idf-score"></small></div><div class="id-meter"><i id="idf-meter" style="width:0"></i></div><p class="vl-hint" id="idf-missing" style="margin:6px 0 0"></p></div>`;
    document.getElementById('idf-modal-footer').innerHTML = `<button type="button" class="btn-refresh" onclick="closeIdeaFormModal()">Huỷ</button><button type="button" class="btn-save" id="idf-save" onclick="saveIdea()"><i class="fa-solid fa-check"></i> Lưu</button>`;
    document.getElementById('idf-modal').classList.add('open');
    idfChanged();
}
function closeIdeaFormModal() { document.getElementById('idf-modal').classList.remove('open'); ID.form = null; }

function idfRead() {
    const v = (id) => document.getElementById(id).value;
    const n = (id) => { const x = v(id); return x === '' ? null : Number(x); };
    return { id: ID.form.id, symbol: v('idf-symbol').trim().toUpperCase(), direction: v('idf-direction'), title: v('idf-title'), thesis: v('idf-thesis'), catalysts: v('idf-catalysts'), risks: v('idf-risks'),
        buyBelow: n('idf-buy'), target: n('idf-target'), stop: n('idf-stop'), horizonMonths: n('idf-horizon'), conviction: n('idf-conviction'),
        tags: v('idf-tags').split(',').map(t => t.trim()).filter(Boolean), valuation: ID.form.valuation, entry: ID.form.entry };
}

function idfChanged() {
    if (!ID.form) return;
    const d = idfRead();
    const r = IdeaFlow.readiness(Object.assign(IdeaFlow.normalize({}), d, { thesis: d.thesis || '', risks: d.risks || '', catalysts: d.catalysts || '', tags: d.tags }));
    document.getElementById('idf-score').textContent = `${r.score}/100`;
    const m = document.getElementById('idf-meter'); m.style.width = r.score + '%'; m.className = r.score >= 70 ? 'ok' : 'warn';
    document.getElementById('idf-missing').textContent = r.missing.length ? 'Còn thiếu để gửi phản biện: ' + r.missing.join(', ') + '.' : 'Hồ sơ đầy đủ — có thể gửi phản biện.';
}

// Điền mục tiêu / cắt lỗ / thời hạn / ảnh chụp định giá từ hồ sơ Định Giá CP của mã (nếu đã có)
function idfFillFromValuation() {
    const sym = document.getElementById('idf-symbol').value.trim().toUpperCase();
    const it = state.items.find(x => x.symbol === sym);
    const note = document.getElementById('idf-note');
    if (!it) { note.textContent = `Chưa có định giá cho ${sym || 'mã này'} — thêm ở Định Giá CP hoặc nhập tay.`; return; }
    const snap = DecisionJournal.snapshotFrom(it.a, it.year);
    const price = it.a.price > 0 ? it.a.price : null;
    if (!snap) { note.textContent = `${sym} chưa có giá hợp lý (cần P/E, P/B mục tiêu ở Định Giá CP).`; return; }
    const plan = DecisionJournal.suggestPlan('buy', price, snap);
    ID.form.valuation = snap;
    const set = (id, v) => { if (v !== null && v !== undefined) document.getElementById(id).value = Math.round(v); };
    if (!document.getElementById('idf-target').value) set('idf-target', plan.expected);
    if (!document.getElementById('idf-stop').value) set('idf-stop', plan.stop);
    if (!document.getElementById('idf-buy').value) set('idf-buy', snap.fair * VC.CHEAP_RATIO);
    if (!document.getElementById('idf-horizon').value && plan.horizonMonths) document.getElementById('idf-horizon').value = plan.horizonMonths;
    note.textContent = `Đã điền theo định giá ${it.year}: hợp lý ${VU.vnd(snap.fair)}, kịch bản xấu/tốt ${VU.vnd(snap.bear)} – ${VU.vnd(snap.bull)}. Soát lại trước khi lưu.`;
    idfChanged();
}

async function saveIdea() {
    const idea = idfRead();
    const btn = document.getElementById('idf-save'); btn.disabled = true;
    try {
        const r = await callGAS('saveIdea', { idea });
        if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
        const msg = typeof r.data === 'string' ? r.data : (r.data && r.data.message) || r.message || 'Đã lưu!';
        const newId = r.data && r.data.id;
        showToast(msg, 'success');
        closeIdeaFormModal();
        await loadIdeas(true);
        if (newId) openIdea(newId); else if (ID.detail && ID.detail.id) openIdea(ID.detail.id);
    } catch (e) { showToast(e.message, 'error'); }
    finally { btn.disabled = false; }
}
