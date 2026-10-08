/* --- FILE: /mastersheet/assets/accounting-link-ui.js ---
   Tab "Báo Cáo" > thẻ "Liên kết kế toán": cho thấy những gì web kế toán (OnyxLine Accounting) sẽ nhận từ Bàn Tài Sản trong một tháng --
   bút toán đề xuất theo TT200 (mua, bán, cổ tức, nạp/rút), lãi/lỗ bán ròng, giá gốc đang nắm -- và mở thẳng web kế toán để gửi đi duyệt.
   Tính bằng lib/accounting-bridge.js (cùng bản chạy trên web kế toán nên hai bên luôn ra cùng một bút toán). Dự phòng giảm giá và đối soát
   TK 121 cần số dư sổ + giá cuối kỳ nên làm ở web kế toán. Dùng global của script.js: callGAS, targetEmail, showToast, escapeAssetHtml.
   Không ghi gì lên máy chủ từ đây. */
const AccountingLinkUI = (function () {
    const URL_KEY = 'wh.fin.accounting.url.v1';
    const DEFAULT_URL = 'https://accounting-2de.pages.dev/app#finlink';
    const S = { result: null, month: null, busy: false };
    const esc = (s) => escapeAssetHtml(String(s === null || s === undefined ? '' : s));
    const vnd = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
    const signed = (n) => { const v = Math.round(Number(n) || 0); return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toLocaleString('en-US'); };
    const cls = (n) => (n > 0 ? 'tl-up' : (n < 0 ? 'tl-down' : ''));
    const dmy = (iso) => String(iso).slice(8, 10) + '/' + String(iso).slice(5, 7);

    function accountingUrl() {
        try { const u = localStorage.getItem(URL_KEY); if (u && /^https?:\/\//i.test(u)) return u; } catch (e) { /* dùng mặc định */ }
        return DEFAULT_URL;
    }
    function saveUrl(v) {
        const u = String(v || '').trim();
        try { if (!u) localStorage.removeItem(URL_KEY); else if (/^https?:\/\//i.test(u)) localStorage.setItem(URL_KEY, u); else if (typeof showToast === 'function') showToast('Địa chỉ phải bắt đầu bằng http:// hoặc https://', 'error'); } catch (e) { /* bỏ qua */ }
    }

    function init() {
        const sel = document.getElementById('rpt-acc-month');
        if (!sel) return;
        if (!sel.options || !sel.options.length) {
            const now = new Date(), opts = [];
            for (let i = 0; i < 18; i++) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const v = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
                opts.push(`<option value="${v}">Tháng ${d.getMonth() + 1}/${d.getFullYear()}${i === 0 ? ' (đang diễn ra)' : ''}</option>`);
            }
            sel.innerHTML = opts.join('');
            if (now.getDate() <= 15) sel.selectedIndex = 1;
        }
        const url = document.getElementById('rpt-acc-url');
        if (url) url.value = accountingUrl();
        const box = document.getElementById('rpt-acc-result');
        if (box && !S.result) box.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-link"></i>Chọn tháng rồi bấm “Xem bút toán đề xuất”. Web kế toán đọc cùng dữ liệu này bằng tài khoản WorkHub của bạn và đưa vào hàng đợi duyệt.</div>';
    }

    async function load() {
        const ask = async (action) => { const r = await callGAS(action, { email: targetEmail }); if (!r || r.status !== 'success') throw new Error((r && r.message) || ('Không đọc được ' + action)); return r.data || []; };
        const [txns, flows, actions] = await Promise.all([ask('listAssetTransactions'), ask('listCashFlows'), ask('listCorporateActions')]);
        return { txns, flows, actions };
    }

    async function run() {
        if (S.busy) return;
        const sel = document.getElementById('rpt-acc-month'), btn = document.getElementById('rpt-acc-btn'), box = document.getElementById('rpt-acc-result');
        if (!sel || !box) return;
        S.busy = true;
        const html = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tính…'; }
        try {
            const data = await load();
            S.month = sel.value;
            S.result = AccountingBridge.build({ txns: data.txns, flows: data.flows, actions: data.actions, period: S.month });
            render();
        } catch (e) {
            S.result = null;
            box.innerHTML = `<div class="tl-empty">Lỗi: ${esc(e.message || e)}</div>`;
        } finally {
            S.busy = false;
            if (btn) { btn.disabled = false; btn.innerHTML = html; }
        }
    }

    function render() {
        const box = document.getElementById('rpt-acc-result');
        const r = S.result;
        if (!box || !r) return;
        const s = r.summary;
        if (!s) { box.innerHTML = `<div class="tl-empty">${esc(r.issues.join(' ') || 'Không tính được kỳ này.')}</div>`; return; }
        const kpi = (k, v, sub, c) => `<div class="tl-kpi"><span class="k">${k}</span><span class="v ${c || ''}">${v}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
        const kinds = AccountingBridge.KIND_LABEL;
        const rows = r.vouchers.slice(0, 60).map((v) => {
            const side = (x) => v.lines.filter((l) => l.side === x).map((l) => l.account).join(' + ');
            return `<tr><td>${dmy(v.date)}</td><td>${esc(kinds[v.kind])}</td><td>${esc(v.memo.replace(/^\[Fin\]\s*/, ''))}</td><td>Nợ ${esc(side('N'))} / Có ${esc(side('C'))}</td><td class="text-right">${vnd(v.total)}</td></tr>`;
        }).join('');
        const more = r.vouchers.length > 60 ? `<p class="tl-hint">Hiển thị 60 trên ${r.vouchers.length} bút toán — tệp CSV có đủ.</p>` : '';
        const notes = [].concat(r.skipped.map((k) => 'Bỏ qua: ' + k.reason), r.notes, r.issues);
        box.innerHTML = `
            <div class="tl-kpis">
                ${kpi('Bút toán đề xuất', String(s.voucherCount), `${s.buyCount} mua · ${s.sellCount} bán`)}
                ${kpi('Lãi/lỗ bán — ròng', signed(s.realizedNet), `Lãi ${vnd(s.gainTotal)} · Lỗ ${vnd(s.lossTotal)}`, cls(s.realizedNet))}
                ${kpi('Cổ tức tiền', vnd(s.dividends), 'Ghi có TK 515')}
                ${kpi('Phí + thuế bán', vnd(s.sellFees + s.sellTaxes), `Phí ${vnd(s.sellFees)} · Thuế ${vnd(s.sellTaxes)}`)}
                ${kpi('Nạp − rút ròng', signed(s.deposits - s.withdrawals), `Nạp ${vnd(s.deposits)} · Rút ${vnd(s.withdrawals)}`, cls(s.deposits - s.withdrawals))}
                ${kpi('Giá gốc đang nắm', vnd(s.costHeld), 'Cuối kỳ, theo FIFO — để đối soát TK 121')}
            </div>
            ${notes.length ? `<ul class="tl-note-list">${notes.map((t) => `<li><i class="fa-solid fa-triangle-exclamation"></i><span>${esc(t)}</span></li>`).join('')}</ul>` : ''}
            ${r.vouchers.length ? `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Ngày</th><th>Nghiệp vụ</th><th>Diễn giải</th><th>Định khoản</th><th class="text-right">Số tiền</th></tr></thead><tbody>${rows}</tbody></table></div>${more}` : '<div class="tl-empty"><i class="fa-regular fa-folder-open"></i>Không có nghiệp vụ nào trong tháng này.</div>'}
            <div class="tl-card-tools" style="margin-top:12px">
                <button type="button" class="btn-save" onclick="AccountingLinkUI.openAccounting()"><i class="fa-solid fa-arrow-up-right-from-square"></i> Mở web kế toán</button>
                <button type="button" class="btn-tool" onclick="AccountingLinkUI.exportCsv()"${r.vouchers.length ? '' : ' disabled'}><i class="fa-solid fa-file-csv"></i> Tải CSV bút toán</button>
            </div>
            <p class="tl-hint">Đây là đề xuất để kế toán soát lại. Bấm “Mở web kế toán” → mục Đầu tư (WorkHub Fin) để gửi vào hàng đợi duyệt; ở đó còn tính dự phòng giảm giá chứng khoán và đối soát TK 121 với số dư sổ.</p>`;
    }

    function csvRows() {
        const rows = [['Số chứng từ đề xuất', 'Ngày', 'Nghiệp vụ', 'Diễn giải', 'Tài khoản', 'Bên', 'Số tiền']];
        (S.result ? S.result.vouchers : []).forEach((v) => v.lines.forEach((l) => rows.push([v.id, v.date, AccountingBridge.KIND_LABEL[v.kind], v.memo.replace(/^\[Fin\]\s*/, ''), l.account, l.side === 'N' ? 'Nợ' : 'Có', l.amount])));
        return rows;
    }
    async function exportCsv() {
        if (!S.result || !S.result.vouchers.length) return;
        try {
            const name = `but-toan-de-xuat-${S.month}.csv`;
            const saved = await saveBytesToDisk(name, new TextEncoder().encode(FinCalc.buildCsv(csvRows())), 'text/csv;charset=utf-8;');
            if (saved && typeof showToast === 'function') showToast('Đã lưu ' + name, 'success');
        } catch (e) { if (typeof showToast === 'function') showToast('Không xuất được: ' + (e.message || e), 'error'); }
    }

    function openAccounting() {
        const url = accountingUrl();
        if (typeof openExternalUrl === 'function') openExternalUrl(url);
        else if (typeof window !== 'undefined' && window.open) window.open(url, '_blank', 'noopener');
    }

    return { init, run, render, exportCsv, openAccounting, saveUrl, csvRows, accountingUrl, state: S, DEFAULT_URL };
})();
