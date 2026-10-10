/* --- FILE: /mastersheet/assets/journal.js ---
   Tab "Nhật Ký": ghi LÝ DO + KỲ VỌNG (giá mục tiêu, cắt lỗ, thời hạn) ngay lúc ra quyết định, rồi đối chiếu với giá thực tế sau đó
   (chạm mục tiêu / chạm cắt lỗ / hết hạn, so với VN-Index) và đánh giá lại để rút bài học. Số liệu này đi thẳng vào báo cáo cuối tháng.
   Phép tính ở /lib/decision-journal.js (có kiểm thử). Dùng global của script.js: callGAS, targetEmail, showToast, escapeAssetHtml,
   TAB_LOADED + ValuationCalc (gợi ý kế hoạch từ Định Giá CP). */

const JN = {
    entries: [],          // quyết định đã chuẩn hoá (kèm id)
    evals: {},            // id -> kết quả đánh giá theo đường giá
    unplanned: [],        // lệnh gần đây chưa có nhật ký
    filter: 'all', query: '',
    evalState: 'idle',    // idle | loading | ok | error
    evalError: '',
    modalMode: null,      // 'edit' | 'review'
    draft: null,          // dữ liệu đang soạn trong hộp thoại
};

const JN_FILTERS = [['all', 'Tất cả'], ['buy', 'Mua'], ['sell', 'Bán'], ['open', 'Đang theo dõi'], ['hit', 'Đã chạm mục tiêu'], ['stop', 'Đã chạm cắt lỗ'], ['review', 'Chờ đánh giá lại']];

async function jnCall(action, params) {
    const r = await callGAS(action, Object.assign({ email: targetEmail }, params || {}));
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}
const jnEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const jnNum = (v, d) => (v === null || v === undefined || !isFinite(v)) ? '—' : Number(v).toLocaleString('vi-VN', { maximumFractionDigits: d === undefined ? 0 : d });
const jnPct = (v, sign) => (v === null || v === undefined || !isFinite(v)) ? '—' : `${sign && v > 0 ? '+' : (v < 0 ? '−' : '')}${Math.abs(v).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`;
const jnToday = () => new Date().toISOString().slice(0, 10);
const jnDate = (iso) => { const p = String(iso || '').split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0].slice(2)}` : ''; };

// ---------- tải dữ liệu ----------
async function loadJournal() {
    const body = document.getElementById('jn-body');
    if (!body) return;
    body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang tải nhật ký…</div>';
    try {
        const [rows, unplanned] = await Promise.all([jnCall('listDecisions'), jnCall('getUnplannedTrades', { days: 45 })]);
        JN.entries = rows.map(r => Object.assign(DecisionJournal.normalize(r), { id: r.id }));
        JN.unplanned = unplanned || [];
        JN.evals = {};
        JN.evalState = JN.entries.length ? 'loading' : 'ok';
        renderJournal();
        updateJournalBadge();
        if (JN.entries.length) await evaluateJournal();
    } catch (e) {
        body.innerHTML = `<div class="tl-empty text-danger">Lỗi: ${jnEsc(e.message)}</div>`;
    }
}

// Giá lịch sử của mọi mã trong nhật ký + VN-Index -> đánh giá từng quyết định. Edge Function giới hạn ~2.600 ngày nên cắt mốc đầu.
async function evaluateJournal() {
    try {
        const today = jnToday();
        const earliest = new Date(Date.now() - 2590 * 86400000).toISOString().slice(0, 10);
        const minDate = JN.entries.reduce((m, e) => (e.date && e.date < m ? e.date : m), today);
        const from = minDate < earliest ? earliest : minDate;
        const symbols = [...new Set(JN.entries.map(e => e.symbol))];
        const hist = {};
        for (let i = 0; i < symbols.length; i += 20) {
            const chunk = symbols.slice(i, i + 20).concat(i === 0 ? ['VNINDEX'] : []);
            Object.assign(hist, await jnCall('getAssetPriceHistory', { symbols: chunk, from: from, to: today }));
        }
        JN.entries.forEach(e => {
            JN.evals[e.id] = DecisionJournal.evaluate(e, { series: hist[e.symbol] || [], today: today, bench: hist.VNINDEX || null });
        });
        JN.evalState = 'ok';
    } catch (err) {
        JN.evalState = 'error';
        JN.evalError = err.message;
    }
    renderJournal();
}

async function updateJournalBadge() {
    const badge = document.getElementById('jn-badge');
    if (!badge) return;
    try {
        const list = JN.unplanned.length || TAB_LOADED.journal ? JN.unplanned : await jnCall('getUnplannedTrades', { days: 45 });
        badge.textContent = list.length ? String(list.length) : '';
        badge.style.display = list.length ? 'inline-flex' : 'none';
        badge.title = list.length ? `${list.length} lệnh gần đây chưa ghi lý do` : '';
    } catch (e) { badge.style.display = 'none'; }
}

// ---------- hiển thị ----------
function journalFiltered() {
    const q = JN.query.trim().toUpperCase();
    return JN.entries.filter(e => {
        const ev = JN.evals[e.id];
        if (q && e.symbol.indexOf(q) === -1) return false;
        switch (JN.filter) {
            case 'buy': return e.action === 'buy';
            case 'sell': return e.action === 'sell';
            case 'open': return ev && ev.status === 'open';
            case 'hit': return ev && ev.status === 'target_hit';
            case 'stop': return ev && ev.status === 'stop_hit';
            case 'review': return !e.review && ev && ['target_hit', 'stop_hit', 'expired', 'sold_early', 'sold_well', 'missed', 'avoided'].includes(ev.status);
            default: return true;
        }
    });
}

function jnPlanBar(score) {
    const cls = score >= 85 ? 'ok' : (score >= 60 ? 'warn' : 'bad');
    return `<span class="jn-plan" title="Điểm kế hoạch ${score}/100"><span class="jn-plan-bar"><i class="${cls}" style="width:${score}%"></i></span><b>${score}</b></span>`;
}

function jnStatusCell(e) {
    const ev = JN.evals[e.id];
    if (JN.evalState === 'loading' && !ev) return '<span class="tl-badge mute"><i class="fa-solid fa-spinner fa-spin"></i> Đang đánh giá</span>';
    if (!ev || ev.status === 'nodata') return '<span class="tl-badge mute" title="Chưa lấy được giá sau ngày quyết định">Chưa có giá</span>';
    const tone = { good: 'ok', bad: 'bad', warn: 'warn', neutral: 'info' }[ev.tone] || 'mute';
    const isBuy = e.action === 'buy' || e.action === 'hold';
    const lines = [];
    if (isBuy) {
        lines.push(`Hiện ${jnPct(ev.returnPct, true)}${ev.alphaPct !== null ? ` · vs VN-Index ${jnPct(ev.alphaPct, true)}` : ''}`);
        if (ev.hitDate) lines.push(`${ev.status === 'target_hit' ? 'Chạm mục tiêu' : 'Chạm cắt lỗ'} ${jnDate(ev.hitDate)} (sau ${ev.hitDays} ngày)`);
        else if (ev.progressPct !== null) lines.push(`Tiến độ tới mục tiêu ${jnNum(Math.max(0, ev.progressPct))}%`);
        lines.push(`Đỉnh ${jnPct(ev.peakPct, true)} · đáy ${jnPct(ev.troughPct, true)}`);
    } else {
        lines.push(`Giá sau đó ${jnPct(ev.afterPct, true)}${ev.alphaPct !== null ? ` · vs VN-Index ${jnPct(ev.alphaPct, true)}` : ''}`);
    }
    return `<span class="tl-badge ${tone}">${jnEsc(ev.label)}</span><div class="jn-sub">${lines.map(jnEsc).join('<br>')}</div>`;
}

function renderJournal() {
    const body = document.getElementById('jn-body');
    if (!body) return;
    const evs = JN.entries.map(e => JN.evals[e.id] || null);
    const s = DecisionJournal.summarize(JN.entries, evs);
    const kpi = (k, v, sub, cls) => `<div class="tl-kpi"><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
    const kpis = `<div class="tl-kpis">
        ${kpi('Quyết định đã ghi', s.total, `${s.byAction.buy} mua · ${s.byAction.sell} bán · ${s.byAction.skip} bỏ qua · ${s.byAction.hold} giữ`)}
        ${kpi('Điểm kế hoạch TB', s.planAvg === null ? '—' : jnNum(s.planAvg), 'tối đa 100 · đo quy trình, không đo kết quả')}
        ${kpi('Kế hoạch đủ', s.fullPlanPct === null ? '—' : jnNum(s.fullPlanPct) + '%', `${s.fullPlanCount}/${s.total} quyết định`)}
        ${s.alertDriven ? kpi('Từ cảnh báo giá', s.alertDriven, `${s.alertDriven}/${s.total} quyết định bắt đầu từ cảnh báo`) : ''}
        ${kpi('Mua đã chạm mục tiêu', s.targetHit, s.buyEvaluated ? `trên ${s.buyEvaluated} lệnh mua đã đánh giá` : 'chưa đủ dữ liệu giá', s.targetHit ? 'tl-up' : '')}
        ${kpi('Mua đã chạm cắt lỗ', s.stopHit, s.buyEvaluated ? `trên ${s.buyEvaluated} lệnh mua đã đánh giá` : '', s.stopHit ? 'tl-down' : '')}
        ${kpi('Alpha TB (mua)', s.avgAlphaPct === null ? '—' : jnPct(s.avgAlphaPct, true), 'so với VN-Index cùng kỳ', s.avgAlphaPct > 0 ? 'tl-up' : (s.avgAlphaPct < 0 ? 'tl-down' : ''))}
    </div>`;

    const unplanned = JN.unplanned.length ? `<div class="jn-nudge"><div><i class="fa-solid fa-pen-to-square"></i> <b>${JN.unplanned.length} lệnh gần đây chưa ghi lý do.</b> Ghi ngay khi còn nhớ — báo cáo cuối tháng sẽ đối chiếu kỳ vọng với kết quả.</div>
        <div class="jn-nudge-list">${JN.unplanned.slice(0, 6).map(t => `<button type="button" class="tl-badge ${t.type === 'buy' ? 'ok' : 'warn'} jn-chip" onclick="openDecisionModal({ fromTxn: '${jnEsc(t.id)}' })" title="Ghi lý do cho lệnh này">${t.type === 'buy' ? 'Mua' : 'Bán'} ${jnEsc(t.symbol)} · ${jnDate(t.trade_date)} <i class="fa-solid fa-plus"></i></button>`).join('')}${JN.unplanned.length > 6 ? `<span class="tl-hint" style="margin:0">và ${JN.unplanned.length - 6} lệnh nữa</span>` : ''}</div></div>` : '';

    const filters = `<div class="jn-toolbar"><div class="jn-chips" role="group" aria-label="Lọc quyết định">${JN_FILTERS.map(f => `<button type="button" class="jn-filter" data-f="${f[0]}" aria-pressed="${JN.filter === f[0]}">${f[1]}</button>`).join('')}</div>
        <input type="search" class="tl-input" id="jn-search" placeholder="Tìm mã…" value="${jnEsc(JN.query)}" aria-label="Tìm mã trong nhật ký" style="width:150px">
        <button type="button" class="btn-save" onclick="openDecisionModal()"><i class="fa-solid fa-plus"></i> Ghi quyết định</button></div>`;

    const list = journalFiltered();
    const rows = list.map(e => {
        const sc = DecisionJournal.planScore(e);
        const act = DecisionJournal.ACTIONS[e.action];
        const planBits = [];
        if (e.expected) planBits.push(`<span title="Giá mục tiêu / kỳ vọng">🎯 ${jnNum(e.expected)}</span>`.replace('🎯', '<i class="fa-solid fa-bullseye"></i>'));
        if (e.stop) planBits.push(`<span title="Ngưỡng cắt lỗ"><i class="fa-solid fa-shield"></i> ${jnNum(e.stop)}</span>`);
        if (e.horizonMonths) planBits.push(`<span title="Thời hạn"><i class="fa-regular fa-clock"></i> ${e.horizonMonths} tháng</span>`);
        const val = e.valuation && e.valuation.fair ? `<div class="jn-sub" title="Ảnh chụp định giá lúc quyết định">Định giá lúc đó: ${jnNum(e.valuation.fair)}${e.valuation.verdict ? ' · ' + ({ cheap: 'Rẻ', fair: 'Hợp lý', expensive: 'Đắt' }[e.valuation.verdict] || '') : ''}</div>` : '';
        const review = e.review ? `<div class="jn-sub" title="${jnEsc(e.review.lesson || e.review.note)}"><i class="fa-solid fa-star" style="color:var(--gold)"></i> ${e.review.rating || '—'}/5${e.review.lesson ? ' · ' + jnEsc(e.review.lesson).slice(0, 60) : ''}</div>` : '';
        return `<tr>
            <td style="white-space:nowrap">${jnDate(e.date)}</td>
            <td><span class="txn-type-badge ${e.action === 'buy' ? 'buy' : (e.action === 'sell' ? 'sell' : 'jn-neutral')}"><i class="fa-solid ${act.icon}"></i>${act.label}</span></td>
            <td class="text-bold">${jnEsc(e.symbol)}${e.txnId ? ' <span class="tl-badge mute" title="Gắn với lệnh trong sổ lệnh">lệnh</span>' : ''}${e.simRunId ? ` <a class="tl-badge mute" href="/simulation/#runs/${jnEsc(e.simRunId)}" title="Quyết định dựa trên một lần Market Simulation đã lưu: mở để xem dự báo lúc đó và kết quả chấm điểm">mô phỏng</a>` : ''}</td>
            <td class="text-right">${e.price ? jnNum(e.price) : '—'}</td>
            <td><div class="jn-plan-bits">${planBits.join('') || '<span class="tl-hint" style="margin:0">—</span>'}</div>${val}</td>
            <td class="jn-reason" title="${jnEsc(e.reason)}">${jnEsc(e.reason) || '<span class="tl-hint" style="margin:0">Chưa ghi lý do</span>'}${e.tags.length ? `<div class="jn-tags">${e.tags.map(t => `<span class="tl-badge mute">${jnEsc(t)}</span>`).join('')}</div>` : ''}</td>
            <td>${jnStatusCell(e)}${review}</td>
            <td>${jnPlanBar(sc.score)}${sc.missing.length ? `<div class="jn-sub" title="Còn thiếu: ${jnEsc(sc.missing.join(', '))}">thiếu ${sc.missing.length} mục</div>` : ''}</td>
            <td style="white-space:nowrap"><button class="icon-btn" title="Đánh giá lại / rút bài học" onclick="openReviewModal('${e.id}')"><i class="fa-solid fa-clipboard-check"></i></button>
                <button class="icon-btn" title="Sửa" onclick="openDecisionModal({ id: '${e.id}' })"><i class="fa-solid fa-pen"></i></button>
                <button class="icon-btn danger" title="Xoá khỏi nhật ký" onclick="deleteDecision('${e.id}')"><i class="fa-solid fa-trash"></i></button></td>
        </tr>`;
    }).join('');
    const empty = !JN.entries.length
        ? '<tr><td colspan="9" class="empty-state"><i class="fa-solid fa-book-open"></i>Chưa có quyết định nào. Bấm “Ghi quyết định”, hoặc điền mục “Kế hoạch &amp; lý do” khi thêm lệnh ở Sổ Lệnh.</td></tr>'
        : '<tr><td colspan="9" class="empty-state">Không có quyết định nào khớp bộ lọc.</td></tr>';
    const evalNote = JN.evalState === 'error' ? `<p class="tl-hint text-danger">Chưa lấy được giá lịch sử nên chưa đánh giá kết quả: ${jnEsc(JN.evalError)}</p>` : '';

    body.innerHTML = kpis + unplanned + filters + evalNote + `<div class="spreadsheet-wrapper"><table class="excel-table asset-table jn-table"><thead><tr>
        <th>Ngày</th><th>Hành động</th><th>Mã</th><th class="text-right">Giá</th><th>Kỳ vọng</th><th>Lý do</th><th>Kết quả tới nay</th><th title="Điểm kế hoạch: có ghi lý do, mục tiêu, cắt lỗ, thời hạn ngay lúc quyết định">Kế hoạch</th><th></th></tr></thead>
        <tbody>${rows || empty}</tbody></table></div>
        <p class="tl-hint"><b>Cách đọc:</b> “Kế hoạch” đo QUY TRÌNH (đã ghi đủ lý do, mục tiêu, cắt lỗ, thời hạn trước khi biết kết quả). “Kết quả” chỉ là giá đóng cửa sau đó: quyết định tốt vẫn có thể thua và ngược lại — đừng trộn hai thứ. Trạng thái chạm mục tiêu / cắt lỗ tính theo giá đóng cửa, cái nào tới trước.</p>`;

    body.querySelectorAll('.jn-filter').forEach(b => b.addEventListener('click', function () { JN.filter = this.getAttribute('data-f'); renderJournal(); }));
    const search = document.getElementById('jn-search');
    search.addEventListener('input', function () {
        JN.query = this.value;
        const pos = this.selectionStart;
        renderJournal();
        const again = document.getElementById('jn-search');
        again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* bỏ qua */ }
    });
}

// ---------- hộp thoại ghi / sửa ----------
function jnModalEl() { return document.getElementById('jn-modal'); }
function closeJournalModal() { jnModalEl().classList.remove('open'); JN.modalMode = null; JN.draft = null; }

function jnField(id, label, inner, wide, hint) {
    return `<div class="txn-field${wide ? ' txn-field-wide' : ''}"><label for="${id}">${label}</label>${inner}${hint ? `<span class="tl-hint" style="margin:0">${hint}</span>` : ''}</div>`;
}

// opts: { id } sửa quyết định có sẵn | { fromTxn } ghi lý do cho 1 lệnh đã có | {} ghi mới
async function openDecisionModal(opts) {
    const o = opts || {};
    let d = { action: 'buy', symbol: '', date: jnToday(), price: null, quantity: null, reason: '', expected: null, stop: null, horizonMonths: null, confidence: null, tags: [], valuation: null, txnId: null, id: null };
    if (o.id) {
        const e = JN.entries.find(x => x.id === o.id);
        if (!e) return;
        d = Object.assign({}, e);
    } else if (o.prefill) {                                              // từ cảnh báo giá (alert-review-ui.js): điền sẵn bối cảnh, người dùng xem và sửa trước khi lưu
        d = Object.assign(d, o.prefill, { tags: (o.prefill.tags || []).slice() });
    } else if (o.fromTxn) {
        const t = JN.unplanned.find(x => x.id === o.fromTxn);
        if (!t) return;
        d = Object.assign(d, { action: t.type, symbol: t.symbol, date: t.trade_date, price: t.price, quantity: t.quantity, txnId: t.id });
    }
    JN.modalMode = 'edit';
    JN.draft = d;
    const seg = ['buy', 'sell', 'hold', 'skip'].map(a => `<button type="button" data-v="${a}" aria-pressed="${d.action === a}" onclick="pickDecisionAction(this)"${d.txnId ? ' disabled' : ''}>${DecisionJournal.ACTIONS[a].label}</button>`).join('');
    const num = (v) => v === null || v === undefined ? '' : v;
    document.getElementById('jn-modal-title').innerHTML = `<i class="fa-solid fa-book-open" style="color: var(--gold);"></i> ${d.id ? 'Sửa quyết định' : (d.txnId ? 'Ghi lý do cho lệnh' : 'Ghi quyết định')}`;
    document.getElementById('jn-modal-body').innerHTML = `
        <div class="txn-form-grid jn-form">
            <div class="txn-field jn-action-field"><label>Hành động</label><div class="seg jn-seg" role="group" aria-label="Hành động">${seg}</div><input type="hidden" id="jn-action" value="${d.action}"></div>
            ${jnField('jn-symbol', 'Mã', `<input type="text" id="jn-symbol" value="${jnEsc(d.symbol)}" placeholder="VD: FPT" style="text-transform:uppercase" ${d.txnId ? 'readonly' : ''} onchange="onDecisionSymbolChange()">`)}
            ${jnField('jn-date', 'Ngày quyết định', `<input type="date" id="jn-date" value="${jnEsc(d.date)}" ${d.txnId ? 'readonly' : ''}>`)}
            ${jnField('jn-price', 'Giá lúc quyết định', `<input type="number" id="jn-price" min="0" step="any" value="${num(d.price)}" placeholder="0" ${d.txnId ? 'readonly' : ''}>`)}
            ${jnField('jn-qty', 'Khối lượng (tuỳ chọn)', `<input type="number" id="jn-qty" min="0" step="any" value="${num(d.quantity)}" placeholder="0" ${d.txnId ? 'readonly' : ''}>`)}
            ${jnField('jn-reason', 'Lý do — vì sao quyết định này? Điều gì làm bạn đổi ý?', `<textarea id="jn-reason" class="jn-textarea" maxlength="1000" placeholder="VD: Lợi nhuận phục hồi 2 quý liền, P/E thấp hơn trung bình 5 năm. Sẽ bán nếu biên lợi nhuận giảm dưới 8%.">${jnEsc(d.reason)}</textarea>`, true)}
            ${jnField('jn-expected', 'Giá mục tiêu / kỳ vọng', `<input type="number" id="jn-expected" min="0" step="any" value="${num(d.expected)}" placeholder="0">`, false, d.action === 'buy' ? 'Mức giá bạn kỳ vọng' : 'Mức giá sẽ cân nhắc lại')}
            ${jnField('jn-stop', 'Ngưỡng cắt lỗ', `<input type="number" id="jn-stop" min="0" step="any" value="${num(d.stop)}" placeholder="0">`, false, 'Giá mà luận điểm coi như sai')}
            ${jnField('jn-horizon', 'Thời hạn (tháng)', `<input type="number" id="jn-horizon" min="1" max="120" step="1" value="${num(d.horizonMonths)}" placeholder="12">`)}
            ${jnField('jn-conf', 'Mức tự tin', `<select id="jn-conf" class="tl-select"><option value="">—</option>${[1, 2, 3, 4, 5].map(n => `<option value="${n}"${d.confidence === n ? ' selected' : ''}>${n}${['', ' · rất thấp', ' · thấp', ' · vừa', ' · cao', ' · rất cao'][n]}</option>`).join('')}</select>`)}
            ${jnField('jn-tags', 'Thẻ (cách nhau bằng dấu phẩy)', `<input type="text" id="jn-tags" value="${jnEsc(d.tags.join(', '))}" placeholder="VD: dài hạn, ngân hàng">`, true)}
        </div>
        <div class="jn-assist"><button type="button" class="btn-tool" onclick="fillDecisionFromValuation()"><i class="fa-solid fa-wand-magic-sparkles"></i> Điền từ Định Giá CP</button>
            <span class="tl-hint" id="jn-assist-note" style="margin:0">${d.valuation && d.valuation.fair ? `Đã gắn ảnh chụp định giá: giá hợp lý ${jnNum(d.valuation.fair)}.` : 'Gợi ý giá mục tiêu = giá hợp lý, cắt lỗ = 10% dưới giá, thời hạn 12 tháng — chỉ điền ô đang trống.'}</span></div>`;
    document.getElementById('jn-modal-footer').innerHTML = `<button type="button" class="btn-tool" onclick="closeJournalModal()">Huỷ</button><button type="button" class="btn-save" id="jn-save-btn" onclick="saveDecision()"><i class="fa-solid fa-check"></i> Lưu</button>`;
    jnModalEl().classList.add('open');
    setTimeout(() => { const el = document.getElementById(d.symbol ? 'jn-reason' : 'jn-symbol'); if (el) el.focus(); }, 50);
}

function pickDecisionAction(btn) {
    document.querySelectorAll('.jn-seg button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    document.getElementById('jn-action').value = btn.getAttribute('data-v');
}

function jnReadNum(id) {
    const v = String(document.getElementById(id).value || '').trim();
    return v === '' ? null : Number(v);
}

async function onDecisionSymbolChange() {
    const symbol = document.getElementById('jn-symbol').value.trim().toUpperCase();
    document.getElementById('jn-symbol').value = symbol;
    if (!/^[A-Z0-9]{1,12}$/.test(symbol) || jnReadNum('jn-price') !== null) return;
    try {
        const live = await jnCall('getStockLivePrices', { symbols: [symbol] });
        if (live[symbol] && jnReadNum('jn-price') === null) document.getElementById('jn-price').value = live[symbol].price;
    } catch (e) { /* người dùng tự nhập giá */ }
}

// Lấy định giá mới nhất của mã -> ảnh chụp + gợi ý kế hoạch (chỉ điền ô trống)
async function fillDecisionFromValuation() {
    const symbol = document.getElementById('jn-symbol').value.trim().toUpperCase();
    const note = document.getElementById('jn-assist-note');
    if (!symbol) { note.textContent = 'Nhập mã trước.'; return; }
    note.textContent = 'Đang lấy định giá…';
    try {
        const snap = await jnValuationSnapshot(symbol, jnReadNum('jn-price'));
        if (!snap) { note.textContent = `Chưa có định giá cho ${symbol} — mở Nghiên Cứu / Định Giá CP để lập định giá. Vẫn gợi ý cắt lỗ và thời hạn mặc định.`; }
        const action = document.getElementById('jn-action').value;
        const price = jnReadNum('jn-price') || (snap && snap.price) || 0;
        const plan = DecisionJournal.suggestPlan(action, price, snap);
        const setIfEmpty = (id, v) => { if (v !== null && v !== undefined && jnReadNum(id) === null) document.getElementById(id).value = v; };
        if (!jnReadNum('jn-price') && price) document.getElementById('jn-price').value = price;
        setIfEmpty('jn-expected', plan.expected !== null ? Math.round(plan.expected) : null);
        setIfEmpty('jn-stop', plan.stop);
        setIfEmpty('jn-horizon', plan.horizonMonths);
        JN.draft.valuation = snap;
        if (snap) note.textContent = `Giá hợp lý ${jnNum(snap.fair)} (kịch bản xấu ${jnNum(snap.bear)} – tốt ${jnNum(snap.bull)}), kết luận: ${({ cheap: 'Rẻ', fair: 'Hợp lý', expensive: 'Đắt' }[snap.verdict] || '—')}. Đã gắn ảnh chụp này vào quyết định.`;
    } catch (e) {
        note.textContent = 'Không lấy được định giá: ' + e.message;
    }
}

// Ảnh chụp định giá mới nhất của 1 mã (null nếu chưa có hoặc chưa tính được giá hợp lý)
async function jnValuationSnapshot(symbol, price) {
    const rows = await jnCall('getStockHistory', { symbol: symbol });
    if (!rows.length) return null;
    const latest = rows.slice().sort((a, b) => b.year - a.year)[0];
    const prevRow = rows.find(r => r.year === latest.year - 1);
    const prev = prevRow ? ValuationCalc.normalize(Object.assign({}, prevRow.data, { year: prevRow.year })) : null;
    let live = price;
    if (!(live > 0)) { try { const lp = await jnCall('getStockLivePrices', { symbols: [symbol] }); live = lp[symbol] ? lp[symbol].price : 0; } catch (e) { live = 0; } }
    const a = ValuationCalc.analyze(Object.assign({}, latest.data, { year: latest.year, symbol: symbol }), { prev: prev, price: live > 0 ? live : undefined });
    return DecisionJournal.snapshotFrom(a, latest.year);
}

async function saveDecision() {
    const d = JN.draft;
    if (!d) return;
    const btn = document.getElementById('jn-save-btn');
    const input = {
        id: d.id || undefined, txnId: d.txnId || undefined,
        action: document.getElementById('jn-action').value, symbol: document.getElementById('jn-symbol').value,
        date: document.getElementById('jn-date').value, price: jnReadNum('jn-price'), quantity: jnReadNum('jn-qty'),
        reason: document.getElementById('jn-reason').value, expected: jnReadNum('jn-expected'), stop: jnReadNum('jn-stop'),
        horizonMonths: jnReadNum('jn-horizon'), confidence: jnReadNum('jn-conf'), tags: document.getElementById('jn-tags').value,
        valuation: d.valuation || null
    };
    const check = DecisionJournal.validate(input);
    if (!check.ok) { showToast(check.error, 'error'); return; }
    btn.disabled = true;
    try {
        const msg = await jnCall('saveDecision', { decision: input });
        showToast(msg, 'success');
        closeJournalModal();
        await loadJournal();
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
        btn.disabled = false;
    }
}

async function deleteDecision(id) {
    const e = JN.entries.find(x => x.id === id);
    if (!e || !confirm(`Xoá quyết định ${DecisionJournal.ACTIONS[e.action].label} ${e.symbol} (${jnDate(e.date)}) khỏi nhật ký? Lệnh trong sổ lệnh không bị ảnh hưởng.`)) return;
    try {
        showToast(await jnCall('deleteDecision', { id }), 'success');
        await loadJournal();
    } catch (err) { showToast('Lỗi: ' + err.message, 'error'); }
}

// ---------- đánh giá lại ----------
function openReviewModal(id) {
    const e = JN.entries.find(x => x.id === id);
    if (!e) return;
    JN.modalMode = 'review';
    JN.draft = { id: id, rating: e.review && e.review.rating ? e.review.rating : null };
    const ev = JN.evals[id];
    const act = DecisionJournal.ACTIONS[e.action];
    const sc = DecisionJournal.planScore(e);
    const stars = [1, 2, 3, 4, 5].map(n => `<button type="button" class="jn-star" data-n="${n}" aria-pressed="${JN.draft.rating === n}" onclick="pickReviewRating(${n})" title="${n}/5">${n}</button>`).join('');
    document.getElementById('jn-modal-title').innerHTML = `<i class="fa-solid fa-clipboard-check" style="color: var(--gold);"></i> Đánh giá lại: ${act.label} ${jnEsc(e.symbol)} (${jnDate(e.date)})`;
    document.getElementById('jn-modal-body').innerHTML = `
        <div class="jn-review-summary">
            <div><span class="k">Lý do lúc đó</span><p>${jnEsc(e.reason) || '<i>Chưa ghi</i>'}</p></div>
            <div><span class="k">Kỳ vọng lúc đó</span><p>${e.expected ? 'Mục tiêu ' + jnNum(e.expected) : ''}${e.stop ? ' · cắt lỗ ' + jnNum(e.stop) : ''}${e.horizonMonths ? ' · ' + e.horizonMonths + ' tháng' : ''}${!e.expected && !e.stop ? '<i>Chưa ghi</i>' : ''}</p></div>
            <div><span class="k">Thực tế tới nay</span><p>${ev && ev.status !== 'nodata' ? jnEsc(ev.label) + ' · ' + (e.action === 'sell' || e.action === 'skip' ? 'giá sau đó ' + jnPct(ev.afterPct, true) : 'lợi suất ' + jnPct(ev.returnPct, true) + (ev.alphaPct !== null ? ' (vs VN-Index ' + jnPct(ev.alphaPct, true) + ')' : '')) : '<i>Chưa có dữ liệu giá</i>'}</p></div>
            <div><span class="k">Điểm kế hoạch</span><p>${sc.score}/100${sc.missing.length ? ' · thiếu: ' + jnEsc(sc.missing.join(', ')) : ''}</p></div>
        </div>
        <div class="txn-field"><label>Quy trình ra quyết định lần này đáng mấy điểm? <span class="tl-hint" style="margin:0;text-transform:none">(chấm cách bạn ra quyết định, không chấm theo lãi/lỗ)</span></label><div class="jn-stars" role="group" aria-label="Điểm đánh giá 1 đến 5">${stars}</div></div>
        <div class="txn-field"><label for="jn-rv-note">Nhận xét</label><textarea id="jn-rv-note" class="jn-textarea" maxlength="1000" placeholder="Luận điểm đúng hay sai? Điều gì ngoài dự kiến?">${jnEsc(e.review ? e.review.note : '')}</textarea></div>
        <div class="txn-field"><label for="jn-rv-lesson">Bài học để lần sau làm tốt hơn</label><textarea id="jn-rv-lesson" class="jn-textarea" maxlength="1000" placeholder="VD: Đặt cắt lỗ trước khi mua; không mua đuổi khi giá đã vượt giá hợp lý.">${jnEsc(e.review ? e.review.lesson : '')}</textarea></div>`;
    document.getElementById('jn-modal-footer').innerHTML = `<button type="button" class="btn-tool" onclick="closeJournalModal()">Huỷ</button><button type="button" class="btn-save" id="jn-save-btn" onclick="saveDecisionReview()"><i class="fa-solid fa-check"></i> Lưu đánh giá</button>`;
    jnModalEl().classList.add('open');
}

function pickReviewRating(n) {
    JN.draft.rating = n;
    document.querySelectorAll('.jn-star').forEach(b => b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-n')) === n)));
}

async function saveDecisionReview() {
    const d = JN.draft;
    if (!d || !d.rating) { showToast('Chọn điểm đánh giá từ 1 đến 5', 'error'); return; }
    const btn = document.getElementById('jn-save-btn');
    btn.disabled = true;
    try {
        showToast(await jnCall('saveDecisionReview', { id: d.id, review: { rating: d.rating, note: document.getElementById('jn-rv-note').value, lesson: document.getElementById('jn-rv-lesson').value } }), 'success');
        closeJournalModal();
        await loadJournal();
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
        btn.disabled = false;
    }
}

// ---------- kế hoạch đi kèm lệnh (form Thêm Lệnh Giao Dịch) ----------
let jnTxnSnapshot = null;

// Đọc ô "Kế hoạch & lý do" của form lệnh -> đối tượng decision (null nếu người dùng để trống hết)
function readTxnPlan() {
    const get = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
    const reason = get('txn-plan-reason'), expected = get('txn-plan-expected'), stop = get('txn-plan-stop'), horizon = get('txn-plan-horizon'), conf = get('txn-plan-conf');
    if (!reason && !expected && !stop && !horizon && !conf) return null;
    return {
        reason: reason, expected: expected === '' ? null : Number(expected), stop: stop === '' ? null : Number(stop),
        horizonMonths: horizon === '' ? null : Number(horizon), confidence: conf === '' ? null : Number(conf), valuation: jnTxnSnapshot
    };
}

function resetTxnPlan() {
    ['txn-plan-reason', 'txn-plan-expected', 'txn-plan-stop', 'txn-plan-horizon', 'txn-plan-conf'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    jnTxnSnapshot = null;
    const note = document.getElementById('txn-plan-note');
    if (note) note.textContent = '';
    const det = document.getElementById('txn-plan');
    if (det) det.open = false;
}

async function fillTxnPlanFromValuation() {
    const symbol = String(document.getElementById('txn-symbol').value || '').trim().toUpperCase();
    const note = document.getElementById('txn-plan-note');
    if (!symbol) { note.textContent = 'Nhập mã ở form trên trước.'; return; }
    note.textContent = 'Đang lấy định giá…';
    try {
        const price = Number(document.getElementById('txn-price').value) || 0;
        const snap = await jnValuationSnapshot(symbol, price > 0 ? price : null);
        const action = document.getElementById('txn-type').value === 'sell' ? 'sell' : 'buy';
        const plan = DecisionJournal.suggestPlan(action, price || (snap && snap.price) || 0, snap);
        const setIfEmpty = (id, v) => { const el = document.getElementById(id); if (el && v !== null && v !== undefined && String(el.value).trim() === '') el.value = v; };
        setIfEmpty('txn-plan-expected', plan.expected !== null ? Math.round(plan.expected) : null);
        if (action === 'buy') { setIfEmpty('txn-plan-stop', plan.stop); setIfEmpty('txn-plan-horizon', plan.horizonMonths); }
        jnTxnSnapshot = snap;
        note.textContent = snap ? `Giá hợp lý ${jnNum(snap.fair)} (${({ cheap: 'Rẻ', fair: 'Hợp lý', expensive: 'Đắt' }[snap.verdict] || '—')}). Đã điền ô trống và gắn ảnh chụp định giá.` : `Chưa có định giá cho ${symbol}; chỉ điền cắt lỗ và thời hạn mặc định.`;
    } catch (e) {
        note.textContent = 'Không lấy được định giá: ' + e.message;
    }
}

document.addEventListener('DOMContentLoaded', () => { setTimeout(updateJournalBadge, 800); });
