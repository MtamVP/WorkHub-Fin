/* --- FILE: /mastersheet/group-data.js ---
   Trang Toàn Nhóm > "Dữ Liệu": sức khoẻ của dữ liệu đầu vào -- các hàm định kỳ có chạy đúng hạn không, cảnh báo chất lượng giá (hai nguồn lệch, nhảy giá vượt biên độ, thiếu phiên),
   độ phủ phân ngành ICB, đường cong lợi suất trái phiếu (lãi phi rủi ro) và nguồn dữ liệu đang dùng. Số liệu sai đầu vào làm sai mọi con số phía sau (NAV, rủi ro, hiệu quả) nên đây là nơi kiểm trước.
   Dữ liệu từ Edge Function market-data-sync (finance_data_health, finance_function_runs, finance_rates, finance_stock_meta) và độ tươi của các bảng giá/NAV/tuân thủ đã có.
   Dùng global của group.js (GR, grCall, grRender), group-limits.js (GL, glDate) và assets/risk.js (rkEsc, rkNum, rkKpi). */

const GD = { state: 'idle', error: '', health: [], runs: [], rates: [], probes: [], filter: 'open', loadedKey: '' };

const GD_KIND = {
    price_mismatch: ['Hai nguồn giá lệch', 'bad'], price_jump: ['Nhảy giá vượt biên độ', 'warn'], price_level: ['Khác cách điều chỉnh giá', 'mute'],
    stale_price: ['Giá cũ / dừng giao dịch', 'warn'], missing_session: ['Thiếu phiên', 'warn'], source_down: ['Nguồn dữ liệu lỗi', 'bad'], meta_gap: ['Mã chưa có ngành', 'mute'],
    source_probe: ['Nguồn giá trực tiếp lỗi', 'bad'], snapshot_stale: ['Ảnh chụp thị trường chậm', 'bad'],
};
const GD_PROBE_LABEL = { vci: 'Bảng giá VCI (giá trực tiếp)', finfo: 'VNDirect finfo (dự phòng)', dchart: 'VNDirect dchart (nến, VN-Index)' };
// Cảnh báo do source-watch: mô tả ngắn
function gdProbeText(h) {
    const d = h.detail || {};
    if (h.kind === 'snapshot_stale') return d.asOf ? `${d.source || 'Ảnh chụp thị trường'}: số liệu ngày ${glDate(d.asOf + 'T00:00:00')}, chậm ${d.behind} ngày giao dịch` : 'Ảnh chụp thị trường: chưa có số liệu';
    if (d.level === 'day') return `${d.source}: lỗi quá nửa số lần thăm dò hai ngày giao dịch liên tiếp (hôm nay ${d.today && d.today.ok}/${d.today && d.today.total} đạt)`;
    return `${d.source}: ${d.failed} lần thăm dò liên tiếp thất bại`;
}
// Thăm dò trong phiên: mỗi nguồn một dòng gồm kết quả hôm nay (theo ngày giờ máy), 7 ngày, lần gần nhất
function gdProbeRows() {
    const today = new Date(); const dayKey = (iso) => { const d = new Date(iso); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }, tk = today.getFullYear() + '-' + today.getMonth() + '-' + today.getDate();
    return ['vci', 'finfo', 'dchart'].map(k => {
        const mine = GD.probes.filter(r => r.mode === 'probe:' + k), t = mine.filter(r => dayKey(r.run_at) === tk), last = mine[0] || null, lastOk = mine.find(r => r.ok) || null;
        const rate = (a) => (a.length ? Math.round(a.filter(r => r.ok).length / a.length * 100) : null);
        const ms = mine.filter(r => r.ok).slice(0, 10).map(r => r.duration_ms).filter(x => x > 0);
        return { key: k, label: GD_PROBE_LABEL[k], today: { ok: t.filter(r => r.ok).length, total: t.length }, rate7: rate(mine), last, lastOk, avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null };
    });
}
const GD_SEV = { error: 'bad', warn: 'warn', info: 'mute' };
// Hạn chạy tối đa (giờ) trước khi coi là "trễ": rates/health chạy ngày làm việc nên cho 3 ngày để qua cuối tuần; meta chạy hằng tuần
const GD_MAX_AGE_H = { meta: 24 * 9, rates: 24 * 3.5, health: 24 * 3.5, snapshot: 24 * 3.5 };

function gdAge(iso) { const h = (Date.now() - Date.parse(iso)) / 3600000; return isFinite(h) ? h : null; }
function gdAgeText(h) { return h === null ? '—' : (h < 1 ? Math.max(1, Math.round(h * 60)) + ' phút trước' : (h < 48 ? Math.round(h) + ' giờ trước' : Math.round(h / 24) + ' ngày trước')); }
function gdManager() { return !!(typeof GL !== 'undefined' && GL.actor && GL.actor.isManager); }

async function gdLoad(force) {
    if (GD.state === 'loading') return;
    const key = GR.data ? GR.data.fetchedAt : '';
    if (GD.state === 'ok' && !force && GD.loadedKey === key) { grRender(); return; }
    GD.state = 'loading'; GD.error = ''; grRender();
    try {
        const [health, runs, rates, probes] = await Promise.all([grCall('listDataHealth', { days: 60 }), grCall('listFunctionRuns', { days: 21 }).catch(() => []), grCall('getMarketRates', { days: 400 }).catch(() => []), grCall('listSourceProbes', { days: 7 }).catch(() => [])]);
        GD.health = health || []; GD.runs = runs || []; GD.rates = rates || []; GD.probes = probes || [];
        GD.state = 'ok'; GD.loadedKey = key;
        const b = document.getElementById('grp-data-badge'), n = GD.health.filter(h => !h.resolved && h.severity !== 'info').length;
        if (b) { b.textContent = n ? String(n) : ''; b.style.display = n ? '' : 'none'; }
    } catch (e) { GD.state = 'error'; GD.error = e.message || String(e); }
    grRender();
}

// Chấm đỏ trên nút tab: số cảnh báo lỗi/cảnh báo đang mở (đọc nhẹ, gọi sau khi tải dữ liệu nhóm; lỗi thì bỏ qua)
async function gdBadge() {
    try {
        const rows = await grCall('listDataHealth', { days: 7 });
        const n = (rows || []).filter(h => !h.resolved && h.severity !== 'info').length;
        const b = document.getElementById('grp-data-badge');
        if (b) { b.textContent = n ? String(n) : ''; b.style.display = n ? '' : 'none'; }
    } catch (e) { /* không có bảng / chưa đăng nhập: bỏ qua */ }
}

async function gdResolve(id) {
    const el = document.getElementById('gd-note-' + id);
    const note = el ? el.value.trim() : '';
    if (note.length < 3) { showToast('Ghi chú xử lý cần ít nhất 3 ký tự.', 'error'); return; }
    try { showToast(await grCall('resolveDataHealth', { id, note, email: (GL.actor && GL.actor.actorEmail) || '' }), 'success'); await gdLoad(true); } catch (e) { showToast('Lỗi: ' + e.message, 'error'); }
}
function gdSetFilter(v) { GD.filter = v; grRender(); }

// Đường cong lợi suất mới nhất: mỗi kỳ hạn lấy bản ghi mới nhất
function gdCurve() {
    const latest = {};
    GD.rates.forEach(r => { if (!latest[r.tenor] || r.rate_date > latest[r.tenor].rate_date) latest[r.tenor] = r; });
    return ['1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '15Y'].map(t => latest[t]).filter(Boolean);
}

// Độ tươi của dữ liệu đã có: giá cổ phiếu, bản chụp NAV, nhật ký tuân thủ
function gdFreshness() {
    const out = [];
    const maxDate = (rows, f) => rows.reduce((m, r) => { const d = String(f(r) || '').slice(0, 10); return d > m ? d : m; }, '');
    const days = (d) => d ? Math.max(0, Math.round((Date.now() - Date.parse(d + 'T00:00:00Z')) / 86400000)) : null;
    const prices = (GR.data && GR.data.prices) || [], navs = (GR.data && GR.data.navHistory) || [];
    const p = maxDate(prices, r => r.price_date || r.updated_at), n = maxDate(navs, r => r.snapshot_date), c = maxDate((typeof GL !== 'undefined' && GL.log) || [], r => r.log_date);
    out.push({ name: 'Giá cổ phiếu (fetch-stock-prices)', date: p, days: days(p), limit: 4 });
    out.push({ name: 'Bản chụp NAV hằng ngày', date: n, days: days(n), limit: 4 });
    out.push({ name: 'Nhật ký tuân thủ giới hạn (check-limits)', date: c, days: days(c), limit: 5 });
    return out;
}

// Sổ đăng ký mô hình (lib/model-registry.js): mô hình nào, tham số, nguồn, đã kiểm chứng thế nào, giới hạn đã biết
function gdRegistryHtml() {
    if (typeof ModelRegistry === 'undefined') return '';
    const groups = ModelRegistry.byArea();
    return `<div class="ce-group-title">Sổ đăng ký mô hình <small style="font-weight:400">(phiên bản ${rkEsc(ModelRegistry.VERSION)})</small></div>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Mô hình</th><th>Phương pháp và tham số</th><th>Nguồn dữ liệu</th><th>Kiểm chứng</th><th>Giới hạn đã biết</th></tr></thead><tbody>
        ${Object.keys(groups).map(a => groups[a].map(m => `<tr><td><b>${rkEsc(m.name)}</b><span class="symbol-sub">${rkEsc(m.area)}</span></td>
            <td class="gr-reason">${rkEsc(m.method)}<span class="symbol-sub">${rkEsc(m.params)}</span></td><td class="gr-reason">${rkEsc(m.data)}</td>
            <td class="gr-reason"><span class="tl-badge ${m.validation.golden ? 'ok' : 'info'}">${m.validation.golden ? 'Đối chiếu số chuẩn' : 'Kiểm thử đơn vị'}</span><span class="symbol-sub">${rkEsc(m.validation.note)}</span></td>
            <td class="gr-reason">${rkEsc(m.limits)}</td></tr>`).join('')).join('')}
        </tbody></table></div>
        <p class="tl-hint">Số chuẩn do Python (numpy/scipy) sinh ra và được kiểm thử tự động mỗi lần đẩy mã. Sổ này cũng là danh sách để rà soát định kỳ: khi quy định thị trường hoặc nguồn dữ liệu đổi, các mô hình ở đây là nơi phải kiểm tra lại.</p>`;
}

function grDataHtml() {
    if (GD.state === 'loading' || GD.state === 'idle') return '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang kiểm tra sức khoẻ dữ liệu…</div>';
    if (GD.state === 'error') return `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không tải được: ${rkEsc(GD.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="gdLoad(true)">Thử lại</button></div>`;
    const manager = gdManager();
    const open = GD.health.filter(h => !h.resolved), errors = open.filter(h => h.severity === 'error').length, warns = open.filter(h => h.severity === 'warn').length;
    const lastBy = {}; GD.runs.forEach(r => { if (!lastBy[r.mode] || r.run_at > lastBy[r.mode].run_at) lastBy[r.mode] = r; });
    const modes = [['meta', 'Thông tin mã + phân ngành ICB', 'hằng tuần'], ['rates', 'Lợi suất trái phiếu chính phủ', 'mỗi ngày làm việc'], ['health', 'Kiểm chất lượng giá (hai nguồn)', 'mỗi ngày làm việc'], ['snapshot', 'Ảnh chụp thị trường + thống kê ngành + lịch sử định giá', 'mỗi ngày làm việc']];
    const lateModes = modes.filter(([m]) => { const r = lastBy[m]; return !r || !r.ok || gdAge(r.run_at) > GD_MAX_AGE_H[m]; }).length;
    const fresh = gdFreshness(), staleData = fresh.filter(f => f.days === null || f.days > f.limit).length;
    const meta = GL && GR.portfolios ? SectorMap.coverage(GR.portfolios.flatMap(p => p.holdings.map(h => h.symbol)), FinCalc.sectorOf) : { total: 0, known: 0, unknown: [] };
    const curve = gdCurve(), y1 = curve.find(c => c.tenor === '1Y'), y10 = curve.find(c => c.tenor === '10Y');

    let html = `<div class="tl-kpis">${[
        rkKpi('Cảnh báo dữ liệu đang mở', String(open.length), `${errors} lỗi · ${warns} cảnh báo`, errors ? 'tl-down' : (warns ? '' : 'tl-up')),
        rkKpi('Hàm định kỳ trễ / lỗi', String(lateModes), lateModes ? 'xem bảng Lịch chạy' : 'chạy đúng hạn', lateModes ? 'tl-down' : 'tl-up'),
        rkKpi('Dữ liệu cũ', String(staleData), staleData ? 'giá / NAV / tuân thủ chưa cập nhật' : 'giá, NAV, tuân thủ còn mới', staleData ? 'tl-down' : 'tl-up'),
        rkKpi('Độ phủ phân ngành', meta.total ? `${meta.known}/${meta.total}` : '—', meta.unknown.length ? 'chưa có: ' + meta.unknown.slice(0, 5).join(', ') : 'mã nào cũng có ngành'),
        rkKpi('Lãi phi rủi ro (TPCP 1 năm)', y1 ? rkNum(y1.yield_pct, 2) + '%' : '—', y1 ? `cập nhật ${glDate(y1.rate_date + 'T00:00:00')}` + (y10 ? ` · 10 năm ${rkNum(y10.yield_pct, 2)}%` : '') : 'chưa có dữ liệu'),
    ].join('')}</div>`;

    // Lịch chạy
    html += `<div class="ce-group-title">Hàm chạy nền</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Tác vụ</th><th>Lịch</th><th>Lần chạy gần nhất</th><th>Kết quả</th></tr></thead><tbody>
        ${modes.map(([m, label, sched]) => { const r = lastBy[m], age = r ? gdAge(r.run_at) : null, late = !r || !r.ok || age > GD_MAX_AGE_H[m];
            const d = r && r.detail && r.detail[m] ? r.detail[m] : null;
            const brief = d ? (d.ok === false ? rkEsc(d.error || 'lỗi') : Object.keys(d).filter(k => k !== 'ok').slice(0, 4).map(k => `${rkEsc(k)} ${rkEsc(String(d[k]))}`).join(' · ')) : '';
            return `<tr><td><b>${label}</b><span class="symbol-sub">market-data-sync · ${m}</span></td><td>${sched}</td><td>${r ? gdAgeText(age) + `<span class="symbol-sub">${rkEsc(String(r.run_at).slice(0, 16).replace('T', ' '))} UTC · ${r.duration_ms || 0} ms</span>` : '<span class="tl-badge bad">chưa chạy</span>'}</td>
                <td>${late ? `<span class="tl-badge bad">${!r ? 'Chưa có lần chạy' : (r.ok ? 'Trễ hạn' : 'Lỗi')}</span>` : '<span class="tl-badge ok"><i class="fa-solid fa-check"></i> Tốt</span>'} <small>${brief}</small></td></tr>`; }).join('')}
        ${fresh.map(f => `<tr><td><b>${rkEsc(f.name)}</b></td><td>ngày giao dịch</td><td>${f.date ? glDate(f.date + 'T00:00:00') + `<span class="symbol-sub">${f.days} ngày trước</span>` : '—'}</td><td>${f.days === null || f.days > f.limit ? '<span class="tl-badge bad">Cũ</span>' : '<span class="tl-badge ok"><i class="fa-solid fa-check"></i> Còn mới</span>'}</td></tr>`).join('')}
        </tbody></table></div>`;

    // Nguồn giá trong phiên (source-watch thăm dò mỗi 30 phút trong giờ giao dịch)
    const pr = gdProbeRows(), anyProbe = pr.some(p => p.last);
    html += `<div class="ce-group-title">Nguồn giá trực tiếp (thăm dò mỗi 30 phút trong phiên)</div>` + (anyProbe ? `<div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Nguồn</th><th class="text-right">Hôm nay</th><th class="text-right">7 ngày</th><th>Lần gần nhất</th><th class="text-right">Độ trễ TB</th></tr></thead><tbody>
        ${pr.map(p => { const bad = p.last && !p.last.ok; return `<tr><td><b>${rkEsc(p.label)}</b></td><td class="text-right">${p.today.total ? `${p.today.ok}/${p.today.total}` : '—'}</td><td class="text-right">${p.rate7 === null ? '—' : p.rate7 + '%'}</td>
            <td>${p.last ? `<span class="tl-badge ${bad ? 'bad' : 'ok'}">${bad ? 'Lỗi' : 'Tốt'}</span> ${gdAgeText(gdAge(p.last.run_at))}${bad && p.lastOk ? `<span class="symbol-sub">lần tốt gần nhất ${gdAgeText(gdAge(p.lastOk.run_at))}</span>` : ''}` : '—'}</td><td class="text-right">${p.avgMs === null ? '—' : (p.avgMs / 1000).toFixed(1) + ' giây'}</td></tr>`; }).join('')}
        </tbody></table></div><p class="tl-hint">Hàm source-watch gọi thử ba nguồn mà giá trực tiếp phụ thuộc. Nguồn lỗi 4 lần liền thì có cảnh báo bên dưới; lỗi quá nửa số lần trong hai ngày giao dịch liên tiếp, hoặc ảnh chụp thị trường chậm từ 2 ngày giao dịch, thì email quản lý. App tự quay về giá VNDirect khi bảng giá VCI lỗi.</p>` : '<div class="tl-empty" style="padding:14px">Chưa có lần thăm dò nào (hàm source-watch chạy trong giờ giao dịch của ngày làm việc).</div>');

    // Cảnh báo
    const shown = GD.health.filter(h => GD.filter === 'all' || (GD.filter === 'open' ? !h.resolved : h.resolved));
    html += `<div class="ce-group-title">Cảnh báo chất lượng dữ liệu <select class="tl-select" style="margin-left:10px;font-weight:400" onchange="gdSetFilter(this.value)" aria-label="Lọc">${[['open', 'Đang mở'], ['done', 'Đã xử lý'], ['all', 'Tất cả']].map(([v, l]) => `<option value="${v}" ${GD.filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
    html += shown.length ? `<div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Loại</th><th>Mã</th><th>Ngày</th><th>Chi tiết</th><th>Xử lý</th></tr></thead><tbody>
        ${shown.slice(0, 120).map(h => { const k = GD_KIND[h.kind] || [h.kind, 'mute'], d = h.detail || {};
            const detail = (h.kind === 'source_probe' || h.kind === 'snapshot_stale') ? gdProbeText(h) : h.kind === 'price_mismatch' ? `VNDirect ${rkNum(d.vndirect, 0)} · VCI ${rkNum(d.vci, 0)} (${d.diffPct > 0 ? '+' : ''}${rkNum(d.diffPct, 2)}%)`
                : (h.kind === 'price_jump' ? `${rkNum(d.prev, 0)} → ${rkNum(d.close, 0)} (${d.retPct > 0 ? '+' : ''}${rkNum(d.retPct, 2)}%, biên độ ±${rkNum(d.bandPct, 0)}%)`
                : (h.kind === 'price_level' ? `chênh đều hệ số ${rkNum(d.factor, 4)}` : (h.kind === 'stale_price' ? `giá cuối ${glDate((d.lastBar || '') + 'T00:00:00')}, chậm ${d.sessionsBehind} phiên` : (h.kind === 'missing_session' ? `thiếu ${(d.missing || []).map(x => glDate(x + 'T00:00:00')).join(', ')}` : (h.kind === 'meta_gap' ? `${d.count} mã: ${(d.symbols || []).slice(0, 8).join(', ')}` : (d.source ? `${d.source}: ${d.failed}/${d.of} mã lỗi` : ''))))));
            return `<tr><td><span class="tl-badge ${GD_SEV[h.severity] || 'mute'}">${rkEsc(k[0])}</span></td><td><b>${rkEsc(h.symbol || '—')}</b></td><td>${h.ref_date ? glDate(h.ref_date + 'T00:00:00') : glDate(h.detected_at)}</td><td class="gr-reason">${rkEsc(detail)}${d.note ? `<span class="symbol-sub">${rkEsc(d.note)}</span>` : ''}</td>
                <td>${h.resolved ? `<span class="gr-reason">${rkEsc(h.resolve_note || '')}</span>` : (manager ? `<div class="gq-act"><input type="text" id="gd-note-${h.id}" class="tl-input" maxlength="500" placeholder="Ghi chú xử lý"><button type="button" class="btn-tool" onclick="gdResolve('${h.id}')"><i class="fa-solid fa-check"></i> Đã xử lý</button></div>` : '<span class="tl-hint" style="margin:0">Chờ quản lý</span>')}</td></tr>`; }).join('')}
        </tbody></table></div>` : '<div class="tl-empty" style="padding:14px"><i class="fa-solid fa-circle-check" style="color:var(--success-color);opacity:1"></i>Không có cảnh báo nào.</div>';

    // Đường cong lợi suất
    if (curve.length) html += `<div class="ce-group-title">Đường cong lợi suất trái phiếu chính phủ</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr>${curve.map(c => `<th class="text-right">${c.tenor}</th>`).join('')}</tr></thead><tbody><tr>${curve.map(c => `<td class="text-right">${rkNum(c.yield_pct, 2)}%</td>`).join('')}</tr></tbody></table></div>
        <p class="tl-hint">Lãi phi rủi ro dùng cho Sharpe, alpha và chi phí vốn lấy từ lợi suất kỳ hạn 1 năm theo từng ngày. Lịch sử bắt đầu từ ngày hệ thống chạy lần đầu (${glDate(GD.rates.reduce((m, r) => (m && m < r.rate_date ? m : r.rate_date), '') + 'T00:00:00')}); các ngày trước đó dùng mức cài đặt tay.</p>`;

    html += gdRegistryHtml();

    html += `<div class="ce-group-title">Nguồn dữ liệu đang dùng</div><ul class="gr-rep-notes">
        <li><b>Giá đóng cửa, chỉ số, khối lượng:</b> VNDirect (dchart) — nguồn chính; kiểm chéo với VCI mỗi ngày làm việc.</li>
        <li><b>Báo cáo tài chính, sự kiện doanh nghiệp, cổ tức:</b> VNDirect (finfo).</li>
        <li><b>Phân ngành ICB, sàn niêm yết, rổ VN30:</b> VCI và VNDirect, cập nhật hằng tuần.</li>
        <li><b>Lợi suất trái phiếu chính phủ:</b> TradingView (điểm cuối công khai), chụp mỗi ngày làm việc.</li>
    </ul><p class="tl-hint">Tất cả là điểm cuối công khai, không có cam kết dịch vụ và có thể đổi hoặc chặn bất cứ lúc nào — vì vậy có kiểm chéo hai nguồn giá và bảng cảnh báo này. Khi một nguồn lỗi, các con số phụ thuộc vào nó (NAV, rủi ro, hiệu quả) có thể sai hoặc cũ mà không báo gì nếu không có lớp kiểm này.</p>`;
    return html;
}
