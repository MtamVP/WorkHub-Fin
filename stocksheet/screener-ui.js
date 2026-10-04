/* --- FILE: /stocksheet/screener-ui.js ---
   Tổng Hợp CP > "Bộ lọc": tìm mã đáng xem trong các mã đã có số liệu (P/E thấp, ROE cao, cổ tức, rẻ hơn ngành, còn tiềm năng...), xếp hạng bằng
   điểm tổng hợp, và thêm hàng loạt mã theo rổ (VN30, ngành...) bằng đồng bộ số liệu tự động. Phép lọc/chấm điểm ở /lib/screener.js (có kiểm thử).
   Dùng global của script.js: state, call, showToast, openDetail, loadOverview, VU (ValuationUI), VC (ValuationCalc), FinancialsSync. */

const SC = {
    filters: { values: {}, verdicts: [], sector: '', scope: 'all', excludeLoss: true },
    preset: null,
    busy: false,
    universe: 'vn30',
    lastAdd: null,
};
const SC_KEY = 'wh.fin.screener.v1';

try {
    const saved = JSON.parse(localStorage.getItem(SC_KEY) || 'null');
    if (saved && saved.filters) { SC.filters = Screener.normalizeFilters(saved.filters); SC.preset = saved.preset || null; if (saved.universe) SC.universe = saved.universe; }
} catch (e) { /* không có localStorage: dùng mặc định */ }

function scSave() {
    try { localStorage.setItem(SC_KEY, JSON.stringify({ filters: SC.filters, preset: SC.preset, universe: SC.universe })); } catch (e) { /* bỏ qua */ }
}

// ---------- vẽ ----------
const SC_VERDICTS = [['cheap', 'Rẻ'], ['fair', 'Hợp lý'], ['expensive', 'Đắt']];
const SC_SCOPES = [['all', 'Tất cả mã'], ['held', 'Đang nắm'], ['notheld', 'Chưa nắm'], ['watched', 'Đang theo dõi']];

function scField(c) {
    const v = SC.filters.values[c.key];
    return `<label class="sc-field" title="${VU.esc(c.hint || '')}">
        <span>${VU.esc(c.label)}${c.unit ? ` <small>(${VU.esc(c.unit)})</small>` : ''}</span>
        <input type="number" step="any" inputmode="decimal" data-crit="${c.key}" value="${v === undefined ? '' : v}" placeholder="Bỏ trống = không lọc" oninput="scOnInput()">
    </label>`;
}

function renderScreener() {
    const root = document.getElementById('sc-root');
    if (!root) return;
    const groups = [];
    Screener.CRITERIA.forEach(c => { let g = groups.find(x => x.name === c.group); if (!g) groups.push(g = { name: c.group, items: [] }); g.items.push(c); });
    const have = state.items.map(i => i.symbol);
    const missing = Screener.missingFromUniverse(SC.universe, have);

    root.innerHTML = `
    <div class="vl-card">
        <h3 class="vl-card-title"><i class="fa-solid fa-layer-group" aria-hidden="true"></i> Danh sách mã để lọc <span class="vl-muted">${state.items.length} mã trong bảng</span></h3>
        <div class="sc-universe">
            <select id="sc-universe" aria-label="Chọn rổ mã" onchange="scPickUniverse(this.value)">
                ${Screener.UNIVERSES.map(u => `<option value="${u.key}"${u.key === SC.universe ? ' selected' : ''}>${VU.esc(u.label)} · ${u.symbols.length} mã</option>`).join('')}
            </select>
            <button type="button" class="btn-save" id="sc-add-universe" onclick="scAddUniverse()"${missing.length && !SC.busy ? '' : ' disabled'}>
                <i class="fa-solid fa-cloud-arrow-down" aria-hidden="true"></i> ${missing.length ? `Thêm ${missing.length} mã chưa có` : 'Đã có đủ mã trong rổ này'}</button>
        </div>
        <p class="vl-hint">Lấy số liệu tài chính tự động từ nguồn thị trường (mất khoảng vài giây mỗi mã). Mã mới chưa có P/E, P/B mục tiêu nên chưa có kết luận Rẻ/Đắt — các tiêu chí P/E, P/B, ROE, cổ tức, tăng trưởng vẫn lọc được. Thành phần rổ chỉ mang tính tham khảo, có thể đã thay đổi.</p>
        <div id="sc-add-result">${scAddResultHtml()}</div>
    </div>

    <div class="vl-card">
        <h3 class="vl-card-title"><i class="fa-solid fa-filter" aria-hidden="true"></i> Bộ lọc
            <button type="button" class="vl-link" style="margin-left:auto" onclick="scReset()">Đặt lại</button></h3>
        <div class="sc-presets" role="group" aria-label="Mẫu lọc có sẵn">
            ${Screener.PRESETS.map(p => `<button type="button" class="vl-chip" aria-pressed="${SC.preset === p.key}" title="${VU.esc(p.desc)}" onclick="scPreset('${p.key}')">${VU.esc(p.label)}</button>`).join('')}
        </div>
        ${SC.preset ? `<p class="vl-hint" style="margin-top:0">${VU.esc(Screener.PRESETS.find(p => p.key === SC.preset).desc)} Bạn có thể chỉnh các ô bên dưới.</p>` : ''}
        <div class="sc-grid">${groups.map(g => `<fieldset class="sc-group"><legend>${VU.esc(g.name)}</legend>${g.items.map(scField).join('')}</fieldset>`).join('')}
            <fieldset class="sc-group"><legend>Phạm vi</legend>
                <div class="sc-chips" role="group" aria-label="Kết luận định giá">${SC_VERDICTS.map(v => `<button type="button" class="vl-chip" aria-pressed="${SC.filters.verdicts.includes(v[0])}" onclick="scToggleVerdict('${v[0]}')">${v[1]}</button>`).join('')}</div>
                <label class="sc-field"><span>Ngành</span><select id="sc-sector" onchange="scOnInput()"><option value="">Tất cả ngành</option>${Object.keys(VC.SECTORS).map(k => `<option value="${k}"${SC.filters.sector === k ? ' selected' : ''}>${VU.esc(VC.SECTORS[k].label)}</option>`).join('')}</select></label>
                <label class="sc-field"><span>Mã</span><select id="sc-scope" onchange="scOnInput()">${SC_SCOPES.map(s => `<option value="${s[0]}"${SC.filters.scope === s[0] ? ' selected' : ''}>${s[1]}</option>`).join('')}</select></label>
                <label class="sc-check"><input type="checkbox" id="sc-loss" ${SC.filters.excludeLoss ? 'checked' : ''} onchange="scOnInput()"> Loại mã đang lỗ</label>
            </fieldset>
        </div>
    </div>
    <div id="sc-results"></div>`;
    renderScreenerResults();
}

function scAddResultHtml() {
    const r = SC.lastAdd;
    if (!r) return '';
    const ok = r.filter(x => x.ok), bad = r.filter(x => !x.ok);
    return `<div class="vl-note"><i class="fa-solid fa-list-check"></i><span>Đã thêm <b>${ok.length}</b>/${r.length} mã.${bad.length ? ` Không lấy được: ${bad.slice(0, 6).map(x => `<b>${VU.esc(x.symbol)}</b>`).join(', ')}${bad.length > 6 ? ` và ${bad.length - 6} mã khác` : ''} — ${VU.esc(bad[0].error)}` : ''}</span></div>`;
}

function scVerdictCell(row) {
    return VU.verdictPill({ key: row.verdict, label: row.verdict === 'cheap' ? 'Rẻ' : (row.verdict === 'fair' ? 'Hợp lý' : (row.verdict === 'expensive' ? 'Đắt' : 'Chưa định giá')) });
}

function scScoreCell(e) {
    if (e.score === null) return '<span class="vl-px-src" title="Chưa đủ dữ liệu để chấm điểm">—</span>';
    return `<span class="sc-score" title="Điểm xếp hạng 0–100 (định giá 35 · chất lượng 30 · tăng trưởng 20 · cổ tức 10 · an toàn 5). Không phải khuyến nghị đầu tư."><b>${Math.round(e.score)}</b><i style="width:${Math.round(e.score)}%"></i></span>`;
}

function scRow(e, idx, near) {
    const r = e.row;
    const tags = (r.held ? '<span class="vl-tag"><i class="fa-solid fa-wallet"></i> Đang nắm</span>' : '') + (r.watched ? ' <span class="vl-tag vl-tag-watch"><i class="fa-solid fa-eye"></i> Theo dõi</span>' : '');
    const failNote = near ? `<div class="sc-fail">${e.failed.map(c => scFailText(c)).join('; ')}</div>` : '';
    const canWatch = !r.watched && !r.held && r.fair > 0;
    return `<tr class="vl-row" tabindex="0" role="link" data-symbol="${VU.esc(r.symbol)}" aria-label="Xem chi tiết ${VU.esc(r.symbol)}">
        <td class="left"><span class="vl-sym">${VU.esc(r.symbol)}</span>${tags}${failNote}</td>
        <td>${scScoreCell(e)}</td>
        <td>${VU.vnd(r.price)}</td>
        <td>${VU.isNum(r.upside) ? `<span class="pnl-pill ${VU.signedClass(r.upside)}">${VU.esc(VU.pct(r.upside, 0, true))}</span>` : VU.NA}</td>
        <td class="left">${scVerdictCell(r)}</td>
        <td>${VU.mult(r.pe)}${r.peDiscount !== null ? `<span class="vl-px-src" title="So với trung vị P/E ngành ${VU.esc(VU.mult(r.peerPe))}">${r.peDiscount >= 0 ? 'rẻ hơn' : 'đắt hơn'} ngành ${VU.esc(VU.pct(Math.abs(r.peDiscount), 0))}</span>` : ''}</td>
        <td>${VU.mult(r.pb, 2)}</td><td>${VU.pct(r.roe)}</td><td>${VU.pct(r.epsGrowth, 0, true)}</td><td>${VU.mult(r.peg, 2)}</td><td>${VU.pct(r.divYield)}</td>
        <td class="left vl-sec">${VU.esc(r.sectorLabel)}</td>
        <td>${canWatch ? `<button type="button" class="vl-link" data-watch="${VU.esc(r.symbol)}" title="Thêm vào Theo Dõi: giá mục tiêu = giá hợp lý, báo khi giá ≤ ${Math.round(VC.CHEAP_RATIO * 100)}% giá hợp lý">+ Theo dõi</button>` : ''}</td>
    </tr>`;
}

const SC_CRIT_FAIL = { verdict: 'kết luận không khớp', lossMaking: 'đang lỗ' };
function scFailText(c) {
    if (SC_CRIT_FAIL[c.key]) return SC_CRIT_FAIL[c.key];
    const def = Screener.CRITERIA_BY_KEY[c.key];
    const v = Number(c.value).toLocaleString('vi-VN', { maximumFractionDigits: 1 });
    return `${def.label.replace(/ (tối thiểu|tối đa)$/, '')} ${v}${def.unit || ''} (cần ${def.op === 'min' ? '≥' : '≤'} ${Number(c.threshold).toLocaleString('vi-VN')}${def.unit || ''})`;
}

function scTable(entries, near) {
    const heads = [['Mã', 1], ['Điểm'], ['Giá'], ['Tiềm năng'], ['Kết luận', 1], ['P/E'], ['P/B'], ['ROE'], ['EPS tăng'], ['PEG'], ['Cổ tức'], ['Ngành', 1], ['']];
    return `<div class="spreadsheet-wrapper vl-table-wrap"><table class="vl-ov sc-table"><thead><tr>${heads.map(h => `<th scope="col" class="${h[1] ? 'left' : ''}"><span class="sc-th">${h[0]}</span></th>`).join('')}</tr></thead>
        <tbody>${entries.map((e, i) => scRow(e, i, near)).join('')}</tbody></table></div>`;
}

function renderScreenerResults() {
    const box = document.getElementById('sc-results');
    if (!box) return;
    if (!state.items.length) {
        box.innerHTML = '<div class="stock-empty-state"><i class="fa-solid fa-filter"></i><p>Chưa có mã nào để lọc. Chọn một rổ ở trên và bấm “Thêm mã chưa có”, hoặc thêm từng mã ở tab Bảng so sánh.</p></div>';
        return;
    }
    const res = Screener.evaluate(Screener.rowsFrom(state.items), SC.filters);
    const s = res.stats;
    const active = Object.keys(SC.filters.values).map(k => Screener.describe(k, SC.filters.values[k]));
    if (SC.filters.verdicts.length) active.push('Kết luận: ' + SC.filters.verdicts.map(v => SC_VERDICTS.find(x => x[0] === v)[1]).join(' hoặc '));
    let html = `<div class="vl-card">
        <h3 class="vl-card-title"><i class="fa-solid fa-ranking-star" aria-hidden="true"></i> Kết quả
            <span class="vl-muted"><b>${s.passed}</b> mã đạt / ${s.inScope} mã trong phạm vi</span></h3>
        ${active.length ? `<div class="sc-active">${active.map(a => `<span class="vl-chipmeta">${VU.esc(a)}</span>`).join('')}</div>` : '<p class="vl-hint" style="margin-top:0">Chưa bật tiêu chí nào — đang hiện mọi mã, xếp theo điểm. Chọn một mẫu lọc hoặc nhập ngưỡng ở trên.</p>'}
        ${s.passed ? scTable(res.passed.slice(0, 100), false) : '<div class="vl-empty">Không có mã nào đạt toàn bộ tiêu chí.</div>'}
        ${s.missingOnly ? `<p class="vl-hint"><i class="fa-solid fa-circle-info"></i> ${s.missingOnly} mã đạt các tiêu chí còn lại nhưng <b>thiếu số liệu</b> cho tiêu chí bạn bật (ví dụ chưa đặt P/E, P/B mục tiêu nên chưa có “tiềm năng”) nên không được tính.</p>` : ''}
        ${res.passed.length > 100 ? '<p class="vl-hint">Chỉ hiện 100 mã điểm cao nhất.</p>' : ''}
    </div>`;
    if (res.near.length) {
        html += `<details class="vl-card sc-near"><summary class="vl-card-title" style="margin:0;cursor:pointer"><i class="fa-solid fa-bullseye" aria-hidden="true"></i> Gần đạt <span class="vl-muted">${res.near.length} mã trượt đúng 1 tiêu chí</span></summary>
            <div style="margin-top:12px">${scTable(res.near.slice(0, 20), true)}</div></details>`;
    }
    box.innerHTML = html + '<p class="vl-hint">Bộ lọc dựa trên số liệu và giả định đã lưu trong bảng; điểm xếp hạng chỉ giúp thu hẹp danh sách cần xem kỹ, không phải khuyến nghị mua bán.</p>';
}

// ---------- thao tác ----------
function scOnInput() {
    const values = {};
    document.querySelectorAll('#sc-root [data-crit]').forEach(i => { if (i.value !== '') values[i.getAttribute('data-crit')] = i.value; });
    SC.filters = Screener.normalizeFilters({
        values, verdicts: SC.filters.verdicts,
        sector: document.getElementById('sc-sector').value, scope: document.getElementById('sc-scope').value,
        excludeLoss: document.getElementById('sc-loss').checked,
    });
    SC.preset = null;
    document.querySelectorAll('#sc-root .sc-presets .vl-chip').forEach(b => b.setAttribute('aria-pressed', 'false'));
    scSave();
    renderScreenerResults();
}

function scPreset(key) {
    const p = Screener.PRESETS.find(x => x.key === key);
    if (!p) return;
    SC.filters = Screener.normalizeFilters(Object.assign({}, Screener.DEFAULT_FILTERS, { values: {}, verdicts: [] }, p.filters, { sector: SC.filters.sector, scope: SC.filters.scope, excludeLoss: SC.filters.excludeLoss }));
    SC.preset = key;
    scSave();
    renderScreener();
}

function scReset() {
    SC.filters = Screener.normalizeFilters({});
    SC.preset = null;
    scSave();
    renderScreener();
}

function scToggleVerdict(v) {
    const set = new Set(SC.filters.verdicts);
    if (set.has(v)) set.delete(v); else set.add(v);
    SC.filters = Screener.normalizeFilters(Object.assign({}, SC.filters, { verdicts: [...set] }));
    SC.preset = null;
    scSave();
    renderScreener();
}

function scPickUniverse(key) { SC.universe = key; scSave(); renderScreener(); }

async function scAddUniverse() {
    const missing = Screener.missingFromUniverse(SC.universe, state.items.map(i => i.symbol));
    if (!missing.length || SC.busy) return;
    if (!window.confirm(`Thêm ${missing.length} mã vào bảng và lấy số liệu tài chính tự động?\n\n${missing.join(', ')}\n\nViệc này có thể mất vài phút. Mã đã thêm xong vẫn được giữ nếu bạn đóng trang giữa chừng.`)) return;
    SC.busy = true;
    const btn = document.getElementById('sc-add-universe');
    if (btn) btn.disabled = true;
    try {
        const results = await FinancialsSync.syncMany(missing, function (done, total, sym) {
            const b = document.getElementById('sc-add-universe');
            if (b) b.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${done}/${total} · ${VU.esc(sym)}`;
        });
        SC.lastAdd = results;
        await loadOverview();
        showToast(`Đã thêm ${results.filter(r => r.ok).length}/${results.length} mã`, results.some(r => r.ok) ? 'success' : 'error');
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        SC.busy = false;
        renderScreener();
    }
}

async function scWatch(symbol) {
    const it = state.items.find(i => i.symbol === symbol);
    if (!it || !(it.a.v.fair > 0)) return;
    const fair = Math.round(it.a.v.fair), buy = Math.round(it.a.v.fair * VC.CHEAP_RATIO);
    if (!window.confirm(`Thêm ${symbol} vào Theo Dõi trong Bàn Tài Sản?\n\n• Giá mục tiêu: ${VU.vnd(fair)} (giá hợp lý)\n• Báo khi giá ≤ ${VU.vnd(buy)} (${Math.round(VC.CHEAP_RATIO * 100)}% giá hợp lý)`)) return;
    try {
        const msg = await call('pushStockToPortfolio', { symbol: symbol, targetPrice: fair, buyBelow: buy });
        showToast(msg, 'success');
        await loadOverview();
    } catch (e) { showToast(e.message, 'error'); }
}

document.addEventListener('click', function (e) {
    const w = e.target.closest('#sc-root [data-watch]');
    if (w) { e.stopPropagation(); scWatch(w.getAttribute('data-watch')); return; }
    const row = e.target.closest('#sc-root tr[data-symbol]');
    if (row && !e.target.closest('button, a')) openDetail(row.getAttribute('data-symbol'));
});
document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest && e.target.closest('#sc-root tr[data-symbol]');
    if (row && e.target === row) { e.preventDefault(); openDetail(row.getAttribute('data-symbol')); }
});
