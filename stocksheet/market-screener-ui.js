/* --- FILE: /stocksheet/market-screener-ui.js ---
   Tổng Hợp CP > "Thị trường": sàng lọc cả ~1.500 mã niêm yết (không cần đã nhập số liệu) theo định giá tương đối trong ngành, chất lượng, tăng trưởng, cổ tức, đòn bẩy, thanh khoản.
   Số liệu: ảnh chụp thị trường hằng ngày từ VNDirect (finance_market_snapshot). Phép lọc/chấm điểm ở /lib/market-screener.js (có kiểm thử).
   Dùng global của script.js: state, call, showToast, openDetail, loadOverview, VU (ValuationUI), FinancialsSync. */

const MK = { state: 'idle', error: '', rows: [], asOf: null, filters: { values: {}, icbs: [], perSector: 0, topN: 0 }, preset: null, limit: 50, busy: '', stats: {}, vals: {}, batch: null, sort: 'score', saved: [] };
const MK_BATCH_MAX = 150;                                   // số mã tối đa mỗi lần định giá hàng loạt
const MK_SAVED_KEY = 'wh.fin.marketscreener.saved.v1';
const MK_KEY = 'wh.fin.marketscreener.v1';
const MK_HEAT_KEY = 'wh.fin.sectorheat.v1';
const MKH = { key: 'chg1m' };                              // kỳ đang xem trên bản đồ nhiệt ngành
try { const hv = JSON.parse(localStorage.getItem(MK_HEAT_KEY) || 'null'); if (hv && SectorHeatmap.PERIODS.some(p => p.key === hv.key)) MKH.key = hv.key; } catch (e) { /* mặc định 1 tháng */ }
try {
    const saved = JSON.parse(localStorage.getItem(MK_KEY) || 'null');
    if (saved && saved.filters) { MK.filters = MarketScreener.normalizeFilters(saved.filters); MK.preset = saved.preset || null; }
} catch (e) { /* không có localStorage: dùng mặc định */ }
try { const sv = JSON.parse(localStorage.getItem(MK_SAVED_KEY) || '[]'); if (Array.isArray(sv)) MK.saved = sv.filter(x => x && typeof x.name === 'string' && x.filters).slice(0, 30); } catch (e) { /* không có localStorage */ }
function mkSaveSaved() { try { localStorage.setItem(MK_SAVED_KEY, JSON.stringify(MK.saved)); } catch (e) { /* bỏ qua */ } }
function mkSave() { try { localStorage.setItem(MK_KEY, JSON.stringify({ filters: MK.filters, preset: MK.preset })); } catch (e) { /* bỏ qua */ } }

async function mkLoad(force) {
    if (MK.state === 'loading') return;
    if (MK.state === 'ok' && !force) { renderMarketScreener(); return; }
    MK.state = 'loading'; MK.error = ''; renderMarketScreener();
    try {
        const u = await call('getMarketUniverse', { force: !!force });
        MK.rows = MarketScreener.buildRows(u.snapshot || [], u.stats || {}, u.meta || {});
        MK.asOf = u.asOf || null; MK.stats = u.stats || {}; if (force) MK.vals = {};
        MK.state = MK.rows.length ? 'ok' : 'empty';
    } catch (e) { MK.state = 'error'; MK.error = e.message || String(e); }
    renderMarketScreener();
    if (MK.state === 'ok' && (force || !MK.hist)) {      // cảnh báo định giá: tải lịch sử nền, không chặn bảng lọc
        call('getValuationHistory', { years: 6 }).then(h => { MK.hist = h; renderMkAlerts(); }).catch(() => { /* thiếu lịch sử: bỏ khung cảnh báo */ });
    } else renderMkAlerts();
}
function renderMkAlerts() {
    const el = document.getElementById('mk-alerts');
    if (el) el.innerHTML = typeof vaAlertsHtml === 'function' ? vaAlertsHtml(MK.hist, true) : '';
}

const mkX = (v, d) => (v === null || v === undefined ? '—' : VU.dec(v, d === undefined ? 1 : d) + 'x');
const mkP = (v, d) => (v === null || v === undefined ? '—' : VU.dec(v * 100, d === undefined ? 1 : d) + '%');
const mkChg = (v) => (v === null || v === undefined ? '—' : `<span class="${v >= 0 ? 'pnl-up-text' : 'pnl-down-text'}">${VU.dec(v * 100, 0)}%</span>`);
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
    <div id="mk-alerts"></div>
    <div id="mk-heat"></div>
    <div id="mk-watch"></div>
    <div class="vl-card">
        <h3 class="vl-card-title"><i class="fa-solid fa-earth-asia" aria-hidden="true"></i> Sàng lọc toàn thị trường <span class="vl-muted">${MK.rows.length} mã niêm yết · số liệu ngày ${VU.esc(String(MK.asOf || '').slice(0, 10).split('-').reverse().join('/'))}
            <button type="button" class="vl-link" style="margin-left:10px" onclick="mkReset()">Đặt lại</button></span></h3>
        <div class="sc-presets" role="group" aria-label="Mẫu lọc có sẵn">
            ${MarketScreener.PRESETS.map(p => `<button type="button" class="vl-chip" aria-pressed="${MK.preset === p.key}" title="${VU.esc(p.desc)}" onclick="mkPreset('${p.key}')">${VU.esc(p.label)}</button>`).join('')}
        </div>
        <div class="mk-saved">
            <label class="sc-field mk-saved-pick"><span>Bộ lọc đã lưu <small>(chỉ trong máy này)</small></span><select id="mk-saved-sel" onchange="mkSavedUse(this.value)"><option value="">${MK.saved.length ? '— Chọn để dùng —' : '— Chưa có bộ lọc nào —'}</option>${MK.saved.map((x, i) => `<option value="${i}">${VU.esc(x.name)}</option>`).join('')}</select></label>
            <label class="sc-field mk-saved-name"><span>Đặt tên để lưu bộ lọc hiện tại</span><input type="text" id="mk-saved-name" maxlength="40" placeholder="Ví dụ: Dẫn đầu ngành 2026"></label>
            <button type="button" class="vl-link" onclick="mkSavedSave()">Lưu</button>
            <button type="button" class="vl-link" onclick="mkSavedDelete()">Xoá bộ lọc đang chọn</button>
        </div>
        ${MK.preset ? `<p class="vl-hint" style="margin-top:0">${VU.esc(MarketScreener.PRESETS.find(p => p.key === MK.preset).desc)} Bạn có thể chỉnh các ô bên dưới.</p>` : ''}
        <div class="sc-grid">${groups.map(g => `<fieldset class="sc-group"><legend>${VU.esc(g.name)}</legend>${g.items.map(mkField).join('')}</fieldset>`).join('')}
            <fieldset class="sc-group"><legend>Ngành và số mã lấy</legend>
                <div class="mk-icb-head"><span>Ngành ICB <small>(${MK.filters.icbs.length ? 'đã chọn ' + MK.filters.icbs.length : 'tất cả ngành'})</small></span><span><button type="button" class="vl-link" onclick="mkIcbAll(true)">Chọn hết</button> · <button type="button" class="vl-link" onclick="mkIcbAll(false)">Bỏ chọn</button></span></div>
                <div class="mk-icb-list" role="group" aria-label="Chọn ngành ICB">${icbs.map(c => `<label class="mk-icb-item"><input type="checkbox" data-mk-icb="${c}"${MK.filters.icbs.includes(c) ? ' checked' : ''} onchange="mkOnInput()"> ${VU.esc(mkIcbName(c))}</label>`).join('')}</div>
                <label class="sc-field" title="Sau khi xếp theo điểm, chỉ giữ tối đa chừng này mã cho mỗi ngành. Bỏ trống = không giới hạn."><span>Tối đa mỗi ngành <small>(mã)</small></span><input type="number" min="1" step="1" inputmode="numeric" data-mk-opt="perSector" value="${MK.filters.perSector || ''}" placeholder="Bỏ trống = không giới hạn" oninput="mkOnInput()"></label>
                <label class="sc-field" title="Giữ tối đa chừng này mã cao điểm nhất trong toàn bộ kết quả."><span>Tối đa tổng cộng <small>(mã)</small></span><input type="number" min="1" step="1" inputmode="numeric" data-mk-opt="topN" value="${MK.filters.topN || ''}" placeholder="Bỏ trống = không giới hạn" oninput="mkOnInput()"></label>
            </fieldset>
        </div>
    </div>
    <div id="mk-results"></div>`;
    renderMkResults();
    renderMkAlerts();
    renderMkHeat();
    renderMkWatch();
}

// ---------- theo dõi bộ lọc đã lưu: mã mới lọt vào / vừa rớt ra so với lần lưu trước (filter-watch.js, lịch sử ảnh chụp trong máy) ----------
const MKW = { sig: '', res: null, busy: false };
const mkDm = (d) => (d ? String(d).split('-').reverse().slice(0, 2).join('/') : '');
async function renderMkWatch() {
    const box = document.getElementById('mk-watch');
    if (!box) return;
    if (typeof WorkHubFilterWatch === 'undefined' || typeof FilterWatch === 'undefined') { box.innerHTML = ''; return; }
    const sig = String(MK.asOf || '') + '|' + JSON.stringify(MK.saved);
    if (MKW.sig !== sig && !MKW.busy) {
        MKW.busy = true; box.innerHTML = '<div class="vl-card"><div class="vl-empty"><i class="fa-solid fa-spinner fa-spin"></i> Đang so sánh bộ lọc đã lưu…</div></div>';
        try { MKW.res = await WorkHubFilterWatch.compute({ currentRows: MK.rows, currentAsOf: MK.asOf }); } catch (e) { MKW.res = { state: 'error', message: String(e && e.message || e) }; }
        MKW.sig = sig; MKW.busy = false;
    }
    const r = MKW.res;
    if (!r) return;
    const head = '<h3 class="vl-card-title"><i class="fa-solid fa-bell" aria-hidden="true"></i> Thay đổi của bộ lọc đã lưu' + (r.state === 'ok' ? ` <span class="vl-muted">${mkDm(r.asOf)} so với ${mkDm(r.prevAsOf)}</span>` : '') + '</h3>';
    if (r.state !== 'ok') { box.innerHTML = r.state === 'web' ? '' : `<div class="vl-card">${head}<p class="vl-hint" style="margin:0">${VU.esc(r.message || '')}</p></div>`; return; }
    const chips = (list, cls) => list.slice(0, 30).map(x => `<a class="mkw-chip ${cls}" href="/valuation/#stock/${encodeURIComponent(x.symbol)}" title="${VU.esc((x.name ? x.name + ' · ' : '') + (x.reason || ''))}">${VU.esc(x.symbol)}</a>`).join('') + (list.length > 30 ? `<span class="vl-muted">+${list.length - 30} mã khác</span>` : '');
    const rows = r.items.map((it, i) => {
        if (!it.comparable) return `<div class="mkw-item"><b>${VU.esc(it.name)}</b><p class="vl-hint" style="margin:2px 0 0">Chưa so sánh được: ${VU.esc(it.why || '')}</p></div>`;
        const none = !it.entered.length && !it.left.length;
        return `<div class="mkw-item"><div class="mkw-head"><b>${VU.esc(it.name)}</b><span class="vl-muted">${it.nowCount} mã hiện tại (trước ${it.beforeCount})</span>
            ${none ? '<span class="vl-muted">không đổi</span>' : `<span class="pnl-up-text">+${it.entered.length} mới</span><span class="pnl-down-text">−${it.left.length} rớt</span>`}
            <button type="button" class="vl-link" onclick="mkSavedUse(${i})">Áp bộ lọc này</button></div>
            ${it.entered.length ? `<div class="mkw-line"><span>Mới lọt vào</span>${chips(it.entered, 'in')}</div>` : ''}
            ${it.left.length ? `<div class="mkw-line"><span>Vừa rớt ra</span>${chips(it.left, 'out')}</div><ul class="mkw-why">${it.left.slice(0, 8).map(x => `<li><b>${VU.esc(x.symbol)}</b>: ${VU.esc(x.reason)}</li>`).join('')}${it.left.length > 8 ? `<li class="vl-muted">+${it.left.length - 8} mã khác</li>` : ''}</ul>` : ''}</div>`;
    }).join('');
    box.innerHTML = `<div class="vl-card">${head}${rows}<p class="vl-hint" style="margin:8px 0 0">So kết quả của từng bộ lọc đã lưu trên ảnh chụp thị trường của hai ngày gần nhất lưu trong máy này. Mã "mới lọt vào" chưa phải khuyến nghị mua: mở hồ sơ để xem lý do. Khi mở app vào ngày có dữ liệu mới, nếu có mã mới lọt vào app gửi một thông báo.</p></div><div id="mkv"></div>`;
    renderMkValid();
}

// ---------- kiểm chứng bộ lọc bằng lịch sử ảnh chụp trong máy (lib/filter-validate.js): mã lọt vào bộ lọc 1/3/6 tháng sau so với trung vị thị trường ----------
const MKV = { busy: false, progress: null, res: null };
const mkPP = (v) => (v === null || v === undefined ? '—' : (v >= 0 ? '+' : '−') + VU.dec(Math.abs(v * 100), 1));
function renderMkValid() {
    const box = document.getElementById('mkv');
    if (!box || typeof FilterValidate === 'undefined' || typeof WorkHubFilterWatch.validate !== 'function') return;
    const r = MKV.res || WorkHubFilterWatch.lastValidation();
    const title = '<h3 class="vl-card-title"><i class="fa-solid fa-flask" aria-hidden="true"></i> Kiểm chứng bộ lọc bằng lịch sử</h3>';
    const btn = `<button type="button" class="btn-save" onclick="mkValidateRun()"${MKV.busy ? ' disabled' : ''}>${MKV.busy ? '<i class="fa-solid fa-spinner fa-spin"></i> Đang đọc lịch sử…' : '<i class="fa-solid fa-play"></i> ' + (r && r.state === 'ok' ? 'Tính lại' : 'Kiểm chứng ngay')}</button>`;
    const prog = MKV.busy && MKV.progress ? `<span class="vl-muted">${MKV.progress.done}/${MKV.progress.total} ngày</span>` : '';
    let body = '';
    if (r && r.state === 'ok') {
        const hdr = `<th>Bộ lọc</th><th class="num" title="Số mã lọt vào bộ lọc (mỗi mã tính một lần, rớt rồi vào lại trong 30 ngày không tính lại) và số ngày có mã mới lọt vào">Sự kiện</th>${FilterValidate.HORIZONS.map(h => `<th class="num" title="Chênh lệch trung vị của lợi suất ${h.label} sau khi lọt vào so với trung vị thị trường cùng kỳ; số % mã hơn thị trường; số sự kiện đã đủ thời gian">${h.label} sau</th>`).join('')}`;
        const cell = (h) => {
            if (!h.n) return `<td class="num"><span class="vl-muted">${h.pending ? 'chưa đủ thời gian' : 'chưa có số liệu'}</span></td>`;
            const cls = h.medianExcess > 0 ? 'pnl-up-text' : (h.medianExcess < 0 ? 'pnl-down-text' : '');
            return `<td class="num"><b class="${cls}">${mkPP(h.medianExcess)} điểm %</b><small>${VU.dec(h.beat * 100, 0)}% mã hơn · ${h.n} sự kiện / ${h.dates} ngày${h.enough ? '' : ' · mẫu nhỏ'}</small></td>`;
        };
        const rows = r.filters.map(f => f.events ? `<tr><td><b>${VU.esc(f.name)}</b></td><td class="num">${f.events}<small>${f.entryDates} ngày lọt vào</small></td>${f.horizons.map(cell).join('')}</tr>`
            : `<tr><td><b>${VU.esc(f.name)}</b></td><td colspan="4"><span class="vl-muted">${VU.esc(f.note || 'Chưa có sự kiện nào.')}</span></td></tr>`).join('');
        body = `<div class="spreadsheet-wrapper vl-table-wrap"><table class="vl-scen sc-table"><thead><tr>${hdr}</tr></thead><tbody>${rows}</tbody></table></div>
            <p class="vl-hint" style="margin:6px 0 0">Tính lúc ${VU.esc(String(r.at || '').slice(0, 16).replace('T', ' '))} trên ${r.days} ngày lịch sử (${mkDm(r.first)} đến ${mkDm(r.last)})${r.skipped ? `, bỏ ${r.skipped} tệp không đọc được` : ''}. Số trong ô là chênh lệch trung vị so với thị trường: dương nghĩa là các mã này tăng hơn mã thường của thị trường sau khi lọt vào.</p>`;
    } else if (r && r.state) body = `<p class="vl-hint" style="margin:0">${VU.esc(r.message || '')}</p>`;
    else body = '<p class="vl-hint" style="margin:0">Chưa chạy. Bấm nút để đọc toàn bộ lịch sử ảnh chụp trong máy và đo xem các mã từng lọt vào bộ lọc đã lưu đi thế nào 1, 3, 6 tháng sau đó.</p>';
    box.innerHTML = `<div class="vl-card">${title}<div class="mkv-bar">${btn}${prog}</div>${body}
        <p class="vl-hint" style="margin:8px 0 0">Cách đo: lợi suất sau h tháng lấy từ biến động giá h tháng ghi trong ảnh chụp của ngày gần mốc đó nhất, so với trung vị của mọi mã cùng kỳ trong chính ảnh chụp ấy. Lưu ý: mã bị hủy niêm yết hoặc mất số liệu bị bỏ ra nên kết quả có thể đẹp hơn thực tế; các mã cùng ngày chịu chung nhịp thị trường nên số sự kiện lớn hơn số mẫu độc lập; lịch sử chỉ có những ngày bạn mở app. Dưới ${FilterValidate.MIN_EVENTS} sự kiện hoặc ${FilterValidate.MIN_DATES} ngày lọt vào thì chỉ để tham khảo. Đây là công cụ phân tích, không phải khuyến nghị đầu tư.</p></div>`;
}
async function mkValidateRun() {
    if (MKV.busy) return;
    MKV.busy = true; MKV.progress = null; renderMkValid();
    try { MKV.res = await WorkHubFilterWatch.validate((p) => { MKV.progress = p; renderMkValid(); }); }
    catch (e) { MKV.res = { state: 'error', message: String(e && e.message || e) }; }
    MKV.busy = false; renderMkValid();
}

// ---------- bản đồ nhiệt ngành (lib/sector-heatmap.js) ----------
const mkSgn = (v, d) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : (v < 0 ? '−' : '')) + VU.dec(Math.abs(v * 100), d === undefined ? 1 : d) + '%');
const mkRel = (v) => (v === null || v === undefined ? '—' : (v >= 0 ? '+' : '−') + VU.dec(Math.abs(v * 100), 1));
const hmClass = (b) => (b === null || b === undefined ? 'hm-bn' : (b === 0 ? 'hm-b0' : 'hm-b' + (b < 0 ? 'd' + (-b) : 'u' + b)));    // bậc màu -> lớp CSS (null = thiếu số liệu)
function renderMkHeat() {
    const box = document.getElementById('mk-heat');
    if (!box) return;
    const names = {}; MK.rows.forEach(r => { if (r.icb2_code) names[r.icb2_code] = mkIcbName(r.icb2_code); });
    const H = SectorHeatmap.build(MK.rows, MKH.key, { names }), per = SectorHeatmap.periodOf(MKH.key);
    const chips = SectorHeatmap.PERIODS.map(p => `<button type="button" class="vl-chip" aria-pressed="${p.key === MKH.key}" onclick="mkHeatPeriod('${p.key}')">${VU.esc(p.label)}</button>`).join('');
    const mk = H.market, head = `<h3 class="vl-card-title"><i class="fa-solid fa-table-cells" aria-hidden="true"></i> Bản đồ nhiệt ngành <span class="vl-muted">biến động giá ${VU.esc(per.label)} · diện tích theo vốn hoá</span></h3>
        <div class="sc-presets" role="group" aria-label="Kỳ xem biến động giá">${chips}</div>`;
    if (H.empty) { box.innerHTML = `<div class="vl-card hm-card">${head}<div class="vl-empty">Kỳ “${VU.esc(per.label)}” chưa có đủ số liệu trong ảnh chụp thị trường. Số liệu mới được nạp mỗi ngày làm việc lúc 18:20; hãy thử lại sau hoặc chọn kỳ khác.</div></div>`; return; }
    const shown = H.sectors.filter(s => s.cap > 0), W = 100, HH = 56;
    const rects = SectorHeatmap.treemap(shown.map(s => ({ key: s.code || '_', value: s.cap })), W, HH), by = {}; shown.forEach(s => { by[s.code || '_'] = s; });
    const sel = new Set(MK.filters.icbs);
    const tile = (r) => {
        const s = by[r.key], b = s.ok ? SectorHeatmap.bucket(s.chg, MKH.key) : null, big = r.w >= 11 && r.h >= 10, mid = r.w >= 7 && r.h >= 7, code = s.code || '', on = !!(code && sel.has(code));
        const tip = `${s.name}: ${s.ok ? mkSgn(s.chg) + ' (so với thị trường ' + mkRel(s.rel) + ' điểm %)' : 'chưa đủ số liệu'} · ${s.n} mã · vốn hoá ${VU.dec(s.cap / 1e12, 1)} nghìn tỷ${s.up === null ? '' : ' · ' + VU.dec(s.up * 100, 0) + '% mã tăng'}`;
        const cls = hmClass(b);
        return `<button type="button" class="hm-tile ${cls}${on ? ' hm-sel' : ''}" style="left:${(r.x / W * 100).toFixed(3)}%;top:${(r.y / HH * 100).toFixed(3)}%;width:${(r.w / W * 100).toFixed(3)}%;height:${(r.h / HH * 100).toFixed(3)}%" title="${VU.esc(tip)}" aria-pressed="${on}" aria-label="${VU.esc(tip)}"${code ? ` onclick="mkHeatToggle('${code}')"` : ' disabled'}>${mid ? `<span class="hm-name">${VU.esc(s.name)}</span><span class="hm-chg">${s.ok ? mkSgn(s.chg) : 'thiếu số liệu'}</span>` : ''}${big ? `<span class="hm-sub">${s.n} mã · ${VU.dec(s.cap / 1e12, 0)} nghìn tỷ</span>` : ''}</button>`;
    };
    const legend = [-3, -2, -1, 0, 1, 2, 3].map(b => `<span class="hm-leg ${hmClass(b)}">${b === 0 ? '≈ 0' : (b < 0 ? '−' : '+') + VU.dec(Math.abs(b) / 3 * per.span * 100, 0) + '%'}</span>`).join('');
    const sorted = shown.filter(s => s.ok).sort((a, b) => b.chg - a.chg).concat(shown.filter(s => !s.ok));
    const trs = sorted.map(s => {
        const code = s.code || '', on = !!(code && sel.has(code));
        return `<tr><td>${code ? `<button type="button" class="vl-link" aria-pressed="${on}" onclick="mkHeatToggle('${code}')" title="${on ? 'Bỏ ngành khỏi bộ lọc' : 'Thêm ngành vào bộ lọc bên dưới'}">${on ? '✓ ' : ''}${VU.esc(s.name)}</button>` : VU.esc(s.name)}</td><td class="num">${s.n}</td><td class="num">${VU.dec(s.cap / 1e12, 1)}</td>
            <td class="num">${s.ok ? `<b class="${s.chg >= 0 ? 'pnl-up-text' : 'pnl-down-text'}">${mkSgn(s.chg)}</b>` : '—'}</td><td class="num">${s.ok ? mkRel(s.rel) : '—'}</td><td class="num">${mkSgn(s.median)}</td><td class="num">${s.up === null ? '—' : VU.dec(s.up * 100, 0) + '%'}</td><td class="num">${s.pe === null ? '—' : VU.dec(s.pe, 1) + 'x'}</td>
            <td><small>${s.biggest.map(x => `${VU.esc(x.symbol)} ${x.chg === null ? '' : mkSgn(x.chg, 0)}`).join(' · ')}</small></td><td><small>${s.best ? `${VU.esc(s.best.symbol)} ${mkSgn(s.best.chg, 0)}` : '—'}${s.worst ? ` / ${VU.esc(s.worst.symbol)} ${mkSgn(s.worst.chg, 0)}` : ''}</small></td></tr>`;
    }).join('');
    box.innerHTML = `<div class="vl-card hm-card">${head}
        <p class="hm-market">Toàn thị trường: <b class="${mk.chg >= 0 ? 'pnl-up-text' : 'pnl-down-text'}">${mkSgn(mk.chg)}</b> (bình quân theo vốn hoá) · trung vị ${mkSgn(mk.median)} · ${mk.up === null ? '—' : VU.dec(mk.up * 100, 0) + '%'} mã tăng · ${mk.n} mã</p>
        <div class="hm-map" role="group" aria-label="Bản đồ nhiệt ngành: bấm một ô để chọn hoặc bỏ chọn ngành trong bộ lọc">${rects.map(tile).join('')}</div>
        <div class="hm-list" role="group" aria-label="Danh sách ngành theo biến động giá">${sorted.map(s => { const code = s.code || '', on = !!(code && sel.has(code)); return `<button type="button" class="hm-row ${hmClass(s.ok ? SectorHeatmap.bucket(s.chg, MKH.key) : null)}${on ? ' hm-sel' : ''}" aria-pressed="${on}"${code ? ` onclick="mkHeatToggle('${code}')"` : ' disabled'}><span class="hm-rname">${VU.esc(s.name)}<small>${s.n} mã · ${VU.dec(s.cap / 1e12, 0)} nghìn tỷ</small></span><b>${s.ok ? mkSgn(s.chg) : 'thiếu số liệu'}</b></button>`; }).join('')}</div>
        <div class="hm-legend" aria-hidden="true">${legend}</div>
        <details class="hm-details"><summary>Bảng chi tiết theo ngành (${shown.length} ngành)</summary>
            <div class="spreadsheet-wrapper vl-table-wrap"><table class="vl-scen sc-table"><thead><tr><th>Ngành</th><th class="num">Số mã</th><th class="num" title="Tổng vốn hoá, nghìn tỷ đồng">Vốn hoá</th><th class="num" title="Bình quân gia quyền theo vốn hoá của các mã có số liệu">Biến động</th><th class="num" title="Chênh lệch so với toàn thị trường, điểm phần trăm">So TT</th><th class="num" title="Trung vị biến động các mã trong ngành">Trung vị</th><th class="num" title="Tỷ lệ mã có giá tăng trong kỳ">Mã tăng</th><th class="num" title="P/E trung vị của các mã có lãi">P/E</th><th>Vốn hoá lớn nhất</th><th title="Mã từ 1.000 tỷ đồng: tăng mạnh nhất / giảm mạnh nhất trong kỳ">Mạnh / yếu nhất</th></tr></thead><tbody>${trs}</tbody></table></div>
        </details>
        <p class="vl-hint">Bấm một ô (hoặc tên ngành trong bảng) để thêm hoặc bỏ ngành đó khỏi bộ lọc bên dưới${MK.filters.icbs.length ? ` · đang chọn ${MK.filters.icbs.length} ngành. <button type="button" class="vl-link" onclick="mkHeatGo()">Xem danh sách mã</button>` : ''}. Mô tả biến động giá đã qua để biết ngành nào mạnh hay yếu; không phải tín hiệu mua bán.</p></div>`;
}
function mkHeatPeriod(key) { if (!SectorHeatmap.PERIODS.some(p => p.key === key)) return; MKH.key = key; try { localStorage.setItem(MK_HEAT_KEY, JSON.stringify({ key })); } catch (e) { /* bỏ qua */ } renderMkHeat(); }
function mkHeatToggle(code) {
    const box = document.querySelector(`#mk-root [data-mk-icb="${code}"]`);
    if (!box) return;
    box.checked = !box.checked;
    mkOnInput(); renderMkHeat();
}
function mkHeatGo() { const el = document.getElementById('mk-results'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

function mkValCells(sym) {
    const x = MK.vals[sym];
    if (!x) return '<td class="num">—</td><td class="num">—</td><td>—</td>';
    if (!x.ok) return `<td class="num" colspan="3"><small title="${VU.esc(x.reason || '')}">không định giá được: ${VU.esc((x.reason || '').slice(0, 40))}</small></td>`;
    const cls = x.mos === null ? '' : (x.mos >= 0.2 ? 'vl-pill-cheap' : (x.mos <= -0.1 ? 'vl-pill-expensive' : 'vl-pill-fair'));
    return `<td class="num">${VU.dec(x.fairBase, 0)}</td><td class="num">${x.mos === null ? '—' : `<span class="vl-pill ${cls}">${x.mos > 0 ? '+' : ''}${VU.dec(x.mos * 100, 0)}%</span>`}</td><td><small>${VU.esc(x.grade || '')}</small>${x.confidence ? `<small class="symbol-sub">${VU.esc(x.confidence)}</small>` : ''}${x.archetype ? `<small class="symbol-sub">${VU.esc(x.archetype)}</small>` : ''}</td>`;
}
function mkRow(e, i, showVal) {
    const r = e.row, m = r.m, inTable = state.items.some(x => x.symbol === r.symbol);
    const peHist = m.pe > 0 && m.pe5y > 0 ? m.pe / m.pe5y : null;
    return `<tr data-mk-symbol="${VU.esc(r.symbol)}"><td>${i + 1}</td>
        <td><b>${VU.esc(r.symbol)}</b>${r.name ? `<span class="symbol-sub">${VU.esc(r.name)}</span>` : ''}<span class="symbol-sub">${VU.esc(mkIcbName(r.icb2_code))}${r.exchange ? ' · ' + VU.esc(r.exchange) : ''}</span>${e.flags.map(f => `<span class="symbol-sub mk-flag"><i class="fa-solid fa-triangle-exclamation"></i> ${VU.esc(f)}</span>`).join('')}</td>
        <td class="num">${e.score === null ? '—' : VU.dec(e.score, 0)}</td>
        <td class="num">${m.marketcap > 0 ? VU.dec(m.marketcap / 1e9, 0) : '—'}</td>
        <td class="num">${mkX(m.pe)}${peHist !== null ? `<small>${VU.dec(peHist * 100, 0)}% TB 5 năm</small>` : ''}</td>
        <td class="num">${mkX(m.pb, 2)}</td>
        <td class="num">${r.financial ? 'n/a' : mkX(m.evEbitda)}${!r.financial && r.evEbitdaRel !== null && r.evEbitdaRel !== undefined ? `<small>${VU.dec(r.evEbitdaRel * 100, 0)}% trung vị ngành</small>` : ''}</td>
        <td class="num">${r.valuationPct === null ? '—' : `<span class="vl-pill ${r.valuationPct <= 30 ? 'vl-pill-cheap' : (r.valuationPct >= 70 ? 'vl-pill-expensive' : 'vl-pill-fair')}">${VU.dec(r.valuationPct, 0)}</span>`}</td>
        <td class="num">${mkP(m.roae)}</td><td class="num">${mkP(m.epsGrowthYoY, 0)}</td><td class="num">${mkP(m.netProfitGrowthYoY, 0)}</td><td class="num">${mkP(m.divYield)}</td>
        <td class="num">${r.financial ? 'n/a' : mkX(m.debtToEquity)}</td><td class="num">${mkChg(m.chgYtd)}</td><td class="num">${mkChg(m.chg1y)}</td>${showVal ? mkValCells(r.symbol) : ''}
        <td><a class="vl-link" href="/valuation/#stock/${encodeURIComponent(r.symbol)}" title="Mở hồ sơ định giá chi tiết trong Valuation Bench">Hồ sơ</a> ${inTable ? '<span class="vl-tag">Trong bảng</span>' : `<button type="button" class="vl-link" data-mk-add="${VU.esc(r.symbol)}">Thêm vào bảng</button>`}</td></tr>`;
}

function renderMkResults() {
    const box = document.getElementById('mk-results');
    if (!box) return;
    const res = MarketScreener.evaluate(MK.rows, MK.filters), c = res.counts;
    const miss = Object.keys(c.missing).map(k => ({ k, n: c.missing[k] })).sort((a, b) => b.n - a.n);
    const hasVals = res.entries.some(e => MK.vals[e.row.symbol]);
    const ordered = MK.sort === 'mos' && hasVals ? MarketBatch.rankByMos(res.entries, MK.vals) : res.entries;
    const shown = ordered.slice(0, MK.limit), b = MK.batch, running = !!(b && b.running);
    const nVal = Math.min(res.entries.length, MK_BATCH_MAX);
    const toolbar = `<div class="mk-toolbar">
        <button type="button" class="btn-save" onclick="mkValueAll()"${running ? ' disabled' : ''} title="Chạy bộ máy Valuation Bench với giả định mặc định cho từng mã trong danh sách (tối đa ${MK_BATCH_MAX} mã mỗi lần), rồi xếp theo biên an toàn. Không lưu gì lên máy chủ."><i class="fa-solid fa-scale-balanced"></i> Định giá cả danh sách (${nVal} mã)</button>
        ${running ? `<button type="button" class="vl-link" onclick="mkValueCancel()">Dừng</button><span class="vl-muted">đang định giá ${b.done}/${b.total}${b.failed ? ` · ${b.failed} mã lỗi` : ''}…</span><progress max="${b.total}" value="${b.done}"></progress>` : ''}
        ${hasVals ? `<label class="mk-sort"><input type="checkbox"${MK.sort === 'mos' ? ' checked' : ''} onchange="mkSortToggle(this.checked)"> Xếp theo biên an toàn</label>` : ''}
        <button type="button" class="vl-link" onclick="mkExportCsv()"><i class="fa-solid fa-file-csv"></i> Xuất CSV</button>
    </div>`;
    const head =`<h3 class="vl-card-title"><i class="fa-solid fa-ranking-star"></i> ${c.active ? `${c.passed} mã đạt` : 'Chưa bật tiêu chí nào'}<span class="vl-muted">trong ${c.universe} mã${c.active ? ' · xếp theo điểm tổng hợp' : ''}${c.cut ? ` · đã cắt ${c.cut} mã theo giới hạn số mã (đạt ${c.matched})` : ''}</span></h3>`;
    if (!c.active) { box.innerHTML = `<div class="vl-card">${head}<div class="vl-empty">Chọn một mẫu lọc hoặc nhập ít nhất một tiêu chí ở trên.</div></div>`; return; }
    if (!c.passed) {
        const worst = Object.keys(c.failedBy).map(k => ({ k, n: c.failedBy[k] })).sort((a, b) => b.n - a.n)[0];
        box.innerHTML = `<div class="vl-card">${head}<div class="vl-empty">Không mã nào đạt mọi tiêu chí.${worst ? ` Tiêu chí loại nhiều nhất: <b>${VU.esc(MarketScreener.BY_KEY[worst.k].label)}</b> (${worst.n} mã). Thử nới tiêu chí này.` : ''}</div></div>`;
        return;
    }
    box.innerHTML = `<div class="vl-card">${head}${toolbar}
        <div class="spreadsheet-wrapper vl-table-wrap"><table class="vl-scen sc-table"><thead><tr><th>#</th><th>Mã</th><th class="num" title="Điểm tổng hợp 0-100 để xếp hạng, không phải khuyến nghị">Điểm</th><th class="num">Vốn hoá (tỷ)</th><th class="num">P/E</th><th class="num">P/B</th><th class="num" title="Giá trị doanh nghiệp / EBITDA hoạt động 4 quý; không áp dụng cho ngân hàng, bảo hiểm, chứng khoán">EV/EBITDA</th><th class="num" title="Phân vị định giá trong ngành: 0 = rẻ nhất ngành">Rẻ so với ngành</th><th class="num">ROE</th><th class="num">Tăng trưởng EPS</th><th class="num" title="Lợi nhuận ròng 12 tháng so với cùng kỳ">Tăng trưởng LN ròng</th><th class="num">Cổ tức</th><th class="num">Nợ/vốn</th><th class="num" title="Giá hiện tại so với giá đóng cửa cuối năm trước">Giá từ 1/1</th><th class="num">Giá 12 tháng</th>${hasVals ? '<th class="num" title="Giá trị hợp lý đồng thuận của Valuation Bench (giả định mặc định)">Giá trị hợp lý (đ)</th><th class="num" title="(Giá trị hợp lý - giá hiện tại) / giá trị hợp lý">Biên an toàn</th><th>Kết luận</th>' : ''}<th></th></tr></thead>
        <tbody>${shown.map((e, i) => mkRow(e, i, hasVals)).join('')}</tbody></table></div>
        ${hasVals ? '<p class="vl-hint">Cột định giá do bộ máy Valuation Bench tính tự động với giả định MẶC ĐỊNH (tự phân loại mô hình kinh doanh, không điều chỉnh khoản bất thường, chưa rà soát từng bước), không lưu. Dùng để sàng và xếp hạng; mở “Hồ sơ” để xem quy trình, chỉnh giả định và lưu bản định giá chính thức.</p>' : ''}
        ${res.entries.length > MK.limit ? `<p class="vl-hint"><button type="button" class="vl-link" onclick="mkMore()">Hiện thêm</button> (đang hiện ${MK.limit}/${res.entries.length})</p>` : ''}
        ${miss.length ? `<p class="vl-hint">Mã bị loại vì thiếu số liệu: ${miss.map(x => `${VU.esc(MarketScreener.BY_KEY[x.k].label)} (${x.n})`).join(', ')}. Mã thiếu số liệu cho tiêu chí đang bật không được tính là đạt.</p>` : ''}
        <p class="vl-hint">Điểm ghép định giá tương đối trong ngành (30%), chất lượng (30%), tăng trưởng (20%), cổ tức (10%), an toàn tài chính (10%); chỉ để xếp hạng. Nợ/vốn không áp dụng cho ngân hàng, bảo hiểm, dịch vụ tài chính. Số liệu là chỉ số công bố của VNDirect, chưa soát với báo cáo tài chính gốc: coi kết quả là danh sách để nghiên cứu tiếp, không phải khuyến nghị mua bán. Mã thêm vào bảng sẽ tự lấy số liệu tài chính để định giá chi tiết.</p></div>`;
}

function mkOnInput() {
    const values = {};
    document.querySelectorAll('#mk-root [data-mk]').forEach(el => { if (el.value !== '') { const n = Number(el.value); if (isFinite(n)) values[el.getAttribute('data-mk')] = n; } });
    const opt = (k) => { const el = document.querySelector(`#mk-root [data-mk-opt="${k}"]`); return el ? el.value : ''; };
    const icbs = [...document.querySelectorAll('#mk-root [data-mk-icb]')].filter(el => el.checked).map(el => el.getAttribute('data-mk-icb'));
    MK.filters = MarketScreener.normalizeFilters({ values, icbs, perSector: opt('perSector'), topN: opt('topN') });
    const head = document.querySelector('#mk-root .mk-icb-head small'); if (head) head.textContent = `(${icbs.length ? 'đã chọn ' + icbs.length : 'tất cả ngành'})`;
    MK.preset = null; MK.limit = 50; mkSave();
    document.querySelectorAll('#mk-root .sc-presets [aria-pressed]').forEach(b => b.setAttribute('aria-pressed', 'false'));
    renderMkResults();
}
function mkPreset(key) {
    const p = MarketScreener.PRESETS.find(x => x.key === key); if (!p) return;
    MK.filters = MarketScreener.normalizeFilters({ values: Object.assign({}, p.values), icbs: MK.filters.icbs, perSector: p.perSector || 0, topN: MK.filters.topN }); MK.preset = key; MK.limit = 50; mkSave(); renderMarketScreener();
}
function mkReset() { MK.filters = MarketScreener.normalizeFilters({}); MK.preset = null; MK.limit = 50; mkSave(); renderMarketScreener(); }
function mkIcbAll(on) {
    document.querySelectorAll('#mk-root [data-mk-icb]').forEach(el => { el.checked = on; });
    mkOnInput();
}
function mkMore() { MK.limit += 50; renderMkResults(); }

// ---------- bộ lọc đã lưu (chỉ trong máy này) ----------
function mkSavedSave() {
    const inp = document.getElementById('mk-saved-name'), name = inp ? inp.value.trim().slice(0, 40) : '';
    const f = MK.filters;
    if (!name) { showToast('Nhập tên cho bộ lọc trước khi lưu.', 'error'); return; }
    if (!Object.keys(f.values).length && !f.icbs.length) { showToast('Bộ lọc đang trống: bật ít nhất một tiêu chí hoặc chọn ngành.', 'error'); return; }
    const copy = JSON.parse(JSON.stringify(f)), at = MK.saved.findIndex(x => x.name === name);
    if (at >= 0) MK.saved[at] = { name, filters: copy }; else if (MK.saved.length >= 30) { showToast('Tối đa 30 bộ lọc: hãy xoá bớt.', 'error'); return; } else MK.saved.push({ name, filters: copy });
    mkSaveSaved(); renderMarketScreener();
    showToast(at >= 0 ? `Đã cập nhật bộ lọc “${name}”.` : `Đã lưu bộ lọc “${name}”.`, 'success');
}
function mkSavedUse(i) {
    const x = MK.saved[Number(i)]; if (!x) return;
    MK.filters = MarketScreener.normalizeFilters(x.filters); MK.preset = null; MK.limit = 50; mkSave(); renderMarketScreener();
    const sel = document.getElementById('mk-saved-sel'); if (sel) sel.value = String(i);
}
function mkSavedDelete() {
    const sel = document.getElementById('mk-saved-sel'), x = sel && sel.value !== '' ? MK.saved[Number(sel.value)] : null;
    if (!x) { showToast('Chọn một bộ lọc đã lưu để xoá.', 'error'); return; }
    if (!window.confirm(`Xoá bộ lọc “${x.name}”?`)) return;
    MK.saved.splice(Number(sel.value), 1); mkSaveSaved(); renderMarketScreener();
}

// ---------- định giá hàng loạt và xuất CSV ----------
async function mkValueAll() {
    if (MK.batch && MK.batch.running) return;
    const res = MarketScreener.evaluate(MK.rows, MK.filters), rows = res.entries.slice(0, MK_BATCH_MAX).map(e => e.row);
    const todo = rows.filter(r => !(MK.vals[r.symbol] && MK.vals[r.symbol].ok));
    if (!rows.length) return;
    if (!todo.length) { MK.sort = 'mos'; renderMkResults(); showToast('Cả danh sách đã được định giá.', 'success'); return; }
    if (todo.length > 25 && !window.confirm(`Định giá ${todo.length} mã: khoảng ${Math.max(1, Math.round(todo.length * 4 / 3 / 60))} phút, mỗi mã cần một lượt gọi nguồn dữ liệu. Tiếp tục?`)) return;
    if (!MK.hist) { try { MK.hist = await call('getValuationHistory', { years: 6 }); } catch (e) { MK.hist = { rows: [], bond10y: null }; } }
    MK.batch = { running: true, done: 0, total: todo.length, failed: 0, cancel: false };
    renderMkResults();
    const scorecard = typeof VB_SCORECARD !== 'undefined' ? VB_SCORECARD : null;
    try {
        const out = await MarketBatch.run(todo, {
            load: (sym) => call('getVbData', { symbol: sym, years: 6, candleYears: 2, lite: true }),
            analyze: (b, row) => VBEngine.analyze(MarketBatch.buildCtx(b.vb, row, { stats: MK.stats }, MK.hist, { scorecard, sectorName: mkIcbName(row.icb2_code) })),
            finish: (r) => MarketBatch.summarize(r, VBEngine),
        }, { concurrency: 3, retries: 1, retryDelayMs: 800, shouldCancel: () => MK.batch.cancel, onProgress: (p) => { MK.vals[p.symbol] = p.result; MK.batch.done = p.done; if (!p.result.ok) MK.batch.failed++; renderMkResults(); } });
        const failed = Object.keys(out.results).filter(k => !out.results[k].ok).length;
        showToast(out.cancelled ? `Đã dừng sau ${out.done}/${out.total} mã.` : `Đã định giá ${out.done - failed}/${out.total} mã${failed ? `, ${failed} mã không định giá được` : ''}.`, failed && !out.cancelled ? 'error' : 'success');
    } catch (e) { showToast('Lỗi khi định giá: ' + (e.message || e), 'error'); }
    MK.batch.running = false; MK.sort = 'mos'; renderMkResults();
}
function mkValueCancel() { if (MK.batch) MK.batch.cancel = true; }
function mkSortToggle(on) { MK.sort = on ? 'mos' : 'score'; renderMkResults(); }

function mkExportCsv() {
    const res = MarketScreener.evaluate(MK.rows, MK.filters);
    if (!res.entries.length) { showToast('Chưa có kết quả để xuất.', 'error'); return; }
    const hasVals = res.entries.some(e => MK.vals[e.row.symbol]);
    const entries = MK.sort === 'mos' && hasVals ? MarketBatch.rankByMos(res.entries, MK.vals) : res.entries;
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0'), name = `bo-loc-thi-truong-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.csv`;
    const bytes = new TextEncoder().encode(FinCalc.buildCsv(MarketBatch.csvRows(entries, MK.vals, mkIcbName)));
    saveBytesToDisk(name, bytes, 'text/csv;charset=utf-8;')
        .then(saved => { if (saved) showToast(`Đã xuất ${entries.length} mã: ${name}`, 'success'); })
        .catch(e => showToast('Lỗi xuất file: ' + (e.message || e), 'error'));
}

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
