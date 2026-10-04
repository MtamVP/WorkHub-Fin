/* --- FILE: /mastersheet/group-strategy.js ---
   Trang Toàn Nhóm > "Chiến Lược": (1) quản lý đặt DANH MỤC CHUẨN CHIẾN LƯỢC của nhóm (tỷ trọng mục tiêu theo ngành, phần còn lại là tiền mặt);
   (2) phân tích Brinson-Fachler của cả nhóm và từng thành viên so với chuẩn đó: hơn/kém bao nhiêu điểm, bao nhiêu nhờ phân bổ ngành đúng,
   bao nhiêu nhờ chọn mã trong ngành giỏi hơn chỉ số ngành. Phép tính ở /lib/brinson-calc.js và /lib/attribution-calc.js (có kiểm thử).
   Dùng global của group.js (GR, grRender, grCall), group-limits.js (GL), assets/brinson.js (BS, bsResultHtml, bsDrawChart...), assets/risk.js (rk*). */

const GS = { range: 'ytd', state: 'idle', error: '', group: null, members: [], draft: null, saving: false, histError: '', loadedKey: '' };

const gsEsc = (s) => rkEsc(s);
const gsToday = () => new Date().toISOString().slice(0, 10);
const GS_RANGES = [['mtd', 'Tháng này'], ['qtd', 'Quý này'], ['ytd', 'Từ đầu năm'], ['1y', '12 tháng']];

function gsManager() { return !!(typeof GL !== 'undefined' && GL.actor && GL.actor.isManager); }

// Tỷ trọng ngành hiện tại của cả nhóm (% giá trị cổ phiếu × tỷ lệ cổ phiếu trong NAV) -- dùng để điền nhanh chuẩn
function gsCurrentSectorWeights() {
    const g = GR.group, out = {};
    if (!g || !(g.nav > 0)) return out;
    g.symbols.forEach(s => { out[s.sector] = (out[s.sector] || 0) + s.value / g.nav * 100; });
    Object.keys(out).forEach(k => { out[k] = Math.round(out[k] * 10) / 10; });
    return out;
}

async function gsLoad(force) {
    if (GS.state === 'loading') return;
    const key = GS.range + '|' + (GR.data ? GR.data.fetchedAt : '');
    if (GS.state === 'ok' && !force && GS.loadedKey === key) { grRender(); return; }
    GS.state = 'loading'; GS.error = ''; GS.histError = '';
    grRender();
    try {
        await bsLoadPolicy(true);
        GS.draft = null;
        const txns = GR.data.txns.filter(t => !t.deleted_at);
        const first = txns.reduce((m, t) => (!m || String(t.trade_date) < m ? String(t.trade_date).slice(0, 10) : m), null);
        if (!first) { GS.group = null; GS.members = []; GS.state = 'ok'; GS.loadedKey = key; grRender(); return; }
        const period = AttributionCalc.periodFor(GS.range, gsToday(), first);
        const hFrom = new Date(new Date(period.from + 'T00:00:00Z').getTime() - 12 * 86400000).toISOString().slice(0, 10);
        const symbols = [...new Set(txns.map(t => t.symbol).filter(Boolean))];
        const [hist] = await Promise.all([grCall('getPriceHistories', { symbols, from: hFrom }), bsLoadIndices(period.from)]);
        GS.histError = hist.error || '';
        const navAll = GroupCalc.groupNavHistory(GR.data.navHistory);
        const base = { actions: GR.data.actions, histories: hist.histories, from: period.from, to: period.to };
        const gAtt = AttributionCalc.analyze(Object.assign({ txns, cashFlows: GR.data.cashFlows, navHistory: navAll }, base));
        GS.group = { att: gAtt, res: bsAnalyze(gAtt) };
        GS.members = GR.portfolios.map(p => {
            const mt = txns.filter(t => t.user_id === p.id);
            const att = AttributionCalc.analyze(Object.assign({ txns: mt, cashFlows: GR.data.cashFlows.filter(f => f.user_id === p.id), navHistory: GR.data.navHistory.filter(r => r.user_id === p.id) }, base,
                { actions: GR.data.actions.filter(a => a.user_id === p.id) }));
            return { id: p.id, name: p.name, att, res: bsAnalyze(att) };
        });
        GS.period = period;
        GS.linked = gsLinkMonthly({ txns, navAll, base, period });
        GS.state = 'ok'; GS.loadedKey = key;
    } catch (e) { GS.state = 'error'; GS.error = e.message || String(e); }
    grRender();
}

// Chia kỳ thành các tháng lịch liên tiếp (mốc chốt = cuối tháng), phân tích Brinson từng tháng rồi NỐI theo Carino: tổng điểm % từng tháng không cộng dồn được vì lợi suất nối lãi kép.
function gsMonthRanges(from, to) {
    const out = []; let cur = from;
    for (let i = 0; i < 40 && cur < to; i++) {
        const d = new Date(Date.parse(cur + 'T00:00:00Z') + 86400000);          // tháng của ngày ĐẦU kỳ (cur là mốc chốt ngày trước đó)
        const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
        const next = end >= to ? to : end;
        if (next > cur) out.push({ from: cur, to: next });
        cur = next;
    }
    return out;
}
function gsLinkMonthly(ctx) {
    try {
        const ranges = gsMonthRanges(ctx.period.from, ctx.period.to);
        if (ranges.length < 2) return null;
        const results = ranges.map(r => {
            try { return bsAnalyze(AttributionCalc.analyze(Object.assign({ txns: ctx.txns, cashFlows: GR.data.cashFlows, navHistory: ctx.navAll }, ctx.base, { from: r.from, to: r.to }))); }
            catch (e) { return { ok: false }; }
        });
        const L = BrinsonCalc.link(results);
        return L.ok && L.periods >= 2 ? L : null;
    } catch (e) { return null; }
}
function gsLinkedHtml() {
    const L = GS.linked;
    if (!L) return '';
    const sg = (v, d) => (v > 0 ? '+' : '') + rkNum(v, d === undefined ? 2 : d);
    const cls = (v) => v > 0.005 ? 'tl-up' : (v < -0.005 ? 'tl-down' : '');
    return `<div class="ce-group-title">Nối ${L.periods} tháng liên tiếp <small style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-muted)">(phương pháp Carino)</small></div>
        <div class="tl-kpis">${[rkKpi('Danh mục (lãi kép)', rkPct(L.portfolioPct, 2, true), `${L.periods} tháng`), rkKpi('Chuẩn (lãi kép)', rkPct(L.benchmarkPct, 2, true), ''), rkKpi('Hơn / kém chuẩn', rkPct(L.activePct, 2, true), 'điểm % cả kỳ', cls(L.activePct)),
            rkKpi('Phân bổ ngành', sg(L.allocation), 'điểm %', cls(L.allocation)), rkKpi('Chọn mã', sg(L.selection), 'điểm %', cls(L.selection)), rkKpi('Tương tác', sg(L.interaction), 'điểm %', cls(L.interaction))].join('')}</div>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Ngành</th><th class="text-right">Phân bổ</th><th class="text-right">Chọn mã</th><th class="text-right">Tương tác</th><th class="text-right">Tổng</th></tr></thead><tbody>
        ${L.rows.map(r => `<tr><td><b>${gsEsc(r.sector)}</b></td><td class="text-right ${cls(r.allocation)}">${sg(r.allocation)}</td><td class="text-right ${cls(r.selection)}">${sg(r.selection)}</td><td class="text-right ${cls(r.interaction)}">${sg(r.interaction)}</td><td class="text-right ${cls(r.total)}"><b>${sg(r.total)}</b></td></tr>`).join('')}
        </tbody></table></div>
        <details class="tl-details"><summary>Từng tháng</summary><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Tháng</th><th class="text-right">Danh mục</th><th class="text-right">Chuẩn</th><th class="text-right">Hơn / kém</th></tr></thead><tbody>
        ${L.months.map(m => `<tr><td>${glDate(m.from + 'T00:00:00')} → ${glDate(m.to + 'T00:00:00')}</td><td class="text-right ${cls(m.portfolioPct)}">${rkPct(m.portfolioPct, 2, true)}</td><td class="text-right">${rkPct(m.benchmarkPct, 2, true)}</td><td class="text-right ${cls(m.activePct)}">${sg(m.activePct)}</td></tr>`).join('')}
        </tbody></table></div></details>
        <p class="tl-hint">Brinson từng tháng không cộng dồn được vì lợi suất nối theo lãi kép (tổng điểm % từng tháng khác chênh lệch cả kỳ). Carino nhân hiệu ứng mỗi tháng với một hệ số để tổng các hiệu ứng đã nối bằng đúng chênh lệch lãi kép cả kỳ. Dùng tỷ trọng chuẩn hiện tại cho mọi tháng.</p>`;
}

function gsChangeRange(v) { GS.range = v; gsLoad(true); }

// ---------- chuẩn chiến lược ----------
function gsDraft() {
    if (!GS.draft) GS.draft = Object.assign({}, BS.policy.weights || {});
    return GS.draft;
}
function gsSetWeight(sector, v) {
    const d = gsDraft(); const n = Number(String(v).replace(',', '.'));
    if (v === '' || !(n > 0)) delete d[sector]; else d[sector] = n;
    gsUpdateSum();
}
function gsUpdateSum() {
    const el = document.getElementById('gs-sum');
    if (!el) return;
    const sum = Object.values(gsDraft()).reduce((s, v) => s + v, 0);
    el.innerHTML = `Tổng các ngành <b class="${sum > 100.0001 ? 'tl-down' : ''}">${rkNum(sum, 1)}%</b> · tiền mặt chuẩn <b>${rkNum(Math.max(0, 100 - sum), 1)}%</b>${sum > 100.0001 ? ' — vượt 100%, chưa lưu được' : ''}`;
}
function gsFillFromCurrent() { GS.draft = gsCurrentSectorWeights(); grRender(); }
function gsClearDraft() { GS.draft = {}; grRender(); }
async function gsSavePolicy() {
    if (GS.saving) return;
    GS.saving = true;
    try {
        const msg = await grCall('savePolicy', { weights: gsDraft(), email: (GL.actor && GL.actor.actorEmail) || '' });
        showToast(msg, 'success');
        GS.draft = null; GS.saving = false;
        await gsLoad(true);
    } catch (e) { GS.saving = false; showToast('Lỗi: ' + e.message, 'error'); }
}

function gsPolicyHtml() {
    const manager = gsManager(), d = manager ? gsDraft() : (BS.policy.weights || {}), cur = gsCurrentSectorWeights();
    const sectors = BrinsonCalc.allSectors();
    const sum = Object.values(d).reduce((s, v) => s + v, 0);
    let html = `<div class="ce-group-title">Danh mục chuẩn chiến lược của nhóm ${manager ? '' : '<small style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-muted)">(chỉ quản lý danh mục / admin được sửa)</small>'}</div>
        <p class="tl-hint" style="margin:0 0 10px">Tỷ trọng mục tiêu của nhóm theo ngành (theo NAV, gồm tiền mặt). Đây là thước đo để biết nhóm đang <b>chọn ngành</b> hơn hay kém: phần còn lại sau khi trừ các ngành là tiền mặt chuẩn. Mỗi ngành so với chỉ số ngành HOSE tương ứng.${BS.policy.updatedAt ? ` Cập nhật lần cuối ${glDate(BS.policy.updatedAt)}.` : ''}</p>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Ngành</th><th>Chỉ số so sánh</th><th class="text-right">Chuẩn (% NAV)</th><th class="text-right">Nhóm đang giữ</th><th class="text-right">Lệch</th></tr></thead><tbody>
        ${sectors.map(s => { const w = d[s] || 0, c = cur[s] || 0; return `<tr><td>${gsEsc(s)}</td><td>${gsEsc(BrinsonCalc.indexFor(s))}</td>
            <td class="text-right">${manager ? `<input type="number" class="tl-input num" style="width:80px" min="0" max="100" step="0.5" value="${w || ''}" placeholder="0" oninput="gsSetWeight('${gsEsc(s).replace(/'/g, '&#39;')}', this.value)">` : (w ? rkNum(w, 1) + '%' : '—')}</td>
            <td class="text-right">${c ? rkNum(c, 1) + '%' : '—'}</td><td class="text-right ${w || c ? (c - w > 0.5 ? 'tl-down' : (c - w < -0.5 ? 'tl-up' : '')) : ''}">${w || c ? (c - w > 0 ? '+' : '') + rkNum(c - w, 1) + ' điểm' : '—'}</td></tr>`; }).join('')}
        </tbody></table></div>
        <div class="gs-sum" id="gs-sum">Tổng các ngành <b>${rkNum(sum, 1)}%</b> · tiền mặt chuẩn <b>${rkNum(Math.max(0, 100 - sum), 1)}%</b></div>`;
    if (manager) html += `<div class="gs-actions"><button type="button" class="btn-save" onclick="gsSavePolicy()" ${GS.saving ? 'disabled' : ''}><i class="fa-solid fa-floppy-disk"></i> Lưu danh mục chuẩn</button>
        <button type="button" class="btn-tool" onclick="gsFillFromCurrent()"><i class="fa-solid fa-wand-magic-sparkles"></i> Điền theo danh mục nhóm hiện tại</button><button type="button" class="btn-tool" onclick="gsClearDraft()">Xoá hết</button></div>
        <p class="tl-hint">Đổi chuẩn sẽ áp dụng cho CẢ kỳ đang xem (phân tích dùng tỷ trọng chuẩn hiện tại), nên nên đổi chuẩn có chủ đích và ghi lại lý do ngoài hệ thống.</p>`;
    return html;
}

// ---------- phân tích ----------
function gsMembersHtml() {
    const rows = GS.members.filter(m => m.res.ok);
    if (!rows.length) return '';
    const cls = (v) => v > 0.005 ? 'tl-up' : (v < -0.005 ? 'tl-down' : '');
    return `<div class="ce-group-title">Từng thành viên so với chuẩn của nhóm</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Thành viên</th><th class="text-right">Danh mục</th><th class="text-right">Chuẩn</th><th class="text-right">Hơn / kém</th><th class="text-right">Phân bổ ngành</th><th class="text-right">Chọn mã</th><th class="text-right">Tương tác</th><th class="text-right">Tiền mặt thực / chuẩn</th></tr></thead><tbody>
        ${rows.map(m => { const r = m.res; return `<tr><td><b>${gsEsc(m.name)}</b></td><td class="text-right">${bsP(r.portfolioPct, 2, true)}</td><td class="text-right">${bsP(r.benchmarkPct, 2, true)}</td><td class="text-right ${cls(r.activePct)}"><b>${bsP(r.activePct, 2, true)}</b></td>
            <td class="text-right ${cls(r.allocation)}">${bsP(r.allocation, 2, true)}</td><td class="text-right ${cls(r.selection)}">${bsP(r.selection, 2, true)}</td><td class="text-right ${cls(r.interaction)}">${bsP(r.interaction, 2, true)}</td><td class="text-right">${rkNum(r.cashActualPct, 0)}% / ${rkNum(r.cashPolicyPct, 0)}%</td></tr>`; }).join('')}
        </tbody></table></div><p class="tl-hint">Mỗi người có vốn, thời điểm bắt đầu và phong cách khác nhau; so với cùng một chuẩn chỉ để thấy ai lệch chuẩn về phía nào (phân bổ) và ai chọn mã trong ngành tốt hơn chỉ số (chọn mã). Không phải bảng xếp hạng.</p>`;
}

function gsAnalysisHtml() {
    if (GS.state === 'loading' || GS.state === 'idle') return '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang lấy giá lịch sử và chỉ số ngành… (có thể mất vài giây)</div>';
    if (GS.state === 'error') return `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không phân tích được: ${gsEsc(GS.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="gsLoad(true)">Thử lại</button></div>`;
    if (!GS.group) return '<div class="tl-empty"><i class="fa-solid fa-scale-unbalanced"></i>Chưa có lệnh giao dịch nào để phân tích.</div>';
    let html = `<div class="ce-group-title">Cả nhóm so với chuẩn chiến lược</div><div class="tl-opts" style="margin:0 0 10px"><label class="tl-check">Kỳ: <select class="tl-select" onchange="gsChangeRange(this.value)">${GS_RANGES.map(([v, t]) => `<option value="${v}" ${GS.range === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <span class="rk-meta" style="margin:0">${glDate(GS.period.from)} → ${glDate(GS.period.to)}</span></div>`;
    if (GS.histError) html += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không lấy đủ giá lịch sử: ${gsEsc(GS.histError)}</span></div>`;
    if (BS.indicesError) html += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không lấy được chỉ số ngành: ${gsEsc(BS.indicesError)}. Phần chọn mã chưa tách được.</span></div>`;
    html += bsResultHtml(GS.group.res, 'gs-chart');
    return html + gsLinkedHtml() + gsMembersHtml();
}

function grStrategyHtml() {
    if (!GL.loaded) return '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang tải…</div>';
    return gsPolicyHtml() + (typeof grbHtml === 'function' ? grbHtml() : '') + gsAnalysisHtml();
}
function grStrategyAfterRender() {
    BS.charts.forEach(c => { try { c.destroy(); } catch (e) { /* đã huỷ */ } }); BS.charts = [];
    if (GS.state === 'ok' && GS.group && GS.group.res.ok) bsDrawChart(GS.group.res, 'gs-chart');
}
