/* --- FILE: /mastersheet/assets/session-ui.js ---
   Nhật ký phiên cuối ngày (Hiệu Suất > "Nhật ký phiên"): mỗi phiên app tóm tắt lãi/lỗ ngày, so với VN-Index, mã tăng/giảm mạnh nhất, mã đóng góp, cảnh báo đã báo (lib/session-log.js)
   rồi LƯU TRONG MÁY: localStorage (nguồn chính) và một bản sao tệp session-log/session-log.json trong thư mục dữ liệu của app (bản desktop). Không ghi lên Supabase, không đụng sổ/NAV.
   LiveUI (live-ui.js) gọi record() mỗi lần có giá trực tiếp: trong phiên ghi bản tạm (tối đa 5 phút một lần), sau 14:50 ghi bản cuối phiên. Không có nút xoá: dữ liệu chỉ tăng (giữ tối đa 400 phiên).
   Dùng global: SessionLog, FinCalc, saveBytesToDisk, escapeAssetHtml, showToast. */
const SessionUI = (function () {
    const KEY = 'wh.fin.sessionlog.v1', DIR = 'session-log', FILE = 'session-log.json';
    const S = { store: {}, lastWrite: 0, mirror: '', error: '' };
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && typeof v === 'object' && !Array.isArray(v)) S.store = v; } catch (e) { /* kho trống */ }

    const esc = (s) => (typeof escapeAssetHtml === 'function' ? escapeAssetHtml(s) : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
    const dmy = (d) => { const p = String(d || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : ''; };
    const num = (v, d) => (v === null || v === undefined || !isFinite(v) ? '—' : Number(v).toLocaleString('vi-VN', { minimumFractionDigits: d === undefined ? 0 : d, maximumFractionDigits: d === undefined ? 0 : d }));
    const sgn = (v, d) => (v === null || v === undefined || !isFinite(v) ? '—' : (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toLocaleString('vi-VN', { minimumFractionDigits: d === undefined ? 2 : d, maximumFractionDigits: d === undefined ? 2 : d }));
    const cls = (v) => (v > 0 ? 'pnl-up-text' : (v < 0 ? 'pnl-down-text' : ''));

    function persist() { try { localStorage.setItem(KEY, JSON.stringify(S.store)); } catch (e) { S.error = 'Không ghi được bộ nhớ trình duyệt.'; } }
    // Bản sao tệp trong thư mục dữ liệu của app (best-effort; bản web hoặc thiếu quyền thì bỏ qua)
    async function mirror() {
        try {
            const T = window.__TAURI__ && window.__TAURI__.fs;
            if (!T) return;
            const base = T.BaseDirectory.AppLocalData;
            if (!(await T.exists(DIR, { baseDir: base }))) await T.mkdir(DIR, { baseDir: base, recursive: true });
            await T.writeTextFile(DIR + '/' + FILE, JSON.stringify({ v: 1, savedAt: new Date().toISOString(), sessions: S.store }), { baseDir: base });
            if (!S.mirror && window.__TAURI__.path && window.__TAURI__.path.appLocalDataDir) S.mirror = (await window.__TAURI__.path.appLocalDataDir()).replace(/[\\/]+$/, '') + '\\' + DIR + '\\' + FILE;
            render();
        } catch (e) { /* không có quyền ghi tệp: vẫn còn bản trong bộ nhớ trình duyệt */ }
    }

    // ctx: { session, hasToday, date, holdings, totals, nav, index, alerts, series, source }
    function record(ctx) {
        if (typeof SessionLog === 'undefined' || !ctx) return;
        const m = SessionLog.mode(ctx.session, ctx.hasToday);
        if (!m) return;
        const rec = SessionLog.build(Object.assign({}, ctx, { mode: m }));
        if (!rec) return;
        const cur = S.store[rec.date];
        if (m === 'partial' && cur && Date.now() - S.lastWrite < 300000) return;                                       // bản tạm: tối đa 5 phút một lần
        if (m === 'final' && cur && cur.final && cur.dayPnl === rec.dayPnl && (cur.alerts || []).length === rec.alerts.length) return;   // không có gì mới
        S.store = SessionLog.merge(S.store, rec); S.lastWrite = Date.now();
        persist(); mirror(); render();
    }

    function render() {
        const el = document.getElementById('session-log');
        if (!el || typeof SessionLog === 'undefined') return;
        const st = SessionLog.stats(S.store), days = Object.keys(S.store).sort().reverse().map((k) => S.store[k]).slice(0, 30);
        const head = `<div class="tl-card-head"><h3 class="tl-card-title"><i class="fa-solid fa-book-open" aria-hidden="true"></i> Nhật ký phiên <span class="tl-hint" style="margin:0 0 0 8px">lưu trong máy này, không gửi lên máy chủ</span></h3>
            <button type="button" class="btn-tool" onclick="SessionUI.exportCsv()"${days.length ? '' : ' disabled'}><i class="fa-solid fa-file-csv"></i> Xuất CSV</button></div>`;
        if (!days.length) { el.innerHTML = head + '<p class="tl-hint">Chưa có phiên nào. App ghi một bản tóm tắt mỗi phiên khi bạn mở Danh Mục lúc sàn đang mở hoặc vừa đóng cửa (sau 14:50). Sau vài tuần bạn có chuỗi phiên để so với VN-Index.</p>'; return; }
        const kpi = (k, v, s, c) => `<div class="tl-kpi"><span class="k">${k}</span><span class="v ${c || ''}">${v}</span>${s ? `<span class="s">${s}</span>` : ''}</div>`;
        const kpis = st.n ? `<div class="tl-kpis">${[
            kpi('Số phiên đã ghi', String(st.n), `${dmy(st.from)} đến ${dmy(st.to)}`),
            kpi('Phiên hơn VN-Index', st.nIdx ? `${st.beat}/${st.nIdx}` : '—', st.nIdx ? Math.round(st.beat / st.nIdx * 100) + '% số phiên có chỉ số' : 'chưa có chỉ số'),
            kpi('Hơn/kém chỉ số trung bình', st.avgRel === null ? '—' : sgn(st.avgRel) + ' điểm %', 'mỗi phiên', cls(st.avgRel)),
            kpi('Phiên tốt nhất', sgn(st.best.pct) + '%', dmy(st.best.date), cls(st.best.pct)), kpi('Phiên xấu nhất', sgn(st.worst.pct) + '%', dmy(st.worst.date), cls(st.worst.pct)),
            kpi('Cộng dồn các phiên', sgn(st.cumPct) + '%', st.cumIndexPct === null ? 'cổ phiếu, không gồm tiền mặt' : 'VN-Index ' + sgn(st.cumIndexPct) + '%', cls(st.cumPct)),
        ].join('')}</div>` : '';
        const rows = days.map((r) => `<tr><td>${dmy(r.date)}${r.final ? '' : ' <span class="tl-badge mute" title="Bản tạm ghi giữa phiên; sẽ thay bằng bản cuối phiên khi bạn mở app sau 14:50">tạm</span>'}</td>
            <td class="text-right ${cls(r.dayPnl)}">${r.dayPnl > 0 ? '+' : (r.dayPnl < 0 ? '−' : '')}${num(Math.abs(r.dayPnl))}</td><td class="text-right ${cls(r.dayPct)}">${sgn(r.dayPct)}%</td>
            <td class="text-right ${cls(r.indexPct)}">${r.indexPct === null ? '—' : sgn(r.indexPct) + '%'}</td><td class="text-right ${cls(r.rel)}">${r.rel === null ? '—' : sgn(r.rel)}</td>
            <td class="text-right">${r.up}/${r.down}</td><td>${(r.best || []).slice(0, 2).map((x) => `${esc(x.s)} ${sgn(x.pct, 1)}%`).join(', ') || '—'}</td><td>${(r.worst || []).slice(0, 2).map((x) => `${esc(x.s)} ${sgn(x.pct, 1)}%`).join(', ') || '—'}</td>
            <td class="text-right" title="${esc((r.alerts || []).map((a) => a.t + ' ' + a.title).join('\n'))}">${(r.alerts || []).length || '—'}</td></tr>`).join('');
        el.innerHTML = head + kpis + `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Ngày</th><th class="text-right">Lãi/lỗ ngày (đ)</th><th class="text-right">% ngày</th><th class="text-right">% VN-Index</th><th class="text-right" title="Chênh lệch % của danh mục cổ phiếu so với chỉ số, điểm phần trăm">Hơn/kém</th><th class="text-right" title="Số mã tăng / giảm trong phiên">Tăng/giảm</th><th>Mạnh nhất</th><th>Yếu nhất</th><th class="text-right">Cảnh báo</th></tr></thead><tbody>${rows}</tbody></table></div>
            <p class="tl-hint">% ngày tính trên giá trị cổ phiếu đang nắm theo giá tham chiếu hôm qua (không gồm tiền mặt, cùng cách với dòng giá trực tiếp); mã bạn mua hoặc bán giữa phiên làm số liệu lệch nhẹ. Giá từ nguồn công khai, có thể trễ vài giây đến 2 phút. Chỉ ghi những phiên bạn mở app.${S.mirror ? ' Bản sao tệp: ' + esc(S.mirror) : ''}</p>`;
    }

    async function exportCsv() {
        try {
            const bytes = new TextEncoder().encode(FinCalc.buildCsv(SessionLog.csvRows(S.store)));
            const d = new Date(), name = `NhatKyPhien-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
            const saved = await saveBytesToDisk(name, bytes, 'text/csv;charset=utf-8;');
            if (saved && typeof showToast === 'function') showToast('Đã xuất ' + name, 'success');
        } catch (e) { if (typeof showToast === 'function') showToast('Không xuất được: ' + (e.message || e), 'error'); }
    }

    return { record, render, exportCsv, state: S };
})();
