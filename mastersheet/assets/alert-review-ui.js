/* --- FILE: /mastersheet/assets/alert-review-ui.js ---
   Ôn lại cảnh báo giá (Hiệu Suất > "Ôn lại cảnh báo"): mỗi cảnh báo theo mã mà LiveUI đã báo được ghi lại kèm giá lúc báo; các lần mở Danh Mục sau đó cập nhật giá phiên kế tiếp và giá gần nhất
   để biết giá ĐI TIẾP, QUAY ĐẦU hay ĐI NGANG sau cảnh báo (lib/alert-review.js). Lưu TRONG MÁY (localStorage), không ghi sổ, không gửi lên máy chủ, không có nút xoá (tự bỏ cảnh báo quá 180 ngày).
   Mỗi dòng có nút "Ghi quyết định": mở hộp thoại Nhật Ký Quyết Định (journal.js) với bối cảnh cảnh báo điền sẵn; bạn xem và sửa trước khi lưu.
   Dùng global: AlertReview, FinCalc, saveBytesToDisk, escapeAssetHtml, showToast, openDecisionModal (journal.js). */
const AlertReviewUI = (function () {
    const KEY = 'wh.fin.alerthist.v1';
    const S = { hist: [], error: '' };
    try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); if (Array.isArray(v)) S.hist = v.filter((x) => x && x.id && x.s && x.kind); } catch (e) { /* kho trống */ }

    const esc = (s) => (typeof escapeAssetHtml === 'function' ? escapeAssetHtml(s) : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
    const dm = (d) => { const p = String(d || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] : ''; };
    const vnd = (v) => (v === null || v === undefined || !isFinite(v) ? '—' : Math.round(v).toLocaleString('vi-VN'));
    const sgn = (v) => (v === null || v === undefined || !isFinite(v) ? '—' : (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%');
    const cls = (v) => (v > 0 ? 'pnl-up-text' : (v < 0 ? 'pnl-down-text' : ''));
    const vnDate = () => (typeof LiveQuotes !== 'undefined' ? LiveQuotes.vnParts().date : new Date().toISOString().slice(0, 10));
    function persist() { try { localStorage.setItem(KEY, JSON.stringify(S.hist)); S.error = ''; } catch (e) { S.error = 'Không ghi được bộ nhớ trình duyệt.'; } }

    // LiveUI gọi khi một cảnh báo theo mã được báo (a: kết quả LiveAlerts.evaluate/evaluateWatch)
    function record(a) {
        if (typeof AlertReview === 'undefined' || !a) return;
        const t = typeof LiveQuotes !== 'undefined' ? LiveQuotes.hhmmss(Math.floor(Date.now() / 1000)) : '';
        const next = AlertReview.record(S.hist, a, { date: vnDate(), time: t });
        if (next.length === S.hist.length && next.every((x, i) => x === S.hist[i])) return;
        S.hist = next; persist(); render();
    }
    // LiveUI gọi mỗi lần có giá trực tiếp mới
    function update(quotes) {
        if (typeof AlertReview === 'undefined' || !S.hist.length) return;
        const r = AlertReview.update(S.hist, quotes, vnDate());
        if (!r.changed) return;
        S.hist = r.hist; persist(); render();
    }

    function decide(id) { openDraft(S.hist.find((h) => h.id === id)); }
    // Từ dải cảnh báo trong Danh Mục (cảnh báo vừa báo, chưa chắc đã vào kho): dựng bản ghi tạm từ chính cảnh báo
    function decideLive(a) { openDraft({ date: vnDate(), time: a.time, s: a.symbol, kind: a.kind, thr: a.thr, price: a.price, pct: a.pct }); }
    function openDraft(x) {
        const d = x && AlertReview.decisionDraft(x);
        if (!d) return;
        if (typeof openDecisionModal !== 'function') { if (typeof showToast === 'function') showToast('Chưa mở được Nhật Ký Quyết Định trên trang này.', 'error'); return; }
        openDecisionModal({ prefill: d });
    }

    function render() {
        const el = document.getElementById('alert-review');
        if (!el || typeof AlertReview === 'undefined') return;
        const head = `<div class="tl-card-head"><h3 class="tl-card-title"><i class="fa-solid fa-bell" aria-hidden="true"></i> Ôn lại cảnh báo <span class="tl-hint" style="margin:0 0 0 8px">lưu trong máy này, không gửi lên máy chủ</span></h3>
            <button type="button" class="btn-tool" onclick="AlertReviewUI.exportCsv()"${S.hist.length ? '' : ' disabled'}><i class="fa-solid fa-file-csv"></i> Xuất CSV</button></div>`;
        if (!S.hist.length) { el.innerHTML = head + '<p class="tl-hint">Chưa có cảnh báo nào được ghi. Khi Danh Mục đang mở và giá trực tiếp chạm mục tiêu, cắt lỗ, giá muốn mua hoặc biến động mạnh, app ghi lại giá lúc báo; những lần mở sau, app so với giá phiên kế tiếp để cho bạn biết giá đi tiếp hay quay đầu.</p>'; return; }
        const sum = AlertReview.summarize(S.hist);
        const srows = sum.map((r) => `<tr><td>${esc(r.label)}</td><td class="text-right">${r.total}</td><td class="text-right">${r.n}</td>
            <td class="text-right">${r.n ? r.cont : '—'}</td><td class="text-right">${r.n ? r.rev : '—'}</td><td class="text-right">${r.n ? r.flat : '—'}</td>
            <td class="text-right ${cls(r.median)}">${r.median === null ? '—' : sgn(r.median)}</td><td class="ar-note${r.enough ? '' : ' tl-hint'}">${esc(r.text)}</td></tr>`).join('');
        const list = AlertReview.rows(S.hist, 15).map((r) => `<tr><td>${dm(r.date)} <small class="tl-hint" style="margin:0">${esc(r.time.slice(0, 5))}</small></td><td><b>${esc(r.s)}</b></td><td>${esc(r.label)}</td>
            <td class="text-right">${vnd(r.price)}</td><td class="text-right ${cls(r.d1Pct)}">${r.d1Pct === null ? '<span class="tl-hint" style="margin:0">chưa có</span>' : sgn(r.d1Pct) + ' <small class="tl-hint" style="margin:0">' + dm(r.d1Date) + '</small>'}</td>
            <td class="text-right ${cls(r.lastPct)}">${r.lastPct === null ? '—' : sgn(r.lastPct) + ' <small class="tl-hint" style="margin:0">' + dm(r.lastDate) + '</small>'}</td>
            <td class="text-right"><button type="button" class="btn-tool ar-decide" onclick="AlertReviewUI.decide('${esc(r.id).replace(/'/g, '')}')" title="Mở Nhật Ký Quyết Định với bối cảnh cảnh báo điền sẵn"><i class="fa-solid fa-book-open"></i> Ghi quyết định</button></td></tr>`).join('');
        el.innerHTML = head + `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Loại cảnh báo</th><th class="text-right">Số lần</th><th class="text-right" title="Đã có giá của phiên sau ngày báo">Có phiên sau</th><th class="text-right" title="Giá đi tiếp theo chiều cảnh báo từ 1% trở lên">Đi tiếp</th><th class="text-right" title="Giá quay ngược chiều cảnh báo từ 1% trở lên">Quay đầu</th><th class="text-right" title="Trong khoảng ±1% so với giá lúc báo">Đi ngang</th><th class="text-right" title="Trung vị chênh lệch giá phiên sau so với giá lúc báo, tính theo chiều cảnh báo">Trung vị</th><th>Nhận xét</th></tr></thead><tbody>${srows}</tbody></table></div>
            <div class="spreadsheet-wrapper" style="margin-top:10px"><table class="excel-table asset-table"><thead><tr><th>Ngày</th><th>Mã</th><th>Cảnh báo</th><th class="text-right">Giá lúc báo</th><th class="text-right" title="Chênh lệch giá cuối phiên đầu tiên sau ngày báo, theo chiều cảnh báo (dương = đi tiếp cùng chiều)">Phiên sau</th><th class="text-right" title="Chênh lệch giá gần nhất app thấy so với giá lúc báo, theo chiều cảnh báo">Gần nhất</th><th></th></tr></thead><tbody>${list}</tbody></table></div>
            <p class="tl-hint">Chênh lệch tính THEO CHIỀU cảnh báo: dương = giá đi tiếp cùng chiều (cắt lỗ mà giá giảm thêm, mục tiêu mà giá tăng thêm, tới giá mua mà giá còn rẻ hơn), âm = quay đầu. "Phiên sau" là giá lần cuối app thấy trong phiên đầu tiên sau ngày báo; nếu hôm đó app không mở thì lấy phiên đầu tiên bạn mở lại. Đây là thống kê riêng của bạn từ vài chục cảnh báo, chưa phải kiểm định: dưới ${AlertReview.MIN_N} cảnh báo mỗi loại thì chỉ để tham khảo, và không phải khuyến nghị đầu tư.${S.error ? ' ' + esc(S.error) : ''}</p>`;
    }

    async function exportCsv() {
        try {
            const bytes = new TextEncoder().encode(FinCalc.buildCsv(AlertReview.csvRows(S.hist)));
            const d = new Date(), name = `OnLaiCanhBao-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
            const saved = await saveBytesToDisk(name, bytes, 'text/csv;charset=utf-8;');
            if (saved && typeof showToast === 'function') showToast('Đã xuất ' + name, 'success');
        } catch (e) { if (typeof showToast === 'function') showToast('Không xuất được: ' + (e.message || e), 'error'); }
    }

    return { record, update, decide, decideLive, render, exportCsv, state: S };
})();
