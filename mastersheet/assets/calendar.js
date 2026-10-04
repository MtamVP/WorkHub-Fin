/* --- FILE: /mastersheet/assets/calendar.js ---
   Tab "Lịch": việc sắp tới của các mã đang giữ (ngày không hưởng quyền, ngày tiền cổ tức về, hạn công bố báo cáo tài chính) và dự báo cổ tức nhận được
   12 tháng tới (đã công bố + ước tính theo lịch sử). Phép tính ở /lib/calendar-calc.js (có kiểm thử). Dữ liệu sự kiện từ nguồn thị trường (Edge Function stock-events).
   Dùng global: callGAS, targetEmail, escapeAssetHtml, cssVar, cssVarAlpha, Chart.js, rkKpi/rkVnd/rkPct (risk.js). */

const CAL = { state: 'idle', error: '', inputs: null, result: null, chart: null };

const calEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const calDate = (iso) => { const p = String(iso || '').split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : ''; };
const calShort = (iso) => { const p = String(iso || '').split('-'); return p.length === 3 ? `${p[2]}/${p[1]}` : ''; };
const calIn = (iso, today) => { const d = Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000); return d === 0 ? 'hôm nay' : (d > 0 ? `còn ${d} ngày` : `quá ${-d} ngày`); };
const CAL_KIND = {
    ex_date: { icon: 'fa-scissors', cls: 'info', label: 'Không hưởng quyền' }, pay_date: { icon: 'fa-coins', cls: 'ok', label: 'Tiền về' },
    rights_deadline: { icon: 'fa-hourglass-half', cls: 'warn', label: 'Hạn mua quyền' }, report: { icon: 'fa-file-lines', cls: 'mute', label: 'Báo cáo tài chính' },
};

async function loadCalendar(force) {
    const body = document.getElementById('cal-body');
    if (!body) return;
    if (CAL.state === 'loading') return;
    if (CAL.state === 'ok' && !force) { renderCalendar(); return; }
    CAL.state = 'loading';
    body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang lấy sự kiện doanh nghiệp và dựng lịch…</div>';
    try {
        const r = await callGAS('getCalendarInputs', { email: targetEmail });
        if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
        CAL.inputs = r.data; CAL.state = 'ok';
        calCompute();
    } catch (e) { CAL.state = 'error'; CAL.error = e.message || String(e); }
    renderCalendar();
}

function calCompute() {
    const i = CAL.inputs;
    const ctx = { today: i.today, txns: i.txns, actions: i.actions, cashFlows: i.cashFlows, dismissed: i.dismissed };
    const qty = {}; i.holdings.forEach(h => { qty[h.symbol] = h.quantity; });
    const held = i.holdings.map(h => h.symbol);
    const upcoming = CalendarCalc.upcomingEvents(i.events, ctx, 90);
    const reports = CalendarCalc.reportDeadlines(held, i.latestQuarter, i.today);
    const forecast = CalendarCalc.dividendForecast(i.events, ctx, qty, 12);
    const mv = i.holdings.reduce((s, h) => s + (Number(h.marketValue) || 0), 0), cost = i.holdings.reduce((s, h) => s + (Number(h.costValue) || 0), 0);
    CAL.result = { upcoming, reports, forecast, yields: CalendarCalc.yields(forecast, mv, cost), mv, cost, held };
}

function calTimeline(r, today) {
    const items = r.upcoming.map(u => ({ date: u.date, kind: u.kind, symbol: u.symbol, title: u.title, detail: u.detail }));
    const limit = CalendarCalc.addDays(today, 90);
    r.reports.forEach(x => {
        if (x.deadline <= limit || x.status === 'due' || x.status === 'late') {
            const when = x.status === 'late' ? x.deadline : x.deadline;
            items.push({ date: when, kind: 'report', symbol: x.symbol, title: `Hạn công bố báo cáo ${x.label}`, detail: `Thường công bố từ ${calDate(x.from)}, hạn tối đa ${calDate(x.deadline)} (30 ngày nếu có công ty con)${x.note ? ' · ' + x.note : ''}${!x.tracked ? ' · chưa theo dõi báo cáo mã này' : ''}`, status: x.status });
        }
    });
    return items.sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : (a.symbol < b.symbol ? -1 : 1)));
}

function renderCalendar() {
    const body = document.getElementById('cal-body');
    if (!body) return;
    if (CAL.chart) { try { CAL.chart.destroy(); } catch (e) { /* đã huỷ */ } CAL.chart = null; }
    if (CAL.state === 'loading' || CAL.state === 'idle') return;
    if (CAL.state === 'error') { body.innerHTML = `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không tải được lịch: ${calEsc(CAL.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="loadCalendar(true)">Thử lại</button></div>`; return; }
    const i = CAL.inputs, r = CAL.result;
    if (!r.held.length) { body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-calendar-days"></i>Chưa có mã nào đang giữ — thêm lệnh mua để thấy lịch sự kiện và dự báo cổ tức.</div>'; return; }
    const f = r.forecast;
    const in30 = calTimeline(r, i.today).filter(x => x.date <= CalendarCalc.addDays(i.today, 30)).length;
    let html = '';
    if (i.eventsError) html += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không lấy được sự kiện doanh nghiệp: ${calEsc(i.eventsError)}. Lịch và dự báo cổ tức chưa đầy đủ; hạn công bố báo cáo vẫn hiển thị.</span></div>`;
    html += `<div class="tl-kpis">${[
        rkKpi('Cổ tức đã nhận 12 tháng', rkVnd(f.receivedTrailing), r.yields.trailingOnCostPct !== null ? `${rkPct(r.yields.trailingOnCostPct, 1)} trên giá vốn` : 'theo Dòng Tiền đã ghi', 'tl-up'),
        rkKpi('Dự kiến 12 tháng tới', rkVnd(f.forwardTotal), `${rkVnd(f.confirmedTotal)} đã công bố + ${rkVnd(f.estimatedTotal)} ước tính`, '', 'Ước tính = lặp lại khoản đã trả cùng kỳ năm trước, không phải cam kết của doanh nghiệp'),
        rkKpi('Suất cổ tức dự kiến', r.yields.forwardOnValuePct === null ? '—' : rkPct(r.yields.forwardOnValuePct, 2), r.yields.forwardOnCostPct !== null ? `${rkPct(r.yields.forwardOnCostPct, 2)} trên giá vốn` : '', '', 'Tiền dự kiến 12 tháng tới / giá trị thị trường (và / giá vốn)'),
        rkKpi('Việc trong 30 ngày tới', String(in30), `${r.upcoming.length} sự kiện doanh nghiệp trong 90 ngày`),
    ].join('')}</div>`;

    const tl = calTimeline(r, i.today);
    html += `<div class="ce-group-title">Sắp tới <small style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-muted)">(90 ngày)</small></div>`;
    html += tl.length ? `<div class="cal-list">${tl.map(x => { const k = CAL_KIND[x.kind]; return `<div class="cal-row">
            <div class="cal-date"><b>${calShort(x.date)}</b><small>${calIn(x.date, i.today)}</small></div>
            <div class="cal-main"><div><span class="symbol-name">${calEsc(x.symbol)}</span> <span class="tl-badge ${k.cls}"><i class="fa-solid ${k.icon}"></i> ${calEsc(x.title)}</span>${x.status === 'late' ? ' <span class="tl-badge bad">Quá hạn, chưa có số mới</span>' : (x.status === 'due' ? ' <span class="tl-badge warn">Đang trong kỳ công bố</span>' : '')}</div>
            <div class="cal-detail">${calEsc(x.detail)}</div></div></div>`; }).join('')}</div>` : '<div class="tl-empty" style="padding:14px"><i class="fa-solid fa-calendar-check"></i>Không có sự kiện nào trong 90 ngày tới.</div>';

    html += `<div class="ce-group-title">Cổ tức dự kiến theo tháng</div><div class="tl-card rk-chart-card"><div style="position:relative;height:240px"><canvas id="cal-chart"></canvas></div></div>`;
    const bySym = {};
    f.items.forEach(x => { const s = bySym[x.symbol] || (bySym[x.symbol] = { symbol: x.symbol, confirmed: 0, estimated: 0, next: null }); s[x.kind] += x.amount; if (!s.next || x.date < s.next) s.next = x.date; });
    Object.keys(f.receivedBySymbol).forEach(sym => { if (sym !== '(không gắn mã)') (bySym[sym] = bySym[sym] || { symbol: sym, confirmed: 0, estimated: 0, next: null }); });
    const rows = Object.keys(bySym).map(k => bySym[k]).sort((a, b) => (b.confirmed + b.estimated) - (a.confirmed + a.estimated));
    html += rows.length ? `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Mã</th><th class="text-right">Đã nhận 12 tháng</th><th class="text-right">Đã công bố</th><th class="text-right">Ước tính</th><th class="text-right">Khoản kế tiếp</th></tr></thead><tbody>
        ${rows.map(s => `<tr><td><b>${calEsc(s.symbol)}</b></td><td class="text-right">${f.receivedBySymbol[s.symbol] ? rkVnd(f.receivedBySymbol[s.symbol]) : '—'}</td><td class="text-right">${s.confirmed ? rkVnd(s.confirmed) : '—'}</td><td class="text-right">${s.estimated ? rkVnd(s.estimated) : '—'}</td><td class="text-right">${s.next ? calDate(s.next) : '—'}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="tl-hint">Các mã đang giữ chưa có lịch sử cổ tức tiền trong 12 tháng qua, nên chưa có dự báo.</p>';
    html += `<details class="tl-details"><summary>Cách tính và giới hạn</summary><div class="tl-hint">
        Số cổ phiếu được hưởng quyền tính theo số bạn giữ trước ngày giao dịch không hưởng quyền (ngày chưa tới thì dùng số đang giữ). Cổ tức tiền hiển thị <b>sau thuế TNCN 5%</b>.
        “Ước tính” giả định mỗi khoản cổ tức tiền đã trả trong 12 tháng qua sẽ lặp lại cùng thời điểm và cùng mức đ/cp vào năm sau, trừ khi đã có khoản công bố của cùng mã gần thời điểm đó; doanh nghiệp có thể cắt giảm, tăng hoặc đổi sang cổ phiếu.
        Hạn công bố báo cáo theo quy định công bố thông tin: báo cáo quý trong 20 ngày (30 ngày nếu có công ty con), soát xét bán niên 45 ngày, kiểm toán năm 90 ngày — chỉ là mốc tham khảo, hãy đối chiếu thông báo của công ty.
        Khoản cổ tức đã tới hạn mà chưa ghi sổ được tính vào hôm nay; ghi chúng ở Sổ Lệnh › Hành Động DN.</div></details>`;
    body.innerHTML = html;
    calDrawChart(f);
}

function calDrawChart(f) {
    const canvas = document.getElementById('cal-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    const label = (m) => { const p = m.split('-'); return `${p[1]}/${p[0].slice(2)}`; };
    CAL.chart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels: f.months.map(m => label(m.month)), datasets: [
            { label: 'Đã công bố', data: f.months.map(m => m.confirmed), backgroundColor: cssVarAlpha('--success-color', 0.8), stack: 's', borderRadius: 2 },
            { label: 'Ước tính', data: f.months.map(m => m.estimated), backgroundColor: cssVarAlpha('--finance-accent', 0.45), stack: 's', borderRadius: 2 },
        ] },
        options: { responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: cssVar('--text-secondary'), boxWidth: 14 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${rkVnd(c.raw)}` } } },
            scales: { x: { stacked: true, ticks: { color: cssVar('--text-secondary') }, grid: { display: false } }, y: { stacked: true, ticks: { color: cssVar('--text-secondary'), callback: (v) => (v / 1e6).toLocaleString('vi-VN') + ' tr' }, grid: { color: cssVar('--border-color') } } } },
    });
}
