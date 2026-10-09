/* --- FILE: /mastersheet/assets/risk-advanced.js ---
   Phần nâng cao của phân tích rủi ro, dùng chung cho tab Rủi Ro cá nhân (scope 'rk') và Rủi Ro cấp nhóm ở trang Toàn Nhóm (scope 'grp'):
   (1) thanh khoản -- bán hết mất bao nhiêu phiên; (2) kịch bản lịch sử -- chuỗi phiên tệ nhất của VN-Index lặp lại; (3) kịch bản tự đặt -- cú sốc chung/theo ngành/theo mã.
   Phép tính ở /lib/risk-calc.js (liquidity, historicalScenarios, customStress; có kiểm thử). Dùng các hàm định dạng của risk.js (rkEsc, rkNum, rkPct, rkVnd, rkDate).
   Người gọi (risk.js / group.js) đặt RKX[scope] = { rerender, market, holdings } trước khi gọi rkAdvancedHtml; dữ liệu khối lượng tải theo yêu cầu (nút "Tải dữ liệu thanh khoản"). */

const RKX = { rk: null, grp: null };
function rkxState(scope) {
    if (!RKX[scope]) RKX[scope] = { rerender: null, market: null, holdings: [], volumes: null, volumesError: '', volumesLoading: false, rate: 0.2, custom: { index: -10, sectors: {}, symbols: {} }, customRun: false, maintenance: 30 };
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

function rkxCustomCoreHtml(scope, r) {
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

// ---------- 4) Hệ quả của kịch bản + kịch bản ngược (lib/stress-calc.js) ----------
function rkxMaintenance(scope, v) {
    const st = rkxState(scope), n = Number(v);
    st.maintenance = n > 0 && n < 100 ? n : 30;
    if (st.rerender) st.rerender();
}

// Giới hạn đầu tư áp dụng cho phạm vi đang xem (cá nhân: giới hạn chung + riêng của mình; nhóm: giới hạn danh mục gộp). Chưa tải được thì không chấm.
function rkxLimitsFor(scope) {
    try {
        if (scope === 'grp' && typeof GL !== 'undefined' && GL.rows) return LimitsCalc.applicable(GL.rows, null, 'consolidated');
        if (scope === 'rk' && typeof LM !== 'undefined' && LM.rows && LM.me) return LimitsCalc.applicable(LM.rows, LM.me, 'member');
    } catch (e) { /* không chấm giới hạn */ }
    return [];
}

function rkxConsequencesHtml(scope, r) {
    if (typeof StressCalc === 'undefined') return '';
    const st = rkxState(scope), limits = rkxLimitsFor(scope);
    const S = RiskCalc.customStress(r, st.custom);
    const c = StressCalc.consequences(r, S, { LC: LimitsCalc, limits, maintenancePct: st.maintenance });
    const m = c.margin;
    const lim = (i) => `<li><span class="tl-badge ${i.mode === 'warn' ? 'info' : (i.mode === 'block' ? 'bad' : 'warn')}">${rkEsc(LimitsCalc.MODES[i.mode].label)}</span> ${rkEsc(i.subject)}: ${rkEsc(LimitsCalc.KINDS[i.kind].label)} ${rkNum(i.current, 1)} / ${rkNum(i.threshold, 1)}</li>`;
    let html = `<div class="ce-group-title">Hệ quả của kịch bản trên</div><div class="tl-kpis">${[
        rkKpi('Tiền mặt / NAV', `${c.cashPctBefore === null ? '—' : rkPct(c.cashPctBefore, 1)} → ${c.cashPctAfter === null ? '—' : rkPct(c.cashPctAfter, 1)}`, 'tiền không đổi, NAV giảm nên tỷ trọng tiền tăng'),
        m.before.hasDebt ? rkKpi('Đòn bẩy', `${m.before.leverage === null ? '—' : rkNum(m.before.leverage, 2) + '×'} → ${m.after.leverage === null ? '—' : rkNum(m.after.leverage, 2) + '×'}`, 'giá trị cổ phiếu ÷ NAV', m.after.breached ? 'tl-down' : '') : '',
        m.before.hasDebt ? rkKpi('NAV ÷ giá trị cổ phiếu', `${m.before.equityPct === null ? '—' : rkPct(m.before.equityPct, 0)} → ${m.after.equityPct === null ? '—' : rkPct(m.after.equityPct, 0)}`, m.after.breached ? `dưới ngưỡng ký quỹ ${st.maintenance}%: có thể bị gọi ký quỹ` : `ngưỡng giả định ${st.maintenance}%`, m.after.breached ? 'tl-down' : '') : '',
        c.limits ? rkKpi('Giới hạn vi phạm', `${c.limits.before.length} → ${c.limits.after.length}`, c.limits.added.length ? `${c.limits.added.length} vi phạm mới` : 'không thêm vi phạm mới', c.limits.added.length ? 'tl-down' : '') : '',
    ].join('')}</div>`;
    if (m.before.hasDebt) html += `<div class="rk-custom-row"><label>Ngưỡng ký quỹ giả định (% NAV ÷ giá trị cổ phiếu)<input type="number" class="tl-input num" min="1" max="99" step="1" value="${st.maintenance}" onchange="rkxMaintenance('${scope}', this.value)" style="width:90px"></label><span class="tl-hint" style="margin:0">Tuỳ công ty chứng khoán (thường 30–40%); chỉnh theo hợp đồng ký quỹ của bạn.</span></div>`;
    if (c.limits && c.limits.added.length) html += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Sau kịch bản này sẽ vi phạm thêm:</span></div><ul class="lm-list">${c.limits.added.map(lim).join('')}</ul>`;
    else if (c.limits) html += '<p class="tl-hint" style="margin:6px 0 0">Kịch bản này không làm vi phạm thêm giới hạn đầu tư nào.</p>';
    else if (!limits.length) html += '<p class="tl-hint" style="margin:6px 0 0">Chưa có giới hạn đầu tư áp dụng nên không chấm tuân thủ sau kịch bản.</p>';
    return html;
}

function rkxReverseHtml(scope, r) {
    if (typeof StressCalc === 'undefined') return '';
    const st = rkxState(scope);
    const rev = StressCalc.reverse(r, { LC: LimitsCalc, limits: rkxLimitsFor(scope), maintenancePct: st.maintenance });
    if (!rev.length) return '';
    return `<div class="ce-group-title">Kịch bản ngược: VN-Index phải giảm bao nhiêu thì…</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Sự kiện</th><th class="text-right">VN-Index giảm</th><th class="text-right">NAV mất</th><th>Ghi chú</th></tr></thead><tbody>
        ${rev.map(x => `<tr><td><b>${rkEsc(x.label)}</b></td><td class="text-right ${x.indexPct !== null && x.indexPct > -15 ? 'tl-down' : ''}">${x.indexPct === null ? '<span class="tl-badge mute">không xảy ra</span>' : rkPct(x.indexPct, 1, true)}</td><td class="text-right">${x.navLossPct === null || x.navLossPct === undefined ? '—' : rkPct(x.navLossPct, 0)}</td><td>${rkEsc(x.note || '')}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="tl-hint">Tính ngược từ beta điều chỉnh của từng mã (mã chưa có beta coi là 1) với cú sốc thị trường chung, không gồm cú sốc riêng theo ngành/mã ở trên. Beta là ước lượng từ quá khứ: khủng hoảng thật thường khiến các mã giảm cùng chiều mạnh hơn beta gợi ý, nên đọc đây là mức tối thiểu cần chịu được.</p>`;
}

// Bảng theo từng thành viên (chỉ cấp nhóm): cùng kịch bản ảnh hưởng ai nặng nhất, ai chạm giới hạn/ký quỹ
function rkxMembersHtml(scope, r) {
    if (scope !== 'grp' || typeof GR === 'undefined' || !GR.portfolios || typeof StressCalc === 'undefined') return '';
    const st = rkxState(scope);
    const beta = {}; (r.symbols || []).forEach(x => { beta[x.symbol] = x.betaAdj; });
    const rows = GR.portfolios.filter(p => p.nav > 0 && p.holdings.length).map(p => {
        const pr = { symbols: p.holdings.map(h => ({ symbol: h.symbol, sector: FinCalc.sectorOf(h.symbol), value: h.value, betaAdj: beta[h.symbol] })), cash: p.cash, debt: p.debt, nav: p.nav };
        const S = RiskCalc.customStress(pr, st.custom);
        const lim = (typeof GL !== 'undefined' && GL.rows) ? LimitsCalc.applicable(GL.rows, p.id, 'member') : [];
        const c = StressCalc.consequences(pr, S, { LC: LimitsCalc, limits: lim, maintenancePct: st.maintenance });
        return { name: p.name, nav: p.nav, pct: S.portfolioPct, navAfter: S.navAfter, added: c.limits ? c.limits.added.length : null, margin: c.margin.after.breached, hasDebt: c.margin.before.hasDebt, worst: S.worst };
    }).sort((a, b) => a.pct - b.pct);
    if (!rows.length) return '';
    return `<div class="ce-group-title">Cùng kịch bản, từng thành viên chịu ra sao</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Thành viên</th><th class="text-right">NAV</th><th class="text-right">Thay đổi NAV</th><th class="text-right">NAV sau</th><th>Khoản mất nhiều nhất</th><th>Giới hạn mới vi phạm</th><th>Ký quỹ</th></tr></thead><tbody>
        ${rows.map(x => `<tr><td><b>${rkEsc(x.name)}</b></td><td class="text-right">${rkVnd(x.nav)}</td><td class="text-right ${x.pct < 0 ? 'tl-down' : ''}">${rkPct(x.pct, 1, true)}</td><td class="text-right">${rkVnd(x.navAfter)}</td>
            <td>${x.worst ? rkEsc(x.worst.symbol) + ' <small>' + rkPct(x.worst.pct, 0, true) + '</small>' : '—'}</td><td>${x.added === null ? '—' : (x.added ? `<span class="tl-badge bad">${x.added}</span>` : '<span class="tl-badge ok">không</span>')}</td>
            <td>${x.hasDebt ? (x.margin ? '<span class="tl-badge bad">chạm ngưỡng</span>' : '<span class="tl-badge ok">an toàn</span>') : '—'}</td></tr>`).join('')}
        </tbody></table></div><p class="tl-hint">Dùng chung beta của danh mục chung; giới hạn là giới hạn áp dụng cho từng người. Không phải bảng xếp hạng: danh mục nhiều tiền mặt hay ít cổ phiếu tất nhiên mất ít hơn.</p>`;
}

function rkxCustomHtml(scope, r) {
    return rkxCustomCoreHtml(scope, r) + rkxConsequencesHtml(scope, r) + rkxMembersHtml(scope, r) + rkxReverseHtml(scope, r);
}

// ---------- 5) Mô hình rủi ro nâng cao (lib/risk-models.js, đã đối chiếu numpy/scipy) ----------
function rkxModelsHtml(scope, r) {
    if (typeof RiskModels === 'undefined' || !r.model) return '';
    if (!r._models) { try { r._models = RiskModels.summary(r.model, { level: 0.95 }); } catch (e) { r._models = { ok: false, reason: 'error', error: String(e && e.message || e) }; } }
    const m = r._models;
    const head = '<div class="ce-group-title">Mô hình rủi ro nâng cao</div>';
    if (!m.ok) return head + `<p class="tl-hint">Chưa đủ lịch sử giá để chạy (cần tối thiểu 60 phiên có giá).</p>`;
    const kpi = [];
    kpi.push(rkKpi('Biến động hiện tại (EWMA)', rkPct(m.vol.ewmaAnn, 1), `so với mẫu cả năm ${rkPct(m.vol.sampleAnn, 1)}`, m.vol.ratio > 1.25 ? 'tl-down' : (m.vol.ratio < 0.8 ? 'tl-up' : '')));
    kpi.push(rkKpi('VaR 95%/ngày: lịch sử', rkPct(m.hist.varPct, 2), m.hist.cvarPct === null ? '' : `CVaR ${rkPct(m.hist.cvarPct, 2)}`));
    kpi.push(rkKpi('VaR 95%/ngày: có lọc biến động', m.fhs ? rkPct(m.fhs.varPct, 2) : '—', m.fhs && m.fhs.cvarPct !== null ? `CVaR ${rkPct(m.fhs.cvarPct, 2)} · theo biến động hiện tại` : ''));
    kpi.push(rkKpi('VaR 95%/ngày: giả định chuẩn', rkPct(m.param.varPct, 2), 'thường thấp hơn nếu đuôi dày'));
    let html = head + `<div class="tl-kpis">${kpi.join('')}</div>`;
    const notes = [];
    if (m.vol.ratio !== null) notes.push(m.vol.ratio > 1.25 ? `Biến động HIỆN TẠI cao hơn mức trung bình cả năm ${rkNum((m.vol.ratio - 1) * 100, 0)}% (EWMA phản ứng nhanh với những phiên gần đây): VaR lịch sử một năm có thể đang đánh giá thấp rủi ro lúc này.` : (m.vol.ratio < 0.8 ? `Biến động hiện tại thấp hơn trung bình năm ${rkNum((1 - m.vol.ratio) * 100, 0)}%: thị trường đang yên, nhưng VaR chỉ phản ánh điều đó chứ không bảo đảm yên tiếp.` : 'Biến động hiện tại gần mức trung bình cả năm.'));
    if (m.fhs && m.hist.varPct !== null && m.fhs.varPct > m.hist.varPct * 1.2) notes.push('VaR có lọc biến động cao hơn VaR lịch sử trên 20%: nên lấy mức cao hơn làm ước lượng thận trọng.');
    if (notes.length) html += `<div class="rk-warns">${notes.map(t => `<div class="rk-warn low"><i class="fa-solid fa-circle-info"></i><span>${rkEsc(t)}</span></div>`).join('')}</div>`;

    // Kiểm định ngược
    const b = m.backtest;
    if (b && b.ok) {
        const V = { ok: ['ok', 'Mô hình VaR phù hợp: số lần vượt và cách phân bố đều trong mức chấp nhận.'], underestimates: ['bad', 'VaR lịch sử ĐÁNH GIÁ THẤP rủi ro: số lần lỗ vượt VaR nhiều hơn kỳ vọng có ý nghĩa thống kê.'], overestimates: ['warn', 'VaR lịch sử đánh giá CAO rủi ro: ít lần vượt hơn kỳ vọng có ý nghĩa thống kê (thận trọng quá mức).'], clustered: ['warn', 'Số lần vượt đúng kỳ vọng nhưng DỒN CỤC theo thời gian: VaR chậm thích ứng khi thị trường đổi chế độ.'] }[b.verdict];
        html += `<div class="ce-group-title">Kiểm định ngược VaR <small style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-muted)">(cửa sổ ${b.window} phiên, ${b.n} phiên kiểm${b.n < 250 ? ' — ít phiên kiểm nên kết luận yếu hơn' : ''})</small></div>
            <div class="tl-kpis">${[rkKpi('Số lần lỗ vượt VaR', `${b.exceptions} / ${rkNum(b.expected, 1)} kỳ vọng`, rkPct(b.rate * 100, 1) + ' số phiên'), rkKpi('Kupiec (đúng tỷ lệ?)', 'p = ' + rkNum(b.kupiec.p, 3), b.kupiec.p < 0.05 ? 'bị bác bỏ ở mức 5%' : 'chấp nhận', b.kupiec.p < 0.05 ? 'tl-down' : 'tl-up'), rkKpi('Christoffersen (có dồn cục?)', 'p = ' + rkNum(b.independence.p, 3), b.independence.p < 0.05 ? 'có dồn cục' : 'độc lập', b.independence.p < 0.05 ? 'tl-down' : 'tl-up')].join('')}</div>
            <div class="conc-warn"><i class="fa-solid fa-${V[0] === 'ok' ? 'circle-check' : 'triangle-exclamation'}"></i><span>${rkEsc(V[1])}</span></div>
            <p class="tl-hint">Kiểm định cho biết mô hình VaR có đáng tin hay không bằng chính lịch sử của danh mục hiện tại (giả định tỷ trọng không đổi). Kupiec kiểm số lần vượt có đúng ${rkPct((1 - b.level) * 100, 0)} không; Christoffersen kiểm các lần vượt có xảy ra liên tiếp không. p dưới 0,05 nghĩa là không nên tin con số VaR.</p>`;
    } else if (b && b.reason === 'short') html += `<p class="tl-hint">Kiểm định ngược VaR cần ít nhất ${b.need} phiên (đang có ${b.have}); chưa chạy được.</p>`;

    // Beta Dimson
    if (m.beta && m.beta.length) {
        const byS = {}; (r.symbols || []).forEach(x => { byS[x.symbol] = x; });
        const rows = m.beta.filter(x => x.dimson !== null).sort((a, c) => ((byS[c.symbol] || {}).value || 0) - ((byS[a.symbol] || {}).value || 0));
        html += `<div class="ce-group-title">Beta từng mã: hồi quy thường và Dimson</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Mã</th><th class="text-right">Beta hồi quy</th><th class="text-right">Beta Dimson</th><th class="text-right">Chênh</th><th class="text-right">Số phiên</th></tr></thead><tbody>
            ${rows.map(x => { const d = x.dimson - x.simple; return `<tr><td><b>${rkEsc(x.symbol)}</b></td><td class="text-right">${rkNum(x.simple, 2)}</td><td class="text-right">${rkNum(x.dimson, 2)}</td><td class="text-right ${Math.abs(d) >= 0.2 ? 'tl-down' : ''}">${d > 0 ? '+' : ''}${rkNum(d, 2)}</td><td class="text-right">${x.obs}</td></tr>`; }).join('')}
            </tbody></table></div><p class="tl-hint">Dimson thêm lợi suất chỉ số hôm qua và ngày mai vào hồi quy: mã kém thanh khoản phản ứng chậm một phiên so với chỉ số nên beta hồi quy thường bị thấp. Chênh từ 0,2 trở lên (đỏ) nghĩa là rủi ro thị trường của mã này đang bị đánh giá thấp nếu chỉ nhìn beta thường.</p>`;
    }

    // Co hiệp phương sai + tương quan căng thẳng
    if (m.shrink) {
        const sh = m.shrink, top = sh.symbols.map((s, i) => ({ s, a: sh.sampleShare[i], b: sh.shrunkShare[i] })).sort((x, y) => y.b - x.b).slice(0, 6);
        html += `<div class="ce-group-title">Đóng góp rủi ro với hiệp phương sai co (Ledoit-Wolf) và khi tương quan tăng vọt</div><div class="tl-kpis">${[
            rkKpi('Cường độ co', rkPct(sh.delta * 100, 1), 'càng cao càng nhiều nhiễu ước lượng'),
            rkKpi('Biến động danh mục', rkPct(sh.shrunkAnn, 1), `mẫu thường ${rkPct(sh.sampleAnn, 1)}`),
            m.stressCorr ? rkKpi('Khi tương quan tăng vọt', rkPct(m.stressCorr.annPct, 1), `×${rkNum(m.stressCorr.multiplier, 2)} (tương quan co ${rkNum(m.stressCorr.k * 100, 0)}% về 1)`, 'tl-down') : '',
        ].join('')}</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Mã</th><th class="text-right">Đóng góp rủi ro (mẫu)</th><th class="text-right">Đóng góp rủi ro (co)</th></tr></thead><tbody>
            ${top.map(x => `<tr><td><b>${rkEsc(x.s)}</b></td><td class="text-right">${rkPct(x.a, 1)}</td><td class="text-right">${rkPct(x.b, 1)}</td></tr>`).join('')}</tbody></table></div>
            <p class="tl-hint">Hiệp phương sai ước lượng từ ít phiên so với số mã thì nhiễu; co về ma trận đường chéo giúp đóng góp rủi ro ổn định hơn. Mức "tương quan tăng vọt" cho biết biến động danh mục lớn thế nào khi mọi mã cùng giảm (đa dạng hoá biến mất đúng lúc cần nhất).</p>`;
    }

    // Kẹt sàn
    if (typeof VnMarket !== 'undefined' && r.symbols && r.symbols.length) {
        const rows = r.symbols.filter(x => x.value > 0).map(x => { const l = typeof FinCalc !== 'undefined' && FinCalc.listingOf ? FinCalc.listingOf(x.symbol) : { exchange: 'HOSE' }; return { symbol: x.symbol, value: x.value, exchange: l.exchange }; });
        const total = (n) => rows.reduce((s, x) => s + x.value * VnMarket.lockedLossPct(x.exchange, n) / 100, 0);
        html += `<div class="ce-group-title">Kịch bản kẹt sàn</div><div class="tl-kpis">${[1, 2, 3, 5].map(n => rkKpi(`Kẹt sàn ${n} phiên`, rkVnd(total(n)), r.nav > 0 ? '−' + rkPct(total(n) / r.nav * 100, 1) + ' NAV' : '', 'tl-down')).join('')}</div>
            <p class="tl-hint">Khi một cổ phiếu giảm sàn liên tiếp, lệnh bán không khớp được: không thể cắt lỗ trong lúc giá giảm theo biên độ (HOSE −7%, HNX −10%, UPCoM −15% mỗi phiên; sàn lấy theo thông tin niêm yết, chưa rõ thì tính HOSE). Bảng cho thiệt hại nếu TOÀN BỘ cổ phiếu cùng kẹt sàn — tình huống cực đoan của một ngày hoảng loạn; VaR thông thường không bắt được rủi ro này.</p>`;
    }
    return html;
}

// ---------- 6) Tối ưu hoá tỷ trọng (lib/portfolio-optimizer.js, đã đối chiếu scipy) -- chỉ danh mục cá nhân ----------
// Cận đặt theo % NAV như giới hạn đầu tư; bộ tối ưu làm trên phần cổ phiếu nên đổi: cận phần cổ phiếu = cận NAV × NAV / tổng giá trị cổ phiếu.
const RKO_METHODS = { minvar: 'Phương sai nhỏ nhất', riskparity: 'Cân bằng rủi ro', maxsharpe: 'Sharpe tối đa (cần định giá)' };
function rkoState(scope) {
    const st = rkxState(scope);
    if (!st.opt) st.opt = { method: 'minvar', maxNav: null, minNav: 0, horizon: 2, mkt: 9, rf: 3, vb: null, vbLoading: false, vbError: '', key: '', res: null };
    return st.opt;
}
function rkoSet(scope, field, v) {
    const o = rkoState(scope);
    if (field === 'method') o.method = RKO_METHODS[v] ? v : 'minvar';
    else { const n = Number(v); o[field] = v === '' || !isFinite(n) ? (field === 'maxNav' ? null : o[field]) : n; }
    if (o.method === 'maxsharpe' && !o.vb && !o.vbLoading) { rkoLoadVb(scope); return; }
    const st = rkxState(scope); if (st.rerender) st.rerender();
}
async function rkoLoadVb(scope) {
    const st = rkxState(scope), o = rkoState(scope);
    o.vbLoading = true; o.vbError = ''; if (st.rerender) st.rerender();
    try {
        const r = await callGAS('getVbLatestMany', { symbols: st.holdings.map(h => h.symbol) });
        if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
        o.vb = r.data || {};
    } catch (e) { o.vbError = e.message || String(e); }
    o.vbLoading = false; if (st.rerender) st.rerender();
}
function rkoLimitNav(scope) {
    const caps = rkxLimitsFor(scope).filter(l => l.kind === 'max_symbol_pct' && !l.symbol && l.value > 0).map(l => Number(l.value));
    return caps.length ? Math.min(...caps) : null;
}
function rkxOptimizerHtml(scope, r) {
    if (scope !== 'rk' || typeof PortfolioOptimizer === 'undefined' || !r.model || !r.model.rets) return '';
    const st = rkxState(scope), o = rkoState(scope), head = '<div class="ce-group-title">Tối ưu hoá tỷ trọng (gợi ý)</div>';
    const held = (st.holdings || []).filter(h => h.value > 0), equity = held.reduce((s, h) => s + h.value, 0), nav = r.nav > 0 ? r.nav : equity;
    const syms = held.map(h => h.symbol).filter(s => r.model.rets[s]), skipped = held.map(h => h.symbol).filter(s => !r.model.rets[s]);
    if (syms.length < 2 || !(equity > 0)) return head + '<p class="tl-hint">Cần ít nhất 2 mã đang nắm có đủ lịch sử giá để tối ưu hoá.</p>';
    const limitNav = rkoLimitNav(scope), maxNav = o.maxNav !== null ? o.maxNav : (limitNav !== null ? limitNav : 35);
    const sleeveOf = (pctNav) => pctNav / 100 * nav / equity;
    const values = {}; held.forEach(h => { values[h.symbol] = h.value; });
    let mu = null, muNote = '';
    if (o.method === 'maxsharpe' && o.vb) {
        mu = {}; const miss = [];
        syms.forEach(s => { const h = held.find(x => x.symbol === s), v = o.vb[s], price = h && h.quantity > 0 ? h.value / h.quantity : null;
            const e = v ? PortfolioOptimizer.expectedFromFair(price, v.fair_base, o.horizon, o.mkt / 100, 0.5) : null;
            mu[s] = e !== null ? e : o.mkt / 100; if (e === null) miss.push(s); });
        muNote = miss.length ? `Chưa có định giá đã lưu ở Valuation Bench: ${miss.join(', ')} (dùng mức chung ${rkNum(o.mkt, 1)}%/năm).` : '';
    }
    const key = JSON.stringify([o.method, maxNav, o.minNav, o.horizon, o.mkt, o.rf, syms, held.map(h => Math.round(h.value)), !!o.vb, r.coverage && r.coverage.to]);
    if (o.key !== key && !(o.method === 'maxsharpe' && !o.vb)) {
        o.res = PortfolioOptimizer.optimize({ symbols: syms, rets: r.model.rets, values, method: o.method, maxPct: sleeveOf(maxNav), minPct: sleeveOf(o.minNav || 0), mu, rf: o.rf / 100 });
        o.key = key;
    }
    const controls = `<div class="rk-liq-tools rko-tools">
        <label>Cách tối ưu <select class="tl-select" onchange="rkoSet('${scope}','method',this.value)">${Object.keys(RKO_METHODS).map(k => `<option value="${k}"${o.method === k ? ' selected' : ''}>${RKO_METHODS[k]}</option>`).join('')}</select></label>
        <label title="Mặc định lấy theo giới hạn 'Một mã tối đa' của bạn (nếu có), không thì 35% NAV">Mỗi mã tối đa (% NAV) <input class="tl-input num" type="number" min="1" max="100" step="1" value="${maxNav}" onchange="rkoSet('${scope}','maxNav',this.value)"></label>
        <label title="Đặt lớn hơn 0 nếu không muốn bán hẳn mã nào">Mỗi mã tối thiểu (% NAV) <input class="tl-input num" type="number" min="0" max="50" step="1" value="${o.minNav || 0}" onchange="rkoSet('${scope}','minNav',this.value)"></label>
        ${o.method === 'maxsharpe' ? `<label title="Khoảng cách giá tới giá trị hợp lý được giả định thu hẹp dần trong chừng này năm">Đóng khoảng cách trong (năm) <input class="tl-input num" type="number" min="0.5" max="10" step="0.5" value="${o.horizon}" onchange="rkoSet('${scope}','horizon',this.value)"></label>
        <label title="Lợi nhuận kỳ vọng chung của thị trường; lợi nhuận kỳ vọng từng mã được co một nửa về mức này">Mức chung (%/năm) <input class="tl-input num" type="number" min="0" max="30" step="0.5" value="${o.mkt}" onchange="rkoSet('${scope}','mkt',this.value)"></label>
        <label>Lãi phi rủi ro (%/năm) <input class="tl-input num" type="number" min="0" max="15" step="0.1" value="${o.rf}" onchange="rkoSet('${scope}','rf',this.value)"></label>` : ''}
    </div>`;
    if (o.method === 'maxsharpe' && !o.vb) return head + controls + (o.vbLoading ? '<div class="tl-empty" style="padding:14px"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải giá trị hợp lý đã lưu…</div>' : `<p class="tl-hint">${o.vbError ? `<b class="tl-down">Không tải được định giá: ${rkEsc(o.vbError)}</b> ` : ''}<button type="button" class="btn-tool" onclick="rkoLoadVb('${scope}')">Tải giá trị hợp lý đã lưu</button></p>`);
    const res = o.res;
    if (!res || !res.ok) {
        const why = { infeasible: `Cận tỷ trọng không khả thi với ${syms.length} mã: tối đa ${rkNum(maxNav, 0)}% NAV mỗi mã chưa đủ để chứa toàn bộ phần cổ phiếu (${rkPct(equity / nav * 100, 0)} NAV), hoặc tối thiểu quá cao. Hãy nới cận.`, short: 'Chưa đủ 60 phiên lịch sử giá chung của các mã.', 'mu-below-rf': 'Không mã nào có lợi nhuận kỳ vọng vượt lãi phi rủi ro: Sharpe tối đa không có nghĩa. Dùng phương sai nhỏ nhất.', 'no-mu': 'Thiếu lợi nhuận kỳ vọng.' }[res && res.reason] || 'Không tối ưu được với dữ liệu hiện có.';
        return head + controls + `<p class="tl-hint"><b class="tl-down">${rkEsc(why)}</b></p>`;
    }
    const od = PortfolioOptimizer.orders(res, held), toNav = (w) => w * equity / nav * 100;
    const buy = od.filter(x => x.delta > 0).reduce((s, x) => s + x.delta, 0), sell = od.filter(x => x.delta < 0).reduce((s, x) => s - x.delta, 0);
    const fee = (buy + sell) * 0.0015 + sell * 0.001;
    const kpis = [
        rkKpi('Biến động năm', rkPct(res.next.vol * 100, 1), `hiện tại ${rkPct(res.now.vol * 100, 1)}`, res.next.vol < res.now.vol ? 'tl-up' : ''),
        res.mu ? rkKpi('Lợi nhuận kỳ vọng năm', rkPct(res.next.ret * 100, 1), `hiện tại ${rkPct(res.now.ret * 100, 1)}`) : '',
        res.mu ? rkKpi('Tỷ lệ Sharpe', rkNum(res.next.sharpe, 2), `hiện tại ${rkNum(res.now.sharpe, 2)}`, res.next.sharpe > res.now.sharpe ? 'tl-up' : '') : '',
        rkKpi('Phải đổi', rkPct(res.turnover * 100, 0), `phần cổ phiếu · mua ${rkVnd(buy)}, bán ${rkVnd(sell)}`),
        rkKpi('Phí và thuế ước tính', rkVnd(fee), '0,15% giá trị giao dịch + 0,1% thuế bán'),
    ].join('');
    const rows = res.symbols.map((s, i) => { const x = od[i]; return `<tr><td><b>${rkEsc(s)}</b></td><td class="text-right">${rkPct(toNav(res.current[i]), 1)}</td><td class="text-right"><b>${rkPct(toNav(res.weights[i]), 1)}</b></td>
        <td class="text-right ${res.weights[i] > res.current[i] + 0.005 ? 'tl-up' : (res.weights[i] < res.current[i] - 0.005 ? 'tl-down' : '')}">${rkPct(toNav(res.weights[i] - res.current[i]), 1, true)}</td>
        <td class="text-right">${Math.abs(x.delta) < 1 ? '—' : rkVnd(x.delta)}</td><td class="text-right">${x.shares ? `${x.side === 'buy' ? 'Mua' : 'Bán'} ${rkNum(Math.abs(x.shares))}` : '—'}</td>
        <td class="text-right">${rkPct(res.now.riskShare[i] * 100, 0)} → ${rkPct(res.next.riskShare[i] * 100, 0)}</td>${res.mu ? `<td class="text-right">${rkPct(res.mu[i] * 100, 1)}</td>` : ''}</tr>`; }).join('');
    const notes = [];
    if (res.capped) notes.push('Cận tỷ trọng chặn lời giải cân bằng rủi ro: đóng góp rủi ro không còn bằng nhau tuyệt đối.');
    if (skipped.length) notes.push(`Không đưa vào tối ưu (thiếu lịch sử giá): ${skipped.join(', ')} — giữ nguyên.`);
    if (muNote) notes.push(muNote);
    return head + controls + `<div class="tl-kpis">${kpis}</div>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Mã</th><th class="text-right">Hiện tại (% NAV)</th><th class="text-right">Đề xuất (% NAV)</th><th class="text-right">Chênh</th><th class="text-right">Giá trị mua/bán</th><th class="text-right">Khối lượng (lô 100)</th><th class="text-right">Đóng góp rủi ro</th>${res.mu ? '<th class="text-right" title="Lợi nhuận kỳ vọng năm dùng để tính">Kỳ vọng/năm</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
        ${notes.length ? `<div class="rk-warns">${notes.map(t => `<div class="rk-warn low"><i class="fa-solid fa-circle-info"></i><span>${rkEsc(t)}</span></div>`).join('')}</div>` : ''}
        <p class="tl-hint">${o.method === 'minvar' ? 'Phương sai nhỏ nhất: tỷ trọng ít biến động nhất trong các cận, không cần dự báo lợi nhuận.' : (o.method === 'riskparity' ? 'Cân bằng rủi ro: mỗi mã đóng góp rủi ro như nhau, tránh vài mã biến động mạnh chiếm phần lớn rủi ro.' : 'Sharpe tối đa: lợi nhuận kỳ vọng mỗi mã = khoảng cách tới giá trị hợp lý đã lưu, thu hẹp dần trong số năm đã chọn, co một nửa về mức chung và chặn trong khoảng −30% đến +40%; rất nhạy với định giá, nên đặt cận chặt.')}
        Hiệp phương sai co Ledoit-Wolf từ ${res.obs} phiên lịch sử (cường độ co ${rkPct(res.shrink * 100, 0)}), chỉ phân bổ lại giữa các mã đang nắm, giữ nguyên tổng giá trị cổ phiếu và tiền mặt. Đây là gợi ý định lượng dựa trên quá khứ, chưa xét thanh khoản, thuế, giới hạn ngành hay luận điểm đầu tư: kiểm tra lại trước khi đặt lệnh (công cụ "Kiểm tra trước lệnh" ở Sổ Lệnh).</p>`;
}

// Gộp các phần, đặt cuối khối rủi ro. scope: 'rk' | 'grp'.
function rkAdvancedHtml(scope, r) {
    if (!r || !r.ok) return '';
    return rkxHistoricalHtml(scope, r) + rkxModelsHtml(scope, r) + rkxOptimizerHtml(scope, r) + rkxLiquidityHtml(scope, r) + rkxCustomHtml(scope, r);
}
