/* --- FILE: /mastersheet/group-quant.js ---
   Trang Toàn Nhóm > "Định Lượng": bảng điều khiển các chỉ báo mà hội đồng đầu tư soát trước khi họp, cho các mã nhóm đang nắm (danh mục gộp): vòng quay sức mạnh tương đối JdK, vị trí trong biên độ 52 tuần,
   P/E so với lịch sử của chính mã và P/E điều hoà của cả danh mục, thanh khoản (số phiên để thoát vị thế), room và dòng tiền khối ngoại. Số liệu từ VNDirect (finance_stock_ratios, cập nhật mỗi ngày làm việc).
   Phép tính ở /lib/quant-calc.js (có kiểm thử). Dùng global của group.js (GR, grCall, grRender), group-limits.js (glDate) và assets/risk.js (rkEsc, rkNum, rkPct, rkVnd, rkKpi). */

const GQT = { state: 'idle', error: '', out: null, ratios: {}, peers: null, hist: null, ideas: null, loadedKey: '', sort: 'weight' };

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
        GQT.peers = await grCall('getPeerStats', { symbols: syms }).catch(() => null);     // thiếu ảnh chụp thị trường: bỏ cột so với ngành
        GQT.hist = await grCall('getValuationHistory', { years: 6 }).catch(() => null);      // lịch sử định giá ngành; thiếu thì bỏ bảng ngành so với lịch sử
        GQT.ideas = null;
        const prices = {}; GR.group.symbols.forEach(s => { if (s.price > 0) prices[s.symbol] = s.price; });
        GQT.out = QuantCalc.dashboard(GR.group.symbols.map(s => ({ symbol: s.symbol, value: s.value })), ratios, { prices });
        GQT.state = 'ok'; GQT.loadedKey = key;
    } catch (e) { GQT.state = 'error'; GQT.error = e.message || String(e); }
    grRender();
}

const gqtX = (v, d) => (v === null || v === undefined ? '—' : rkNum(v, d === undefined ? 1 : d) + 'x');
const gqtP = (v, d, sign) => (v === null || v === undefined ? '—' : rkPct(v, d === undefined ? 1 : d, !!sign));


// Định giá so với ngành (phân vị trong thống kê ngành ICB; lib/peer-valuation.js): { symbol: assess } hoặc null nếu chưa có ảnh chụp thị trường
function gqtPeerMap() {
    const P = GQT.peers;
    if (!P || typeof PeerValuation === 'undefined' || !Object.keys(P.bySymbol || {}).length) return null;
    const out = {};
    Object.keys(P.bySymbol).forEach(sym => { const r = P.bySymbol[sym], st = P.stats[r.icb2_code]; if (st) out[sym] = PeerValuation.assess(r.metrics, st.stats); });
    return out;
}

// Hồ sơ phong cách của danh mục gộp (lib/style-exposure.js): phân vị có trọng số của từng nhân tố so với cả thị trường; null nếu thiếu thống kê thị trường hoặc chưa đủ dữ liệu
function gqtStyle() {
    const P = GQT.peers;
    if (!P || typeof StyleExposure === 'undefined' || !P.stats || !P.stats.ALL || !GQT.out) return null;
    const r = StyleExposure.compute(GQT.out.rows.map(x => ({ symbol: x.symbol, value: x.value })), P.bySymbol, P.stats.ALL.stats);
    return r.factors.some(f => f.pct !== null) ? r : null;
}
function gqtStyleHtml() {
    const st = gqtStyle();
    if (!st) return '';
    const bar = (f) => f.pct === null ? `<div class="gqt-style-row mute"><span>${rkEsc(f.label)}</span><span class="gqt-style-track"></span><b>chưa đủ dữ liệu</b></div>`
        : `<div class="gqt-style-row"><span>${rkEsc(f.label)}</span><span class="gqt-style-track" title="Phân vị ${rkNum(f.pct, 0)} so với cả thị trường (50 = trung lập)"><i class="gqt-style-mid"></i><i class="gqt-style-dot ${f.tone}" style="left:${Math.min(98, Math.max(2, f.pct))}%"></i></span><b>${rkNum(f.pct, 0)}</b></div>`;
    return `<div class="ce-group-title">Hồ sơ phong cách <small style="font-weight:400">(${st.counted}/${st.count} mã có số liệu, ${rkPct(st.coverage * 100, 0)} giá trị)</small></div>
        <div class="gqt-style">${st.factors.map(bar).join('')}</div>
        ${st.tilts.length ? `<ul class="gr-rep-notes">${st.tilts.map(t => `<li>${rkEsc(t.text)}</li>`).join('')}</ul>` : '<p class="tl-hint">Danh mục không nghiêng rõ về nhân tố nào so với thị trường.</p>'}
        <p class="tl-hint">Mỗi nhân tố là phân vị trung bình (có trọng số theo giá trị vị thế) trong phân phối của cả thị trường niêm yết (mã vốn hoá từ 300 tỷ): 50 là trung lập, trên 50 là nghiêng về nhân tố đó. Mã không phải ngân hàng và ngân hàng được so chung một thị trường nên P/E, P/B của ngân hàng thường làm danh mục trông "rẻ"; hãy đọc cùng bảng ngành. Đây là mô tả, không phải khuyến nghị.</p>`;
}

// Ngành đang nắm so với lịch sử định giá của chính ngành (lib/valuation-history.js): tỷ trọng danh mục theo ngành ICB + phân vị P/E, P/B tổng hợp trong 5 năm
function gqtSectorHistory() {
    const P = GQT.peers, H = GQT.hist;
    if (!P || !H || !H.rows || !H.rows.length || typeof ValuationHistory === 'undefined' || !GQT.out) return null;
    const total = GQT.out.rows.reduce((t, r) => t + r.value, 0), by = {};
    GQT.out.rows.forEach(r => { const x = P.bySymbol[r.symbol]; if (x && x.icb2_code) by[x.icb2_code] = (by[x.icb2_code] || 0) + r.value; });
    const rows = Object.keys(by).map(code => {
        const pe = ValuationHistory.summarize(ValuationHistory.seriesOf(H.rows, code, 'pe_agg'), { years: 5 }), pb = ValuationHistory.summarize(ValuationHistory.seriesOf(H.rows, code, 'pb_agg'), { years: 5 });
        return { code, name: (typeof SectorMap !== 'undefined' && SectorMap.icbName(code)) || ('ICB ' + code), weightPct: by[code] / total * 100, pe: pe && pe.enough ? pe : null, pb: pb && pb.enough ? pb : null };
    }).sort((a, b) => b.weightPct - a.weightPct);
    return rows.length ? { rows, expensivePct: rows.filter(r => r.pe && r.pe.pct >= 80).reduce((t, r) => t + r.weightPct, 0), cheapPct: rows.filter(r => r.pe && r.pe.pct <= 20).reduce((t, r) => t + r.weightPct, 0) } : null;
}
function gqtSectorHistoryHtml() {
    const sh = gqtSectorHistory();
    if (!sh) return '';
    const badge = (s) => s ? `<span class="tl-badge ${s.label.tone}" title="${rkEsc(s.label.label)}">phân vị ${rkNum(s.pct, 0)}</span><span class="symbol-sub">TB ${rkNum(s.mean, s.now < 5 ? 2 : 1)}x · nay ${rkNum(s.now, s.now < 5 ? 2 : 1)}x</span>` : '—';
    return `<div class="ce-group-title">Ngành đang nắm so với lịch sử định giá của chính nó</div>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Ngành</th><th class="text-right">Tỷ trọng</th><th>P/E tổng hợp (5 năm)</th><th>P/B tổng hợp (5 năm)</th></tr></thead><tbody>
        ${sh.rows.map(r => `<tr><td><b>${rkEsc(r.name)}</b></td><td class="text-right">${rkPct(r.weightPct, 1)}</td><td>${badge(r.pe)}</td><td>${badge(r.pb)}</td></tr>`).join('')}</tbody></table></div>
        <p class="tl-hint">${sh.expensivePct >= 20 ? `<b>${rkPct(sh.expensivePct, 0)} danh mục nằm trong ngành đang đắt so với lịch sử của chính ngành (phân vị từ 80).</b> ` : ''}${sh.cheapPct >= 20 ? `${rkPct(sh.cheapPct, 0)} danh mục nằm trong ngành đang rẻ so với lịch sử (phân vị đến 20). ` : ''}Phân vị 0 là rẻ nhất trong 5 năm của chính ngành đó, không so giữa các ngành. Ngành rẻ so với lịch sử vẫn có thể rẻ vì lợi nhuận đang đi xuống. Xem thêm Nghiên Cứu → Bản đồ.</p>`;
}

// Gợi ý mã thay thế cho vị thế đang đắt hoặc tụt hậu (lib/replacement-ideas.js): tải cả thị trường theo yêu cầu (vài trăm KB) khi bấm nút
async function gqtLoadIdeas() {
    if (GQT.ideas && GQT.ideas.state === 'loading') return;
    GQT.ideas = { state: 'loading' }; grRender();
    try {
        const u = await grCall('getMarketUniverse', {});
        const rows = MarketScreener.buildRows(u.snapshot || [], u.stats || {}, u.meta || {});
        const restricted = ((typeof GL !== 'undefined' && GL.restricted) || []).filter(r => r.active && !r.user_id).map(r => r.symbol);
        const list = ReplacementIdeas.suggest(GQT.out.rows.map(x => ({ symbol: x.symbol, value: x.value })), rows, restricted);
        GQT.ideas = { state: 'ok', list, asOf: u.asOf };
    } catch (e) { GQT.ideas = { state: 'error', error: e.message || String(e) }; }
    grRender();
}
function gqtIdeasHtml() {
    if (typeof ReplacementIdeas === 'undefined' || typeof MarketScreener === 'undefined' || !GQT.peers) return '';
    const I = GQT.ideas;
    const head = '<div class="ce-group-title">Gợi ý mã thay thế</div>';
    if (!I) return `${head}<p class="tl-hint">Tìm trong cùng ngành những mã rẻ hơn rõ rệt, ROE không thấp hơn, đủ lớn và thanh khoản cho các vị thế đang đắt so với ngành hoặc tụt hậu so với thị trường.</p><button type="button" class="btn-tool" onclick="gqtLoadIdeas()"><i class="fa-solid fa-magnifying-glass-chart"></i> Tìm mã thay thế</button>`;
    if (I.state === 'loading') return `${head}<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang quét cả thị trường…</div>`;
    if (I.state === 'error') return `${head}<div class="tl-empty text-danger">Không tải được: ${rkEsc(I.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="gqtLoadIdeas()">Thử lại</button></div>`;
    if (!I.list.length) return `${head}<p class="tl-hint">Không vị thế nào đang đắt so với ngành hoặc tụt hậu so với thị trường: chưa có gì cần tìm thay thế.</p>`;
    return `${head}${I.list.map(x => `<div class="gqt-idea"><div><b>${rkEsc(x.symbol)}</b> <span class="text-muted">${rkEsc(x.name || '')}</span> · ${rkPct(x.weightPct, 1)} danh mục</div>
        <ul class="gr-rep-notes">${x.reasons.map(t => `<li>${rkEsc(t)}</li>`).join('')}</ul>
        ${x.candidates.length ? `<div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Mã thay thế</th><th class="text-right">P/E</th><th class="text-right">P/B</th><th class="text-right">ROE</th><th class="text-right">Vốn hoá (tỷ)</th><th>Vì sao đáng xem</th></tr></thead><tbody>
            ${x.candidates.map(c => `<tr><td><b>${rkEsc(c.symbol)}</b>${c.name ? `<span class="symbol-sub">${rkEsc(c.name)}</span>` : ''}</td><td class="text-right">${c.pe === null ? '—' : rkNum(c.pe, 1) + 'x'}</td><td class="text-right">${c.pb === null ? '—' : rkNum(c.pb, 2) + 'x'}</td><td class="text-right">${rkPct(c.roe * 100, 1)}</td><td class="text-right">${rkNum(c.marketcap / 1e9, 0)}</td><td class="gr-reason">${rkEsc(c.why)}</td></tr>`).join('')}</tbody></table></div>${x.candidateCount > x.candidates.length ? `<p class="tl-hint">Còn ${x.candidateCount - x.candidates.length} mã khác thoả điều kiện; xem Nghiên Cứu → Thị trường để lọc kỹ hơn.</p>` : ''}`
            : '<p class="tl-hint">Không có mã cùng ngành nào vừa rẻ hơn rõ rệt, vừa ROE không thấp hơn, đủ lớn và thanh khoản.</p>'}</div>`).join('')}
        <p class="tl-hint">Danh sách để nghiên cứu, không phải khuyến nghị đổi mã: chưa tính thuế phí khi đổi, tác động giá của lệnh, vị thế đang lãi lỗ hay lý do vì sao doanh nghiệp bị chấm đắt hoặc yếu. Đã loại mã đang nắm, mã bị hạn chế, mã vốn hoá dưới 1.000 tỷ hoặc thanh khoản dưới 5 tỷ/ngày, và mã có số liệu đẹp bất thường (P/E dưới 4x, EPS tăng gấp đôi). Số liệu ngày ${rkEsc(String(I.asOf || '').slice(0, 10).split('-').reverse().join('/'))}.</p>`;
}

// Cảnh báo định giá (lib/valuation-alerts.js): thị trường và ngành đang nắm đắt/rẻ so với lịch sử của chính nó, gom thành vài dòng ưu tiên
function gqtAlertsHtml() {
    const sh = gqtSectorHistory();
    if (typeof ValuationAlerts === 'undefined' || !GQT.hist || !GQT.hist.rows || !GQT.hist.rows.length) return '';
    const R = ValuationAlerts.build(GQT.hist.rows, sh ? sh.rows.map(r => ({ code: r.code, name: r.name, weightPct: r.weightPct })) : []);
    if (!R.enough) return '';
    const head = `<div class="ce-group-title">Cảnh báo định giá${R.warn ? ` <span class="tl-badge warn">${R.warn}</span>` : ''}</div>`;
    if (!R.alerts.length) return `${head}<p class="tl-hint"><span class="tl-badge ok">●</span> Thị trường và các ngành bạn đang nắm đều quanh mức trung bình lịch sử 5 năm của chính chúng. Không có tín hiệu nào cần xem.</p>`;
    return `${head}<div class="gqt-alerts">${R.alerts.map(a => `<div class="gqt-alert"><span class="tl-badge ${a.level === 'warn' ? 'warn' : 'ok'}">${a.level === 'warn' ? 'Cần xem' : 'Thông tin'}</span><div><b>${rkEsc(a.title)}</b><div class="text-muted">${rkEsc(a.detail)}</div></div></div>`).join('')}</div>
        <p class="tl-hint">Tín hiệu để soát danh mục, không phải lệnh mua bán: đắt hoặc rẻ so với lịch sử có thể kéo dài nhiều năm, và rẻ có thể do lợi nhuận đi xuống. Số liệu ngày ${rkEsc(String(R.asOf || '').split('-').reverse().join('/'))}.</p>`;
}

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
    html += gqtAlertsHtml();
    const PM = gqtPeerMap();
    const rows = o.rows.slice().sort(GQT.sort === 'flags' ? (a, b) => b.flags.length - a.flags.length || b.value - a.value : (a, b) => b.value - a.value);
    html += `<div class="ce-group-title">Từng mã <select class="tl-select" style="margin-left:10px;font-weight:400" onchange="gqtSetSort(this.value)" aria-label="Sắp xếp"><option value="weight" ${GQT.sort === 'weight' ? 'selected' : ''}>Theo tỷ trọng</option><option value="flags" ${GQT.sort === 'flags' ? 'selected' : ''}>Nhiều cờ trước</option></select></div>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Mã</th><th class="text-right">Tỷ trọng</th><th class="text-right">P/E</th><th class="text-right">P/E / TB 5 năm</th>${PM ? '<th>So với ngành</th>' : ''}<th class="text-right">ROE</th><th>Sức mạnh tương đối</th><th class="text-right">Vị trí 52 tuần</th><th class="text-right">1 / 3 / 12 tháng</th><th class="text-right">Thoát vị thế</th><th class="text-right">Khối ngoại 5 phiên</th><th>Ghi chú</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td><b>${rkEsc(r.symbol)}</b>${r.hasData ? '' : '<span class="symbol-sub">chưa có số liệu</span>'}</td><td class="text-right">${rkPct(r.weightPct, 1)}</td>
            <td class="text-right">${gqtX(r.pe)}</td><td class="text-right ${r.peVs5y !== null && r.peVs5y > 1.3 ? 'tl-down' : (r.peVs5y !== null && r.peVs5y < 0.7 ? 'tl-up' : '')}">${r.peVs5y === null ? '—' : rkPct(r.peVs5y * 100, 0)}</td>
            ${PM ? `<td>${PM[r.symbol] && PM[r.symbol].verdict ? `<span class="tl-badge ${PM[r.symbol].verdict.tone}" title="${rkEsc(PM[r.symbol].verdict.text)}">${rkEsc(PM[r.symbol].verdict.label)}</span><span class="symbol-sub">phân vị ${rkNum(PM[r.symbol].valuationPct, 0)}</span>` : '—'}</td>` : ''}
            <td class="text-right">${r.roe === null ? '—' : rkPct(r.roe * 100, 1)}</td>
            <td>${r.rotation ? `<span class="tl-badge ${r.rotation.tone}" title="RS-Ratio ${rkNum(r.rotation.rs, 1)} · RS-Momentum ${rkNum(r.rotation.mom, 1)} (100 = ngang thị trường)">${rkEsc(r.rotation.label)}</span>` : '—'}</td>
            <td class="text-right">${r.range ? `${rkNum(r.range.positionPct, 0)}%<span class="symbol-sub">cách đỉnh ${rkPct(r.range.fromHighPct, 0)}</span>` : '—'}</td>
            <td class="text-right">${[r.chg1m, r.chg3m, r.chg1y].map(v => v === null ? '—' : `<span class="${v >= 0 ? 'tl-up' : 'tl-down'}">${rkPct(v * 100, 0, true)}</span>`).join(' / ')}</td>
            <td class="text-right ${r.daysToExit !== null && r.daysToExit > 5 ? 'tl-down' : ''}">${r.daysToExit === null ? '—' : rkNum(r.daysToExit, 1) + ' phiên'}</td>
            <td class="text-right ${r.foreignNet5d !== null && r.foreignNet5d < 0 ? 'tl-down' : 'tl-up'}">${r.foreignNet5d === null ? '—' : rkVnd(r.foreignNet5d)}${r.foreignRoomLeftPct !== null ? `<span class="symbol-sub">room còn ${rkNum(r.foreignRoomLeftPct, 0)}%</span>` : ''}</td>
            <td class="gr-reason">${r.flags.length ? r.flags.map(f => `<div><span class="tl-badge ${f.tone}">●</span> ${rkEsc(f.text)}</div>`).join('') : '<span class="text-muted">—</span>'}</td></tr>`).join('')}
        </tbody></table></div>`;
    html += gqtStyleHtml();
    html += gqtSectorHistoryHtml();
    html += gqtIdeasHtml();
    html += `<p class="tl-hint">Nguồn: VNDirect (chỉ số cập nhật mỗi ngày làm việc; ngày số liệu gần nhất ${rkEsc(Object.values(GQT.ratios).map(x => x.dailyDate).filter(Boolean).sort().pop() || '—')}). <b>Sức mạnh tương đối</b> theo vòng quay JdK: RS-Ratio &gt; 100 là mạnh hơn thị trường, RS-Momentum &gt; 100 là đang tăng tốc — Dẫn đầu (cả hai &gt; 100), Suy yếu (mạnh nhưng chậm lại), Tụt hậu (cả hai &lt; 100), Cải thiện (yếu nhưng tăng tốc). <b>So với ngành</b>: phân vị định giá (P/E và P/B) trong các mã cùng ngành ICB, 0 là rẻ nhất ngành; kèm ROE để không nhầm "rẻ vì kém" với "rẻ thật". <b>P/E / TB 5 năm</b>: dưới 100% là đang rẻ hơn lịch sử của chính mã (chưa tính tăng trưởng đã đổi hay chưa). <b>Thoát vị thế</b>: số phiên cần nếu chỉ chiếm 20% giá trị giao dịch trung bình ngày. Đây là chỉ báo để soát và đặt câu hỏi, không phải khuyến nghị mua hoặc bán.</p>`;
    return html;
}
