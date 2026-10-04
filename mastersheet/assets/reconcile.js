/* --- FILE: /mastersheet/assets/reconcile.js ---
   "Đối soát sao kê": so sổ lệnh trong app với sao kê của công ty chứng khoán -- (1) sao kê SỐ DƯ chứng khoán: mã nào lệch bao nhiêu và vì sao có thể lệch
   (thiếu thưởng/tách, lệnh nhập trùng, thiếu lệnh mua/bán), kèm nút tạo lệnh điều chỉnh; (2) sao kê LỆNH trong kỳ: thiếu / thừa / lệch khối lượng-giá; (3) so khớp số dư tiền.
   Kết quả lưu vào nhật ký đối soát để quản lý biết ai đã đối soát tới ngày nào. Phép tính ở /lib/reconcile.js (có kiểm thử); đọc file dùng lại StatementImport.
   Dùng global: callGAS, targetEmail, showToast, escapeAssetHtml, StatementImport, Reconcile, loadHoldings/loadLedger/loadKpis (script.js). */

const RC = { open: false, step: 'pick', fileName: '', sheets: [], sheetIndex: 0, kind: null, inputs: null, asOf: '', cashInput: '', result: null, cash: null, fixing: null, saved: false, history: [], busy: false, error: '' };

const rcEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const rcN = (v, d) => Number(v).toLocaleString('vi-VN', { maximumFractionDigits: d === undefined ? 0 : d });
const rcDate = (iso) => { const p = String(iso || '').slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : ''; };

async function rcCall(action, params) {
    const r = await callGAS(action, Object.assign({ email: targetEmail }, params || {}));
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}

async function openReconcileModal() {
    Object.assign(RC, { open: true, step: 'pick', fileName: '', sheets: [], sheetIndex: 0, kind: null, result: null, cash: null, fixing: null, saved: false, error: '', cashInput: '', asOf: new Date().toISOString().slice(0, 10) });
    document.getElementById('rc-modal').classList.add('open');
    renderReconcile();
    try {
        [RC.inputs, RC.history] = await Promise.all([rcCall('getReconcileInputs'), rcCall('listReconciliations', { limit: 5 }).catch(() => [])]);
    } catch (e) { RC.error = e.message || String(e); }
    renderReconcile();
}
function closeReconcileModal() { RC.open = false; document.getElementById('rc-modal').classList.remove('open'); }

async function rcPickFile(file) {
    if (!file) return;
    const name = file.name || 'sao-ke';
    try {
        let sheets;
        if (/\.xlsx$/i.test(name)) sheets = await StatementImport.readXlsx(new Uint8Array(await file.arrayBuffer()));
        else if (/\.xls$/i.test(name)) throw new Error('File .xls cũ chưa đọc được: hãy mở bằng Excel rồi “Lưu thành” .xlsx hoặc .csv.');
        else {
            let text = await file.text();
            if (text.indexOf('�') >= 0) { try { text = new TextDecoder('windows-1258').decode(new Uint8Array(await file.arrayBuffer())); } catch (e) { /* giữ bản UTF-8 */ } }
            sheets = [{ name: 'CSV', rows: StatementImport.parseCsv(text) }];
        }
        sheets = sheets.filter(s => s.rows.length);
        if (!sheets.length) throw new Error('File trống.');
        // chọn sheet nhận ra được loại sao kê, ưu tiên nhiều dòng
        let best = 0, bestScore = -1;
        sheets.forEach((s, i) => { const k = Reconcile.detectKind(s.rows); const sc = (k ? 1e6 : 0) + s.rows.length; if (sc > bestScore) { bestScore = sc; best = i; } });
        RC.fileName = name; RC.sheets = sheets; RC.sheetIndex = best; RC.saved = false;
        rcAnalyze();
    } catch (e) { showToast(rcEsc(e.message || String(e)), 'error'); }
}

function rcSelectSheet(i) { RC.sheetIndex = Number(i); rcAnalyze(); }
function rcSetKind(k) { RC.kind = k; rcAnalyze(true); }
function rcSetAsOf(v) { RC.asOf = v; rcAnalyze(true); }
function rcSetCash(v) { RC.cashInput = v; rcCashCompute(); renderReconcile(); }

function rcCashCompute() {
    const raw = String(RC.cashInput || '').trim();
    const v = raw === '' ? null : StatementImport.parseNumber(raw);
    RC.cash = v === null || !RC.inputs ? null : Reconcile.compareCash(v, RC.inputs.cash);
}

// Đọc sheet đã chọn, nhận loại sao kê, so khớp
function rcAnalyze(keepKind) {
    const rows = RC.sheets[RC.sheetIndex].rows;
    if (!keepKind || !RC.kind) RC.kind = Reconcile.detectKind(rows);
    RC.result = null; RC.error = '';
    if (!RC.kind) { RC.step = 'result'; RC.error = 'Không nhận ra loại sao kê. Cần file có cột Mã CK + Khối lượng (sao kê số dư) hoặc Ngày + Mã + Loại lệnh + KL + Giá (sao kê lệnh).'; renderReconcile(); return; }
    if (!RC.inputs) { RC.step = 'result'; RC.error = 'Chưa tải xong sổ lệnh, hãy thử lại.'; renderReconcile(); return; }
    try {
        if (RC.kind === 'positions') {
            const d = Reconcile.detectPositionColumns(rows);
            if (d.headerRow < 0) throw new Error('Không tìm thấy cột Mã CK và Khối lượng trong sheet này.');
            const norm = Reconcile.normalizePositions(rows, { headerRow: d.headerRow, mapping: d.mapping });
            if (norm.asOf && !keepKind) RC.asOf = norm.asOf;
            const app = Reconcile.positionsAsOf(RC.inputs.txns, RC.inputs.actions, RC.asOf);
            RC.result = { kind: 'positions', norm, app, cmp: Reconcile.comparePositions(norm.rows, app, { asOf: RC.asOf, txns: RC.inputs.txns }) };
        } else {
            const d = StatementImport.detectColumns(rows);
            if (d.headerRow < 0) throw new Error('Không nhận ra cột của sao kê lệnh.');
            const norm = StatementImport.normalizeRows(rows, { headerRow: d.headerRow, mapping: d.mapping, autoFees: false, mergeFills: false, priceMultiplier: null, rates: PortfolioCalc.DEFAULT_RATES });
            const cmp = Reconcile.compareTrades(norm.rows, RC.inputs.txns);
            if (cmp.to && !keepKind) RC.asOf = cmp.to;
            RC.result = { kind: 'trades', norm, cmp };
        }
        rcCashCompute();
    } catch (e) { RC.error = e.message || String(e); }
    RC.step = 'result'; RC.saved = false;
    renderReconcile();
}

// ---------- vẽ ----------
const RC_STATUS = { match: ['ok', 'Khớp'], missing_in_app: ['bad', 'Thiếu trong sổ'], extra_in_app: ['warn', 'Thừa trong sổ'], qty_diff: ['bad', 'Lệch khối lượng'] };

function rcPositionsHtml(r) {
    const c = r.cmp;
    let html = `<div class="tl-kpis">${[
        rkKpi('Khớp', `${c.matched} / ${c.total}`, c.matchedPct === null ? '' : rkPct(c.matchedPct, 0) + ' số mã', c.mismatched ? '' : 'tl-up'),
        rkKpi('Đang lệch', String(c.mismatched), `${c.missingInApp} thiếu · ${c.extraInApp} thừa · ${c.qtyDiff} lệch KL`, c.mismatched ? 'tl-down' : ''),
        rkKpi('Giá trị đang lệch', rkVnd(c.valueAtStake), 'ước tính theo giá sao kê'),
        rkKpi('Giá vốn khác', String(c.costNotes), 'mã khớp KL nhưng giá vốn lệch >2%'),
    ].join('')}</div>`;
    const rows = c.items.slice().sort((a, b) => (a.status === 'match') - (b.status === 'match') || Math.abs(b.diff * (b.price || b.statementCost || b.appCost || 1)) - Math.abs(a.diff * (a.price || a.statementCost || a.appCost || 1)));
    html += `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Mã</th><th class="text-right">Sao kê</th><th class="text-right">Sổ lệnh</th><th class="text-right">Chênh</th><th>Trạng thái</th><th>Nguyên nhân có thể &amp; cách sửa</th></tr></thead><tbody>
        ${rows.map(i => { const st = RC_STATUS[i.status];
            const hints = i.hints.concat(i.costNote ? [i.costNote] : []).map(h => `<div class="rc-hint">${rcEsc(h)}</div>`).join('');
            const btns = i.status === 'match' ? '' : `<div class="rc-actions">${i.fix ? `<button type="button" class="btn-tool" onclick="rcStartFix('${rcEsc(i.symbol)}','trade')"><i class="fa-solid fa-plus"></i> Tạo lệnh ${i.fix.type === 'buy' ? 'mua' : 'bán'} ${rcN(i.fix.quantity)} cp</button>` : ''}${i.fixAction ? `<button type="button" class="btn-tool" onclick="rcStartFix('${rcEsc(i.symbol)}','action')"><i class="fa-solid fa-scissors"></i> Ghi ${i.fixAction.actionType === 'split' ? 'tách ' + i.fixAction.ratio + ':1' : 'thưởng ' + rcN(i.fixAction.ratio * 100, 1) + '%'}</button>` : ''}</div>`;
            const form = RC.fixing && RC.fixing.symbol === i.symbol ? rcFixFormHtml(i) : '';
            return `<tr class="${i.status === 'match' ? '' : 'rc-bad'}"><td><b>${rcEsc(i.symbol)}</b></td><td class="text-right">${rcN(i.statementQty)}</td><td class="text-right">${rcN(i.appQty, 2)}</td><td class="text-right ${i.diff ? 'tl-down' : ''}">${i.diff ? (i.diff > 0 ? '+' : '') + rcN(i.diff, 2) : '—'}</td>
                <td><span class="tl-badge ${st[0]}">${st[1]}</span></td><td class="rc-cause">${hints}${btns}${form}</td></tr>`; }).join('')}
        </tbody></table></div>`;
    if (r.norm.skipped.length) html += `<details class="tl-details"><summary>${r.norm.skipped.length} dòng bị bỏ qua</summary><ul class="rc-skip">${r.norm.skipped.slice(0, 30).map(s => `<li>Dòng ${s.line}: ${rcEsc(s.reason)}</li>`).join('')}</ul></details>`;
    return html;
}

function rcFixFormHtml(i) {
    const f = RC.fixing;
    if (f.mode === 'action') {
        return `<div class="rc-form"><label>Ngày không hưởng quyền<input type="date" id="rc-fix-date" class="tl-input" value="${rcEsc(f.date)}"></label>
            <button type="button" class="btn-save" onclick="rcConfirmFix()" ${RC.busy ? 'disabled' : ''}>Ghi hành động DN</button><button type="button" class="btn-tool" onclick="rcCancelFix()">Huỷ</button></div>`;
    }
    return `<div class="rc-form"><label>Loại<select id="rc-fix-type" class="tl-select"><option value="buy" ${i.fix.type === 'buy' ? 'selected' : ''}>Mua</option><option value="sell" ${i.fix.type === 'sell' ? 'selected' : ''}>Bán</option></select></label>
        <label>Khối lượng<input type="number" id="rc-fix-qty" class="tl-input num" min="0" step="any" value="${i.fix.quantity}"></label>
        <label>Giá<input type="number" id="rc-fix-price" class="tl-input num" min="0" step="any" value="${i.fix.price || ''}" placeholder="bắt buộc"></label>
        <label>Ngày<input type="date" id="rc-fix-date" class="tl-input" value="${rcEsc(f.date)}"></label>
        <button type="button" class="btn-save" onclick="rcConfirmFix()" ${RC.busy ? 'disabled' : ''}>Tạo lệnh điều chỉnh</button><button type="button" class="btn-tool" onclick="rcCancelFix()">Huỷ</button>
        <div class="tl-hint" style="flex-basis:100%;margin:0">Lệnh điều chỉnh được ghi chú “Đối soát” và không qua kiểm tra giới hạn (đây là sửa sổ cho khớp thực tế, không phải giao dịch mới). Ngày mặc định là ngày sao kê.</div></div>`;
}

function rcTradesHtml(r) {
    const c = r.cmp;
    const ok = c.ok;
    let html = `<div class="tl-kpis">${[
        rkKpi('Khớp', `${c.matched.length} / ${c.total}`, c.matchedPct === null ? '' : rkPct(c.matchedPct, 0) + ' số lệnh trong sao kê', ok ? 'tl-up' : ''),
        rkKpi('Thiếu trong sổ', String(c.missingInApp.length), 'có trong sao kê, không có trong sổ', c.missingInApp.length ? 'tl-down' : ''),
        rkKpi('Thừa trong sổ', String(c.extraInApp.length), 'có trong sổ (cùng kỳ), không có trong sao kê', c.extraInApp.length ? 'tl-down' : ''),
        rkKpi('Lệch', String(c.mismatched.length), 'cùng ngày/mã/chiều nhưng khác KL hoặc giá', c.mismatched.length ? 'tl-down' : ''),
    ].join('')}</div><p class="tl-hint" style="margin:0 0 10px">Kỳ sao kê: ${rcDate(c.from)} → ${rcDate(c.to)} · ${c.appInRange} lệnh của sổ trong kỳ.</p>`;
    const row = (cells, cls) => `<tr class="${cls || ''}">${cells.map(x => `<td>${x}</td>`).join('')}</tr>`;
    const side = (t) => (t === 'buy' ? 'Mua' : 'Bán');
    const body = [];
    c.missingInApp.forEach(x => body.push(row([`<span class="tl-badge bad">Thiếu trong sổ</span>`, rcDate(x.date), rcEsc(x.symbol), side(x.type), rcN(x.quantity), rcN(x.price), 'Nhập lệnh này, hoặc dùng “Nhập từ sao kê” (cùng file) — lệnh trùng sẽ tự bỏ qua.'], 'rc-bad')));
    c.extraInApp.forEach(t => body.push(row([`<span class="tl-badge warn">Thừa trong sổ</span>`, rcDate(t.trade_date), rcEsc(t.symbol), side(t.type), rcN(t.quantity), rcN(t.price), 'Sổ có lệnh này nhưng sao kê không có: có thể nhập trùng, nhập sai ngày, hoặc lệnh không khớp. Kiểm tra ở Sổ Lệnh.'], 'rc-bad')));
    c.mismatched.forEach(m => body.push(row([`<span class="tl-badge bad">Lệch</span>`, rcDate(m.statement.date), rcEsc(m.statement.symbol), side(m.statement.type), `${rcN(m.statement.quantity)} <small>(sổ ${rcN(m.app.quantity)})</small>`, `${rcN(m.statement.price)} <small>(sổ ${rcN(m.app.price)})</small>`, rcEsc(m.reasons.join('; '))], 'rc-bad')));
    html += body.length ? `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Trạng thái</th><th>Ngày</th><th>Mã</th><th>Loại</th><th class="text-right">KL</th><th class="text-right">Giá</th><th>Ghi chú</th></tr></thead><tbody>${body.join('')}</tbody></table></div>` : '<div class="tl-empty" style="padding:14px"><i class="fa-solid fa-circle-check" style="color:var(--success-color);opacity:1"></i>Tất cả lệnh trong sao kê đều khớp với sổ.</div>';
    return html;
}

function rcCashHtml() {
    const c = RC.cash;
    return `<div class="rc-cash"><label>Số dư tiền theo sao kê (tuỳ chọn)<input type="text" class="tl-input num" value="${rcEsc(RC.cashInput)}" placeholder="VD: 125.000.000" onchange="rcSetCash(this.value)"></label>
        ${c ? (c.ok ? `<span class="tl-badge ok"><i class="fa-solid fa-check"></i> Khớp tiền mặt trong app (${rkVnd(c.app)})</span>` : `<span class="tl-badge bad">Lệch ${c.diff > 0 ? '+' : '−'}${rkVnd(Math.abs(c.diff))}</span><span class="tl-hint" style="margin:0">${rcEsc(c.hint)} (tiền mặt hiện trong app: ${rkVnd(c.app)})</span>`) : ''}</div>`;
}

function renderReconcile() {
    const body = document.getElementById('rc-body'), foot = document.getElementById('rc-footer');
    if (!body || !RC.open) return;
    const hist = RC.history.length ? `<details class="tl-details"><summary>Các lần đối soát gần đây (${RC.history.length})</summary><ul class="rc-skip">${RC.history.map(h => `<li>${rcDate(h.as_of)} · ${h.kind === 'positions' ? 'số dư' : 'lệnh'} · ${h.matched}/${h.total} khớp${h.mismatched ? `, <b class="tl-down">${h.mismatched} lệch</b>` : ''}${h.source ? ' · ' + rcEsc(h.source) : ''}</li>`).join('')}</ul></details>` : '';
    if (RC.step === 'pick' || !RC.sheets.length) {
        body.innerHTML = `<div class="tl-drop" id="rc-drop" onclick="document.getElementById('rc-file').click()"><i class="fa-solid fa-scale-balanced"></i><div><b>Chọn file sao kê của công ty chứng khoán</b> hoặc kéo thả vào đây</div>
            <small>Excel (.xlsx) hoặc CSV. Hai loại: <b>sao kê số dư chứng khoán</b> (Mã CK + Khối lượng, có thể kèm giá vốn) hoặc <b>sao kê lệnh</b> (Ngày, Mã, Mua/Bán, KL, Giá). App tự nhận loại.</small></div>
            <input type="file" id="rc-file" accept=".xlsx,.csv,.txt,.tsv" style="display:none" onchange="rcPickFile(this.files[0])">
            <p class="tl-hint">Đối soát là bước kiểm soát cơ bản: số cổ phiếu và các lệnh trong sổ phải khớp với bên giữ tài sản. Lệch cho biết sổ đang thiếu hoặc thừa gì, từ đó mọi phân tích (lãi/lỗ, rủi ro, giới hạn) mới đáng tin.</p>${hist}${RC.error ? `<p class="tl-hint text-danger">${rcEsc(RC.error)}</p>` : ''}`;
        const drop = document.getElementById('rc-drop');
        ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
        drop.addEventListener('drop', e => { if (e.dataTransfer.files && e.dataTransfer.files[0]) rcPickFile(e.dataTransfer.files[0]); });
        foot.innerHTML = '<button type="button" class="btn-tool" onclick="closeReconcileModal()">Đóng</button>';
        return;
    }
    const sheetSel = RC.sheets.length > 1 ? `<label class="tl-check">Sheet: <select class="tl-select" onchange="rcSelectSheet(this.value)">${RC.sheets.map((s, i) => `<option value="${i}" ${i === RC.sheetIndex ? 'selected' : ''}>${rcEsc(s.name)}</option>`).join('')}</select></label>` : '';
    let html = `<div class="tl-opts"><span><b>${rcEsc(RC.fileName)}</b></span>${sheetSel}
        <label class="tl-check">Loại: <select class="tl-select" onchange="rcSetKind(this.value)"><option value="positions" ${RC.kind === 'positions' ? 'selected' : ''}>Số dư chứng khoán</option><option value="trades" ${RC.kind === 'trades' ? 'selected' : ''}>Lệnh giao dịch</option></select></label>
        ${RC.kind === 'positions' ? `<label class="tl-check">Số dư tới ngày: <input type="date" class="tl-input" value="${rcEsc(RC.asOf)}" onchange="rcSetAsOf(this.value)"></label>` : ''}
        <button type="button" class="tl-link" onclick="Object.assign(RC,{step:'pick',sheets:[],result:null,error:''});renderReconcile()"><i class="fa-solid fa-rotate-left"></i> Chọn file khác</button></div>`;
    if (RC.error) html += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>${rcEsc(RC.error)}</span></div>`;
    else if (RC.result) {
        html += RC.result.kind === 'positions' ? rcPositionsHtml(RC.result) : rcTradesHtml(RC.result);
        if (RC.result.kind === 'positions') html += rcCashHtml();
        html += `<p class="tl-hint">${RC.result.kind === 'positions' ? 'Số cổ phiếu của sổ tính bằng FIFO có thưởng/tách tới đúng ngày sao kê.' : 'Khớp theo số hiệu lệnh, rồi theo ngày + mã + chiều + KL + giá.'} Đối soát chỉ so khớp và gợi ý: bạn quyết định sửa gì.</p>`;
    }
    body.innerHTML = html + hist;
    const r = RC.result, canSave = r && !RC.error && !RC.saved;
    foot.innerHTML = `<button type="button" class="btn-tool" onclick="closeReconcileModal()">Đóng</button>${canSave ? '<button type="button" class="btn-save" onclick="rcSave()"><i class="fa-solid fa-floppy-disk"></i> Lưu kết quả đối soát</button>' : (RC.saved ? '<span class="tl-badge ok"><i class="fa-solid fa-check"></i> Đã lưu</span>' : '')}`;
}

// ---------- sửa ----------
function rcStartFix(symbol, mode) { RC.fixing = { symbol, mode, date: RC.asOf }; renderReconcile(); }
function rcCancelFix() { RC.fixing = null; renderReconcile(); }

async function rcConfirmFix() {
    const f = RC.fixing; if (!f || RC.busy) return;
    const date = document.getElementById('rc-fix-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { showToast('Chọn ngày hợp lệ', 'error'); return; }
    RC.busy = true;
    try {
        if (f.mode === 'action') {
            const item = RC.result.cmp.items.find(i => i.symbol === f.symbol);
            await rcCall('addCorporateAction', { action: { symbol: f.symbol, actionType: item.fixAction.actionType, ratio: item.fixAction.ratio, exDate: date, note: `Đối soát ${rcDate(RC.asOf)}: bổ sung theo sao kê` } });
        } else {
            const qty = Number(document.getElementById('rc-fix-qty').value), price = Number(document.getElementById('rc-fix-price').value), type = document.getElementById('rc-fix-type').value;
            if (!(qty > 0) || !(price > 0)) throw new Error('Nhập khối lượng và giá lớn hơn 0');
            await rcCall('addAssetTransaction', { txn: { type, symbol: f.symbol, quantity: qty, price, tradeDate: date, fee: 0, tax: 0, note: `Đối soát ${rcDate(RC.asOf)}: điều chỉnh theo sao kê`, skipLimitCheck: true, skipApprovalCheck: true, skipRestrictedCheck: true } });
        }
        showToast('Đã ghi điều chỉnh. Đang so khớp lại…', 'success');
        RC.fixing = null;
        RC.inputs = await rcCall('getReconcileInputs');
        if (typeof refreshAfterLedgerChange === 'function') refreshAfterLedgerChange();
        rcAnalyze(true);
    } catch (e) { showToast('Lỗi: ' + rcEsc(e.message || String(e)), 'error'); }
    RC.busy = false;
    renderReconcile();
}

async function rcSave() {
    const r = RC.result; if (!r) return;
    const c = r.cmp;
    const rec = r.kind === 'positions'
        ? { kind: 'positions', asOf: RC.asOf, source: RC.fileName, total: c.total, matched: c.matched, mismatched: c.mismatched, valueAtStake: c.valueAtStake, summary: Reconcile.summarize('positions', c) }
        : { kind: 'trades', asOf: RC.asOf, source: RC.fileName, total: c.total, matched: c.matched.length, mismatched: c.mismatched.length + c.missingInApp.length + c.extraInApp.length, valueAtStake: 0, summary: Reconcile.summarize('trades', c) };
    if (RC.cash) Object.assign(rec, { cashStatement: RC.cash.statement, cashApp: RC.cash.app, cashOk: RC.cash.ok });
    try {
        await rcCall('saveReconciliation', { record: rec });
        RC.saved = true;
        RC.history = await rcCall('listReconciliations', { limit: 5 }).catch(() => RC.history);
        showToast('Đã lưu kết quả đối soát', 'success');
    } catch (e) { showToast('Lỗi: ' + rcEsc(e.message || String(e)), 'error'); }
    renderReconcile();
}
