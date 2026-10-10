/* --- FILE: /simulation/sim-views.js ---
   Market Simulation: dựng HTML cho từng mục (Triển vọng, Mô phỏng & quyết định, Cây kịch bản, Kiểm chứng, Phương pháp) từ trạng thái SIM (sim-app.js).
   Chỉ vẽ: không gọi mạng, không tính toán mô hình (kết quả đã có từ luồng nền). */

const HZ_LABEL = { 5: '1 tuần', 21: '1 tháng', 63: '3 tháng' };
const hzLabel = (h) => HZ_LABEL[h] || h + ' phiên';
const STAGE_LABEL = ['Tuần đầu', 'Đến hết tháng', 'Đến hết 3 tháng'];
const BR_WORD = ['giảm', 'đi ngang', 'tăng'];
const sE = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sPct = (v, d, sign) => { if (v === null || v === undefined || !isFinite(v)) return '—'; const x = v * 100, s = x > 0 && sign ? '+' : (x < 0 ? '−' : ''); return s + Math.abs(x).toLocaleString('vi-VN', { minimumFractionDigits: d === undefined ? 1 : d, maximumFractionDigits: d === undefined ? 1 : d }) + '%'; };
const sProb = (v) => { if (v === null || v === undefined || !isFinite(v)) return '—'; const x = v * 100; return (x > 0 && x < 1 ? '<1' : (x > 99 && x < 100 ? '>99' : Math.round(x))) + '%'; };
const sNum = (v, d) => (v === null || v === undefined || !isFinite(v) ? '—' : Number(v).toLocaleString('vi-VN', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }));
const sVnd = (v) => { if (v === null || v === undefined || !isFinite(v)) return '—'; const a = Math.abs(v), s = v < 0 ? '−' : ''; return a >= 1e9 ? s + (a / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + ' tỷ' : a >= 1e6 ? s + (a / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' tr' : s + Math.round(a).toLocaleString('vi-VN') + ' đ'; };
const sCls = (v) => (v > 0 ? 'sim-up' : (v < 0 ? 'sim-down' : ''));
const branchText = (b, band) => (b === 0 ? 'VN-Index giảm hơn ' + sPct(band, 0) : (b === 2 ? 'VN-Index tăng hơn ' + sPct(band, 0) : 'Đi ngang (trong ±' + sPct(band, 0).replace('−', '') + ')'));
const regimeName = (k, K) => (K === 2 ? ['Bình thường', 'Căng thẳng'][k] : ['Êm', 'Bình thường', 'Căng thẳng'][k] || 'Chế độ ' + (k + 1));
const loadingHtml = (text) => '<div class="tl-card"><div class="sim-progress"><span class="spin" aria-hidden="true"></span><span>' + sE(text) + '</span></div></div>';
const errorHtml = (text, retry) => '<div class="tl-card"><div class="tl-empty"><i class="fa-solid fa-triangle-exclamation"></i>' + sE(text) + (retry ? '<div style="margin-top:12px"><button type="button" class="sim-btn sm" onclick="' + retry + '"><i class="fa-solid fa-rotate"></i> Thử lại</button></div>' : '') + '</div></div>';

function describePolicy(p) {
    const parts = [];
    if (p.now && p.now.sellPct) parts.push('bán ' + p.now.sellPct + '% mỗi mã ngay');
    if (p.now && p.now.buyPct) parts.push('mua thêm bằng ' + p.now.buyPct + '% tiền mặt ngay');
    if (p.stop) parts.push((p.stop.trailing ? 'cắt lỗ động ' : 'cắt lỗ ') + p.stop.pct + '% từng mã');
    if (p.take) parts.push('chốt ' + p.take.sellPct + '% khi một mã +' + p.take.pct + '%');
    if (p.dip) parts.push('khi VN-Index giảm ' + p.dip.drop + '% thì mua bằng ' + p.dip.deployPct + '% tiền mặt');
    (p.rules || []).forEach((r) => parts.push((r.path && r.path.length > 1 ? 'nếu ' + pathWords(r.path) : 'sau ' + (r.stage === 1 ? '1 tuần' : '1 tháng') + ' nếu thị trường ' + BR_WORD[['down', 'flat', 'up'].indexOf(r.when)]) + ' thì ' + (r.act === 'sell' ? 'bán ' + r.pct + '% mỗi mã' : 'mua bằng ' + r.pct + '% tiền mặt')));
    return parts.length ? parts.join('; ') : 'không làm gì, giữ nguyên danh mục';
}

// ---------- Triển vọng thị trường ----------
function renderOutlookView() {
    const M = SIM.market;
    if (M.state === 'loading' || M.state === 'idle') return loadingHtml(M.step || 'Đang lấy 7 năm lịch sử VN-Index và ước lượng mô hình…');
    if (M.state === 'error') return errorHtml('Không dựng được mô hình thị trường: ' + M.error, 'simLoadMarket(true)');
    const D = M.model, withCtx = !!(SIM.ctx && SIM.ctx.use && M.ctxResult && ctxEvents().length), R = withCtx ? M.ctxResult : M.result, last = R.byHorizon[R.byHorizon.length - 1];
    const K = D.hmm.K, cur = D.hmm.current, top = cur.indexOf(Math.max.apply(null, cur));
    const pDown3 = last.index.pLoss10;
    const l1 = R.tree.filter((n) => n.depth === 1);
    const thesis = '<section class="sim-thesis"><div><div class="eyebrow">Triển vọng VN-Index · ' + sE(fmtDate(D.lastDate)) + (withCtx ? ' · có bối cảnh (' + ctxEvents().length + ' sự kiện)' : ' · chỉ lịch sử') + '</div>' +
        '<h2>Trong 3 tháng tới, 90% số kịch bản mô phỏng đưa VN-Index về khoảng ' + sNum(D.indexLevel * (1 + last.index.q05)) + ' – ' + sNum(D.indexLevel * (1 + last.index.q95)) + ' điểm.</h2>' +
        '<p>Thị trường đang ở chế độ <b>' + sE(regimeName(top, K)) + '</b> (xác suất ' + sProb(cur[top]) + '). Biến động hiện tại ' + sPct(D.garch.volNowAnn, 0) + '/năm so với trung bình dài hạn ' + sPct(D.garch.volLongAnn, 0) + '. ' +
        'Xác suất giảm hơn 10% trong 3 tháng: <b>' + sProb(pDown3) + '</b>; tăng hơn 10%: <b>' + sProb(last.index.pGain10) + '</b>.</p></div>' +
        '<div class="side"><b>' + sNum(D.indexLevel, 2) + '</b><span>VN-Index đóng cửa gần nhất</span></div></section>';
    const probRows = R.byHorizon.map((hh) => { const I = hh.index; return '<tr><td><b>' + hzLabel(hh.h) + '</b></td><td>' + sNum(D.indexLevel * (1 + I.q05)) + '</td><td>' + sNum(D.indexLevel * (1 + I.q25)) + '</td><td><b>' + sNum(D.indexLevel * (1 + I.median)) + '</b></td><td>' + sNum(D.indexLevel * (1 + I.q75)) + '</td><td>' + sNum(D.indexLevel * (1 + I.q95)) + '</td><td>' + sProb(I.pLoss) + '</td><td class="sim-down">' + sProb(I.pLoss10) + '</td><td class="sim-up">' + sProb(I.pGain10) + '</td></tr>'; }).join('');
    const fanCard = '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-chart-area"></i> Quạt xác suất VN-Index (' + sNum(R.paths) + ' đường)</h3></div>' +
        '<div class="sim-chart"><canvas id="sim-fan-index" aria-label="Biểu đồ quạt xác suất VN-Index 3 tháng tới"></canvas></div>' +
        '<div class="sim-legend"><span><i style="background:var(--sim-band-outer)"></i>90% kịch bản</span><span><i style="background:var(--sim-band-inner)"></i>50% kịch bản</span><span><i style="background:var(--finance-accent)"></i>Trung vị</span></div>' +
        '<div class="sim-table-wrap" style="margin-top:14px"><table class="sim-table"><thead><tr><th>Mốc</th><th>Xấu 5%</th><th>25%</th><th>Trung vị</th><th>75%</th><th>Tốt 95%</th><th>P(giảm)</th><th>P(giảm &gt;10%)</th><th>P(tăng &gt;10%)</th></tr></thead><tbody>' + probRows + '</tbody></table></div></section>';
    const regimeRows = D.hmm.states.map((st) => '<div class="sim-regime r' + st.k + (st.k === K - 1 ? ' stress' : '') + '"><span class="name">' + sE(regimeName(st.k, K)) + '<small>' + sPct(st.volAnn, 0) + ' biến động/năm · thường kéo dài ~' + sNum(D.hmm.durations[st.k]) + ' phiên</small></span><span class="bar"><span style="width:' + (cur[st.k] * 100).toFixed(1) + '%"></span></span><span class="p">' + sProb(cur[st.k]) + '</span></div>').join('');
    const ahead = D.hmm.ahead.map((a) => '<tr><td>Sau ' + hzLabel(a.h) + '</td>' + a.p.map((p) => '<td>' + sProb(p) + '</td>').join('') + '</tr>').join('');
    const regimeCard = '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-wave-square"></i> Chế độ thị trường hiện tại</h3></div>' +
        '<div class="sim-regimes">' + regimeRows + '</div>' +
        '<div class="sim-table-wrap" style="margin-top:12px"><table class="sim-table"><thead><tr><th>Xác suất chế độ</th>' + D.hmm.states.map((st) => '<th>' + sE(regimeName(st.k, K)) + '</th>').join('') + '</tr></thead><tbody>' + ahead + '</tbody></table></div>' +
        '<p class="tl-hint">Mô hình chuyển chế độ Markov ' + K + ' trạng thái (chọn theo BIC) ước lượng trên ' + sNum(D.obs) + ' phiên từ ' + sE(fmtDate(D.from)) + '. Chế độ căng thẳng chiếm ' + sProb(D.hmm.states[K - 1].share) + ' số phiên lịch sử.</p></section>';
    const stressCard = '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-clock-rotate-left"></i> Lịch sử xác suất chế độ căng thẳng</h3></div><div class="sim-chart"><canvas id="sim-regime-hist" aria-label="Xác suất chế độ căng thẳng theo thời gian cùng VN-Index"></canvas></div>' +
        '<div class="sim-legend"><span><i style="background:var(--sim-down);opacity:.35"></i>Xác suất căng thẳng</span><span><i style="background:var(--finance-accent)"></i>VN-Index</span></div>' +
        '<p class="tl-hint">Các đỉnh vùng đỏ trùng với những giai đoạn sập mạnh: nhìn vào đây để biết mô hình nhận ra chế độ căng thẳng nhanh đến đâu.</p></section>';
    const branchCard = '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-code-branch"></i> Tuần tới rẽ nhánh thế nào</h3><div class="tl-card-tools"><a class="sim-btn ghost sm" href="#tree">Xem cả cây <i class="fa-solid fa-arrow-right"></i></a></div></div>' +
        '<div class="sim-tri" aria-hidden="true">' + l1.map((n) => '<span class="' + 'dfu'[n.branch] + '" style="width:' + (n.prob * 100).toFixed(1) + '%"></span>').join('') + '</div>' +
        '<div class="sim-table-wrap" style="margin-top:10px"><table class="sim-table"><tbody>' + l1.map((n) => '<tr><td>' + sE(branchText(n.branch, R.bands[0])) + '</td><td><b>' + sProb(n.prob) + '</b></td><td class="sim-muted">trung vị ' + sPct(n.index.median, 1, true) + '</td></tr>').join('') + '</tbody></table></div>' +
        '<p class="tl-hint">So với tần suất lịch sử của mọi tuần trong 7 năm, xác suất ở đây đã tính theo biến động và chế độ thị trường hiện tại.</p></section>';
    const modelCard = '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-gears"></i> Mô hình đang dùng</h3></div>' +
        '<div class="tl-kpis"><div class="tl-kpi"><span class="k">Biến động hiện tại</span><span class="v">' + sPct(D.garch.volNowAnn, 0) + '</span><span class="s">dài hạn ' + sPct(D.garch.volLongAnn, 0) + '/năm</span></div>' +
        '<div class="tl-kpi"><span class="k">Nửa đời cú sốc</span><span class="v">' + sNum(D.garch.halfLife, 0) + ' phiên</span><span class="s">độ bền ' + sNum(D.garch.persistence, 3) + '</span></div>' +
        '<div class="tl-kpi"><span class="k">Hiệu ứng đòn bẩy</span><span class="v">' + sNum(D.garch.gamma / Math.max(1e-9, D.garch.alpha), 1) + '×</span><span class="s">cú giảm làm biến động tăng mạnh hơn cú tăng</span></div>' +
        '<div class="tl-kpi"><span class="k">Kỳ vọng dài hạn</span><span class="v">' + sPct(D.driftAnnual, 0) + '/năm</span><span class="s">neo lợi suất, chỉnh ở mục Mô phỏng</span></div></div>' +
        '<p class="tl-hint">Kết hợp hai mô hình (mỗi mô hình một nửa số đường): GJR-GARCH lấy mẫu lại phần dư thật, và chuyển chế độ Markov lấy mẫu lại lợi suất thật của những ngày cùng chế độ. Chi tiết ở mục Phương pháp.</p></section>';
    const ctxNote = withCtx ? ctxCompareHtml() : (SIM.ctx && SIM.ctx.use && ctxEvents().length ? '' : '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-wand-magic-sparkles"></i> Đưa bối cảnh vào</h3><div class="tl-card-tools"><a class="sim-btn ghost sm" href="#context">Mở Bối cảnh <i class="fa-solid fa-arrow-right"></i></a></div></div><p class="tl-hint" style="margin:0">Triển vọng trên chỉ dựa vào lịch sử giá. Ở mục Bối cảnh, AI đọc tin mới nhất và đề xuất các sự kiện (bạn chỉnh được) để cộng vào mô phỏng.</p></section>');
    return thesis + ctxNote + (typeof outlookSaveHtml === 'function' ? outlookSaveHtml(R) : '') + '<div class="sim-grid"><div class="sim-stack">' + fanCard + stressCard + '</div><div class="sim-stack">' + branchCard + regimeCard + modelCard + '</div></div>';
}
function mountOutlookCharts() {
    const M = SIM.market; if (M.state !== 'ok') return;
    const withCtx = !!(SIM.ctx && SIM.ctx.use && M.ctxResult && ctxEvents().length), R = withCtx ? M.ctxResult : M.result;
    const c = document.getElementById('sim-fan-index');
    if (c) SimCharts.fan(c, { bands: R.fan.index, base: M.model.indexLevel, fmt: (v) => sNum(v), markers: R.horizons, labels: HZ_LABEL, height: 290, overlay: withCtx ? { data: M.result.fan.index.q50, label: 'Chỉ lịch sử' } : null });
    const r = document.getElementById('sim-regime-hist');
    if (r) { const h = M.model.stressHist, from = Math.max(0, h.dates.length - 750); SimCharts.regime(r, { dates: h.dates.slice(from), p: h.p.slice(from), line: h.index ? h.index.slice(from) : null, height: 170 }); }
}

// ---------- Mô phỏng & quyết định ----------
function subjectSeg() {
    const opts = [['mine', 'fa-user', 'Danh mục của tôi'], ['group', 'fa-users', 'Danh mục nhóm'], ['index', 'fa-chart-line', 'VN-Index'], ['custom', 'fa-list', 'Tự chọn mã']];
    return '<div class="sim-seg" role="group" aria-label="Đối tượng mô phỏng">' + opts.map((o) => '<button type="button" aria-pressed="' + (SIM.subject === o[0]) + '" onclick="simSetSubject(\'' + o[0] + '\')"><i class="fa-solid ' + o[1] + '"></i> ' + o[2] + '</button>').join('') + '</div>';
}
function bookHtml() {
    const S = SIM;
    let custom = '';
    if (S.subject === 'custom' || S.subject === 'index') {
        custom = '<div class="sim-form" style="margin-top:12px">' +
            (S.subject === 'custom' ? '<label class="sim-field" style="grid-column:1/-1">Mã và tỷ trọng<input class="tl-input" id="sim-custom-syms" value="' + sE(S.custom.symbols) + '" placeholder="FPT, HPG:30, MWG" autocomplete="off" onchange="simCustomChanged()"><small>Cách nhau bởi dấu phẩy. Thêm :số để đặt tỷ trọng (%), không ghi thì chia đều. Tối đa 25 mã.</small></label>' : '') +
            '<label class="sim-field">Số tiền đầu tư (đồng)<input class="tl-input num" id="sim-custom-amt" inputmode="numeric" value="' + sE(sNum(S.custom.amount)) + '" onchange="simCustomChanged()"></label></div>' +
            (S.subject === 'custom' && S.watchlist && S.watchlist.length ? '<div style="margin-top:10px"><div class="tl-hint" style="margin:0 0 6px">Thêm từ danh sách theo dõi:</div><div class="sim-chips">' + S.watchlist.slice(0, 24).map((w) => '<button type="button" class="sim-chip" onclick="simAddSymbol(\'' + sE(w) + '\')">' + sE(w) + '</button>').join('') + '</div></div>' : '');
    }
    let table = '';
    if (S.bookState === 'loading') table = '<div class="sim-progress"><span class="spin"></span>Đang tải danh mục…</div>';
    else if (S.bookState === 'error') table = '<p class="tl-hint"><b class="sim-down">' + sE(S.bookError) + '</b></p>';
    else if (S.book) {
        const b = S.book, mv = b.positions.reduce((s, p) => s + p.qty * p.price, 0), nav = mv + b.cash - b.debt;
        table = '<div class="tl-kpis" style="margin-top:12px"><div class="tl-kpi"><span class="k">Giá trị ròng (NAV)</span><span class="v">' + sVnd(nav) + '</span></div><div class="tl-kpi"><span class="k">Cổ phiếu</span><span class="v">' + sVnd(mv) + '</span><span class="s">' + b.positions.length + ' vị thế</span></div><div class="tl-kpi"><span class="k">Tiền mặt</span><span class="v">' + sVnd(b.cash) + '</span></div>' + (b.debt ? '<div class="tl-kpi"><span class="k">Nợ vay</span><span class="v sim-down">' + sVnd(b.debt) + '</span><span class="s">đòn bẩy, không tính lãi</span></div>' : '') + '</div>' +
            (b.positions.length ? '<details class="tl-details"><summary>Xem ' + b.positions.length + ' vị thế</summary><div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>Mã</th><th>Khối lượng</th><th>Giá</th><th>Giá trị</th><th>Tỷ trọng NAV</th></tr></thead><tbody>' +
            b.positions.map((p) => '<tr><td><b>' + sE(p.symbol === MarketSim.INDEX ? 'VN-Index' : p.symbol) + '</b></td><td>' + (p.symbol === MarketSim.INDEX ? '—' : sNum(p.qty)) + '</td><td>' + sNum(p.price, p.symbol === MarketSim.INDEX ? 2 : 0) + '</td><td>' + sVnd(p.qty * p.price) + '</td><td>' + sPct(nav > 0 ? p.qty * p.price / nav : null) + '</td></tr>').join('') + '</tbody></table></div></details>' : '<p class="tl-hint">Chưa có vị thế cổ phiếu nào.</p>') +
            (b.note ? '<p class="tl-hint">' + sE(b.note) + '</p>' : '');
    }
    return '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-briefcase"></i> Mô phỏng cho</h3></div>' + subjectSeg() + custom + table + '</section>';
}
function policiesHtml() {
    const all = MarketSim.PRESETS.concat(SIM.customPolicies);
    const cards = all.map((p) => {
        const on = SIM.selected.indexOf(p.id) !== -1, isCustom = SIM.customPolicies.some((c) => c.id === p.id);
        return '<label class="sim-pol' + (on ? ' on' : '') + '"><input type="checkbox" ' + (on ? 'checked ' : '') + (p.id === 'hold' ? 'disabled ' : '') + 'onchange="simTogglePolicy(\'' + sE(p.id) + '\', this.checked)"><span><b>' + sE(p.label) + '</b><small>' + sE(describePolicy(p)) + '</small></span>' +
            (isCustom ? '<button type="button" class="x" title="Xoá chính sách này" aria-label="Xoá chính sách ' + sE(p.label) + '" onclick="event.preventDefault();simRemovePolicy(\'' + sE(p.id) + '\')"><i class="fa-solid fa-xmark"></i></button>' : '') + '</label>';
    }).join('');
    const sel = (id, opts, v) => '<select class="tl-select" id="' + id + '">' + opts.map((o) => '<option value="' + o[0] + '"' + (String(v) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>';
    const builder = '<details class="tl-details" id="sim-builder"' + (SIM.builderOpen ? ' open' : '') + ' ontoggle="SIM.builderOpen=this.open"><summary>Tạo chính sách của riêng bạn</summary><div class="sim-form">' +
        '<label class="sim-field" style="grid-column:1/-1">Tên<input class="tl-input" id="pb-name" maxlength="60" placeholder="Ví dụ: Hạ 20% rồi cắt lỗ 10%"></label>' +
        '<label class="sim-field">Bán ngay (% mỗi mã)<input class="tl-input num" id="pb-sell" inputmode="decimal" placeholder="0"></label>' +
        '<label class="sim-field">Mua thêm ngay (% tiền mặt)<input class="tl-input num" id="pb-buy" inputmode="decimal" placeholder="0"></label>' +
        '<label class="sim-field">Cắt lỗ (% từ giá hiện tại)<input class="tl-input num" id="pb-stop" inputmode="decimal" placeholder="bỏ trống = không"></label>' +
        '<label class="sim-field">Kiểu cắt lỗ' + sel('pb-trail', [['0', 'Cố định'], ['1', 'Động (theo đỉnh)']], '0') + '</label>' +
        '<label class="sim-field">Chốt lời khi tăng (%)<input class="tl-input num" id="pb-take" inputmode="decimal" placeholder="bỏ trống = không"></label>' +
        '<label class="sim-field">Lúc chốt bán (% vị thế)<input class="tl-input num" id="pb-takesell" inputmode="decimal" placeholder="100"></label>' +
        '<label class="sim-field">Mua khi VN-Index giảm (%)<input class="tl-input num" id="pb-dip" inputmode="decimal" placeholder="bỏ trống = không"></label>' +
        '<label class="sim-field">Dùng bao nhiêu tiền mặt (%)<input class="tl-input num" id="pb-dipuse" inputmode="decimal" placeholder="50"></label>' +
        '<label class="sim-field">Kế hoạch có điều kiện: sau' + sel('pb-rstage', [['', 'Không dùng'], ['1', '1 tuần'], ['2', '1 tháng']], '') + '</label>' +
        '<label class="sim-field">nếu VN-Index' + sel('pb-rwhen', [['down', 'giảm'], ['flat', 'đi ngang'], ['up', 'tăng']], 'down') + '</label>' +
        '<label class="sim-field">thì' + sel('pb-ract', [['sell', 'bán (% mỗi mã)'], ['buy', 'mua (% tiền mặt)']], 'sell') + '</label>' +
        '<label class="sim-field">mức (%)<input class="tl-input num" id="pb-rpct" inputmode="decimal" placeholder="30"></label>' +
        '</div><div class="sim-actions"><button type="button" class="sim-btn sm" onclick="simAddCustomPolicy()"><i class="fa-solid fa-plus"></i> Thêm chính sách</button><span class="tl-hint" style="margin:0">Ngưỡng "giảm / tăng" của kế hoạch có điều kiện là ' + sPct(SIM.settings.bands[0], 0) + ' sau 1 tuần và ' + sPct(SIM.settings.bands[1], 0) + ' trong giai đoạn tới hết tháng.</span></div></details>';
    return '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-chess"></i> Các cách xử lý cần so sánh</h3><span class="tl-hint" style="margin:0">' + SIM.selected.length + ' đang chọn · tối đa 10</span></div><div class="sim-pols">' + cards + '</div>' + builder + '</section>';
}
function settingsHtml() {
    const s = SIM.settings;
    const sel = (id, opts, v, extra) => '<select class="tl-select" id="' + id + '" onchange="simSettingsChanged()"' + (extra || '') + '>' + opts.map((o) => '<option value="' + o[0] + '"' + (String(v) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>';
    const inp = (id, v) => '<input class="tl-input num" id="' + id + '" inputmode="decimal" value="' + sE(v) + '" onchange="simSettingsChanged()">';
    return '<details class="tl-details tl-card" id="sim-settings"' + (SIM.settingsOpen ? ' open' : '') + ' ontoggle="SIM.settingsOpen=this.open" style="margin-top:0"><summary><i class="fa-solid fa-sliders"></i> Giả định mô phỏng · ' + sNum(s.paths) + ' đường · kỳ vọng ' + s.drift + '%/năm · khẩu vị ' + riskWord(s.riskAversion) + '</summary><div class="sim-form">' +
        '<label class="sim-field">Số đường mô phỏng' + sel('st-paths', [[2000, '2.000 (nhanh)'], [10000, '10.000'], [30000, '30.000 (kỹ)']], s.paths) + '<small>Nhiều đường thì nhánh hiếm của cây kịch bản đáng tin hơn.</small></label>' +
        '<label class="sim-field">Mô hình thị trường' + sel('st-model', [['blend', 'Kết hợp (mặc định)'], ['garch', 'GJR-GARCH'], ['hmm', 'Chuyển chế độ']], s.model) + '<small>Xem mục Kiểm chứng để biết mô hình nào đúng hơn.</small></label>' +
        '<label class="sim-field">Kỳ vọng thị trường (%/năm)' + inp('st-drift', s.drift) + '<small>Mức trung bình dài hạn, không phải dự báo năm nay.</small></label>' +
        '<label class="sim-field">Khẩu vị rủi ro' + sel('st-gamma', [[1, 'Chấp nhận rủi ro (1)'], [3, 'Vừa phải (3)'], [6, 'Thận trọng (6)'], [10, 'Rất thận trọng (10)']], s.riskAversion) + '<small>Dùng để xếp hạng theo lợi suất tương đương chắc chắn.</small></label>' +
        '<label class="sim-field">Mục tiêu lợi nhuận (%)' + inp('st-target', s.target) + '</label>' +
        '<label class="sim-field">Phí giao dịch (%)' + inp('st-fee', s.fee) + '</label>' +
        '<label class="sim-field">Thuế bán (%)' + inp('st-tax', s.tax) + '</label>' +
        '<label class="sim-field">Tối đa mỗi phiên (% thanh khoản)' + inp('st-part', s.participation) + '<small>Lệnh lớn hơn được chia sang các phiên sau.</small></label>' +
        '<label class="sim-field">Hạt giống ngẫu nhiên' + inp('st-seed', s.seed) + '<small>Cùng hạt giống thì cùng kết quả.</small></label>' +
        '<label class="sim-field" style="justify-content:flex-end"><span class="sim-check"><input type="checkbox" id="st-fair"' + (s.useFair ? ' checked' : '') + ' onchange="simSettingsChanged()"> Kéo về giá trị hợp lý (Valuation Bench)</span><small>Mã có bản định giá đã lưu được cộng kỳ vọng riêng. Tín hiệu này yếu khi kiểm chứng ngoài mẫu: dùng để thử, không nên tin mặc định.</small></label>' +
        '</div></details>';
}
const riskWord = (g) => ({ 1: 'chấp nhận rủi ro', 3: 'vừa phải', 6: 'thận trọng', 10: 'rất thận trọng' }[g] || 'γ=' + g);

function renderPortfolioView() {
    const R = SIM.run;
    let results = '';
    if (R.state === 'running') results = loadingHtml(R.step || 'Đang mô phỏng…');
    else if (R.state === 'error') results = errorHtml(R.error, 'simRun()');
    else if (R.state === 'ok' && R.result) results = resultsHtml(R.result);
    else results = '<section class="tl-card"><div class="tl-empty"><i class="fa-solid fa-flask"></i>Chọn đối tượng và các cách xử lý, rồi bấm <b>Chạy mô phỏng</b>. Mỗi cách xử lý chạy trên cùng một bộ đường giá nên so sánh công bằng.</div></section>';
    return '<div class="sim-grid even"><div class="sim-stack">' + bookHtml() + '</div><div class="sim-stack">' + policiesHtml() + '</div></div>' + settingsHtml() +
        '<div class="sim-actions" style="margin:0 0 18px"><button type="button" class="sim-btn" id="sim-run-btn" onclick="simRun()"' + (R.state === 'running' || SIM.bookState !== 'ok' ? ' disabled' : '') + '><i class="fa-solid fa-play"></i> Chạy mô phỏng</button>' +
        (R.result && R.state === 'ok' ? '<span class="tl-hint" style="margin:0">Lần chạy gần nhất: ' + sNum(R.result.paths) + ' đường, ' + sE(R.ms ? (R.ms / 1000).toFixed(1) + ' giây' : '') + '</span>' : '') + '</div>' + results;
}
function picksHtml(hh, res) {
    const rows = hh.policies, by = (id) => rows.find((r) => r.id === id);
    const card = (k, id, sub, lead) => { const r = by(id); return r ? '<div class="sim-pick' + (lead ? ' lead' : '') + '"><div class="k">' + k + '</div><div class="v">' + sE(r.label) + '</div><div class="s">' + sub(r) + '</div></div>' : ''; };
    return '<div class="sim-picks">' +
        card('Hợp khẩu vị nhất', hh.best.ce, (r) => 'tương đương chắc chắn ' + sPct(r.ce, 2, true) + ' · khẩu vị ' + riskWord(res.riskAversion), true) +
        card('Ít hối tiếc nhất', hh.best.regret, (r) => 'trung bình thua cách tốt nhất ' + sPct(r.regretMean, 2)) +
        card('Kỳ vọng cao nhất', hh.best.mean, (r) => 'trung bình ' + sPct(r.mean, 2, true) + ' · trung vị ' + sPct(r.median, 1, true)) +
        card('Đuôi xấu nhẹ nhất', hh.best.cvar, (r) => '5% xấu nhất lỗ TB ' + sPct(r.cvar95, 1)) + '</div>';
}
function resultsHtml(res) {
    const hk = Math.min(SIM.run.hk, res.byHorizon.length - 1), hh = res.byHorizon[hk], sel = SIM.run.sel && hh.policies.some((p) => p.id === SIM.run.sel) ? SIM.run.sel : hh.policies[0].id;
    const tabs = '<div class="sim-tabs" role="tablist">' + res.byHorizon.map((x, i) => '<button type="button" role="tab" aria-selected="' + (i === hk) + '" onclick="simSetHorizon(' + i + ')">Sau ' + hzLabel(x.h) + '</button>').join('') + '</div>';
    const rows = hh.policies.map((p) => '<tr class="' + (p.id === sel ? 'sel' : '') + '"><td><button type="button" class="sim-row-btn" onclick="simSelectPolicy(\'' + sE(p.id) + '\')">' + sE(p.label) + '</button>' +
        (p.id === hh.best.ce ? '<span class="sim-tag">hợp khẩu vị</span>' : '') + (p.id === hh.best.regret && p.id !== hh.best.ce ? '<span class="sim-tag ok">ít hối tiếc</span>' : '') + '</td>' +
        '<td class="' + sCls(p.mean) + '">' + sPct(p.mean, 2, true) + '</td><td>' + sPct(p.median, 1, true) + '</td><td>' + sPct(p.q05, 1, true) + ' … ' + sPct(p.q95, 1, true) + '</td><td>' + sProb(p.pLoss) + '</td><td class="sim-down">' + sProb(p.pLoss10) + '</td><td>' + sPct(p.cvar95, 1) + '</td><td>' + sPct(p.dd95, 1) + '</td><td>' + sProb(p.pTarget) + '</td><td>' + sPct(p.ce, 2, true) + '</td><td>' + sPct(p.regretMean, 2) + '</td><td>' + sProb(p.pBest) + '</td></tr>').join('');
    const table = '<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>Cách xử lý</th><th>Trung bình</th><th>Trung vị</th><th>Khoảng 90%</th><th>P(lỗ)</th><th>P(lỗ &gt;10%)</th><th title="Lỗ trung bình trong 5% kịch bản xấu nhất">CVaR 95%</th><th title="Mức sụt giảm từ đỉnh, ngưỡng 5% xấu nhất">Sụt giảm 5% xấu</th><th>P(đạt +' + sNum(res.target * 100) + '%)</th><th title="Lợi suất chắc chắn tương đương theo khẩu vị rủi ro">Tương đương chắc chắn</th><th title="Trung bình thua cách tốt nhất trên cùng đường giá">Hối tiếc TB</th><th>P(tốt nhất)</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<p class="tl-hint">Bấm tên một cách xử lý để xem quạt xác suất và phân phối của nó (đường nét đứt là Giữ nguyên). "Hối tiếc" đo trên từng đường giá: cách xử lý bền vững là cách ít thua cách tốt nhất nhất trong mọi kịch bản, không phải cách đẹp nhất ở một kịch bản.</p>';
    const pi = res.policies.findIndex((p) => p.id === sel), selLabel = res.policies[pi] ? res.policies[pi].label : '';
    const charts = '<div class="sim-grid even" style="margin-top:14px"><div><div class="tl-hint" style="margin:0 0 6px"><b>' + sE(selLabel) + '</b>: giá trị danh mục theo thời gian</div><div class="sim-chart"><canvas id="sim-fan-port"></canvas></div><div class="sim-legend"><span><i style="background:var(--sim-band-outer)"></i>90%</span><span><i style="background:var(--sim-band-inner)"></i>50%</span><span><i style="background:var(--finance-accent)"></i>Trung vị</span><span><i style="background:var(--text-muted)"></i>Giữ nguyên (trung vị)</span></div></div>' +
        '<div><div class="tl-hint" style="margin:0 0 6px">Phân phối kết quả sau ' + hzLabel(res.horizons[res.horizons.length - 1]) + '</div><div class="sim-chart"><canvas id="sim-hist-port"></canvas></div><div class="sim-legend"><span><i style="background:var(--sim-band-inner)"></i>' + sE(selLabel) + '</span><span><i style="background:var(--text-muted)"></i>Giữ nguyên</span></div></div></div>';
    const dr = res.drivers[hk];
    const contrib = (list, nav0) => { const mx = Math.max.apply(null, list.map((c) => Math.abs(c.pctNav)).concat([1e-9])); return '<div class="sim-contrib">' + list.slice(0, 6).map((c) => '<div class="row"><b>' + sE(c.symbol === MarketSim.INDEX ? 'VN-Index' : c.symbol) + '</b><span class="bar"><span style="width:' + (Math.abs(c.pctNav) / mx * 100).toFixed(1) + '%;background:var(' + (c.pctNav < 0 ? '--sim-down' : '--sim-up') + ')"></span></span><span class="v ' + sCls(c.pctNav) + '">' + sPct(c.pctNav, 1, true) + '</span></div>').join('') + '</div>'; };
    const truth = '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-magnifying-glass"></i> Điều gì phải đúng</h3><span class="tl-hint" style="margin:0">Giữ nguyên · sau ' + hzLabel(hh.h) + '</span></div><div class="sim-grid even">' +
        '<div><p class="sim-prose" style="margin:0 0 10px">Trong <b>5% kịch bản xấu nhất</b> (danh mục ' + sPct(dr.worst.portMean, 1, true) + '), VN-Index thường ' + sPct(dr.worst.indexMedian, 1, true) + ' (khoảng ' + sPct(dr.worst.indexQ25, 0, true) + ' đến ' + sPct(dr.worst.indexQ75, 0, true) + ')' + (dr.worst.stressShare !== null ? ' và thị trường nằm ở chế độ căng thẳng ' + sProb(dr.worst.stressShare) + ' thời gian' : '') + '. Mã kéo lỗ nhiều nhất (% NAV):</p>' + contrib(dr.worst.contrib) + '</div>' +
        '<div><p class="sim-prose" style="margin:0 0 10px">Trong <b>5% kịch bản tốt nhất</b> (danh mục ' + sPct(dr.best.portMean, 1, true) + '), VN-Index thường ' + sPct(dr.best.indexMedian, 1, true) + '. Mã đóng góp nhiều nhất:</p>' + contrib(dr.best.contrib.slice().reverse()) + '</div></div>' +
        '<p class="tl-hint">Dùng để tự hỏi: nếu kịch bản xấu xảy ra, mình có chịu được không, và mã nào là nguồn rủi ro thật sự? Nếu một mã chiếm phần lớn khoản lỗ ở đuôi, đó là chỗ cần xem lại đầu tiên.</p></section>';
    const sens = '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-sliders"></i> Danh mục phản ứng theo VN-Index</h3><span class="tl-hint" style="margin:0">Giữ nguyên · sau ' + hzLabel(res.horizons[res.horizons.length - 1]) + '</span></div><div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>Nếu VN-Index</th><th>Xác suất</th><th>Danh mục: trung vị</th><th>Khoảng 90%</th></tr></thead><tbody>' +
        res.sensitivity.filter((b) => b.n > 0).map((b) => '<tr><td>' + (b.lo === -Infinity ? 'giảm hơn ' + sPct(-b.hi, 0) : b.hi === Infinity ? 'tăng hơn ' + sPct(b.lo, 0) : sPct(b.lo, 0, true) + ' đến ' + sPct(b.hi, 0, true)) + '</td><td>' + sProb(b.prob) + '</td><td class="' + sCls(b.median) + '">' + sPct(b.median, 1, true) + '</td><td>' + sPct(b.q05, 1, true) + ' … ' + sPct(b.q95, 1, true) + '</td></tr>').join('') + '</tbody></table></div></section>';
    const notes = [];
    if (res.skipped && res.skipped.length) notes.push('Không đủ lịch sử giá để mô phỏng (giữ nguyên giá trị): ' + res.skipped.join(', ') + '.');
    if (res.stuckSessions > 0.05) notes.push('Trung bình mỗi đường có ' + sNum(res.stuckSessions, 1) + ' phiên muốn bán nhưng cổ phiếu nằm sàn không bán được: kết quả cắt lỗ đã tính điều này.');
    notes.push('Chi phí: phí ' + sPct(res.costs.fee, 2) + ', thuế bán ' + sPct(res.costs.tax, 2) + ', chi phí tác động giá theo thanh khoản, tối đa ' + sPct(res.costs.participation, 0) + ' thanh khoản mỗi phiên; lệnh quyết định theo giá đóng cửa được khớp ở phiên sau; cổ phiếu mua T+2 mới bán được.');
    const stale = typeof ctxKey === 'function' && res.ctxKey !== undefined && res.ctxKey !== ctxKey() ? '<p class="tl-hint"><b class="sim-down">Bối cảnh đã thay đổi sau lần chạy này: bấm Chạy mô phỏng để tính lại.</b></p>' : '';
    const evInfo = res.events && res.events.length ? '<p class="tl-hint" style="margin-top:0">Đã tính ' + res.events.length + ' sự kiện của bối cảnh (mục Bối cảnh).</p>' : '';
    return '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-scale-unbalanced"></i> So sánh các cách xử lý</h3><span class="tl-hint" style="margin:0">' + sNum(res.paths) + ' đường · NAV ' + sVnd(res.nav0) + '</span></div>' + stale + evInfo + tabs + picksHtml(hh, res) + table + charts + '<p class="tl-hint">' + notes.map(sE).join(' ') + '</p></section>' + (typeof eventImpactHtml === 'function' ? eventImpactHtml(res, hk) : '') + (typeof runSaveHtml === 'function' ? runSaveHtml(res) : '') + '<div class="sim-grid even">' + truth + sens + '</div>';
}
function mountPortfolioCharts() {
    const R = SIM.run; if (R.state !== 'ok' || !R.result) return;
    const res = R.result, pi = Math.max(0, res.policies.findIndex((p) => p.id === SIM.run.sel));
    const c = document.getElementById('sim-fan-port');
    if (c) SimCharts.fan(c, { bands: res.fan.policies[pi], base: res.nav0, pct: true, overlay: pi > 0 ? { data: res.fan.policies[0].q50, label: 'Giữ nguyên' } : null, markers: res.horizons, labels: HZ_LABEL, height: 250 });
    const h = document.getElementById('sim-hist-port');
    if (h) SimCharts.hist(h, { lo: res.hist.lo, hi: res.hist.hi, series: (pi > 0 ? [{ counts: res.hist.counts[0] }] : []).concat([{ counts: res.hist.counts[pi], strong: true }]), height: 250 });
}

// ---------- Cây kịch bản ----------
// Cây thường: 3 giai đoạn x 3 nhánh của VN-Index. Cây theo sự kiện (khi lần chạy có bối cảnh): thêm một gốc "sự kiện xảy ra / không xảy ra" trước 3 giai đoạn;
// id nút khi đó bắt đầu bằng Y hoặc N (MarketSim.summarize -> eventTrees).
function renderTreeView() {
    const src = SIM.run.state === 'ok' && SIM.run.result ? 'run' : (SIM.market.state === 'ok' ? 'market' : null);
    if (!src) return SIM.market.state === 'error' ? errorHtml('Chưa có mô hình thị trường: ' + SIM.market.error, 'simLoadMarket(true)') : loadingHtml('Đang dựng mô hình thị trường…');
    const mres = SIM.market.ctxResult && SIM.ctx && SIM.ctx.use && ctxEvents().length ? SIM.market.ctxResult : SIM.market.result;
    const res = src === 'run' ? SIM.run.result : mres, ets = res.eventTrees || [];
    const ti = SIM.treeEvent >= 0 && ets[SIM.treeEvent] ? SIM.treeEvent : -1, ev = ti >= 0 ? ets[ti] : null;
    const T = ev ? ev.nodes : res.tree, path = SIM.treePath || '';
    const rootId = ev && (path[0] === 'Y' || path[0] === 'N') ? path[0] : '', mp = ev ? path.slice(rootId ? 1 : 0) : path;
    const byId = {}; T.forEach((n) => { byId[n.id] = n; });
    const rootText = (id) => (id === 'Y' ? 'Sự kiện xảy ra' : 'Sự kiện không xảy ra');
    const node = (n) => {
        const on = n.id === path, inPath = path.indexOf(n.id) === 0 && !on, hold = n.policies ? n.policies[0] : null;
        const label = n.depth === 0 ? rootText(n.id) + '<small>trước mốc ' + sE(hzLabel(res.horizons[res.horizons.length - 1])) + ' · VN-Index ' + sPct(n.index ? n.index.median : null, 1, true) + (src === 'run' && hold ? ' · danh mục ' + sPct(hold.median, 1, true) : '') + '</small>'
            : sE(branchText(n.branch, res.bands[n.depth - 1])) + '<small>VN-Index tích luỹ ' + sPct(n.index ? n.index.median : null, 1, true) + (src === 'run' && hold ? ' · danh mục ' + sPct(hold.median, 1, true) : '') + '</small>';
        const cls = n.depth === 0 ? (n.id === 'Y' ? (ev.sign > 0 ? 'b2' : (ev.sign < 0 ? 'b0' : 'b1')) : 'b1') : 'b' + n.branch;
        return '<button type="button" class="sim-node ' + cls + (on ? ' on' : '') + (inPath ? ' path' : '') + (n.n < 200 ? ' thin' : '') + '" onclick="simTreeSelect(\'' + n.id + '\')" aria-pressed="' + on + '"><span class="edge"></span><span class="t">' + label + '</span><span class="p">' + sProb(n.prob) + '<small>' + (n.depth > 1 || (ev && n.depth === 1) ? sProb(n.parentProb) + ' nhánh' : '') + '</small></span></button>';
    };
    const col = (depth) => {
        const pre = ev ? rootId : '';
        const parents = ev && !rootId ? [] : (depth === 1 ? [pre] : (mp.length >= depth - 1 ? [pre + mp.slice(0, depth - 1)] : []));
        const groups = parents.map((pid) => { const kids = [0, 1, 2].map((b) => byId[pid + b]).filter(Boolean); if (!kids.length) return ''; const words = pid.replace(/^[YN]/, ''); return '<div class="grp">' + (words || (ev && pid) ? '<div class="grp-label">Nếu ' + sE((ev && pid ? rootText(pid[0]).toLowerCase() + (words ? ', ' : '') : '') + pathWords(words)) + '</div>' : '') + kids.map(node).join('') + '</div>'; }).join('');
        return '<div class="sim-tree-col"><h4>' + STAGE_LABEL[depth - 1] + ' · tới ' + hzLabel(res.horizons[depth - 1]) + '</h4>' + (groups || '<p class="tl-hint">' + (ev && !rootId ? 'Chọn sự kiện xảy ra hay không ở cột đầu.' : 'Chọn một nhánh ở cột trước.') + '</p>') + '</div>';
    };
    const rootCol = ev ? '<div class="sim-tree-col"><h4>Sự kiện</h4><div class="grp"><div class="grp-label">' + sE(ev.title) + ' · ' + sProb(ev.p) + ' khả năng</div>' + ['Y', 'N'].map((id) => byId[id]).filter(Boolean).map(node).join('') + '</div></div>' : '';
    const picker = ets.length ? '<div class="sim-seg sim-tree-pick" role="group" aria-label="Chọn cây"><button type="button" aria-pressed="' + (ti < 0) + '" onclick="simTreeEvent(-1)">Theo VN-Index</button>' +
        ets.map((e, i) => '<button type="button" aria-pressed="' + (ti === i) + '" onclick="simTreeEvent(' + i + ')" title="' + sE(e.title) + '">Nếu: ' + sE(e.title.length > 38 ? e.title.slice(0, 37) + '…' : e.title) + '</button>').join('') + '</div>' : '';
    const head = '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-code-branch"></i> Cây kịch bản ' + (src === 'run' ? 'cho ' + sE(subjectWord()) : 'VN-Index') + '</h3><span class="tl-hint" style="margin:0">' + sNum(res.paths) + ' đường · ' + (ev ? 'sự kiện × ' : '') + '3 mốc × 3 nhánh</span></div>' + picker +
        '<p class="tl-hint" style="margin:0 0 12px">' + (ev ? 'Gốc tách các đường mô phỏng có sự kiện <b>' + sE(ev.title) + '</b> xảy ra (trước mốc cuối) và không xảy ra; mỗi bên lại rẽ 3 giai đoạn của VN-Index. So hai gốc để thấy sự kiện làm các nhánh và cách xử lý thay đổi thế nào. ' : 'Mỗi nhánh là cách VN-Index đi trong giai đoạn đó (so với đầu giai đoạn). ') +
        'Xác suất = tỷ lệ đường mô phỏng đi qua nhánh; số nhỏ bên dưới là xác suất có điều kiện khi đã ở nút trước. Nhánh mờ có ít hơn 200 đường: kém tin cậy, tăng số đường nếu cần.' + (src === 'market' ? ' Chạy mục Mô phỏng để xem danh mục và các cách xử lý ở từng nhánh.' : '') + '</p>' +
        '<div class="sim-tree' + (ev ? ' four' : '') + '">' + rootCol + col(1) + col(2) + col(3) + '</div></section>';
    const n = byId[path];
    if (!n) return head;
    const crumbs = (rootId ? ['<span>Sự kiện: <b>' + (rootId === 'Y' ? 'xảy ra' : 'không xảy ra') + '</b></span>'] : []).concat(mp.split('').filter(Boolean).map((c, i) => '<span>' + sE(STAGE_LABEL[i]) + ': <b>' + BR_WORD[+c] + '</b></span>'));
    let detail = '<section class="tl-card"><div class="sim-crumbs">' + crumbs.join('<span class="sep">›</span>') + '</div>' +
        '<div class="tl-kpis"><div class="tl-kpi"><span class="k">Xác suất tới đây</span><span class="v">' + sProb(n.prob) + '</span><span class="s">' + sNum(n.n) + ' đường</span></div><div class="tl-kpi"><span class="k">VN-Index tích luỹ</span><span class="v">' + sPct(n.index.median, 1, true) + '</span><span class="s">90%: ' + sPct(n.index.q05, 0, true) + ' … ' + sPct(n.index.q95, 0, true) + (n.depth === 0 ? ' · tới ' + hzLabel(n.h) : '') + '</span></div>' +
        (n.stressShare !== null ? '<div class="tl-kpi"><span class="k">Thời gian căng thẳng</span><span class="v">' + sProb(n.stressShare) + '</span><span class="s">trong các đường mô hình chế độ</span></div>' : '') + '</div>';
    if (n.policies && src === 'run') {
        detail += '<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>Cách xử lý (nếu đi theo nhánh này)</th><th>Trung bình</th><th>Trung vị</th><th>Khoảng 90%</th><th>P(lỗ &gt;10%)</th><th>Tương đương chắc chắn</th><th>Hối tiếc TB</th></tr></thead><tbody>' +
            n.policies.map((p) => '<tr><td>' + sE(p.label) + (p.id === n.best.ce ? '<span class="sim-tag">hợp khẩu vị</span>' : '') + '</td><td class="' + sCls(p.mean) + '">' + sPct(p.mean, 2, true) + '</td><td>' + sPct(p.median, 1, true) + '</td><td>' + sPct(p.q05, 1, true) + ' … ' + sPct(p.q95, 1, true) + '</td><td>' + sProb(p.pLoss10) + '</td><td>' + sPct(p.ce, 2, true) + '</td><td>' + sPct(p.regretMean, 2) + '</td></tr>').join('') + '</tbody></table></div>';
        const overall = res.byHorizon[n.depth === 0 ? res.byHorizon.length - 1 : n.depth - 1].best.ce, here = n.best.ce, lab = (id) => (res.policies.find((p) => p.id === id) || {}).label;
        detail += '<p class="sim-prose" style="margin-top:12px">' + (overall === here
            ? 'Ở nhánh này, cách hợp khẩu vị nhất vẫn là <b>' + sE(lab(here)) + '</b>, giống khi xét mọi kịch bản: quyết định này bền vững với nhánh này.'
            : 'Ở nhánh này, cách hợp khẩu vị nhất là <b>' + sE(lab(here)) + '</b>, khác với <b>' + sE(lab(overall)) + '</b> khi xét mọi kịch bản. Đây là chỗ một <b>kế hoạch có điều kiện</b> có thể đáng giá: quyết định khi đã biết ' + (n.depth === 0 ? 'sự kiện có xảy ra hay không (theo dõi các dấu hiệu trên thẻ sự kiện).' : 'thị trường đi nhánh nào.')) + '</p>';
        if (n.depth >= 1 && n.depth <= 2) {
            detail += '<div class="sim-actions"><span class="tl-hint" style="margin:0">Thử ngay một kế hoạch có điều kiện cho nhánh này:</span>' +
                '<button type="button" class="sim-btn ghost sm" onclick="simPlanFromNode(\'' + mp + '\',\'sell\',30)">Nếu xảy ra thì bán 30%</button>' +
                '<button type="button" class="sim-btn ghost sm" onclick="simPlanFromNode(\'' + mp + '\',\'buy\',50)">Nếu xảy ra thì mua bằng 50% tiền mặt</button></div>' +
                '<p class="tl-hint">Kế hoạch được thêm vào danh sách cách xử lý và mô phỏng lại: lần này quyết định chỉ được đưa ra SAU khi thị trường đã đi đúng chuỗi nhánh này (không nhìn trước), nên so sánh mới công bằng.' + (ev ? ' Kế hoạch chỉ căn theo nhánh của VN-Index, không căn theo sự kiện.' : '') + '</p>';
        }
    } else if (src === 'run') detail += '<p class="tl-hint">Nhánh này có quá ít đường để so sánh các cách xử lý. Tăng số đường mô phỏng ở phần Giả định.</p>';
    detail += '</section>';
    return head + detail;
}
function pathWords(pid) { return pid.split('').map((c, i) => STAGE_LABEL[i].toLowerCase() + ' ' + BR_WORD[+c]).join(', '); }
function subjectWord() { return { mine: 'danh mục của tôi', group: 'danh mục nhóm', index: 'VN-Index', custom: 'danh mục tự chọn' }[SIM.subject] || 'danh mục'; }

// ---------- Kiểm chứng ----------
function renderValidateView() {
    const V = SIM.validate;
    const intro = '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-bullseye"></i> Mô hình đã dự báo đúng đến đâu</h3><div class="tl-card-tools"><button type="button" class="sim-btn sm" onclick="simRunBacktest()"' + (V.state === 'running' || SIM.market.state !== 'ok' ? ' disabled' : '') + '><i class="fa-solid fa-play"></i> ' + (V.state === 'ok' ? 'Chạy lại' : 'Chạy kiểm chứng') + '</button></div></div>' +
        '<p class="sim-prose" style="margin:0">Tại hơn 100 ngày gốc trong quá khứ, mô hình chỉ được dùng dữ liệu tới ngày đó để dự báo phân phối VN-Index 1 tuần, 1 tháng, 3 tháng tới, rồi so với thực tế. Một mô hình tốt: khoảng 90% chứa giá thật khoảng 90% số lần (không hơn nhiều, không kém nhiều), biểu đồ PIT gần phẳng, CRPS thấp, và điểm Brier của xác suất nhánh tốt hơn tần suất lịch sử (BSS dương). <b>Lịch sử thay thế</b> là mốc so sánh: chỉ lấy mẫu lại lợi suất quá khứ, không có biến động hay chế độ.</p></section>';
    if (V.state === 'running') return intro + loadingHtml('Đang kiểm chứng ngược (ước lượng lại mô hình nhiều lần), mất khoảng 10–40 giây…');
    if (V.state === 'error') return intro + errorHtml(V.error, 'simRunBacktest()');
    if (V.state !== 'ok') return intro;
    const B = V.result, names = { blend: 'Kết hợp', garch: 'GJR-GARCH', hmm: 'Chuyển chế độ', hist: 'Lịch sử thay thế' };
    const cov = (v, nom) => { const d = Math.abs(v - nom); return '<span class="sim-tag ' + (d <= 0.07 ? 'ok' : (d <= 0.14 ? 'warn' : 'bad')) + '">' + sProb(v) + '</span>'; };
    const bestCrps = B.horizons.map((h, hk) => B.models.reduce((b, m) => (b === null || B.results[m][hk].crps < B.results[b][hk].crps ? m : b), null));
    const blocks = B.horizons.map((h, hk) => {
        const n0 = B.results[B.models[0]][hk];
        return '<section class="tl-card"><div class="tl-card-head"><h3>Sau ' + hzLabel(h) + '</h3><span class="tl-hint" style="margin:0">' + n0.n + ' ngày gốc · ~' + n0.nEff + ' độc lập</span></div><div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>Mô hình</th><th>Khoảng 50%</th><th>Khoảng 80%</th><th>Khoảng 90%</th><th>PIT</th><th title="Sai số xác suất liên tục: càng thấp càng tốt">CRPS</th><th title="Điểm kỹ năng Brier của xác suất 3 nhánh so với tần suất lịch sử">BSS nhánh</th></tr></thead><tbody>' +
            B.models.map((m) => { const x = B.results[m][hk]; return '<tr><td><b>' + names[m] + '</b>' + (m === bestCrps[hk] ? '<span class="sim-tag">CRPS tốt nhất</span>' : '') + '</td><td>' + cov(x.cover50, 0.5) + '</td><td>' + cov(x.cover80, 0.8) + '</td><td>' + cov(x.cover90, 0.9) + '</td><td><span class="sim-pit" aria-label="Biểu đồ PIT">' + x.pit.map((p) => '<span style="height:' + Math.max(2, Math.min(26, p * 130)).toFixed(0) + 'px"></span>').join('') + '</span></td><td>' + sPct(x.crps, 2) + '</td><td class="' + sCls(x.bss) + '">' + (x.bss === null ? '—' : (x.bss >= 0 ? '+' : '−') + Math.abs(x.bss).toFixed(3)) + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
    }).join('');
    return intro + blocks + '<p class="tl-hint">Kiểm chứng trên ' + sNum(B.obs) + ' phiên VN-Index; ngày gốc cách nhau ' + B.step + ' phiên, tham số ước lượng lại mỗi ' + B.refitEvery + ' phiên (biến động và chế độ luôn được lọc tới đúng ngày gốc), ' + sNum(B.paths) + ' đường mỗi lần. Các cửa sổ dự báo dài chồng lấn nhau nên số quan sát độc lập ít hơn số ngày gốc: chênh lệch nhỏ giữa các mô hình có thể chỉ là nhiễu. Nhãn xanh: độ phủ lệch không quá 7 điểm % so với danh nghĩa; vàng: tới 14 điểm; đỏ: hơn.</p>';
}

// ---------- Phương pháp ----------
function renderMethodView() {
    return '<section class="tl-card"><div class="sim-prose">' +
        '<h3>Market Simulation làm gì</h3><p>Sinh hàng nghìn tương lai có thể xảy ra cho VN-Index và từng mã trong danh mục, áp từng cách xử lý (giữ, bán bớt, cắt lỗ, mua khi giảm, kế hoạch có điều kiện) lên <b>cùng</b> các tương lai đó, rồi so sánh phân phối kết quả. Xác suất là tỷ lệ tương lai mô phỏng, tính từ mô hình ước lượng trên lịch sử thật.</p>' +
        '<h3>Thị trường</h3><ul><li><b>GJR-GARCH(1,1)</b> ước lượng hợp lý cực đại: biến động hôm nay phụ thuộc cú sốc hôm qua, cú giảm làm biến động tăng mạnh hơn cú tăng. Cú sốc được lấy mẫu lại từ phần dư chuẩn hoá thật (không giả định phân phối chuẩn) nên giữ đuôi dày của thị trường Việt Nam.</li>' +
        '<li><b>Chuyển chế độ Markov</b> (2 hoặc 3 trạng thái, chọn theo BIC, ước lượng bằng Baum-Welch): thị trường đổi tính khí giữa êm, bình thường và căng thẳng; lợi suất mỗi ngày mô phỏng lấy từ một ngày lịch sử cùng chế độ.</li>' +
        '<li>Mặc định trộn hai mô hình, mỗi mô hình một nửa số đường. Mức lợi suất dài hạn được neo theo giả định của bạn (mặc định 9%/năm) thay vì trung bình lịch sử 7 năm vốn rất nhiễu.</li></ul>' +
        '<h3>Từng mã</h3><ul><li>Lợi suất = beta × thị trường + phần riêng. Beta ước lượng riêng cho từng chế độ (cổ phiếu thường nhạy hơn khi thị trường căng thẳng), co về beta chung và về 1 khi ít dữ liệu.</li>' +
        '<li>Phần riêng lấy mẫu lại theo NGÀY: mọi mã lấy phần riêng của cùng một ngày lịch sử, nên giữ được tương quan ngành (ngân hàng cùng giảm, chứng khoán cùng tăng) mà không cần ước lượng ma trận lớn.</li>' +
        '<li>Giá đã điều chỉnh cổ tức và chia tách. Mã có ít hơn 60 phiên lịch sử được giữ nguyên giá trị và ghi chú.</li></ul>' +
        '<h3>Luật chơi Việt Nam</h3><ul><li>Biên độ giá theo sàn (HOSE ±7%, HNX ±10%, UPCoM ±15%): phần biến động vượt biên độ dồn sang phiên sau, tạo chuỗi phiên sàn liên tiếp như thật.</li>' +
        '<li>Giá nằm sàn thì không bán được, nằm trần thì không mua được. Cổ phiếu mua phải chờ T+2 mới bán được. Lô 100 cổ phiếu.</li>' +
        '<li>Chi phí: phí và thuế bán, chi phí tác động giá theo căn bậc hai của khối lượng so với thanh khoản, và giới hạn tỷ lệ tham gia mỗi phiên (lệnh lớn được chia nhiều phiên).</li>' +
        '<li>Quyết định theo giá đóng cửa phiên này được khớp ở phiên sau: không chính sách nào được nhìn trước tương lai.</li></ul>' +
        '<h3>Đọc kết quả</h3><ul><li><b>CVaR 95%</b>: lỗ trung bình trong 5% kịch bản xấu nhất. <b>Sụt giảm</b>: mức giảm từ đỉnh trong kỳ.</li>' +
        '<li><b>Tương đương chắc chắn</b>: lợi suất chắc chắn mà bạn thấy ngang giá với phân phối rủi ro đó, theo khẩu vị rủi ro (hàm lợi ích CRRA). Đây là tiêu chí chính để xếp hạng.</li>' +
        '<li><b>Hối tiếc</b>: trên mỗi đường giá, chênh lệch so với cách xử lý tốt nhất trên chính đường đó. Cách ít hối tiếc là cách bền vững qua mọi kịch bản.</li>' +
        '<li><b>Cây kịch bản</b>: nhóm các đường theo cách VN-Index đi ở từng giai đoạn. So sánh cách xử lý trong một nhánh cho biết quyết định nào bền với nhánh đó; muốn quyết định SAU khi biết nhánh, dùng kế hoạch có điều kiện.</li></ul>' +
        '<h3>Bối cảnh (AI)</h3><ul><li>AI (Gemini, qua máy chủ) đọc tiêu đề và mô tả ngắn của khoảng 60 tin mới nhất cùng trạng thái thị trường dạng SỐ, rồi liệt kê sự kiện có thể làm thị trường đổi hướng trong 3 tháng. Mỗi sự kiện phải dẫn tin làm căn cứ; liên kết lấy từ danh sách tin chứ không từ lời AI; nội dung tin được coi là dữ liệu (AI được dặn bỏ qua mọi chỉ dẫn trong tin).</li>' +
        '<li>AI <b>chỉ</b> đưa mức thô (khả năng thấp/vừa/cao, tác động nhỏ/vừa/lớn, hướng, thời điểm, ngành). Bộ máy quy đổi: khả năng thấp 15%, vừa 35%, cao 60%; độ lớn theo phân vị của các nhịp 5 phiên trong lịch sử VN-Index (nhỏ = trung vị, vừa = 85%, lớn = 97%); sự kiện theo ngành tác động thêm 1,5 lần lên cổ phiếu trong ngành và 25% lên thị trường chung. Bạn chỉnh mọi con số trên thẻ.</li>' +
        '<li>Trong mỗi đường mô phỏng, một sự kiện xảy ra với xác suất của nó, vào một phiên ngẫu nhiên trong cửa sổ thời gian, thành một cú sốc cộng vào lợi suất (với GARCH, cú sốc làm biến động các phiên sau tăng theo). Sự kiện "chưa rõ chiều" là 50/50 tăng hoặc giảm. Lịch sự kiện bốc bằng bộ số ngẫu nhiên riêng nên bật/tắt một sự kiện không làm xáo trộn phần lịch sử: so sánh có và không có bối cảnh là công bằng.</li>' +
        '<li>Sự kiện là <b>quan điểm cộng thêm</b> trên mô hình lịch sử (giống quan điểm trong Black-Litterman): lịch sử đã chứa những biến cố thường gặp, nên chỉ bật sự kiện bạn tin là đặc biệt của giai đoạn này. Phần Kiểm chứng chỉ chấm mô hình lịch sử (không chấm được bối cảnh AI trong quá khứ); các lần dùng bối cảnh được chấm dần ở mục Nhật ký khi bạn lưu lần chạy.</li>' +
        '<li><b>Cây theo sự kiện</b>: với 3 sự kiện đầu, cây có thêm một gốc tách các đường có sự kiện xảy ra (trước mốc 3 tháng) và không xảy ra, rồi mới tới 3 giai đoạn của VN-Index.</li></ul>' +
        '<h3>Nhật ký mô phỏng và tự chấm điểm</h3><ul><li>Bấm <b>Lưu</b> ở Mô phỏng hoặc Triển vọng để giữ lại dự báo đúng như lúc đó: 39 phân vị lợi suất VN-Index ở từng mốc (có bối cảnh và chỉ lịch sử), phân vị của danh mục nếu giữ nguyên, xác suất 3 nhánh mỗi giai đoạn và cây kịch bản. Dự báo đã lưu không sửa được.</li>' +
        '<li>Khi đủ 5 / 21 / 63 phiên sau ngày dữ liệu của lần chạy, trang so với VN-Index thật: giá trị thật nằm ở phân vị nào (PIT), có trong khoảng 50% / 90% không, CRPS (xấp xỉ từ phân vị) và điểm Brier của xác suất nhánh so với tần suất lịch sử TRƯỚC ngày chạy. Gộp nhiều lần chạy: độ phủ thật so với danh nghĩa, và trên các lần có bối cảnh, CRPS có bối cảnh so với chỉ lịch sử.</li>' +
        '<li><b>Cây sống</b>: theo các mốc đã qua, trang biết thị trường thật đã đi nhánh nào và đọc từ cây đã lưu xác suất CÓ ĐIỀU KIỆN của các nhánh còn lại (không mô phỏng lại). Đánh dấu một sự kiện đã xảy ra hay không thì cây sống chuyển sang cây theo sự kiện đó.</li>' +
        '<li>Từ một lần chạy đã lưu, ghi quyết định vào <b>Nhật Ký Quyết Định</b> (lý do điền sẵn tóm tắt mô phỏng, nhãn "mô phỏng", liên kết về lần chạy) để sau này đánh giá lại cả quyết định lẫn dự báo.</li></ul>' +
        '<h3>Giới hạn</h3><ul><li>Mô hình học từ 7 năm lịch sử (gồm 2020 và 2022): sự kiện chưa từng có trong lịch sử chỉ được đưa vào qua thẻ bối cảnh, và độ chính xác phụ thuộc vào đánh giá của bạn và của AI.</li>' +
        '<li>Tin xấu riêng của một doanh nghiệp chỉ được mô phỏng ở mức đã từng xảy ra với chính mã đó.</li><li>Lãi vay ký quỹ không được tính; tiền mặt không sinh lãi.</li></ul>' +
        '</div></section>';
}
function fmtDate(iso) { const p = String(iso || '').slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : ''; }
