/* --- FILE: /mastersheet/assets/ledger-tools.js ---
   Sổ lệnh: biểu phí tự tính (phí + thuế bán), lưu file ra đĩa, nhập sao kê CSV/Excel của công ty chứng khoán.
   Dùng global của script.js (callGAS, targetEmail, showToast, escapeAssetHtml, loadLedger, loadHoldings, loadKpis, TAB_LOADED)
   và PortfolioCalc / StatementImport. */

// ---------------------------------------------------------------------------------------------
// Lưu file: app desktop -> hộp thoại "Lưu thành" của hệ điều hành; trình duyệt -> tải xuống thường.
// Ghi qua lệnh sync_write_file có sẵn (root = thư mục người dùng vừa chọn, relative = tên file) nên không cần cấp thêm quyền ghi đĩa.
// ---------------------------------------------------------------------------------------------
function bytesToBase64(u8) {
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
}

async function saveBytesToDisk(filename, bytes, mime) {
    if (window.__TAURI__ && window.__TAURI__.dialog && window.__TAURI__.dialog.save && window.__TAURI__.core) {
        const ext = (filename.split('.').pop() || '').toLowerCase();
        const path = await window.__TAURI__.dialog.save({ defaultPath: filename, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
        if (!path) return false;                                   // người dùng bấm Huỷ
        const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
        const dir = cut >= 0 ? path.slice(0, cut) || path.slice(0, cut + 1) : '.';
        const name = cut >= 0 ? path.slice(cut + 1) : path;
        await window.__TAURI__.core.invoke('sync_write_file', { root: dir, relativePath: name, contentBase64: bytesToBase64(bytes) });
        return path;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return filename;
}

// ---------------------------------------------------------------------------------------------
// Biểu phí
// ---------------------------------------------------------------------------------------------
const FEE_SETTINGS_KEY = 'wh_fin_fee_settings';

function getFeeSettings() {
    const d = PortfolioCalc.DEFAULT_RATES;
    try {
        const s = JSON.parse(localStorage.getItem(FEE_SETTINGS_KEY) || 'null');
        if (s && isFinite(s.buyFeeRate) && isFinite(s.sellFeeRate) && isFinite(s.sellTaxRate)) return Object.assign({ auto: true }, s);
    } catch (e) { /* dùng mặc định */ }
    return { auto: true, buyFeeRate: d.buyFeeRate, sellFeeRate: d.sellFeeRate, sellTaxRate: d.sellTaxRate };
}

function saveFeeSettings(s) {
    try { localStorage.setItem(FEE_SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* không chặn */ }
}

function feeRatesOnly(s) { return { buyFeeRate: s.buyFeeRate, sellFeeRate: s.sellFeeRate, sellTaxRate: s.sellTaxRate }; }

function toggleFeePanel() {
    const panel = document.getElementById('fee-panel');
    if (!panel) return;
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) renderFeePanel();
}

function renderFeePanel() {
    const s = getFeeSettings();
    const pct = (r) => String(Math.round(r * 100000) / 1000);        // 0.0015 -> "0.15"
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('fee-buy-rate', pct(s.buyFeeRate)); set('fee-sell-rate', pct(s.sellFeeRate)); set('fee-tax-rate', pct(s.sellTaxRate));
}

function onFeeSettingsChange() {
    const read = (id, fallback) => { const v = parseFloat(String(document.getElementById(id).value).replace(',', '.')); return isFinite(v) && v >= 0 && v <= 5 ? v / 100 : fallback; };
    const d = getFeeSettings();
    saveFeeSettings({ auto: d.auto, buyFeeRate: read('fee-buy-rate', d.buyFeeRate), sellFeeRate: read('fee-sell-rate', d.sellFeeRate), sellTaxRate: read('fee-tax-rate', d.sellTaxRate) });
    updateTxnFeePreview();
}

function onAutoFeesToggle(box) {
    const s = getFeeSettings();
    s.auto = !!box.checked;
    saveFeeSettings(s);
    updateTxnFeePreview();
}

// Phí/thuế dự kiến của lệnh đang nhập (hiện làm gợi ý trong ô; để trống ô thì lúc lưu dùng đúng số này)
function computeTxnFees() {
    const s = getFeeSettings();
    const type = document.getElementById('txn-type').value;
    const qty = parseMoney(document.getElementById('txn-quantity').value);
    const price = parseMoney(document.getElementById('txn-price').value);
    if (!s.auto || !(qty > 0) || !(price > 0)) return { fee: 0, tax: 0, auto: false };
    const f = PortfolioCalc.feesFor(type, qty, price, feeRatesOnly(s));
    return { fee: f.fee, tax: f.tax, auto: true };
}

function updateTxnFeePreview() {
    const feeEl = document.getElementById('txn-fee'), taxEl = document.getElementById('txn-tax');
    if (!feeEl || !taxEl) return;
    const sell = document.getElementById('txn-type').value === 'sell';
    taxEl.disabled = !sell;
    taxEl.closest('.txn-field').style.opacity = sell ? '' : '0.45';
    const f = computeTxnFees();
    feeEl.placeholder = f.auto ? '≈ ' + f.fee.toLocaleString('en-US') : '0';
    taxEl.placeholder = f.auto && sell ? '≈ ' + f.tax.toLocaleString('en-US') : '0';
    const box = document.getElementById('txn-auto-fees');
    if (box) box.checked = getFeeSettings().auto;
}

// Gọi từ handleTxnSubmit: điền phí/thuế tự tính cho ô còn trống
function applyAutoFeesToTxn(txn) {
    const out = Object.assign({}, txn);
    const f = computeTxnFees();
    const feeBlank = String(txn.fee === undefined || txn.fee === null ? '' : txn.fee).trim() === '' || Number(txn.fee) === 0;
    const taxBlank = String(txn.tax === undefined || txn.tax === null ? '' : txn.tax).trim() === '' || Number(txn.tax) === 0;
    if (f.auto && feeBlank) out.fee = f.fee;
    if (f.auto && taxBlank && txn.type === 'sell') out.tax = f.tax;
    if (txn.type !== 'sell') out.tax = 0;
    return out;
}

document.addEventListener('DOMContentLoaded', () => {
    ['txn-quantity', 'txn-price'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', updateTxnFeePreview); });
    const seg = document.querySelector('#txn-form .seg');
    if (seg) seg.addEventListener('click', () => setTimeout(updateTxnFeePreview, 0));
    updateTxnFeePreview();
});

// ---------------------------------------------------------------------------------------------
// NHẬP SAO KÊ
// ---------------------------------------------------------------------------------------------
const FIELD_LABELS = {
    date: 'Ngày giao dịch', symbol: 'Mã CK', side: 'Loại lệnh (Mua/Bán)', quantity: 'Khối lượng', price: 'Giá',
    value: 'Giá trị (tuỳ chọn)', fee: 'Phí (tuỳ chọn)', tax: 'Thuế (tuỳ chọn)', ref: 'Số hiệu lệnh (tuỳ chọn)', note: 'Ghi chú (tuỳ chọn)'
};
const REQUIRED_FIELDS = ['date', 'symbol', 'side', 'quantity'];     // "price" hoặc "value" phải có ít nhất 1

let importState = null;
let lastImportBatch = null;

function openImportModal() {
    if (!navigator.onLine) { showToast('Đang mất mạng — cần kết nối để nhập sao kê.', 'error'); return; }
    importState = { fileName: '', sheets: [], sheetIndex: 0, rows: [], headerRow: 0, mapping: {}, normalized: null, preview: null, busy: false, result: null };
    renderImportModal();
    document.getElementById('import-modal').classList.add('open');
}

function closeImportModal() {
    document.getElementById('import-modal').classList.remove('open');
    importState = null;
}

function importStepIndex() {
    if (!importState || !importState.rows.length) return 0;
    return importState.result ? 3 : 2;
}

function renderImportModal() {
    const body = document.getElementById('import-body');
    if (!body) return;
    const step = importStepIndex();
    // bước hiện tại: 0 = chọn file, 1 = kiểm tra & ghép cột, 3 = xong
    const on = step === 0 ? 0 : (step === 3 ? 3 : 1);
    const stepsHtml = ['1 · Chọn file', '2 · Kiểm tra & ghép cột', '3 · Nhập', '✓ Xong'].map((t, i) => `<span class="${i === on ? 'on' : ''}">${t}</span>`).join('');

    if (!importState.rows.length) {
        body.innerHTML = `
        <div class="tl-steps">${stepsHtml}</div>
        <div class="tl-drop" id="import-drop" onclick="document.getElementById('import-file').click()">
            <i class="fa-solid fa-file-arrow-up"></i>
            <div><b>Bấm để chọn file sao kê</b> hoặc kéo thả vào đây</div>
            <small>Hỗ trợ Excel (.xlsx) và CSV. File .xls cũ: hãy mở rồi “Lưu thành” .xlsx. Mỗi công ty chứng khoán đặt tên cột khác nhau — app tự nhận, sai thì chỉnh ở bước sau.</small>
        </div>
        <input type="file" id="import-file" accept=".xlsx,.csv,.txt,.tsv" style="display:none" onchange="onImportFilePicked(this.files[0])">
        <p class="tl-hint"><b>Cần có các cột:</b> Ngày giao dịch, Mã CK, Loại lệnh (Mua/Bán), Khối lượng, Giá. Phí và thuế nếu thiếu sẽ tự tính theo <b>Biểu phí</b> ở form thêm lệnh.
        Nhập lại cùng một file không tạo lệnh trùng. <button type="button" class="tl-link" onclick="downloadImportTemplate()"><i class="fa-solid fa-download"></i> Tải file mẫu (CSV)</button></p>`;
        const drop = document.getElementById('import-drop');
        ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
        drop.addEventListener('drop', e => { if (e.dataTransfer.files && e.dataTransfer.files[0]) onImportFilePicked(e.dataTransfer.files[0]); });
        setImportFooter([{ label: 'Đóng', cls: 'btn-tool', onclick: 'closeImportModal()' }]);
        return;
    }

    if (importState.result) { renderImportResult(body, stepsHtml); return; }

    const st = importState;
    const headers = st.rows[st.headerRow] || [];
    const options = (selected) => '<option value="">— không có —</option>' + headers.map((h, i) =>
        `<option value="${i}" ${String(selected) === String(i) ? 'selected' : ''}>${escapeAssetHtml((String(h).trim() || '(cột ' + (i + 1) + ')'))}</option>`).join('');
    const mapHtml = StatementImport.FIELDS.map(f => {
        const req = REQUIRED_FIELDS.includes(f) || f === 'price';
        const missing = (REQUIRED_FIELDS.includes(f) && st.mapping[f] === undefined) || (f === 'price' && st.mapping.price === undefined && st.mapping.value === undefined);
        return `<label class="${req ? 'req' : ''} ${missing ? 'missing' : ''}">${FIELD_LABELS[f]}${req ? ' *' : ''}
            <select class="tl-select" onchange="onImportMappingChange('${f}', this.value)">${options(st.mapping[f])}</select></label>`;
    }).join('');
    const sheetSelect = st.sheets.length > 1
        ? `<label class="tl-check">Sheet: <select class="tl-select" onchange="onImportSheetChange(this.value)">${st.sheets.map((s, i) => `<option value="${i}" ${i === st.sheetIndex ? 'selected' : ''}>${escapeAssetHtml(s.name)} (${s.rows.length} dòng)</option>`).join('')}</select></label>` : '';
    body.innerHTML = `
        <div class="tl-steps">${stepsHtml}</div>
        <div class="tl-opts"><span><b>${escapeAssetHtml(st.fileName)}</b> · ${st.rows.length} dòng</span>${sheetSelect}
            <label class="tl-check">Dòng tiêu đề: <input type="number" class="tl-input num" style="width:70px" min="1" max="${Math.max(1, st.rows.length)}" value="${st.headerRow + 1}" onchange="onImportHeaderRowChange(this.value)"></label>
            <button type="button" class="tl-link" onclick="resetImportFile()"><i class="fa-solid fa-rotate-left"></i> Chọn file khác</button></div>
        <div class="tl-map">${mapHtml}</div>
        <div class="tl-opts">
            <label class="tl-check"><input type="checkbox" id="imp-auto-fees" ${getFeeSettings().auto ? 'checked' : ''} onchange="onImportOptionChange()"> Tự tính phí & thuế bán khi file không có</label>
            <label class="tl-check"><input type="checkbox" id="imp-merge" onchange="onImportOptionChange()"> Gộp các lần khớp cùng ngày/mã/chiều</label>
            <label class="tl-check">Giá trong file: <select class="tl-select" id="imp-mult" onchange="onImportOptionChange()"><option value="">Tự nhận</option><option value="1">đồng (×1)</option><option value="1000">nghìn đồng (×1000)</option></select></label>
            <label class="tl-check"><input type="checkbox" id="imp-div" checked onchange="onImportOptionChange()"> Nhập cả cổ tức tiền mặt (nếu có)</label>
        </div>
        <div class="tl-summary" id="import-summary"><span class="tl-badge mute"><i class="fa-solid fa-spinner fa-spin"></i> Đang kiểm tra…</span></div>
        <div class="tl-preview" id="import-preview"></div>`;
    setImportFooter([{ label: 'Huỷ', cls: 'btn-tool', onclick: 'closeImportModal()' }, { label: 'Nhập', cls: 'btn-save', onclick: 'confirmImport()', id: 'import-confirm-btn', disabled: true }]);
    refreshImportPreview();
}

function setImportFooter(buttons) {
    const f = document.getElementById('import-footer');
    if (!f) return;
    f.innerHTML = buttons.map(b => `<button type="button" class="${b.cls}" ${b.id ? `id="${b.id}"` : ''} ${b.disabled ? 'disabled' : ''} onclick="${b.onclick}">${b.label}</button>`).join('');
}

function resetImportFile() {
    importState = { fileName: '', sheets: [], sheetIndex: 0, rows: [], headerRow: 0, mapping: {}, normalized: null, preview: null, busy: false, result: null };
    renderImportModal();
}

async function onImportFilePicked(file) {
    if (!file) return;
    const name = file.name || 'sao-ke';
    try {
        let sheets;
        if (/\.xlsx$/i.test(name)) {
            sheets = await StatementImport.readXlsx(new Uint8Array(await file.arrayBuffer()));
        } else if (/\.xls$/i.test(name)) {
            throw new Error('File .xls (định dạng Excel cũ) chưa đọc được. Hãy mở bằng Excel rồi “Lưu thành” .xlsx hoặc .csv.');
        } else {
            let text = await file.text();
            // File CSV xuất từ Excel tiếng Việt đôi khi là Windows-1258: chữ lỗi (�) thì thử đọc lại bằng bảng mã đó
            if (text.indexOf('�') >= 0) { try { text = new TextDecoder('windows-1258').decode(new Uint8Array(await file.arrayBuffer())); } catch (e) { /* giữ bản UTF-8 */ } }
            sheets = [{ name: 'CSV', rows: StatementImport.parseCsv(text) }];
        }
        sheets = sheets.filter(s => s.rows.length);
        if (!sheets.length) throw new Error('File trống hoặc không có dòng dữ liệu nào.');
        // Mặc định chọn sheet nhận được nhiều cột bắt buộc nhất (rồi tới sheet nhiều dòng nhất)
        let best = 0, bestScore = -1;
        sheets.forEach((s, i) => { const d = StatementImport.detectColumns(s.rows); const sc = (d.headerRow >= 0 ? d.score : 0) * 100000 + s.rows.length; if (sc > bestScore) { bestScore = sc; best = i; } });
        importState.fileName = name;
        importState.sheets = sheets;
        selectImportSheet(best);
        renderImportModal();
    } catch (e) {
        showToast(escapeAssetHtml(e.message || String(e)), 'error');
    }
}

function selectImportSheet(index) {
    const st = importState;
    st.sheetIndex = index;
    st.rows = st.sheets[index].rows;
    const d = StatementImport.detectColumns(st.rows);
    st.headerRow = d.headerRow >= 0 ? d.headerRow : 0;
    st.mapping = d.headerRow >= 0 ? d.mapping : {};
}

function onImportSheetChange(v) { selectImportSheet(Number(v)); renderImportModal(); }
function onImportHeaderRowChange(v) {
    const n = Math.max(1, Math.min(importState.rows.length, parseInt(v, 10) || 1));
    importState.headerRow = n - 1;
    const d = StatementImport.detectColumns(importState.rows.slice(importState.headerRow, importState.headerRow + 1));
    importState.mapping = d.headerRow === 0 ? d.mapping : {};
    renderImportModal();
}
function onImportMappingChange(field, value) {
    if (value === '') delete importState.mapping[field]; else importState.mapping[field] = Number(value);
    renderImportModal(); // vẽ lại để nhãn "thiếu cột" cập nhật; renderImportModal tự gọi refreshImportPreview
}
function onImportOptionChange() { refreshImportPreview(); }

function importOptions() {
    const g = (id) => document.getElementById(id);
    const mult = g('imp-mult') ? g('imp-mult').value : '';
    const s = getFeeSettings();
    return {
        autoFees: g('imp-auto-fees') ? g('imp-auto-fees').checked : true,
        mergeFills: g('imp-merge') ? g('imp-merge').checked : false,
        priceMultiplier: mult === '' ? null : Number(mult),
        withDividends: g('imp-div') ? g('imp-div').checked : true,
        rates: feeRatesOnly(s),
    };
}

let importPreviewSeq = 0;
async function refreshImportPreview() {
    const st = importState;
    if (!st) return;
    const seq = ++importPreviewSeq;
    const sum = document.getElementById('import-summary');
    const prev = document.getElementById('import-preview');
    const btn = document.getElementById('import-confirm-btn');
    if (btn) btn.disabled = true;
    const m = st.mapping;
    const missing = REQUIRED_FIELDS.filter(f => m[f] === undefined).concat(m.price === undefined && m.value === undefined ? ['price'] : []);
    if (missing.length) {
        sum.innerHTML = `<span class="tl-badge bad"><i class="fa-solid fa-circle-exclamation"></i> Thiếu cột bắt buộc: ${missing.map(f => FIELD_LABELS[f].replace(/ \(.*\)/, '')).join(', ')}</span>`;
        prev.innerHTML = '<div class="tl-empty">Chọn đúng cột cho các mục có dấu * ở trên để xem trước.</div>';
        return;
    }
    const o = importOptions();
    const norm = StatementImport.normalizeRows(st.rows, { headerRow: st.headerRow, mapping: st.mapping, autoFees: o.autoFees, mergeFills: o.mergeFills, priceMultiplier: o.priceMultiplier, rates: o.rates });
    st.normalized = norm;
    const trades = norm.rows.filter(r => (r.type === 'buy' || r.type === 'sell') && !r.issues.length);
    const dividends = o.withDividends ? norm.rows.filter(r => r.type === 'dividend' && !r.issues.length) : [];
    const bad = norm.rows.filter(r => r.issues.length);
    let preview = { fresh: [], duplicates: [], blocked: [] };
    try {
        if (trades.length) {
            const resp = await callGAS('previewAssetImport', { email: targetEmail, rows: trades });
            if (resp.status !== 'success') throw new Error(resp.message);
            preview = resp.data;
        }
    } catch (e) {
        if (seq !== importPreviewSeq) return;
        sum.innerHTML = `<span class="tl-badge bad"><i class="fa-solid fa-circle-exclamation"></i> Không kiểm tra được với sổ lệnh hiện có: ${escapeAssetHtml(e.message || String(e))}</span>`;
        return;
    }
    if (seq !== importPreviewSeq) return;                         // đã có lần xem trước mới hơn
    st.preview = preview; st.trades = trades; st.dividends = dividends;
    const freshLines = new Set(preview.fresh.map(r => r.line));
    const dupLines = new Set(preview.duplicates.map(r => r.line));
    const blockedByLine = {}; preview.blocked.forEach(r => { blockedByLine[r.line] = r.blockReason; });
    const mult = norm.priceMultiplier === 1000 ? '<span class="tl-badge info" title="Giá trong file là nghìn đồng — đã nhân 1000">giá ×1000</span>' : '';
    sum.innerHTML = `<span class="tl-badge ok"><i class="fa-solid fa-plus"></i> ${preview.fresh.length} lệnh mới</span>`
        + (dividends.length ? `<span class="tl-badge ok"><i class="fa-solid fa-coins"></i> ${dividends.length} cổ tức</span>` : '')
        + `<span class="tl-badge mute">${preview.duplicates.length} trùng (bỏ qua)</span>`
        + (preview.blocked.length ? `<span class="tl-badge warn" title="Bán vượt khối lượng đang có">${preview.blocked.length} bị chặn</span>` : '')
        + (bad.length ? `<span class="tl-badge bad">${bad.length} dòng lỗi</span>` : '')
        + (norm.skipped.length ? `<span class="tl-badge mute">${norm.skipped.length} dòng bỏ qua</span>` : '') + mult;
    const rowsHtml = norm.rows.slice(0, 400).map(r => {
        let status, cls = '';
        if (r.issues.length) { status = `<span class="tl-badge bad">Lỗi</span>`; }
        else if (blockedByLine[r.line]) { status = `<span class="tl-badge warn">Bị chặn</span>`; }
        else if (dupLines.has(r.line)) { status = `<span class="tl-badge mute">Trùng</span>`; }
        else if (freshLines.has(r.line) || r.type === 'dividend') { status = `<span class="tl-badge ok">Mới</span>`; }
        else status = `<span class="tl-badge mute">—</span>`;
        const detail = r.issues.length ? r.issues.join('; ') : (blockedByLine[r.line] || '');
        const typeLabel = r.type === 'buy' ? 'Mua' : (r.type === 'sell' ? 'Bán' : (r.type === 'dividend' ? 'Cổ tức' : '?'));
        return `<tr><td>${r.line}</td><td>${status}</td><td>${escapeAssetHtml(r.date || '')}</td><td>${typeLabel}</td><td class="text-bold">${escapeAssetHtml(r.symbol || '')}</td>
            <td class="text-right">${r.type === 'dividend' ? '' : Number(r.quantity || 0).toLocaleString('en-US')}</td>
            <td class="text-right">${r.type === 'dividend' ? Math.round(r.amount || 0).toLocaleString('en-US') : Math.round(r.price || 0).toLocaleString('en-US')}</td>
            <td class="text-right">${Math.round(r.fee || 0).toLocaleString('en-US')}</td><td class="text-right">${Math.round(r.tax || 0).toLocaleString('en-US')}</td>
            <td class="err">${escapeAssetHtml(detail)}</td></tr>`;
    }).join('');
    const skippedHtml = norm.skipped.slice(0, 50).map(s => `<tr><td>${s.line}</td><td><span class="tl-badge mute">Bỏ qua</span></td><td colspan="7"></td><td class="err">${escapeAssetHtml(s.reason)}</td></tr>`).join('');
    prev.innerHTML = `<table class="excel-table asset-table"><thead><tr><th>Dòng</th><th>Trạng thái</th><th>Ngày</th><th>Loại</th><th>Mã</th><th class="text-right">KL</th><th class="text-right">Giá</th><th class="text-right">Phí</th><th class="text-right">Thuế</th><th>Ghi chú</th></tr></thead><tbody>${rowsHtml}${skippedHtml}</tbody></table>`
        + (norm.rows.length > 400 ? `<div class="tl-hint" style="padding:8px 12px">Hiện 400 dòng đầu / ${norm.rows.length} dòng.</div>` : '');
    if (btn) {
        const total = preview.fresh.length + dividends.length;
        btn.disabled = total === 0;
        btn.innerHTML = total ? `<i class="fa-solid fa-file-import"></i> Nhập ${preview.fresh.length} lệnh${dividends.length ? ' + ' + dividends.length + ' cổ tức' : ''}` : 'Không có gì để nhập';
    }
}

async function confirmImport() {
    const st = importState;
    if (!st || !st.preview) return;
    const btn = document.getElementById('import-confirm-btn');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang nhập…';
    try {
        const resp = await callGAS('importAssetTransactions', {
            email: targetEmail, rows: st.trades,
            opts: { dividends: st.dividends.map(d => ({ date: d.date, symbol: d.symbol, amount: d.amount })), adjustCash: false, fileName: st.fileName }
        });
        if (resp.status !== 'success') throw new Error(resp.message);
        st.result = resp.data;
        lastImportBatch = resp.data.batchId;
        renderImportModal();
        refreshAfterLedgerChange();
    } catch (e) {
        showToast(escapeAssetHtml(e.message || String(e)), 'error');
        btn.disabled = false; btn.innerHTML = 'Thử lại';
    }
}

function renderImportResult(body, stepsHtml) {
    const r = importState.result;
    const blocked = (r.blocked || []).length;
    body.innerHTML = `
        <div class="tl-steps">${stepsHtml}</div>
        <div class="tl-result">
            <div><b><i class="fa-solid fa-circle-check"></i> Đã nhập ${r.imported} lệnh${r.dividendsAdded ? ' + ' + r.dividendsAdded + ' cổ tức' : ''}.</b>
                <div class="tl-hint">${r.duplicates} dòng trùng đã bỏ qua${r.dividendsSkipped ? ', ' + r.dividendsSkipped + ' cổ tức trùng bỏ qua' : ''}. Lãi/lỗ đã chốt theo FIFO đã được tính lại.</div></div>
            ${r.imported ? `<button type="button" class="btn-tool" onclick="undoLastImport('${escapeAssetHtml(r.batchId)}')"><i class="fa-solid fa-rotate-left"></i> Hoàn tác lần nhập này</button>` : ''}
        </div>
        ${blocked ? `<div class="tl-warn"><i class="fa-solid fa-triangle-exclamation"></i><span><b>${blocked} lệnh bán chưa nhập</b> vì vượt khối lượng đang có (thiếu lệnh mua trước đó). Hãy nhập lệnh mua/số dư đầu kỳ rồi nhập lại file — các lệnh đã nhập sẽ không bị trùng.</span></div>` : ''}`;
    setImportFooter([{ label: 'Đóng', cls: 'btn-save', onclick: 'closeImportModal()' }]);
}

async function undoLastImport(batchId) {
    if (!confirm('Hoàn tác toàn bộ các lệnh vừa nhập từ file này? Danh mục và lãi/lỗ sẽ được tính lại.')) return;
    try {
        const resp = await callGAS('undoAssetImportBatch', { email: targetEmail, batchId });
        if (resp.status !== 'success') throw new Error(resp.message);
        showToast(escapeAssetHtml(resp.message), 'success');
        closeImportModal();
        refreshAfterLedgerChange();
    } catch (e) {
        showToast(escapeAssetHtml(e.message || String(e)), 'error');
    }
}

function refreshAfterLedgerChange() {
    loadLedger();
    loadHoldings();
    loadKpis();
    if (TAB_LOADED.performance) loadPerformanceChart();
    TAB_LOADED.reports = false;
    if (document.getElementById('tab-reports') && document.getElementById('tab-reports').style.display !== 'none' && typeof initReportsTab === 'function') initReportsTab();
}

function downloadImportTemplate() {
    const bytes = new TextEncoder().encode('﻿' + StatementImport.sampleCsv());
    saveBytesToDisk('mau-sao-ke.csv', bytes, 'text/csv;charset=utf-8').then(p => { if (p) showToast('Đã lưu file mẫu', 'success'); }).catch(e => showToast(escapeAssetHtml(e.message || String(e)), 'error'));
}
