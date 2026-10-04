/* --- FILE: /mastersheet/group-journey.js ---
   Trang Toàn Nhóm > "Hành Trình": theo từng ý tưởng đầu tư đi từ đề xuất -> quản lý duyệt/bác -> đề xuất lệnh -> ghi lệnh -> kết quả so với VN-Index, và tổng hợp để thấy
   QUY TRÌNH nào của nhóm cho kết quả tốt (bao nhiêu ý tưởng tới được danh mục, mất bao lâu, ý tưởng duyệt mà để đó lẽ ra lãi hay lỗ, ý tưởng bị bác sau đó đi đâu).
   Phép tính ở /lib/idea-journey.js và /lib/ideas.js (có kiểm thử). Dùng global của group.js (GR, grCall, grRender), group-limits.js (glDate) và assets/risk.js (rkEsc, rkNum, rkPct, rkKpi). */

const GJ = { state: 'idle', error: '', raw: null, out: null, filter: 'all', marksError: '', loadedKey: '' };

const GJ_PATH_TONE = { pending: 'mute', rejected: 'bad', idle: 'warn', executed: 'ok' };
const GJ_FLAG = { idle: ['warn', 'Duyệt rồi mà để đó'], stuck: ['warn', 'Đề xuất lệnh kẹt chờ duyệt'], no_trade_found: ['info', 'Vào danh mục nhưng không thấy lệnh'] };

function gjName(id) { return (GJ.raw && GJ.raw.members && GJ.raw.members[id]) || 'Thành viên'; }
function gjD(iso) { return iso ? glDate(String(iso).length <= 10 ? iso + 'T00:00:00' : iso) : '—'; }

async function gjLoad(force) {
    if (GJ.state === 'loading') return;
    const key = GR.data ? GR.data.fetchedAt : '';
    if (GJ.state === 'ok' && !force && GJ.loadedKey === key) { grRender(); return; }
    GJ.state = 'loading'; GJ.error = ''; GJ.marksError = '';
    grRender();
    try {
        const [raw, requests] = await Promise.all([grCall('listIdeas'), grCall('listAllOrderRequests', { days: 540 }).catch(() => [])]);
        const ideas = raw.ideas.map(IdeaFlow.normalize);
        const symbols = [...new Set(ideas.filter(i => i.status !== 'closed').map(i => i.symbol))];
        let marks = { prices: {}, index: null };
        if (symbols.length) { try { marks = await grCall('getIdeaMarks', { symbols, email: (GL.actor && GL.actor.actorEmail) || '' }); } catch (e) { GJ.marksError = e.message || String(e); } }
        const evals = {};
        ideas.forEach(i => { const m = marks.prices && marks.prices[i.symbol]; evals[i.id] = IdeaFlow.evaluate(i, { nowPrice: m ? m.price : null, indexNow: marks.index }); });
        GJ.raw = raw;
        GJ.out = IdeaJourney.build({ ideas, requests, txns: (GR.data && GR.data.txns) || [], evals, today: new Date().toISOString().slice(0, 10) });
        GJ.state = 'ok'; GJ.loadedKey = key;
    } catch (e) { GJ.state = 'error'; GJ.error = e.message || String(e); }
    grRender();
}

function gjSetFilter(v) { GJ.filter = v; grRender(); }

function gjTimeline(r) {
    const s = r.stages, d = r.days;
    const step = (label, at, extra) => `<span class="gj-step ${at ? 'done' : ''}" title="${rkEsc(label)}">${rkEsc(label)}${at ? ' ' + gjD(at) : ''}${extra ? `<small>${rkEsc(extra)}</small>` : ''}</span>`;
    return [step('Đề xuất', s.proposedAt), step(r.path === 'rejected' ? 'Bị bác' : 'Duyệt', s.decidedAt, d.toDecide !== null ? '+' + d.toDecide + ' ngày' : ''),
        r.direction === 'avoid' ? '' : step('Đề xuất lệnh', s.requestedAt, s.requestedAt && d.toRequest !== null ? '+' + d.toRequest + ' ngày' : (r.inferred ? 'không qua đề xuất' : '')),
        r.direction === 'avoid' ? '' : step('Ghi lệnh', s.firstExecAt, s.firstExecAt && d.toExecute !== null ? '+' + d.toExecute + ' ngày' + (r.inferred ? ' (suy đoán)' : '') : ''),
        r.status === 'closed' ? step('Đóng', s.closedAt) : ''].filter(Boolean).join('<i class="gj-arrow">›</i>');
}

function grJourneyHtml() {
    if (GJ.state === 'loading' || GJ.state === 'idle') return '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang dựng hành trình ý tưởng…</div>';
    if (GJ.state === 'error') return `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không tải được: ${rkEsc(GJ.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="gjLoad(true)">Thử lại</button></div>`;
    const o = GJ.out, S = o.summary, f = S.funnel;
    if (!o.rows.length) return '<div class="tl-empty"><i class="fa-solid fa-route"></i>Nhóm chưa có ý tưởng đầu tư nào. Ý tưởng được tạo ở Nghiên Cứu → Ý tưởng.</div>';
    const pct = (n, d) => d ? Math.round(n / d * 100) + '%' : '—';
    const med = (v) => v === null ? '—' : v + ' ngày';
    const stat = (k) => { const s = S.byPath[k]; return s.n ? `${s.n} ý tưởng · ${s.alphaN ? 'vượt VN-Index ' + (s.avgAlpha > 0 ? '+' : '') + rkNum(s.avgAlpha, 1) + ' điểm % (' + s.alphaN + ' có kết quả)' : 'chưa có kết quả'}` : 'không có'; };
    let html = (GJ.marksError ? `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không lấy được giá hiện tại: ${rkEsc(GJ.marksError)}. Kết quả của ý tưởng đang mở có thể thiếu.</span></div>` : '')
        + `<div class="tl-kpis">${[
        rkKpi('Ý tưởng', String(f.total), `${f.decided} đã có quyết định`),
        rkKpi('Được duyệt', String(f.approved), pct(f.approved, f.decided) + ' số đã quyết định'),
        rkKpi('Tới được danh mục', String(f.executed), pct(f.executed, f.approved) + ' số được duyệt'),
        rkKpi('Duyệt → ghi lệnh', med(S.timing.toExecute), 'trung vị'),
        rkKpi('Đề xuất → duyệt', med(S.timing.toDecide), 'trung vị'),
    ].join('')}</div>`;
    if (S.insights.length) html += `<div class="rk-warns">${S.insights.map(i => `<div class="rk-warn ${{ good: 'good', warn: 'med', info: 'low', mute: 'low' }[i.tone] || 'low'}"><i class="fa-solid ${i.tone === 'good' ? 'fa-circle-check' : (i.tone === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info')}"></i><span>${rkEsc(i.text)}</span></div>`).join('')}</div>`;
    html += `<div class="ce-group-title">Kết quả theo đường đi</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Đường đi</th><th>Ý tưởng</th></tr></thead><tbody>
        ${['executed', 'idle', 'rejected', 'pending'].map(k => `<tr><td><span class="tl-badge ${GJ_PATH_TONE[k]}">${rkEsc(IdeaJourney.PATHS[k].label)}</span></td><td>${rkEsc(stat(k))}</td></tr>`).join('')}</tbody></table></div>
        <p class="tl-hint">Kết quả mỗi ý tưởng tính từ giá ghi nhận lúc đề xuất tới giá hiện tại (hoặc giá đóng) so với VN-Index, kể cả ý tưởng bị bác — để biết quyết định bác/duyệt đúng hay sai. Các nhóm có dưới ${S.minN} kết quả không được dùng để so sánh. Không phải kết quả đầu tư thực tế của ai: lệnh thực tế phụ thuộc giá khớp và quy mô.</p>`;
    const rows = o.rows.filter(r => GJ.filter === 'all' || (GJ.filter === 'flag' ? r.flags.length : r.path === GJ.filter))
        .sort((a, b) => (b.flags.length - a.flags.length) || (String(b.stages.decidedAt || b.stages.proposedAt) < String(a.stages.decidedAt || a.stages.proposedAt) ? -1 : 1));
    html += `<div class="ce-group-title">Từng ý tưởng <select class="tl-select" style="margin-left:10px;font-weight:400" onchange="gjSetFilter(this.value)" aria-label="Lọc">
        ${[['all', 'Tất cả'], ['flag', 'Cần chú ý'], ['executed', 'Đã thực hiện'], ['idle', 'Duyệt chưa thực hiện'], ['rejected', 'Bị bác'], ['pending', 'Chưa quyết định']].map(([v, l]) => `<option value="${v}" ${GJ.filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Ý tưởng</th><th>Hành trình</th><th class="text-right">Đã ghi lệnh</th><th class="text-right">Kết quả</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td><b>${rkEsc(r.symbol)}</b>${r.direction === 'avoid' ? ' <span class="tl-badge mute">tránh</span>' : ''}<span class="symbol-sub">${rkEsc(r.title)}</span><span class="symbol-sub">${rkEsc(gjName(r.userId))}</span></td>
            <td><span class="tl-badge ${GJ_PATH_TONE[r.path]}">${rkEsc(IdeaJourney.PATHS[r.path].label)}</span>${r.flags.map(fl => ` <span class="tl-badge ${GJ_FLAG[fl][0]}">${rkEsc(GJ_FLAG[fl][1])}</span>`).join('')}<div class="gj-line">${gjTimeline(r)}</div></td>
            <td class="text-right">${r.exec.count ? `${r.exec.buyers} người · ${rkVnd(r.exec.value)}${r.inferred ? '<span class="symbol-sub">suy đoán theo mã và ngày</span>' : ''}` : '—'}</td>
            <td class="text-right">${r.result ? `<span class="${r.result.returnPct >= 0 ? 'tl-up' : 'tl-down'}">${rkPct(r.result.returnPct, 1, true)}</span>${r.result.alphaPct !== null && r.result.alphaPct !== undefined ? `<span class="symbol-sub">so VN-Index ${rkPct(r.result.alphaPct, 1, true)}</span>` : ''}${r.result.closed ? '<span class="symbol-sub">đã đóng</span>' : ''}` : '—'}</td></tr>`).join('')}
        </tbody></table></div>`;
    return html;
}
