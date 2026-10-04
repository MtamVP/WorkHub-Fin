/* --- FILE: /mastersheet/group.js ---
   Trang Toàn Nhóm: phân tích cấp nhóm -- danh mục chung (gộp mọi thành viên), mã nào nhiều người cùng giữ, rủi ro chung, mức trùng lặp danh mục
   giữa các thành viên, và bảng so sánh hiệu quả thành viên. Phép tính ở /lib/group-calc.js, /lib/risk-calc.js, /lib/perf-calc.js (có kiểm thử).
   Dùng lại các hàm dựng HTML của assets/risk.js (rkBuildHtml, rkKpi, rkPct...). Dùng global của script.js: callGAS, showToast, escapeAssetHtml, cssVar, cssVarAlpha. */

const GR = {
    state: 'idle',            // idle | loading | ok | error
    error: '',
    tab: 'portfolio',
    data: null, portfolios: [], group: null,
    market: null, bench: null, benchError: null,
    range: 'ytd', rf: PerfCalc.DEFAULT_RF,
    risk: null, perf: {}, groupPerf: null,
    sort: { key: 'nav', dir: -1 },
    charts: [],
};
const GR_KEY = 'wh.fin.group.v1';
try {
    const saved = JSON.parse(localStorage.getItem(GR_KEY) || 'null');
    if (saved) {
        if (['3m', '6m', 'ytd', '1y', 'all'].includes(saved.range)) GR.range = saved.range;
        if (saved.rf >= 0 && saved.rf <= 0.3) GR.rf = Number(saved.rf);
    }
} catch (e) { /* không có localStorage: dùng mặc định */ }

async function grCall(action, params) {
    const r = await callGAS(action, params || {});
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}

function grSave() { try { localStorage.setItem(GR_KEY, JSON.stringify({ range: GR.range, rf: GR.rf })); } catch (e) { /* bỏ qua */ } }

async function loadGroup(force) {
    const body = document.getElementById('grp-body');
    if (!body) return;
    if (GR.state === 'loading') return;
    if (GR.state === 'ok' && !force) { grRender(); return; }
    GR.state = 'loading';
    body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang gộp dữ liệu của cả nhóm… (có thể mất vài giây)</div>';
    try {
        const data = await grCall('getGroupData');
        GR.data = data;
        GR.portfolios = GroupCalc.memberPortfolios(data);
        GR.group = GroupCalc.consolidate(GR.portfolios);
        if (typeof glLoad === 'function') await glLoad();   // giới hạn + ngoại lệ (lỗi không làm hỏng các tab khác)
        const symbols = GR.group.symbols.map(s => s.symbol).slice(0, 40);
        const firstNav = data.navHistory.reduce((m, r) => (!m || r.snapshot_date < m ? r.snapshot_date : m), null);
        const [market, bench] = await Promise.all([
            symbols.length ? grCall('getMarketInputs', { symbols, windowDays: 365 }).catch(e => ({ histories: {}, historyError: e.message, events: [], eventsError: null })) : Promise.resolve({ histories: {}, events: [] }),
            firstNav ? grCall('getBenchSeries', { benchKey: 'VNINDEX', from: String(firstNav).slice(0, 10) }).then(s => ({ series: s, error: null })).catch(e => ({ series: null, error: e.message })) : Promise.resolve({ series: null, error: null }),
        ]);
        GR.market = market; GR.bench = bench.series; GR.benchError = bench.error;
        GR.state = 'ok';
        grCompute();
    } catch (e) { GR.state = 'error'; GR.error = e.message || String(e); }
    grRender();
}

// Tính lại các phân tích phụ thuộc cửa sổ/lãi phi rủi ro (không cần tải lại dữ liệu)
function grCompute() {
    if (GR.state !== 'ok') return;
    const g = GR.group;
    const range = PerfCalc.rangeFor(GR.range, new Date().toISOString().slice(0, 10));
    const holdings = g.symbols.map(s => ({ symbol: s.symbol, quantity: s.quantity, marketValue: s.value }));
    const lim = grLimits();
    GR.risk = RiskCalc.analyze({ holdings, cash: g.cash, debt: g.debt, histories: (GR.market && GR.market.histories) || {}, events: (GR.market && GR.market.events) || [], navHistory: GroupCalc.groupNavHistory(GR.data.navHistory) },
        { windowDays: 365, singleLimit: lim.singleLimit, sectorLimit: lim.sectorLimit });
    GR.perf = {};
    GR.portfolios.forEach(p => {
        const rows = GR.data.navHistory.filter(r => r.user_id === p.id);
        GR.perf[p.id] = PerfCalc.analyze({ navHistory: rows, bench: GR.bench, rf: GR.rf, range });
    });
    GR.groupPerf = PerfCalc.analyze({ navHistory: GroupCalc.groupNavHistory(GR.data.navHistory), bench: GR.bench, rf: GR.rf, range });
}

// Ngưỡng tập trung của nhóm (mở rộng ở phần Giới Hạn): mặc định 25% / 40%
function grLimits() {
    if (typeof grGroupLimits === 'function') return grGroupLimits();
    return { singleLimit: 25, sectorLimit: 40 };
}

function switchGroupTab(tab) {
    GR.tab = tab;
    document.querySelectorAll('#grp-tabs .view-toggle-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-gtab') === tab));
    grRender();
}

function grChangeRange() {
    GR.range = document.getElementById('grp-range').value;
    grSave(); grCompute(); grRender();
}
function grChangeRf() {
    const v = Number(document.getElementById('grp-rf').value);
    if (!(v >= 0 && v <= 30)) { showToast('Lãi phi rủi ro từ 0 đến 30%/năm.', 'error'); return; }
    GR.rf = v / 100; grSave(); grCompute(); grRender();
}

// ---------- vẽ ----------
const grCls = (v) => v > 0 ? 'tl-up' : (v < 0 ? 'tl-down' : '');

function grHolderChips(s) {
    return s.holders.slice(0, 5).map(h => `<span class="gr-chip" title="${rkEsc(h.name)}: ${rkVnd(h.value)} (${rkPct(h.weightInMemberPct, 0)} danh mục của họ)">${rkEsc(h.name)} <b>${rkPct(h.weightInMemberPct, 0)}</b></span>`).join('') + (s.holders.length > 5 ? `<span class="gr-chip">+${s.holders.length - 5}</span>` : '');
}

function grPortfolioHtml() {
    const g = GR.group;
    if (!g.symbols.length) return '<div class="tl-empty"><i class="fa-solid fa-layer-group"></i>Chưa có thành viên nào đang giữ cổ phiếu.</div>';
    const ov = GroupCalc.overlap(GR.portfolios);
    const maxV = Math.max(...g.symbols.map(s => s.weightPct), 1);
    let html = `<div class="tl-kpis">${[
        rkKpi('NAV cả nhóm', rkVnd(g.nav), `${GR.portfolios.length} thành viên`),
        rkKpi('Giá trị cổ phiếu', rkVnd(g.marketValue), `${g.symbols.length} mã khác nhau`),
        rkKpi('Tiền mặt / nợ', `${rkVnd(g.cash)}`, g.debt > 0 ? `Nợ ${rkVnd(g.debt)}` : 'Không có nợ vay'),
        rkKpi('Mã nhiều người cùng giữ', String(g.sharedCount), `${rkPct(g.sharedValuePct, 0)} giá trị cổ phiếu`, g.sharedValuePct >= 60 ? 'tl-down' : '', 'Mã được từ 2 thành viên trở lên giữ cùng lúc: rủi ro bị nhân lên mà ít ai để ý'),
        rkKpi('Mức trùng danh mục TB', ov.avgPct === null ? '—' : rkPct(ov.avgPct, 0), 'giữa từng cặp thành viên', ov.avgPct !== null && ov.avgPct >= 50 ? 'tl-down' : '', '0% = hai người không có mã chung; 100% = giống hệt nhau'),
    ].join('')}</div>`;
    html += `<div class="ce-group-title">Danh mục chung: ai đang giữ gì</div>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Mã</th><th class="text-right">Số lượng</th><th class="text-right">Giá trị</th><th>Tỷ trọng nhóm</th><th class="text-right">Lãi/lỗ chưa chốt</th><th class="text-center">Số người giữ</th><th>Thành viên (tỷ trọng trong danh mục của họ)</th></tr></thead><tbody>
        ${g.symbols.map(s => `<tr><td><span class="symbol-name">${rkEsc(s.symbol)}<span class="symbol-sub">${rkEsc(s.sector)}</span></span></td>
            <td class="text-right">${rkNum(s.quantity)}</td><td class="text-right">${rkVnd(s.value)}</td>
            <td><span class="rk-pair"><b>${rkPct(s.weightPct, 1)}</b>${rkBar(s.weightPct, maxV, s.holderCount >= 2 ? '' : 'risk')}</span></td>
            <td class="text-right ${grCls(s.unrealizedPct)}">${rkPct(s.unrealizedPct, 1, true)}</td>
            <td class="text-center">${s.holderCount >= 2 ? `<span class="tl-badge warn">${s.holderCount}</span>` : '1'}</td>
            <td class="gr-holders">${grHolderChips(s)}</td></tr>`).join('')}
        </tbody></table></div>`;
    if (ov.names.length >= 2) {
        html += `<div class="ce-group-title">Mức trùng danh mục giữa các thành viên</div><div style="overflow-x:auto"><table class="rk-corr-table"><tr><th></th>${ov.names.map(n => `<th class="rk-corr-h">${rkEsc(n)}</th>`).join('')}</tr>
            ${ov.names.map((a, i) => `<tr><th class="rk-corr-h">${rkEsc(a)}</th>${ov.matrix[i].map((v, j) => i === j ? '<td class="rk-corr self">—</td>' : `<td class="rk-corr" style="background:color-mix(in srgb, var(--warning-color) ${Math.round(Math.min(v, 100) * 0.7)}%, transparent)">${rkNum(v, 0)}%</td>`).join('')}</tr>`).join('')}</table></div>
            <p class="tl-hint">Mức trùng = tổng phần nhỏ hơn trong tỷ trọng của hai người trên các mã chung. Cao nghĩa là hai người thực chất đang giữ cùng một danh mục.${ov.pairs[0] && ov.pairs[0].overlapPct > 0 ? ` Cặp giống nhau nhất: <b>${rkEsc(ov.pairs[0].a)}</b> và <b>${rkEsc(ov.pairs[0].b)}</b> (${rkPct(ov.pairs[0].overlapPct, 0)}${ov.pairs[0].common.length ? '; chung ' + rkEsc(ov.pairs[0].common.join(', ')) : ''}).` : ''}</p>`;
    }
    if (GR.risk && GR.risk.symbols) {
        const lim = grLimits();
        if (typeof rkxState === 'function') { const x = rkxState('grp'); x.rerender = grRender; x.market = GR.market; x.holdings = GR.group.symbols.map(s => ({ symbol: s.symbol, quantity: s.quantity, value: s.value })); }
        html += `<div class="ce-group-title" style="margin-top:22px">Rủi ro của danh mục chung</div>` + rkBuildHtml(GR.risk, { inputs: GR.market, limits: lim, windowDays: 365, chartId: 'grp-dd-chart', scope: 'grp' });
    }
    return html;
}

function grSortRows(rows) {
    const { key, dir } = GR.sort;
    return rows.slice().sort((a, b) => {
        const x = a[key], y = b[key];
        const xn = x === null || x === undefined, yn = y === null || y === undefined;
        if (xn && yn) return a.name < b.name ? -1 : 1;
        if (xn) return 1; if (yn) return -1;
        return typeof x === 'string' ? x.localeCompare(y, 'vi') * dir : (x - y) * dir;
    });
}
function grSort(key) { GR.sort = GR.sort.key === key ? { key, dir: -GR.sort.dir } : { key, dir: key === 'name' ? 1 : -1 }; grRender(); }

function grMembersHtml() {
    const g = GR.group, gp = GR.groupPerf;
    const rows = grSortRows(GroupCalc.memberTable(GR.portfolios, GR.perf, g));
    const benchOk = !!GR.bench;
    let html = '';
    if (GR.benchError) html += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không lấy được giá VN-Index: ${rkEsc(GR.benchError)}. Chưa so sánh được với chuẩn.</span></div>`;
    html += `<div class="rk-meta">Hiệu quả tính trên lịch sử NAV đã chụp của từng người (Modified Dietz, đã loại nạp/rút vốn). Chuỗi ngắn thì alpha/Sharpe sẽ ẩn (cần ≥ ${PerfCalc.MIN_PERIODS} kỳ).</div>`;
    if (gp && gp.ok) {
        html += `<div class="ce-group-title" style="margin-top:4px">Cả nhóm cộng lại</div><div class="tl-kpis">${[
            rkKpi('Lợi suất (TWR)', rkPct(gp.cumulativePct, 2, true), gp.annualizedPct !== null ? `${rkPct(gp.annualizedPct, 1, true)}/năm` : `${gp.periods} kỳ`, grCls(gp.cumulativePct)),
            gp.hasBench ? rkKpi('Vượt / thua VN-Index', rkPct(gp.excessCumulativePct, 2, true), 'điểm % cùng kỳ', grCls(gp.excessCumulativePct)) : '',
            gp.enough && gp.hasBench ? rkKpi('Alpha', rkPct(gp.alphaPct, 1, true), `beta ${rkNum(gp.beta, 2)}`, grCls(gp.alphaPct)) : '',
            gp.enough && gp.hasBench ? rkKpi('Information ratio', rkNum(gp.informationRatio, 2), `tracking error ${rkPct(gp.trackingErrorPct, 1)}`) : '',
            gp.enough ? rkKpi('Sharpe', rkNum(gp.sharpe, 2), `biến động ${rkPct(gp.volatilityPct, 1)}`) : '',
            gp.enough ? rkKpi('Sụt giảm tối đa', rkPct(gp.maxDD, 1), '', 'tl-down') : '',
        ].join('')}</div>`;
    }
    const cols = [['name', 'Thành viên', 1], ['nav', 'NAV'], ['sharePct', '% nhóm'], ['holdingCount', 'Số mã'], ['topWeightPct', 'Mã lớn nhất'], ['cashPct', 'Tiền mặt'],
        ['returnPct', 'Lợi suất'], ['excessPct', 'Vượt chuẩn'], ['alphaPct', 'Alpha'], ['beta', 'Beta'], ['sharpe', 'Sharpe'], ['maxDD', 'Sụt giảm tối đa'], ['overlapWithGroupPct', 'Trùng với người khác']];
    html += `<div class="ce-group-title">So sánh thành viên</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr>${cols.map(c => `<th class="${c[2] ? '' : 'text-right'}"><button type="button" class="tl-link" onclick="grSort('${c[0]}')">${c[1]}${GR.sort.key === c[0] ? (GR.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr></thead><tbody>
        ${rows.map(r => `<tr><td><span class="symbol-name">${rkEsc(r.name)}<span class="symbol-sub">${rkEsc(r.email)}</span></span></td>
            <td class="text-right">${rkVnd(r.nav)}</td><td class="text-right">${rkPct(r.sharePct, 1)}</td><td class="text-right">${r.holdingCount}</td>
            <td class="text-right">${r.topSymbol ? `${rkEsc(r.topSymbol)} <small>${rkPct(r.topWeightPct, 0)}</small>` : '—'}</td>
            <td class="text-right">${rkPct(r.cashPct, 0)}${r.leverage !== null ? ` <span class="tl-badge warn" title="Có nợ vay">margin</span>` : ''}</td>
            <td class="text-right ${grCls(r.returnPct)}">${rkPct(r.returnPct, 2, true)}</td><td class="text-right ${grCls(r.excessPct)}">${benchOk ? rkPct(r.excessPct, 2, true) : '—'}</td>
            <td class="text-right ${grCls(r.alphaPct)}">${rkPct(r.alphaPct, 1, true)}</td><td class="text-right">${rkNum(r.beta, 2)}</td><td class="text-right">${rkNum(r.sharpe, 2)}</td>
            <td class="text-right tl-down">${rkPct(r.maxDD, 1)}</td><td class="text-right ${r.overlapWithGroupPct >= 70 ? 'tl-down' : ''}">${rkPct(r.overlapWithGroupPct, 0)}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="ce-group-title">Lợi suất từng thành viên so với VN-Index</div><div class="tl-card rk-chart-card"><div style="position:relative;height:${Math.max(180, rows.length * 34 + 60)}px"><canvas id="grp-members-chart"></canvas></div></div>
        <p class="tl-hint">So sánh thành viên chỉ để thấy phong cách và kết quả khác nhau, không phải xếp hạng: mỗi người có thời điểm bắt đầu, vốn và mục tiêu riêng. Đừng kết luận từ vài tháng dữ liệu.</p>`;
    return html;
}

function grRender() {
    const body = document.getElementById('grp-body');
    if (!body) return;
    GR.charts.forEach(c => { try { c.destroy(); } catch (e) { /* đã huỷ */ } }); GR.charts = [];
    const rangeEl = document.getElementById('grp-range'); if (rangeEl) rangeEl.value = GR.range;
    const rfEl = document.getElementById('grp-rf'); if (rfEl) rfEl.value = (GR.rf * 100).toFixed(1).replace(/\.0$/, '');
    document.getElementById('grp-perf-tools').style.display = GR.tab === 'members' ? '' : 'none';
    if (GR.state === 'loading' || GR.state === 'idle') return;
    if (GR.state === 'error') { body.innerHTML = `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không tải được dữ liệu nhóm: ${rkEsc(GR.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="loadGroup(true)">Thử lại</button></div>`; return; }
    if (!GR.portfolios.length) { body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-users"></i>Chưa có thành viên nhóm Finance nào.</div>'; return; }
    if (GR.tab === 'members') {
        body.innerHTML = grMembersHtml();
        grDrawMembersChart();
    } else if (GR.tab === 'activity' && typeof gaActivityHtml === 'function') {
        body.innerHTML = gaActivityHtml();
    } else if (GR.tab === 'report' && typeof gaReportHtml === 'function') {
        body.innerHTML = gaReportHtml();
    } else if (GR.tab === 'limits' && typeof grLimitsHtml === 'function') {
        body.innerHTML = grLimitsHtml();
        if (typeof grLimitsAfterRender === 'function') grLimitsAfterRender();
    } else {
        body.innerHTML = grPortfolioHtml();
        if (GR.risk && GR.risk.ok) GR.charts.push(rkDrawChart(GR.risk, 'grp-dd-chart'));
    }
}

function grDrawMembersChart() {
    const canvas = document.getElementById('grp-members-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    const rows = GroupCalc.memberTable(GR.portfolios, GR.perf, GR.group).filter(r => r.returnPct !== null).sort((a, b) => b.returnPct - a.returnPct);
    if (!rows.length) return;
    const bench = GR.groupPerf && GR.groupPerf.hasBench ? GR.groupPerf.benchCumulativePct : null;
    GR.charts.push(new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels: rows.map(r => r.name), datasets: [{ label: 'Lợi suất (TWR)', data: rows.map(r => r.returnPct), backgroundColor: rows.map(r => r.returnPct >= 0 ? cssVarAlpha('--success-color', 0.8) : cssVarAlpha('--danger-color', 0.8)), borderRadius: 3 }].concat(bench !== null ? [{ label: 'VN-Index', data: rows.map(() => bench), type: 'line', borderColor: cssVar('--text-muted'), borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, fill: false }] : []) },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: cssVar('--text-secondary'), boxWidth: 14 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${rkPct(c.raw, 2, true)}` } } },
            scales: { x: { ticks: { color: cssVar('--text-secondary'), callback: (v) => v + '%' }, grid: { color: cssVar('--border-color') } }, y: { ticks: { color: cssVar('--text-secondary') }, grid: { display: false } } } },
    }));
}
