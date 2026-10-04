/* --- FILE: /mastersheet/assets/brinson.js ---
   Phân tích Brinson-Fachler: lợi suất danh mục so với DANH MỤC CHUẨN CHIẾN LƯỢC của nhóm (tỷ trọng mục tiêu theo ngành do quản lý đặt), tách thành
   phân bổ ngành / chọn mã trong ngành / tương tác. Phép tính ở /lib/brinson-calc.js (có kiểm thử), dựa trên kết quả AttributionCalc.analyze.
   File này gồm: (1) các hàm dùng chung (tải chuẩn + chỉ số ngành, dựng HTML kết quả, biểu đồ) -- dùng cả ở Toàn Nhóm (group-strategy.js);
   (2) thẻ "Phân Bổ Ngành Và Chọn Mã" trong tab Hiệu Suất của cá nhân, gọi từ attribution.js sau mỗi lần tính nguồn gốc lợi nhuận.
   Dùng global: callGAS, targetEmail, escapeAssetHtml, cssVar, cssVarAlpha, Chart.js, BrinsonCalc, rkKpi/rkPct/rkNum/rkVnd (risk.js). */

const BS = { policy: { weights: {}, updatedAt: null }, policyState: 'idle', policyError: '', indices: null, indicesKey: '', indicesError: '', personal: { state: 'idle', result: null, error: '' }, charts: [] };

const bsEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const bsP = (v, d, signed) => (v === null || v === undefined || !isFinite(v)) ? '—' : rkPct(v, d === undefined ? 2 : d, !!signed);
const bsCls = (v) => v > 0.005 ? 'tl-up' : (v < -0.005 ? 'tl-down' : '');

async function bsLoadPolicy(force) {
    if (BS.policyState === 'ok' && !force) return BS.policy;
    try {
        const r = await callGAS('listPolicy', {});
        if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
        BS.policy = r.data; BS.policyState = 'ok'; BS.policyError = '';
    } catch (e) { BS.policyState = 'error'; BS.policyError = e.message || String(e); }
    return BS.policy;
}

// Chuỗi điểm các chỉ số ngành (cache theo ngày bắt đầu)
async function bsLoadIndices(from) {
    const key = String(from || '');
    if (BS.indices && BS.indicesKey === key) return BS.indices;
    try {
        const r = await callGAS('getSectorIndices', { from });
        if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
        BS.indices = r.data || {}; BS.indicesKey = key; BS.indicesError = '';
    } catch (e) { BS.indices = {}; BS.indicesKey = ''; BS.indicesError = e.message || String(e); }
    return BS.indices;
}

// attribution: kết quả AttributionCalc.analyze. Trả kết quả BrinsonCalc.analyze (hoặc { ok:false, reason })
function bsAnalyze(attribution, policyWeights) {
    const weights = policyWeights || BS.policy.weights || {};
    const sectors = Array.from(new Set(((attribution && attribution.sectors) || []).map(s => s.sector).concat(Object.keys(weights))));
    const returns = BrinsonCalc.sectorReturns(BS.indices || {}, sectors, attribution ? attribution.from : '', attribution ? attribution.to : '');
    return BrinsonCalc.analyze({ attribution, policy: weights, returns });
}

const BS_REASON = {
    noBase: 'Chưa đủ lịch sử NAV để tính mẫu số của kỳ này.',
    noBench: 'Chưa có dữ liệu VN-Index trong kỳ nên chưa tính được vốn bình quân theo ngành.',
    noPolicy: 'Nhóm chưa đặt danh mục chuẩn chiến lược. Quản lý đặt ở trang Toàn Nhóm > Chiến Lược.',
    badPolicy: 'Danh mục chuẩn chiến lược không hợp lệ.',
};

function bsResultHtml(res, canvasId) {
    if (!res.ok) return `<div class="tl-empty" style="padding:14px"><i class="fa-solid fa-scale-unbalanced"></i>${bsEsc(BS_REASON[res.reason] || 'Chưa tính được.')}${res.error ? ' ' + bsEsc(res.error) : ''}</div>`;
    let html = `<div class="tl-kpis">${[
        rkKpi('Danh mục', bsP(res.portfolioPct, 2, true), 'lợi suất trong kỳ (theo vốn bình quân)', bsCls(res.portfolioPct)),
        rkKpi('Chuẩn chiến lược', bsP(res.benchmarkPct, 2, true), 'theo tỷ trọng mục tiêu × chỉ số ngành'),
        rkKpi('Hơn / kém chuẩn', bsP(res.activePct, 2, true), 'điểm phần trăm', bsCls(res.activePct)),
        rkKpi('Phân bổ ngành', bsP(res.allocation, 2, true), 'nắm nhiều/ít ngành đúng lúc', bsCls(res.allocation), 'Tổng (tỷ trọng thực − tỷ trọng chuẩn) × (lợi suất ngành chuẩn − lợi suất chuẩn chung)'),
        rkKpi('Chọn mã', bsP(res.selection, 2, true), 'trong ngành so với chỉ số ngành', bsCls(res.selection), 'Tổng tỷ trọng chuẩn × (lợi suất ngành của danh mục − lợi suất chỉ số ngành)'),
        rkKpi('Tương tác', bsP(res.interaction, 2, true), 'phần chung của hai quyết định', bsCls(res.interaction)),
    ].join('')}</div>`;
    if (res.notes.length) html += `<div class="rk-warns">${res.notes.map((n, i) => `<div class="rk-warn ${i === 0 ? (res.activePct >= 0 ? 'good' : 'med') : 'low'}"><i class="fa-solid ${i === 0 ? (res.activePct >= 0 ? 'fa-circle-check' : 'fa-triangle-exclamation') : 'fa-circle-info'}"></i><span>${bsEsc(n)}</span></div>`).join('')}</div>`;
    html += `<div class="tl-card rk-chart-card"><div style="position:relative;height:${Math.max(200, res.rows.length * 34 + 60)}px"><canvas id="${canvasId}"></canvas></div></div>`;
    html += `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Ngành</th><th>Chỉ số chuẩn</th><th class="text-right">Tỷ trọng thực</th><th class="text-right">Tỷ trọng chuẩn</th><th class="text-right">Lợi suất thực</th><th class="text-right">Lợi suất chuẩn</th><th class="text-right">Phân bổ</th><th class="text-right">Chọn mã</th><th class="text-right">Tương tác</th><th class="text-right">Tổng</th></tr></thead><tbody>
        ${res.rows.map(r => `<tr><td><b>${bsEsc(r.sector)}</b></td><td>${r.index ? bsEsc(r.index) + (r.noIndex ? ' <span class="tl-badge warn" title="Thiếu dữ liệu chỉ số">thiếu</span>' : '') : '—'}</td>
            <td class="text-right">${bsP(r.wpPct, 1)}</td><td class="text-right">${bsP(r.wbPct, 1)}</td><td class="text-right ${bsCls(r.rpPct)}">${bsP(r.rpPct, 1, true)}</td><td class="text-right ${bsCls(r.rbPct)}">${bsP(r.rbPct, 1, true)}</td>
            <td class="text-right ${bsCls(r.allocation)}">${bsP(r.allocation, 2, true)}</td><td class="text-right ${bsCls(r.selection)}">${bsP(r.selection, 2, true)}</td><td class="text-right ${bsCls(r.interaction)}">${bsP(r.interaction, 2, true)}</td><td class="text-right ${bsCls(r.total)}"><b>${bsP(r.total, 2, true)}</b></td></tr>`).join('')}
        <tr class="tl-total-row"><td colspan="6"><b>Tổng</b></td><td class="text-right ${bsCls(res.allocation)}"><b>${bsP(res.allocation, 2, true)}</b></td><td class="text-right ${bsCls(res.selection)}"><b>${bsP(res.selection, 2, true)}</b></td><td class="text-right ${bsCls(res.interaction)}"><b>${bsP(res.interaction, 2, true)}</b></td><td class="text-right ${bsCls(res.activePct)}"><b>${bsP(res.activePct, 2, true)}</b></td></tr>
        </tbody></table></div>
        <p class="tl-hint">Lợi suất thực của ngành = lãi/lỗ ngành ÷ vốn bình quân trong ngành (gồm cổ tức, đã trừ phí/thuế). Lợi suất chuẩn của ngành = lợi suất giá của chỉ số ngành HOSE tương ứng; tiền mặt coi là 0%. Tổng phân bổ + chọn mã + tương tác = hơn/kém chuẩn. Dùng tỷ trọng chuẩn HIỆN TẠI cho cả kỳ${res.residualPct ? `; ${bsP(res.residualPct, 2, true)} điểm lãi/lỗ phát sinh khi vốn bình quân ≈ 0 chưa gán vào ngành` : ''}.</p>`;
    return html;
}

function bsDrawChart(res, canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined' || !res.ok) return null;
    const rows = res.rows;
    const mk = (label, key, color) => ({ label, data: rows.map(r => Math.round(r[key] * 1000) / 1000), backgroundColor: cssVarAlpha(color, 0.85), borderRadius: 2, stack: 's' });
    const chart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels: rows.map(r => r.sector), datasets: [mk('Phân bổ', 'allocation', '--series-1'), mk('Chọn mã', 'selection', '--series-3'), mk('Tương tác', 'interaction', '--series-2')] },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: cssVar('--text-secondary'), boxWidth: 14 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${bsP(c.raw, 2, true)} điểm` } } },
            scales: { x: { stacked: true, ticks: { color: cssVar('--text-secondary'), callback: (v) => v + ' đ' }, grid: { color: cssVar('--border-color') }, title: { display: true, text: 'điểm phần trăm', color: cssVar('--text-muted') } }, y: { stacked: true, ticks: { color: cssVar('--text-secondary') }, grid: { display: false } } } },
    });
    BS.charts.push(chart);
    return chart;
}

// ---------- thẻ cá nhân (tab Hiệu Suất) ----------
async function bsRefresh() {
    const body = document.getElementById('bs-body');
    if (!body || typeof AT === 'undefined' || AT.state !== 'ok' || !AT.result) return;
    BS.charts.forEach(c => { try { c.destroy(); } catch (e) { /* đã huỷ */ } }); BS.charts = [];
    const a = AT.result;
    if (!a.rows || !a.rows.length) { body.innerHTML = '<div class="tl-empty" style="padding:14px">Không có mã nào trong kỳ để phân tích.</div>'; return; }
    body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang lấy danh mục chuẩn và chỉ số ngành…</div>';
    await bsLoadPolicy();
    if (!Object.keys(BS.policy.weights || {}).length) { body.innerHTML = bsResultHtml({ ok: false, reason: 'noPolicy' }); return; }
    await bsLoadIndices(a.from);
    let html = '';
    if (BS.policyError) html += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không đọc được danh mục chuẩn: ${bsEsc(BS.policyError)}</span></div>`;
    if (BS.indicesError) html += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không lấy được chỉ số ngành: ${bsEsc(BS.indicesError)}. Phần chọn mã chưa tách được.</span></div>`;
    const res = bsAnalyze(a);
    BS.personal.result = res;
    body.innerHTML = html + `<div class="rk-meta">Kỳ <b>${atDate(a.from)}</b> → <b>${atDate(a.to)}</b> · chuẩn chiến lược của nhóm${BS.policy.updatedAt ? ' cập nhật ' + atDate(String(BS.policy.updatedAt).slice(0, 10)) : ''} · ${Object.keys(BS.policy.weights).length} ngành, tiền mặt chuẩn ${rkNum(Math.max(0, 100 - Object.values(BS.policy.weights).reduce((s, v) => s + v, 0)), 1)}%</div>` + bsResultHtml(res, 'bs-chart');
    if (res.ok) bsDrawChart(res, 'bs-chart');
}
