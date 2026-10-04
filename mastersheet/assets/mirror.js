/* --- FILE: /mastersheet/assets/mirror.js ---
   Tab "Gương": soi cách MÌNH ra quyết định -- mức tự tin có dự báo đúng không, thiên kiến chốt lời sớm/giữ lỗ lâu, mua đuổi, bán hoảng loạn, điểm vào/ra có tạo lợi thế
   so với VN-Index không, bán xong giá đi đâu, quy trình tốt có cho kết quả tốt không. Phép tính ở /lib/decision-mirror.js (có kiểm thử).
   Dùng global: callGAS, targetEmail, escapeAssetHtml, rkKpi/rkPct/rkNum/rkVnd/rkBar (risk.js), DecisionJournal, DecisionMirror. */

const MR = { state: 'idle', error: '', inputs: null, result: null };

const mrEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const mrP = (v, d, signed) => (v === null || v === undefined) ? '—' : rkPct(v, d === undefined ? 1 : d, signed);
const mrCls = (v) => v > 0 ? 'tl-up' : (v < 0 ? 'tl-down' : '');

async function loadMirror(force) {
    const body = document.getElementById('mr-body');
    if (!body) return;
    if (MR.state === 'loading') return;
    if (MR.state === 'ok' && !force) { renderMirror(); return; }
    MR.state = 'loading';
    body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang đọc sổ lệnh, nhật ký và giá lịch sử… (có thể mất vài giây)</div>';
    try {
        const r = await callGAS('getMirrorInputs', { email: targetEmail });
        if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
        MR.inputs = r.data;
        MR.result = DecisionMirror.analyze({ txns: MR.inputs.txns, actions: MR.inputs.actions, histories: MR.inputs.histories, decisions: MR.inputs.decisions, today: MR.inputs.today });
        MR.state = 'ok';
    } catch (e) { MR.state = 'error'; MR.error = e.message || String(e); }
    renderMirror();
}

const MR_TONE = { warn: ['warn', 'fa-triangle-exclamation', 'Cần chú ý'], good: ['ok', 'fa-circle-check', 'Điểm mạnh'], info: ['mute', 'fa-circle-info', 'Ghi nhận'] };

function mrFindingsHtml(r) {
    if (!r.findings.length) return '<div class="tl-empty" style="padding:14px"><i class="fa-solid fa-mirror"></i>Chưa đủ dữ liệu để đưa ra nhận xét nào. Cần thêm lệnh bán, nhật ký quyết định có mức tự tin, hoặc lịch sử giá.</div>';
    return `<div class="mr-findings">${r.findings.map(f => { const t = MR_TONE[f.tone] || MR_TONE.info;
        return `<div class="mr-find ${t[0]}"><div class="mr-find-head"><span class="tl-badge ${t[0]}"><i class="fa-solid ${t[1]}"></i> ${t[2]}</span><b>${mrEsc(f.title)}</b><span class="mr-n ${f.solid ? '' : 'weak'}" title="${f.solid ? 'Mẫu đủ lớn để tham khảo' : 'Mẫu còn nhỏ: chỉ là dấu hiệu, chưa kết luận được'}">${f.solid ? 'mẫu ' + f.n : 'mẫu nhỏ · ' + f.n}</span></div>
            <div class="mr-find-body">${mrEsc(f.evidence)}</div>${f.tip ? `<div class="mr-find-tip"><i class="fa-solid fa-lightbulb"></i> ${mrEsc(f.tip)}</div>` : ''}</div>`; }).join('')}</div>`;
}

function mrCalibrationHtml(r) {
    const d = r.decisions;
    if (!d.rows.length) return '<p class="tl-hint">Cần các quyết định MUA trong Nhật Ký đã qua ít nhất 30 ngày để đo. Ghi mức tự tin (1–5) lúc ra quyết định.</p>';
    const max = Math.max(10, ...d.calibration.map(c => Math.abs(c.avgAlpha || 0)));
    const corr = d.confidenceCorr;
    return `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Mức tự tin</th><th class="text-right">Số quyết định</th><th class="text-right">Thắng thị trường</th><th class="text-right">Lợi suất TB</th><th>Vượt VN-Index TB</th></tr></thead><tbody>
        ${d.calibration.map(c => `<tr><td><b>${c.level}</b> ${'●'.repeat(c.level)}</td><td class="text-right">${c.n}</td><td class="text-right">${c.n ? mrP(c.beatPct, 0) : '—'}</td><td class="text-right ${mrCls(c.avgReturn)}">${c.n ? mrP(c.avgReturn, 1, true) : '—'}</td>
            <td>${c.n ? `<span class="rk-pair"><b class="${mrCls(c.avgAlpha)}">${mrP(c.avgAlpha, 1, true)}</b>${rkBar(Math.abs(c.avgAlpha), max, c.avgAlpha < 0 ? 'over' : '')}</span>` : '—'}</td></tr>`).join('')}</tbody></table></div>
        <p class="tl-hint">${corr === null ? `Cần ít nhất ${DecisionMirror.MIN_N} quyết định có mức tự tin để tính độ tương quan.` : `Tương quan hạng giữa mức tự tin và kết quả: <b>${rkNum(corr, 2)}</b> (${d.nWithConfidence} quyết định). +1 = tự tin càng cao càng đúng; 0 = mức tự tin không nói lên điều gì; âm = tự tin cao lại hay sai.`} Kết quả tính từ giá lúc quyết định tới hết thời hạn đã ghi (hoặc 6 tháng) hay tới nay nếu chưa hết hạn.</p>`;
}

function mrBehaviorHtml(r) {
    const d = r.disposition, h = r.holding, c = r.behavior.chase, p = r.behavior.panic;
    let html = '';
    if (d.pgr !== null && d.plr !== null) {
        html += `<div class="mr-meter"><div><span class="k">Tỷ lệ CHỐT LỜI khi có cơ hội</span><div class="rk-pair"><b>${mrP(d.pgr * 100, 0)}</b>${rkBar(d.pgr * 100, 100, '')}</div><small>${d.RG} lần bán lời / ${d.RG + d.PG} lần có lãi chưa bán</small></div>
            <div><span class="k">Tỷ lệ CẮT LỖ khi có cơ hội</span><div class="rk-pair"><b>${mrP(d.plr * 100, 0)}</b>${rkBar(d.plr * 100, 100, 'risk')}</div><small>${d.RL} lần bán lỗ / ${d.RL + d.PL} lần đang lỗ chưa bán</small></div></div>
            <p class="tl-hint">Chênh lệch ${mrP(d.diff * 100, 0, true)} điểm${d.p !== null ? ` (p≈${rkNum(d.p, 2)}, ${d.nRealized} lần bán)` : ''}. Dương và có ý nghĩa = chốt lời sớm hơn cắt lỗ (“disposition effect”, Odean 1998). Chỉ tính ở những ngày có bán, so mỗi mã đang giữ với giá vốn trung bình.</p>`;
    } else html += '<p class="tl-hint">Chưa đủ lệnh bán để đo xu hướng chốt lời/cắt lỗ.</p>';
    html += `<div class="tl-kpis" style="margin-top:10px">${[
        rkKpi('Giữ lệnh lời', h.winners.avgDays === null ? '—' : rkNum(h.winners.avgDays, 0) + ' ngày', h.winners.n + ' lệnh bán lời'),
        rkKpi('Giữ lệnh lỗ', h.losers.avgDays === null ? '—' : rkNum(h.losers.avgDays, 0) + ' ngày', h.losers.n + ' lệnh bán lỗ', h.lossHoldRatio !== null && h.lossHoldRatio >= 1.3 ? 'tl-down' : ''),
        rkKpi('Mua sau khi giá đã tăng ≥10%', c.n ? mrP(c.runupSharePct, 0) : '—', `${c.runup.n} / ${c.n} lệnh mua`, c.runupSharePct >= 40 ? 'tl-down' : ''),
        rkKpi('Bán sau nhịp giảm ≥8%', String(p.n), p.nAfter ? `sau 30 ngày: ${mrP(p.avgAfter, 1, true)} TB` : 'chưa đủ 30 ngày'),
    ].join('')}</div>`;
    if (c.n) html += `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Lệnh mua theo diễn biến 4 tuần trước</th><th class="text-right">Số lệnh</th><th class="text-right">Giá 4 tuần trước (TB)</th><th class="text-right">Sau 30 ngày so với VN-Index</th></tr></thead><tbody>
        ${[['Sau khi tăng ≥10% (mua đuổi)', c.runup], ['Đi ngang', c.flat], ['Sau khi giảm ≥5% (mua nhịp giảm)', c.dip]].map(([t, g]) => `<tr><td>${t}</td><td class="text-right">${g.n}</td><td class="text-right">${mrP(g.avgPrior, 1, true)}</td><td class="text-right ${mrCls(g.avgExcess)}">${g.nFwd ? mrP(g.avgExcess, 1, true) + ` <small>(${g.nFwd})</small>` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
    return html;
}

function mrTimingHtml(r) {
    const rows = [];
    DecisionMirror.FWD.forEach(f => {
        const b = r.timing.buys[f], s = r.timing.sells[f];
        rows.push(`<tr><td>Sau <b>${f}</b> ngày</td><td class="text-right">${b.n}</td><td class="text-right ${mrCls(b.avgReturn)}">${mrP(b.avgReturn, 1, true)}</td><td class="text-right ${mrCls(b.avgExcess)}">${mrP(b.avgExcess, 1, true)}</td><td class="text-right">${b.nExcess ? mrP(b.hitPct, 0) : '—'}</td>
            <td class="text-right">${s.n}</td><td class="text-right ${mrCls(-s.avgExcess)}">${mrP(s.avgExcess, 1, true)}</td></tr>`);
    });
    const si = r.holding.sellImpact;
    return `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th></th><th class="text-right">Lệnh mua</th><th class="text-right">Lợi suất giá TB</th><th class="text-right">Vượt VN-Index TB</th><th class="text-right">Thắng thị trường</th><th class="text-right">Lệnh bán</th><th class="text-right">Mã sau bán so với VN-Index</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
        <p class="tl-hint">Mua đúng thì mã tăng hơn thị trường sau lệnh; bán đúng thì mã sau bán kém thị trường (số ÂM ở cột cuối là tốt). Lợi suất theo giá đóng cửa, đã điều chỉnh thưởng/tách, chưa gồm cổ tức tiền.</p>
        ${si.n ? `<div class="tl-kpis"><div class="tl-kpi big"><span class="k">Nếu cứ giữ các mã đã bán đến nay</span><span class="v ${mrCls(-si.valueVnd)}">${si.valueVnd <= 0 ? '+' : '−'}${rkVnd(Math.abs(si.valueVnd))}</span><span class="s">${si.valueVnd <= 0 ? 'giữ lại sẽ có thêm' : 'bán đã có lợi hơn giữ'} · ${mrP(si.rightPct, 0)} lệnh bán đúng (${si.n} lệnh) · phí và thuế bán đã trả ${rkVnd(r.holding.sellCosts)}</span></div></div>` : ''}`;
}

function mrProcessHtml(r) {
    const q = r.decisions.process, n = r.decisions.nOutcomes;
    if (!n) return '<p class="tl-hint">Cần quyết định MUA trong Nhật Ký đã qua ít nhất 30 ngày.</p>';
    const cell = (v, t, cls) => `<div class="mr-cell ${cls}"><b>${v}</b><span>${t}</span></div>`;
    return `<div class="mr-quad"><div class="mr-quad-h"></div><div class="mr-quad-h">Thắng thị trường</div><div class="mr-quad-h">Thua thị trường</div>
        <div class="mr-quad-h side">Kế hoạch đầy đủ<br><small>lý do + mục tiêu + cắt lỗ</small></div>${cell(q.goodGood, 'Quy trình tốt, kết quả tốt', 'ok')}${cell(q.goodBad, 'Quy trình tốt, kết quả xấu (không phải lỗi)', 'mute')}
        <div class="mr-quad-h side">Kế hoạch thiếu</div>${cell(q.badGood, 'May mắn — khó lặp lại', 'warn')}${cell(q.badBad, 'Quy trình kém, kết quả xấu', 'bad')}</div>
        <p class="tl-hint">${n} quyết định mua đã đủ 30 ngày. Quy trình tốt vẫn có thể thua (thị trường không chắc chắn); đáng lo là ô “may mắn”: thắng mà không có kế hoạch thì không học được gì và khó lặp lại.</p>`;
}

function renderMirror() {
    const body = document.getElementById('mr-body');
    if (!body) return;
    if (MR.state === 'loading' || MR.state === 'idle') return;
    if (MR.state === 'error') { body.innerHTML = `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không dựng được Gương: ${mrEsc(MR.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="loadMirror(true)">Thử lại</button></div>`; return; }
    const r = MR.result, hErr = MR.inputs.historyError;
    if (!r.ok) { body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-mirror"></i>Chưa có lệnh giao dịch nào. Gương cần sổ lệnh để soi: hãy thêm lệnh hoặc nhập sao kê.</div>'; return; }
    let html = '';
    if (hErr) html += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không lấy được giá lịch sử: ${mrEsc(hErr)}. Các phân tích cần giá (điểm vào/ra, mua đuổi, bán hoảng loạn) sẽ thiếu.</span></div>`;
    else if (r.missingSymbols.length) html += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Thiếu giá lịch sử của: ${mrEsc(r.missingSymbols.join(', '))} — các lệnh của mã này chưa được tính vào phần cần giá.</span></div>`;
    if (r.smallSample) html += `<div class="conc-warn"><i class="fa-solid fa-circle-info"></i><span>Mới có ${r.nTrades} lệnh: Gương cần nhiều lệnh hơn (từ vài chục) mới nói được thói quen. Các nhận xét dưới đây chỉ là dấu hiệu ban đầu.</span></div>`;
    html += `<div class="rk-meta">${r.nTrades} lệnh (${r.nBuys} mua, ${r.nSells} bán) từ ${calDate(r.firstDate)} · ${r.decisions.rows.length} quyết định mua trong Nhật Ký đã đủ tuổi để đo${r.hasBench ? '' : ' · <b>chưa có VN-Index</b> nên chưa so được với thị trường'}</div>`;
    html += `<div class="ce-group-title">Huấn luyện viên nhận xét</div>${mrFindingsHtml(r)}`;
    html += `<div class="ce-group-title">Mức tự tin của bạn có đáng tin không?</div>${mrCalibrationHtml(r)}`;
    html += `<div class="ce-group-title">Thiên kiến hành vi</div>${mrBehaviorHtml(r)}`;
    html += `<div class="ce-group-title">Điểm vào và điểm ra</div>${mrTimingHtml(r)}`;
    html += `<div class="ce-group-title">Quy trình tốt có cho kết quả tốt?</div>${mrProcessHtml(r)}`;
    html += '<p class="tl-hint">Gương chỉ mô tả thói quen đã đo được trên dữ liệu của bạn, kèm cỡ mẫu; không phải khuyến nghị đầu tư. Một vài tháng dữ liệu rất dễ cho kết luận sai — hãy xem xu hướng sau nhiều tháng.</p>';
    body.innerHTML = html;
}
