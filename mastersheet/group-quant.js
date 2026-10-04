/* --- FILE: /mastersheet/group-quant.js ---
   Trang Toàn Nhóm > "Định Lượng": bảng điều khiển các chỉ báo mà hội đồng đầu tư soát trước khi họp, cho các mã nhóm đang nắm (danh mục gộp): vòng quay sức mạnh tương đối JdK, vị trí trong biên độ 52 tuần,
   P/E so với lịch sử của chính mã và P/E điều hoà của cả danh mục, thanh khoản (số phiên để thoát vị thế), room và dòng tiền khối ngoại. Số liệu từ VNDirect (finance_stock_ratios, cập nhật mỗi ngày làm việc).
   Phép tính ở /lib/quant-calc.js (có kiểm thử). Dùng global của group.js (GR, grCall, grRender), group-limits.js (glDate) và assets/risk.js (rkEsc, rkNum, rkPct, rkVnd, rkKpi). */

const GQT = { state: 'idle', error: '', out: null, ratios: {}, loadedKey: '', sort: 'weight' };

function gqtSetSort(v) { GQT.sort = v; grRender(); }

async function gqtLoad(force) {
    if (GQT.state === 'loading') return;
    const key = GR.data ? GR.data.fetchedAt : '';
    if (GQT.state === 'ok' && !force && GQT.loadedKey === key) { grRender(); return; }
    GQT.state = 'loading'; GQT.error = ''; grRender();
    try {
        const syms = GR.group.symbols.filter(s => s.value > 0).map(s => s.symbol);
        const ratios = {};
        for (let i = 0; i < syms.length; i += 15) Object.assign(ratios, await grCall('getStockRatios', { symbols: syms.slice(i, i + 15) }));
        GQT.ratios = ratios;
        const prices = {}; GR.group.symbols.forEach(s => { if (s.price > 0) prices[s.symbol] = s.price; });
        GQT.out = QuantCalc.dashboard(GR.group.symbols.map(s => ({ symbol: s.symbol, value: s.value })), ratios, { prices });
        GQT.state = 'ok'; GQT.loadedKey = key;
    } catch (e) { GQT.state = 'error'; GQT.error = e.message || String(e); }
    grRender();
}

const gqtX = (v, d) => (v === null || v === undefined ? '—' : rkNum(v, d === undefined ? 1 : d) + 'x');
const gqtP = (v, d, sign) => (v === null || v === undefined ? '—' : rkPct(v, d === undefined ? 1 : d, !!sign));

function grQuantHtml() {
    if (GQT.state === 'loading' || GQT.state === 'idle') return '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang lấy chỉ số thị trường của các mã đang nắm…</div>';
    if (GQT.state === 'error') return `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không tải được: ${rkEsc(GQT.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="gqtLoad(true)">Thử lại</button></div>`;
    const o = GQT.out;
    if (!o.rows.length) return '<div class="tl-empty"><i class="fa-solid fa-chart-simple"></i>Nhóm chưa nắm mã nào.</div>';
    const S = o.summary, Q = QuantCalc.QUADRANTS;
    let html = `<div class="tl-kpis">${[
        rkKpi('P/E điều hoà danh mục', S.harmonicPe === null ? '—' : rkNum(S.harmonicPe, 1) + 'x', `${S.covered}/${S.count} mã có số liệu (${rkPct(S.coveragePct, 0)} giá trị)`),
        rkKpi('ROE bình quân', S.roe === null ? '—' : rkPct(S.roe * 100, 1), 'trọng số theo giá trị'),
        rkKpi('Beta bình quân (VNDirect)', S.beta === null ? '—' : rkNum(S.beta, 2), 'so với VN-Index'),
        rkKpi('Giá trị tụt hậu so với thị trường', rkPct(S.rotationPct.lagging + S.rotationPct.weakening, 0), `tụt hậu ${rkPct(S.rotationPct.lagging, 0)} · suy yếu ${rkPct(S.rotationPct.weakening, 0)}`, S.rotationPct.lagging >= 40 ? 'tl-down' : ''),
        rkKpi('Giá trị khó thoát (> 5 phiên)', rkPct(S.illiquidPct, 0), 'chiếm tối đa 20% thanh khoản ngày', S.illiquidPct >= 10 ? 'tl-down' : 'tl-up'),
        rkKpi('Mã có cờ cần chú ý', String(S.flagged), 'xem cột Ghi chú', S.flagged ? 'tl-down' : 'tl-up'),
    ].join('')}</div>`;
    const rows = o.rows.slice().sort(GQT.sort === 'flags' ? (a, b) => b.flags.length - a.flags.length || b.value - a.value : (a, b) => b.value - a.value);
    html += `<div class="ce-group-title">Từng mã <select class="tl-select" style="margin-left:10px;font-weight:400" onchange="gqtSetSort(this.value)" aria-label="Sắp xếp"><option value="weight" ${GQT.sort === 'weight' ? 'selected' : ''}>Theo tỷ trọng</option><option value="flags" ${GQT.sort === 'flags' ? 'selected' : ''}>Nhiều cờ trước</option></select></div>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Mã</th><th class="text-right">Tỷ trọng</th><th class="text-right">P/E</th><th class="text-right">P/E / TB 5 năm</th><th class="text-right">ROE</th><th>Sức mạnh tương đối</th><th class="text-right">Vị trí 52 tuần</th><th class="text-right">1 / 3 / 12 tháng</th><th class="text-right">Thoát vị thế</th><th class="text-right">Khối ngoại 5 phiên</th><th>Ghi chú</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td><b>${rkEsc(r.symbol)}</b>${r.hasData ? '' : '<span class="symbol-sub">chưa có số liệu</span>'}</td><td class="text-right">${rkPct(r.weightPct, 1)}</td>
            <td class="text-right">${gqtX(r.pe)}</td><td class="text-right ${r.peVs5y !== null && r.peVs5y > 1.3 ? 'tl-down' : (r.peVs5y !== null && r.peVs5y < 0.7 ? 'tl-up' : '')}">${r.peVs5y === null ? '—' : rkPct(r.peVs5y * 100, 0)}</td><td class="text-right">${r.roe === null ? '—' : rkPct(r.roe * 100, 1)}</td>
            <td>${r.rotation ? `<span class="tl-badge ${r.rotation.tone}" title="RS-Ratio ${rkNum(r.rotation.rs, 1)} · RS-Momentum ${rkNum(r.rotation.mom, 1)} (100 = ngang thị trường)">${rkEsc(r.rotation.label)}</span>` : '—'}</td>
            <td class="text-right">${r.range ? `${rkNum(r.range.positionPct, 0)}%<span class="symbol-sub">cách đỉnh ${rkPct(r.range.fromHighPct, 0)}</span>` : '—'}</td>
            <td class="text-right">${[r.chg1m, r.chg3m, r.chg1y].map(v => v === null ? '—' : `<span class="${v >= 0 ? 'tl-up' : 'tl-down'}">${rkPct(v * 100, 0, true)}</span>`).join(' / ')}</td>
            <td class="text-right ${r.daysToExit !== null && r.daysToExit > 5 ? 'tl-down' : ''}">${r.daysToExit === null ? '—' : rkNum(r.daysToExit, 1) + ' phiên'}</td>
            <td class="text-right ${r.foreignNet5d !== null && r.foreignNet5d < 0 ? 'tl-down' : 'tl-up'}">${r.foreignNet5d === null ? '—' : rkVnd(r.foreignNet5d)}${r.foreignRoomLeftPct !== null ? `<span class="symbol-sub">room còn ${rkNum(r.foreignRoomLeftPct, 0)}%</span>` : ''}</td>
            <td class="gr-reason">${r.flags.length ? r.flags.map(f => `<div><span class="tl-badge ${f.tone}">●</span> ${rkEsc(f.text)}</div>`).join('') : '<span class="text-muted">—</span>'}</td></tr>`).join('')}
        </tbody></table></div>`;
    html += `<p class="tl-hint">Nguồn: VNDirect (chỉ số cập nhật mỗi ngày làm việc; ngày số liệu gần nhất ${rkEsc(Object.values(GQT.ratios).map(x => x.dailyDate).filter(Boolean).sort().pop() || '—')}). <b>Sức mạnh tương đối</b> theo vòng quay JdK: RS-Ratio &gt; 100 là mạnh hơn thị trường, RS-Momentum &gt; 100 là đang tăng tốc — Dẫn đầu (cả hai &gt; 100), Suy yếu (mạnh nhưng chậm lại), Tụt hậu (cả hai &lt; 100), Cải thiện (yếu nhưng tăng tốc). <b>P/E / TB 5 năm</b>: dưới 100% là đang rẻ hơn lịch sử của chính mã (chưa tính tăng trưởng đã đổi hay chưa). <b>Thoát vị thế</b>: số phiên cần nếu chỉ chiếm 20% giá trị giao dịch trung bình ngày. Đây là chỉ báo để soát và đặt câu hỏi, không phải khuyến nghị mua hoặc bán.</p>`;
    return html;
}
