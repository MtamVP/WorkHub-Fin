/* --- FILE: /stocksheet/market-screener-ui.js ---
   Tổng Hợp CP > "Thị trường": sàng lọc cả ~1.500 mã niêm yết (không cần đã nhập số liệu) theo định giá tương đối trong ngành, chất lượng, tăng trưởng, cổ tức, đòn bẩy, thanh khoản.
   Số liệu: ảnh chụp thị trường hằng ngày từ VNDirect (finance_market_snapshot). Phép lọc/chấm điểm ở /lib/market-screener.js (có kiểm thử).
   Dùng global của script.js: state, call, showToast, openDetail, loadOverview, VU (ValuationUI), FinancialsSync. */

const MK = { state: 'idle', error: '', rows: [], asOf: null, filters: { values: {}, icb: '' }, preset: null, limit: 50, busy: '' };
const MK_KEY = 'wh.fin.marketscreener.v1';
try {
    const saved = JSON.parse(localStorage.getItem(MK_KEY) || 'null');
    if (saved && saved.filters) { MK.filters = MarketScreener.normalizeFilters(saved.filters); MK.preset = saved.preset || null; }
} catch (e) { /* không có localStorage: dùng mặc định */ }
function mkSave() { try { localStorage.setItem(MK_KEY, JSON.stringify({ filters: MK.filters, preset: MK.preset })); } catch (e) { /* bỏ qua */ } }

async function mkLoad(force) {
    if (MK.state === 'loading') return;
    if (MK.state === 'ok' && !force) { renderMarketScreener(); return; }
    MK.state = 'loading'; MK.error = ''; renderMarketScreener();
    try {
        const u = await call('getMarketUniverse', { force: !!force });
        MK.rows = MarketScreener.buildRows(u.snapshot || [], u.stats || {}, u.meta || {});
        MK.asOf = u.asOf || null;
        MK.state = MK.rows.length ? 'ok' : 'empty';
    } catch (e) { MK.state = 'error'; MK.error = e.message || String(e); }
    renderMarketScreener();
}

const mkX = (v, d) => (v === null || v === undefined ? '—' : VU.dec(v, d === undefined ? 1 : d) + 'x');
const mkP = (v, d) => (v === null || v === undefined ? '—' : VU.dec(v * 100, d === undefined ? 1 : d) + '%');
function mkIcbName(code) { return (typeof SectorMap !== 'undefined' && SectorMap.icbName(code)) || (code ? 'ICB ' + code : 'Chưa phân ngành'); }

function mkField(c) {
    const v = MK.filters.values[c.key];
    return `<label class="sc-field" title="${VU.esc(c.hint || '')}"><span>${VU.esc(c.label)}${c.unit ? ` <small>(${VU.esc(c.unit)})</small>` : ''}</span>
        <input type="number" step="any" inputmode="decimal" data-mk="${c.key}" value="${v === undefined ? '' : v}" placeholder="Bỏ trống = không lọc" oninput="mkOnInput()"></label>`;
}

function renderMarketScreener() {
    const root = document.getElementById('mk-root');
    if (!root) return;
    if (MK.state === 'idle' || MK.state === 'loading') { root.innerHTML = '<div class="vl-card"><div class="vl-empty"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải ảnh chụp thị trường…</div></div>'; return; }
    if (MK.state === 'error') { root.innerHTML = `<div class="vl-card"><div class="vl-empty">Không tải được: ${VU.esc(MK.error)}<br><button type="button" class="btn-save" style="margin-top:10px" onclick="mkLoad(true)">Thử lại</button></div></div>`; return; }
    if (MK.state === 'empty') { root.innerHTML = '<div class="vl-card"><div class="vl-empty"><i class="fa-solid fa-database"></i> Chưa có ảnh chụp thị trường. Hàm cập nhật chạy mỗi ngày làm việc lúc 18:20; hãy thử lại sau.</div></div>'; return; }
    const groups = [];
    MarketScreener.CRITERIA.forEach(c => { let g = groups.find(x => x.name === c.group); if (!g) groups.push(g = { name: c.group, items: [] }); g.items.push(c); });
    const icbs = [...new Set(MK.rows.map(r => r.icb2_code).filter(Boolean))].sort();
    root.innerHTML = `
    <div class="vl-card">
        <h3 class="vl-card-title"><i class="fa-solid fa-earth-asia" aria-hidden="true"></i> Sàng lọc toàn thị trường <span class="vl-muted">${MK.rows.length} mã niêm yết · số liệu ngày ${VU.esc(String(MK.asOf || '').slice(0, 10).split('-').reverse().join('/'))}
            <button type="button" class="vl-link" style="margin-left:10px" onclick="mkReset()">Đặt lại</button></span></h3>
        <div class="sc-presets" role="group" aria-label="Mẫu lọc có sẵn">
            ${MarketScreener.PRESETS.map(p => `<button type="button" class="vl-chip" aria-pressed="${MK.preset === p.key}" title="${VU.esc(p.desc)}" onclick="mkPreset('${p.key}')">${VU.esc(p.label)}</button>`).join('')}
        </div>
        ${MK.preset ? `<p class="vl-hint" style="margin-top:0">${VU.esc(MarketScreener.PRESETS.find(p => p.key === MK.preset).desc)} Bạn có thể chỉnh các ô bên dưới.</p>` : ''}
        <div class="sc-grid">${groups.map(g => `<fieldset class="sc-group"><legend>${VU.esc(g.name)}</legend>${g.items.map(mkField).join('')}</fieldset>`).join('')}
            <fieldset class="sc-group"><legend>Ngành</legend><label class="sc-field"><span>Ngành ICB</span><select id="mk-icb" onchange="mkOnInput()"><option value="">Tất cả ngành</option>${icbs.map(c => `<option value="${c}"${MK.filters.icb === c ? ' selected' : ''}>${VU.esc(mkIcbName(c))}</option>`).join('')}</select></label></fieldset>
        </div>
    </div>
    <div id="mk-results"></div>`;
    renderMkResults();
}

function mkRow(e, i) {
    const r = e.row, m = r.m, inTable = state.items.some(x => x.symbol === r.symbol);
    const peHist = m.pe > 0 && m.pe5y > 0 ? m.pe / m.pe5y : null;
    return `<tr data-mk-symbol="${VU.esc(r.symbol)}"><td>${i + 1}</td>
        <td><b>${VU.esc(r.symbol)}</b>${r.name ? `<span class="symbol-sub">${VU.esc(r.name)}</span>` : ''}<span class="symbol-sub">${VU.esc(mkIcbName(r.icb2_code))}${r.exchange ? ' · ' + VU.esc(r.exchange) : ''}</span>${e.flags.map(f => `<span class="symbol-sub mk-flag"><i class="fa-solid fa-triangle-exclamation"></i> ${VU.esc(f)}</span>`).join('')}</td>
        <td class="num">${e.score === null ? '—' : VU.dec(e.score, 0)}</td>
        <td class="num">${m.marketcap > 0 ? VU.dec(m.marketcap / 1e9, 0) : '—'}</td>
        <td class="num">${mkX(m.pe)}${peHist !== null ? `<small>${VU.dec(peHist * 100, 0)}% TB 5 năm</small>` : ''}</td>
        <td class="num">${mkX(m.pb, 2)}</td>
        <td class="num">${r.valuationPct === null ? '—' : `<span class="vl-pill ${r.valuationPct <= 30 ? 'vl-pill-cheap' : (r.valuationPct >= 70 ? 'vl-pill-expensive' : 'vl-pill-fair')}">${VU.dec(r.valuationPct, 0)}</span>`}</td>
        <td class="num">${mkP(m.roae)}</td><td class="num">${mkP(m.epsGrowthYoY, 0)}</td><td class="num">${mkP(m.divYield)}</td>
        <td class="num">${r.financial ? 'n/a' : mkX(m.debtToEquity)}</td><td class="num">${m.chg1y === undefined ? '—' : `<span class="${m.chg1y >= 0 ? 'pnl-up-text' : 'pnl-down-text'}">${VU.dec(m.chg1y * 100, 0)}%</span>`}</td>
        <td>${inTable ? '<span class="vl-tag">Trong bảng</span>' : `<button type="button" class="vl-link" data-mk-add="${VU.esc(r.symbol)}">Thêm vào bảng</button>`}</td></tr>`;
}

function renderMkResults() {
    const box = document.getElementById('mk-results');
    if (!box) return;
    const res = MarketScreener.evaluate(MK.rows, MK.filters), c = res.counts;
    const miss = Object.keys(c.missing).map(k => ({ k, n: c.missing[k] })).sort((a, b) => b.n - a.n);
    const shown = res.entries.slice(0, MK.limit);
    const head = `<h3 class="vl-card-title"><i class="fa-solid fa-ranking-star"></i> ${c.active ? `${c.passed} mã đạt` : 'Chưa bật tiêu chí nào'}<span class="vl-muted">trong ${c.universe} mã${c.active ? ' · xếp theo điểm tổng hợp' : ''}</span></h3>`;
    if (!c.active) { box.innerHTML = `<div class="vl-card">${head}<div class="vl-empty">Chọn một mẫu lọc hoặc nhập ít nhất một tiêu chí ở trên.</div></div>`; return; }
    if (!c.passed) {
        const worst = Object.keys(c.failedBy).map(k => ({ k, n: c.failedBy[k] })).sort((a, b) => b.n - a.n)[0];
        box.innerHTML = `<div class="vl-card">${head}<div class="vl-empty">Không mã nào đạt mọi tiêu chí.${worst ? ` Tiêu chí loại nhiều nhất: <b>${VU.esc(MarketScreener.BY_KEY[worst.k].label)}</b> (${worst.n} mã). Thử nới tiêu chí này.` : ''}</div></div>`;
        return;
    }
    box.innerHTML = `<div class="vl-card">${head}
        <div class="spreadsheet-wrapper vl-table-wrap"><table class="vl-scen sc-table"><thead><tr><th>#</th><th>Mã</th><th class="num" title="Điểm tổng hợp 0-100 để xếp hạng, không phải khuyến nghị">Điểm</th><th class="num">Vốn hoá (tỷ)</th><th class="num">P/E</th><th class="num">P/B</th><th class="num" title="Phân vị định giá trong ngành: 0 = rẻ nhất ngành">Rẻ so với ngành</th><th class="num">ROE</th><th class="num">Tăng trưởng EPS</th><th class="num">Cổ tức</th><th class="num">Nợ/vốn</th><th class="num">Giá 12 tháng</th><th></th></tr></thead>
        <tbody>${shown.map(mkRow).join('')}</tbody></table></div>
        ${res.entries.length > MK.limit ? `<p class="vl-hint"><button type="button" class="vl-link" onclick="mkMore()">Hiện thêm</button> (đang hiện ${MK.limit}/${res.entries.length})</p>` : ''}
        ${miss.length ? `<p class="vl-hint">Mã bị loại vì thiếu số liệu: ${miss.map(x => `${VU.esc(MarketScreener.BY_KEY[x.k].label)} (${x.n})`).join(', ')}. Mã thiếu số liệu cho tiêu chí đang bật không được tính là đạt.</p>` : ''}
        <p class="vl-hint">Điểm ghép định giá tương đối trong ngành (30%), chất lượng (30%), tăng trưởng (20%), cổ tức (10%), an toàn tài chính (10%); chỉ để xếp hạng. Nợ/vốn không áp dụng cho ngân hàng, bảo hiểm, dịch vụ tài chính. Số liệu là chỉ số công bố của VNDirect, chưa soát với báo cáo tài chính gốc: coi kết quả là danh sách để nghiên cứu tiếp, không phải khuyến nghị mua bán. Mã thêm vào bảng sẽ tự lấy số liệu tài chính để định giá chi tiết.</p></div>`;
}

function mkOnInput() {
    const values = {};
    document.querySelectorAll('#mk-root [data-mk]').forEach(el => { if (el.value !== '') { const n = Number(el.value); if (isFinite(n)) values[el.getAttribute('data-mk')] = n; } });
    const sel = document.getElementById('mk-icb');
    MK.filters = { values, icb: sel ? sel.value : '' };
    MK.preset = null; MK.limit = 50; mkSave();
    document.querySelectorAll('#mk-root .sc-presets [aria-pressed]').forEach(b => b.setAttribute('aria-pressed', 'false'));
    renderMkResults();
}
function mkPreset(key) {
    const p = MarketScreener.PRESETS.find(x => x.key === key); if (!p) return;
    MK.filters = { values: Object.assign({}, p.values), icb: MK.filters.icb }; MK.preset = key; MK.limit = 50; mkSave(); renderMarketScreener();
}
function mkReset() { MK.filters = { values: {}, icb: '' }; MK.preset = null; MK.limit = 50; mkSave(); renderMarketScreener(); }
function mkMore() { MK.limit += 50; renderMkResults(); }

async function mkAdd(symbol) {
    if (MK.busy) return;
    if (!window.confirm(`Thêm ${symbol} vào bảng và lấy số liệu tài chính tự động từ nguồn thị trường?\n\nMã mới chưa có P/E, P/B mục tiêu nên chưa có kết luận Rẻ/Đắt cho đến khi bạn đặt giả định.`)) return;
    MK.busy = symbol;
    try {
        const results = await FinancialsSync.syncMany([symbol]);
        await loadOverview();
        const ok = results.some(r => r.ok);
        showToast(ok ? `Đã thêm ${symbol} vào bảng` : `Không lấy được số liệu của ${symbol}`, ok ? 'success' : 'error');
    } catch (e) { showToast(e.message, 'error'); }
    MK.busy = '';
    renderMkResults();
}

document.addEventListener('click', function (e) {
    const a = e.target.closest('#mk-root [data-mk-add]');
    if (a) { e.stopPropagation(); mkAdd(a.getAttribute('data-mk-add')); return; }
    const row = e.target.closest('#mk-root tr[data-mk-symbol]');
    if (row && !e.target.closest('button, a')) { const s = row.getAttribute('data-mk-symbol'); if (state.items.some(x => x.symbol === s)) openDetail(s); }
});
