/* --- FILE: /mastersheet/assets/risk-advanced.js ---
   Phần nâng cao của phân tích rủi ro, dùng chung cho tab Rủi Ro cá nhân (scope 'rk') và Rủi Ro cấp nhóm ở trang Toàn Nhóm (scope 'grp'):
   (1) thanh khoản -- bán hết mất bao nhiêu phiên; (2) kịch bản lịch sử -- chuỗi phiên tệ nhất của VN-Index lặp lại; (3) kịch bản tự đặt -- cú sốc chung/theo ngành/theo mã.
   Phép tính ở /lib/risk-calc.js (liquidity, historicalScenarios, customStress; có kiểm thử). Dùng các hàm định dạng của risk.js (rkEsc, rkNum, rkPct, rkVnd, rkDate).
   Người gọi (risk.js / group.js) đặt RKX[scope] = { rerender, market, holdings } trước khi gọi rkAdvancedHtml; dữ liệu khối lượng tải theo yêu cầu (nút "Tải dữ liệu thanh khoản"). */

const RKX = { rk: null, grp: null };
function rkxState(scope) {
    if (!RKX[scope]) RKX[scope] = { rerender: null, market: null, holdings: [], volumes: null, volumesError: '', volumesLoading: false, rate: 0.2, custom: { index: -10, sectors: {}, symbols: {} }, customRun: false };
    return RKX[scope];
}

// ---------- 1) Thanh khoản ----------
async function rkxLoadVolumes(scope) {
    const st = rkxState(scope);
    st.volumesLoading = true; st.volumesError = '';
    if (st.rerender) st.rerender();
    try {
        const r = await callGAS('getVolumeHistory', { symbols: st.holdings.map(h => h.symbol), days: 120 });
        if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
        st.volumes = r.data || {};
    } catch (e) { st.volumesError = e.message || String(e); }
    st.volumesLoading = false;
    if (st.rerender) st.rerender();
}
function rkxSetRate(scope, v) { const st = rkxState(scope); st.rate = Number(v) / 100; if (st.rerender) st.rerender(); }

function rkxLiquidityHtml(scope, r) {
    const st = rkxState(scope);
    const head = '<div class="ce-group-title">Thanh khoản: bán hết mất bao nhiêu phiên</div>';
    if (st.volumesLoading) return head + '<div class="tl-empty" style="padding:14px"><i class="fa-solid fa-spinner fa-spin"></i> Đang lấy khối lượng giao dịch…</div>';
    if (!st.volumes) {
        return head + `<div class="rk-liq-start"><button type="button" class="btn-tool" onclick="rkxLoadVolumes('${scope}')"><i class="fa-solid fa-droplet"></i> Tải dữ liệu thanh khoản</button>
            <span class="tl-hint" style="margin:0">Lấy khối lượng giao dịch ~6 tháng của các mã đang giữ để ước tính số phiên cần để bán hết.${st.volumesError ? ` <b class="tl-down">Lỗi: ${rkEsc(st.volumesError)}</b>` : ''}</span></div>`;
    }
    const L = RiskCalc.liquidity(st.holdings, st.volumes, { rate: st.rate });
    if (!L.rows.length) return head + '<div class="tl-empty" style="padding:14px">Chưa có đủ dữ liệu khối lượng giao dịch của các mã đang giữ.</div>';
    const cover = (d) => { const c = L.cover.find(x => x.days === d); return c && c.pct !== null ? rkPct(c.pct, 0) : '—'; };
    const lvl = { ok: '<span class="tl-badge ok">Dễ</span>', med: '<span class="tl-badge warn">Vừa</span>', high: '<span class="tl-badge bad">Khó bán</span>', unknown: '' };
    return head + `<div class="rk-liq-tools"><label>Tỷ lệ tham gia tối đa
            <select class="tl-select" onchange="rkxSetRate('${scope}', this.value)">${[10, 20, 30].map(p => `<option value="${p}"${Math.round(st.rate * 100) === p ? ' selected' : ''}>${p}% khối lượng ngày</option>`).join('')}</select></label>
        <span class="tl-hint" style="margin:0">Mức dám chiếm trong khối lượng giao dịch mỗi ngày khi bán; thấp hơn thì ít ảnh hưởng giá nhưng bán lâu hơn.</span></div>
        <div class="tl-kpis">${[
            rkKpi('Bán xong trong 1 phiên', cover(1), 'giá trị cổ phiếu có dữ liệu', ''), rkKpi('Trong 3 phiên', cover(3), '', ''), rkKpi('Trong 5 phiên', cover(5), '', ''),
            rkKpi('Mã khó bán nhất', rkEsc(L.worst.symbol), `${rkNum(L.worst.days, L.worst.days < 1 ? 2 : 1)} phiên`, L.worst.level === 'high' ? 'tl-down' : ''),
        ].join('')}</div>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Mã</th><th class="text-right">Giá trị</th><th class="text-right">Số cổ phiếu</th><th class="text-right">KL bình quân/ngày</th><th class="text-right" title="Số cổ phiếu bạn giữ so với khối lượng giao dịch một ngày">Chiếm KL ngày</th><th class="text-right">Số phiên để bán hết</th><th>Mức</th></tr></thead><tbody>
        ${L.rows.map(x => `<tr><td><b>${rkEsc(x.symbol)}</b></td><td class="text-right">${rkVnd(x.value)}</td><td class="text-right">${rkNum(x.quantity)}</td><td class="text-right">${rkNum(x.adv)}</td><td class="text-right">${rkPct(x.shareOfAdvPct, 0)}</td><td class="text-right ${x.level === 'high' ? 'tl-down' : ''}"><b>${rkNum(x.days, x.days < 1 ? 2 : 1)}</b></td><td>${lvl[x.level]}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="tl-hint">${L.missing.length ? `Chưa có khối lượng của: ${rkEsc(L.missing.join(', '))}. ` : ''}Số phiên = số cổ phiếu ÷ (tỷ lệ tham gia × khối lượng bình quân 20 phiên). Chưa tính tác động giá khi bán lượng lớn, phiên trần/sàn hay giao dịch thoả thuận — thực tế bán thường chậm hơn ước tính, nhất là lúc thị trường hoảng loạn khi khối lượng mua cạn.</p>`;
}

// ---------- 2) Kịch bản lịch sử ----------
function rkxHistoricalHtml(scope, r) {
    const st = rkxState(scope);
    const m = st.market;
    const head = '<div class="ce-group-title">Kịch bản lịch sử: nếu chuỗi phiên tệ nhất lặp lại</div>';
    if (!m || !m.histories) return head + '<div class="tl-empty" style="padding:14px">Chưa có giá lịch sử.</div>';
    const scen = RiskCalc.historicalScenarios({ holdings: st.holdings, nav: r.nav, histories: m.histories, events: m.events }, { windowDays: m.windowDays || 365 });
    if (!scen.length) return head + '<div class="tl-empty" style="padding:14px">Chưa đủ lịch sử VN-Index trong kỳ đang chọn để tìm chuỗi phiên giảm. Chọn kỳ dài hơn (2 năm) ở trên.</div>';
    const lab = { 1: 'Phiên tệ nhất', 5: '5 phiên tệ nhất liên tiếp', 20: '20 phiên tệ nhất liên tiếp', 60: '60 phiên tệ nhất liên tiếp' };
    return head + `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Kịch bản</th><th>Thời gian</th><th class="text-right">VN-Index</th><th class="text-right">Danh mục</th><th class="text-right">Thay đổi NAV</th><th>Mã giảm nhiều nhất</th></tr></thead><tbody>
        ${scen.map(x => `<tr><td>${lab[x.windowDays] || x.windowDays + ' phiên'}</td><td>${rkDate(x.from)} → ${rkDate(x.to)}</td><td class="text-right tl-down">${rkPct(x.benchPct, 1)}</td><td class="text-right tl-down"><b>${rkPct(x.portfolioPct, 1)}</b></td><td class="text-right tl-down">${rkVnd(x.vnd)}</td>
            <td class="rk-stress-detail">${x.bySymbol.slice(0, 3).map(b => `${rkEsc(b.symbol)} ${rkPct(b.pct, 0)}${b.estimated ? '*' : ''}`).join(' · ')}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="tl-hint">Áp dụng đúng lợi suất THẬT của từng mã đang giữ trong khoảng ngày đó (không dùng beta) lên NAV hiện tại. Dấu * = mã chưa có giá lúc đó, tạm coi đi cùng VN-Index. Chỉ phản ánh giai đoạn nằm trong kỳ đã chọn — kỳ càng dài càng có khả năng chứa khủng hoảng thật.</p>`;
}

// ---------- 3) Kịch bản tự đặt ----------
function rkxCustomChanged(scope) {
    const st = rkxState(scope);
    const v = document.getElementById(`rkx-${scope}-index`).value;
    st.custom.index = v === '' ? 0 : Number(v);
    st.customRun = true;
    if (st.rerender) st.rerender();
}
function rkxAddShock(scope, kind) {
    const st = rkxState(scope);
    const sel = document.getElementById(`rkx-${scope}-${kind}-sel`), val = document.getElementById(`rkx-${scope}-${kind}-val`);
    if (!sel.value || val.value === '' || !isFinite(Number(val.value))) { showToast('Chọn đối tượng và nhập mức thay đổi (%)', 'error'); return; }
    st.custom[kind === 'sector' ? 'sectors' : 'symbols'][sel.value] = Number(val.value);
    st.customRun = true;
    if (st.rerender) st.rerender();
}
function rkxRemoveShock(scope, kind, key) {
    const st = rkxState(scope);
    delete st.custom[kind === 'sector' ? 'sectors' : 'symbols'][key];
    if (st.rerender) st.rerender();
}
function rkxPreset(scope, name) {
    const st = rkxState(scope);
    const presets = { down10: { index: -10, sectors: {}, symbols: {} }, down20: { index: -20, sectors: {}, symbols: {} }, clear: { index: 0, sectors: {}, symbols: {} } };
    st.custom = presets[name] ? JSON.parse(JSON.stringify(presets[name])) : st.custom;
    st.customRun = name !== 'clear';
    if (st.rerender) st.rerender();
}

function rkxCustomHtml(scope, r) {
    const st = rkxState(scope);
    const c = st.custom;
    const sectors = (r.sectors || []).map(s => s.sector), symbols = (r.symbols || []).map(s => s.symbol);
    const chips = Object.keys(c.sectors).map(k => `<span class="gr-chip">Ngành ${rkEsc(k)} <b>${rkPct(c.sectors[k], 0, true)}</b> <button type="button" class="tl-link" onclick="rkxRemoveShock('${scope}','sector','${rkEsc(k)}')" aria-label="Bỏ">×</button></span>`)
        .concat(Object.keys(c.symbols).map(k => `<span class="gr-chip">${rkEsc(k)} <b>${rkPct(c.symbols[k], 0, true)}</b> <button type="button" class="tl-link" onclick="rkxRemoveShock('${scope}','symbol','${rkEsc(k)}')" aria-label="Bỏ">×</button></span>`)).join('');
    const S = RiskCalc.customStress(r, c);
    const src = { beta: 'beta × chung', sector: 'theo ngành', symbol: 'theo mã' };
    return `<div class="ce-group-title">Kịch bản tự đặt</div>
        <div class="rk-custom"><div class="rk-custom-row"><label>VN-Index thay đổi (%)<input type="number" step="any" class="tl-input num" id="rkx-${scope}-index" value="${c.index}" onchange="rkxCustomChanged('${scope}')"></label>
            <span class="rk-presets"><button type="button" class="vl-chip" onclick="rkxPreset('${scope}','down10')">−10%</button><button type="button" class="vl-chip" onclick="rkxPreset('${scope}','down20')">−20%</button><button type="button" class="vl-chip" onclick="rkxPreset('${scope}','clear')">Xoá</button></span></div>
          <div class="rk-custom-row"><label>Thêm cú sốc cho ngành<select class="tl-select" id="rkx-${scope}-sector-sel"><option value="">— chọn ngành —</option>${sectors.map(s => `<option>${rkEsc(s)}</option>`).join('')}</select></label>
            <input type="number" step="any" class="tl-input num" id="rkx-${scope}-sector-val" placeholder="% VD −15" style="width:90px"><button type="button" class="btn-tool" onclick="rkxAddShock('${scope}','sector')">Thêm</button>
            <label>cho mã<select class="tl-select" id="rkx-${scope}-symbol-sel"><option value="">— chọn mã —</option>${symbols.map(s => `<option>${rkEsc(s)}</option>`).join('')}</select></label>
            <input type="number" step="any" class="tl-input num" id="rkx-${scope}-symbol-val" placeholder="% VD −25" style="width:90px"><button type="button" class="btn-tool" onclick="rkxAddShock('${scope}','symbol')">Thêm</button></div>
          ${chips ? `<div class="rk-custom-chips">${chips}</div>` : ''}</div>
        <div class="tl-kpis">${[
            rkKpi('Thay đổi NAV', rkPct(S.portfolioPct, 1, true), rkVnd(S.totalVnd), S.totalVnd < 0 ? 'tl-down' : 'tl-up'),
            rkKpi('NAV sau kịch bản', rkVnd(S.navAfter), S.negativeNav ? 'NAV âm: nợ vay lớn hơn tài sản' : `từ ${rkVnd(r.nav)}`, S.negativeNav ? 'tl-down' : ''),
            S.worst ? rkKpi('Khoản mất nhiều nhất', rkEsc(S.worst.symbol), `${rkPct(S.worst.pct, 1, true)} · ${rkVnd(S.worst.vnd)}`, S.worst.vnd < 0 ? 'tl-down' : '') : '',
        ].join('')}</div>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Mã</th><th class="text-right">Giá trị</th><th>Áp dụng</th><th class="text-right">Thay đổi</th><th class="text-right">Giá trị thay đổi</th></tr></thead><tbody>
        ${S.rows.map(x => `<tr><td><b>${rkEsc(x.symbol)}</b> <small>${rkEsc(x.sector)}</small></td><td class="text-right">${rkVnd(x.value)}</td><td>${src[x.source]}${x.source === 'beta' && x.defaultBeta ? ' <small title="Chưa tính được beta, dùng 1">(beta 1)</small>' : ''}</td><td class="text-right ${x.pct < 0 ? 'tl-down' : (x.pct > 0 ? 'tl-up' : '')}">${rkPct(x.pct, 1, true)}</td><td class="text-right ${x.vnd < 0 ? 'tl-down' : ''}">${rkVnd(x.vnd)}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="tl-hint">Cú sốc theo mã ưu tiên hơn theo ngành, theo ngành ưu tiên hơn “beta điều chỉnh × thay đổi VN-Index”. Dùng để thử các giả định như “ngân hàng −15% do nợ xấu” hoặc “mã lớn nhất −25% do tin xấu riêng”.</p>`;
}

// Gộp 3 phần, đặt cuối khối rủi ro. scope: 'rk' | 'grp'.
function rkAdvancedHtml(scope, r) {
    if (!r || !r.ok) return '';
    return rkxHistoricalHtml(scope, r) + rkxLiquidityHtml(scope, r) + rkxCustomHtml(scope, r);
}
