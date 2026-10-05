/* --- FILE: /stocksheet/valuation-map-ui.js ---
   Tổng Hợp CP > "Bản đồ định giá": thị trường và từng ngành đang rẻ hay đắt SO VỚI CHÍNH LỊCH SỬ của nó (phân vị P/E, P/B tổng hợp theo vốn hoá trong 3-6 năm), phần bù cổ phiếu so với trái phiếu chính phủ, và vòng quay sức mạnh tương đối của ngành.
   Số liệu: finance_valuation_history (market-data-sync, hằng ngày + bù ngược theo tháng) và thống kê ngành hiện tại. Phép tính ở /lib/valuation-history.js (có kiểm thử).
   Dùng global của script.js: call, showToast, VU (ValuationUI). Chart.js đã nạp ở trang. */

const VM = { state: 'idle', error: '', rows: [], bond10y: null, bondDate: null, stats: {}, years: 5, key: 'pe_agg', charts: [] };
const VM_KEY = 'wh.fin.valmap.v1';
try { const sv = JSON.parse(localStorage.getItem(VM_KEY) || 'null'); if (sv) { if ([3, 5, 6].includes(sv.years)) VM.years = sv.years; if (sv.key === 'pb_agg') VM.key = 'pb_agg'; } } catch (e) { /* mặc định */ }
function vmSave() { try { localStorage.setItem(VM_KEY, JSON.stringify({ years: VM.years, key: VM.key })); } catch (e) { /* bỏ qua */ } }

async function vmLoad(force) {
    if (VM.state === 'loading') return;
    if (VM.state === 'ok' && !force) { renderValuationMap(); return; }
    VM.state = 'loading'; VM.error = ''; renderValuationMap();
    try {
        const [h, u] = await Promise.all([call('getValuationHistory', { years: 6 }), call('getMarketUniverse', {}).catch(() => null)]);
        VM.rows = h.rows || []; VM.bond10y = h.bond10y; VM.bondDate = h.bondDate;
        VM.stats = u && u.stats ? u.stats : {};
        VM.state = VM.rows.length ? 'ok' : 'empty';
    } catch (e) { VM.state = 'error'; VM.error = e.message || String(e); }
    renderValuationMap();
}

const vmN = (v, d) => (v === null || v === undefined ? '—' : VU.dec(v, d === undefined ? 1 : d));
function vmName(code) { return (typeof SectorMap !== 'undefined' && SectorMap.icbName(code)) || ('ICB ' + code); }
function vmDate(d) { return String(d || '').slice(0, 10).split('-').reverse().join('/'); }
const vmTone = (t) => (t === 'ok' ? 'vl-pill-cheap' : (t === 'warn' ? 'vl-pill-expensive' : 'vl-pill-fair'));

function vmKpi(title, key, unit, sub) {
    const s = ValuationHistory.summarize(ValuationHistory.seriesOf(VM.rows, 'ALL', key), { years: VM.years });
    if (!s) return '';
    return `<div class="vl-kpi"><span class="vl-kpi-label">${VU.esc(title)}</span><b class="vl-kpi-value">${vmN(s.now, key.startsWith('pb') ? 2 : 1)}${unit}</b>
        ${s.enough ? `<span class="vl-pill ${vmTone(s.label.tone)}">${VU.esc(s.label.label)}</span><small>phân vị ${VU.dec(s.pct, 0)} trong ${VM.years} năm · TB ${vmN(s.mean, key.startsWith('pb') ? 2 : 1)}${unit} (${vmN(s.min, key.startsWith('pb') ? 2 : 1)}–${vmN(s.max, key.startsWith('pb') ? 2 : 1)})</small>` : '<small>chưa đủ lịch sử</small>'}
        ${sub ? `<small>${VU.esc(sub)}</small>` : ''}</div>`;
}

function vmSpark(series) {
    const sp = ValuationHistory.sparkline(series.slice(-60), 110, 28);
    if (!sp.d) return '';
    return `<svg class="vm-spark" viewBox="0 0 110 28" width="110" height="28" aria-hidden="true"><path d="${sp.d}" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="${sp.last[0].toFixed(1)}" cy="${sp.last[1].toFixed(1)}" r="2.4" fill="currentColor"/></svg>`;
}

// Vòng quay ngành: trung vị RS-Ratio và RS-Momentum (JdK) của các mã trong ngành, từ thống kê ngành hiện tại
function vmRotation(code) {
    const st = VM.stats[code] && VM.stats[code].stats; if (!st || !st.jdkRs || !st.jdkMom || typeof QuantCalc === 'undefined') return null;
    return QuantCalc.rotation(st.jdkRs.median, st.jdkMom.median);
}

function renderValuationMap() {
    const root = document.getElementById('vm-root');
    if (!root) return;
    VM.charts.forEach(c => { try { c.destroy(); } catch (e) { /* đã huỷ */ } }); VM.charts = [];
    if (VM.state === 'idle' || VM.state === 'loading') { root.innerHTML = '<div class="vl-card"><div class="vl-empty"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải lịch sử định giá…</div></div>'; return; }
    if (VM.state === 'error') { root.innerHTML = `<div class="vl-card"><div class="vl-empty">Không tải được: ${VU.esc(VM.error)}<br><button type="button" class="btn-save" style="margin-top:10px" onclick="vmLoad(true)">Thử lại</button></div></div>`; return; }
    if (VM.state === 'empty') { root.innerHTML = '<div class="vl-card"><div class="vl-empty"><i class="fa-solid fa-database"></i> Chưa có lịch sử định giá. Hàm cập nhật ghi mỗi ngày làm việc; quản trị viên có thể bù ngược nhiều năm bằng chế độ "history" của market-data-sync (xem sổ tay vận hành).</div></div>'; return; }
    const pe = ValuationHistory.summarize(ValuationHistory.seriesOf(VM.rows, 'ALL', 'pe_agg'), { years: VM.years });
    const spread = pe ? ValuationHistory.earningsYieldSpread(pe.now, VM.bond10y) : null;
    const board = ValuationHistory.sectorBoard(VM.rows, VM.key, VM.years, vmName);
    const keyLabel = VM.key === 'pb_agg' ? 'P/B' : 'P/E';
    root.innerHTML = `
    <div class="vl-card">
        <h3 class="vl-card-title"><i class="fa-solid fa-map" aria-hidden="true"></i> Bản đồ định giá <span class="vl-muted">số liệu đến ${vmDate(pe ? pe.date : '')}
            <select id="vm-years" class="vl-select-sm" aria-label="Cửa sổ lịch sử" onchange="vmSet('years', Number(this.value))">${[3, 5, 6].map(y => `<option value="${y}"${VM.years === y ? ' selected' : ''}>${y} năm</option>`).join('')}</select></span></h3>
        <div class="vl-kpis">
            ${vmKpi('P/E thị trường (tổng hợp theo vốn hoá)', 'pe_agg', 'x', '')}
            ${vmKpi('P/B thị trường (tổng hợp theo vốn hoá)', 'pb_agg', 'x', '')}
            ${vmKpi('P/E trung vị (mã điển hình)', 'pe_median', 'x', '')}
            ${spread ? `<div class="vl-kpi"><span class="vl-kpi-label">Lợi suất lợi nhuận − TPCP 10 năm</span><b class="vl-kpi-value">${spread.spreadPct === null ? '—' : (spread.spreadPct > 0 ? '+' : '') + vmN(spread.spreadPct, 1) + ' điểm %'}</b><small>1/P/E = ${vmN(spread.earningsYieldPct, 1)}% so với trái phiếu ${spread.bondPct === null ? '—' : vmN(spread.bondPct, 2) + '%'}${VM.bondDate ? ' (' + vmDate(VM.bondDate) + ')' : ''}</small></div>` : ''}
        </div>
        <div class="vm-charts"><div><canvas id="vm-chart-pe" height="150" aria-label="P/E thị trường theo thời gian"></canvas></div><div><canvas id="vm-chart-pb" height="150" aria-label="P/B thị trường theo thời gian"></canvas></div></div>
    </div>
    <div class="vl-card">
        <h3 class="vl-card-title"><i class="fa-solid fa-table-cells" aria-hidden="true"></i> Ngành rẻ hay đắt so với chính nó <span class="vl-muted">${keyLabel} tổng hợp theo vốn hoá
            <select id="vm-key" class="vl-select-sm" aria-label="Chỉ số" onchange="vmSet('key', this.value)"><option value="pe_agg"${VM.key === 'pe_agg' ? ' selected' : ''}>P/E</option><option value="pb_agg"${VM.key === 'pb_agg' ? ' selected' : ''}>P/B</option></select></span></h3>
        <div class="spreadsheet-wrapper vl-table-wrap"><table class="vl-scen"><thead><tr><th>Ngành</th><th class="num">${keyLabel} hiện tại</th><th class="num">TB ${VM.years} năm</th><th class="num" title="0 = rẻ nhất trong ${VM.years} năm của chính ngành, 100 = đắt nhất">Phân vị lịch sử</th><th>Xu hướng 5 năm</th><th title="Trung vị RS-Ratio / RS-Momentum của các mã trong ngành so với thị trường (100 = ngang thị trường)">Sức mạnh tương đối</th></tr></thead>
        <tbody>${board.length ? board.map(b => { const s = b.summary, rot = vmRotation(b.scope), d = VM.key === 'pb_agg' ? 2 : 1;
            return `<tr><td><b>${VU.esc(b.name)}</b></td><td class="num">${vmN(s.now, d)}x</td><td class="num">${vmN(s.mean, d)}x<small>${vmN(s.min, d)}–${vmN(s.max, d)}</small></td>
                <td class="num"><span class="vl-pill ${vmTone(s.label.tone)}" title="${VU.esc(s.label.label)}">${VU.dec(s.pct, 0)}</span></td><td class="vm-spark-cell">${vmSpark(b.series)}</td>
                <td>${rot ? `<span class="tl-badge ${rot.tone}" title="RS-Ratio ${VU.dec(rot.rs, 1)} · RS-Momentum ${VU.dec(rot.mom, 1)}">${VU.esc(rot.label)}</span>` : '—'}</td></tr>`; }).join('') : '<tr><td colspan="6" class="vl-empty">Chưa đủ lịch sử theo ngành (cần ít nhất 12 tháng).</td></tr>'}</tbody></table></div>
        <p class="vl-hint">Phân vị thấp = ngành đang rẻ hơn phần lớn thời gian trong ${VM.years} năm qua của chính nó (không phải rẻ hơn ngành khác — mỗi ngành có mặt bằng P/E riêng). Ngành rẻ so với lịch sử vẫn có thể rẻ vì lợi nhuận đang đi xuống; hãy xem cột sức mạnh tương đối và báo cáo ngành trước khi kết luận.</p>
    </div>
    <p class="vl-hint">Cách tính: P/E (P/B) tổng hợp = tổng vốn hoá / tổng lợi nhuận (vốn chủ) của các mã vốn hoá từ 300 tỷ, chỉ mã có lãi — gần với P/E của chỉ số nhưng không giống hệt. Phân ngành quá khứ lấy theo danh sách ngành hiện tại nên mã đã hủy niêm yết chỉ nằm trong số liệu toàn thị trường. Nguồn: VNDirect. Đây là thước đo để đặt câu hỏi, không phải tín hiệu mua bán.</p>`;
    vmCharts();
}

function vmCharts() {
    if (typeof Chart === 'undefined') return;
    const mk = (id, agg, med, label, d) => {
        const el = document.getElementById(id); if (!el) return;
        const a = ValuationHistory.seriesOf(VM.rows, 'ALL', agg), m = ValuationHistory.seriesOf(VM.rows, 'ALL', med);
        const sum = ValuationHistory.summarize(a, { years: VM.years });
        const cut = a.length ? new Date(Date.parse(a[a.length - 1].d + 'T00:00:00Z') - VM.years * 365.25 * 86400000).toISOString().slice(0, 10) : '';
        const aw = a.filter(x => x.d >= cut), mw = m.filter(x => x.d >= cut);
        VM.charts.push(new Chart(el.getContext('2d'), {
            type: 'line',
            data: { labels: aw.map(x => x.d.slice(0, 7)), datasets: [
                { label: label + ' tổng hợp', data: aw.map(x => x.v), borderColor: '#d4af37', backgroundColor: 'transparent', pointRadius: 0, borderWidth: 2, tension: 0.25 },
                { label: label + ' trung vị', data: aw.map(x => { const f = mw.find(y => y.d === x.d); return f ? f.v : null; }), borderColor: '#7e8aa0', backgroundColor: 'transparent', pointRadius: 0, borderWidth: 1.5, tension: 0.25 },
                ...(sum && sum.enough ? [{ label: 'Trung bình ' + VM.years + ' năm', data: aw.map(() => sum.mean), borderColor: '#8a8a8a', borderDash: [5, 4], pointRadius: 0, borderWidth: 1 }] : []),
            ] },
            options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: '#9aa0a6', boxWidth: 12 } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${VU.dec(c.parsed.y, d)}x` } } }, scales: { x: { ticks: { color: '#9aa0a6', maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,0.05)' } }, y: { ticks: { color: '#9aa0a6' }, grid: { color: 'rgba(255,255,255,0.05)' } } } }
        }));
    };
    mk('vm-chart-pe', 'pe_agg', 'pe_median', 'P/E', 1);
    mk('vm-chart-pb', 'pb_agg', 'pb_median', 'P/B', 2);
}

function vmSet(k, v) { VM[k] = v; vmSave(); renderValuationMap(); }
