/* --- FILE: /mastersheet/assets/rebalance.js ---
   Đề xuất CÂN BẰNG LẠI về danh mục chuẩn chiến lược của nhóm: so tỷ trọng ngành thực tế với tỷ trọng mục tiêu (quản lý đặt ở Toàn Nhóm > Chiến Lược), rồi liệt kê lệnh bán/mua cụ thể
   để về chuẩn -- đã trừ phí/thuế, cắt theo thanh khoản và giới hạn đầu tư. Lệnh vượt ngưỡng duyệt lệnh lớn có thể gửi thành đề xuất cho quản lý duyệt ngay từ đây; lệnh còn lại
   điền sẵn vào form "Thêm Lệnh Giao Dịch". Vòng khép kín: phân tích (Brinson) -> đề xuất -> duyệt -> thực hiện. Phép tính ở /lib/rebalance-calc.js (có kiểm thử).
   Dùng global: callGAS, targetEmail, showToast, escapeAssetHtml, pickTxnType, lmCall, ptAdv (pretrade.js), bsLoadPolicy/BS (brinson.js), getFeeSettings, FinCalc, LimitsCalc, SizingCalc, ApprovalCalc. */

const RB = { open: false, state: 'idle', error: '', ctx: null, result: null, band: 2, includeOff: false, selected: new Set(), sending: false };

const rbEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const rbNum = (v, d) => Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: d === undefined ? 0 : d });
const rbVnd = (v) => rbNum(Math.round(v), 0) + ' đ';
const rbPts = (v) => (v > 0 ? '+' : '') + rbNum(v, 1);
const RB_REASON = { noPolicy: 'Nhóm chưa đặt danh mục chuẩn chiến lược. Quản lý đặt ở trang Toàn Nhóm > Chiến Lược.', badPolicy: 'Danh mục chuẩn chiến lược không hợp lệ (tổng vượt 100%).', noNav: 'NAV chưa dương nên chưa tính được.' };

async function rbCall(action, params) {
    const r = await callGAS(action, Object.assign({ email: targetEmail }, params || {}));
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}

async function openRebalance() {
    RB.open = true; RB.state = 'loading'; RB.error = ''; RB.result = null; RB.selected = new Set();
    document.getElementById('rb-modal').classList.add('open');
    rbRender();
    try {
        const [holdings, cd, , rows, actor, approval] = await Promise.all([
            rbCall('getHoldingsView'), rbCall('getCashDebt'), bsLoadPolicy(true), lmCall('listLimits').catch(() => []), lmCall('getLimitActor').catch(() => ({})), lmCall('getApprovalPolicy').catch(() => null),
        ]);
        const hs = (holdings || []).filter(h => Number(h.quantity) > 0 && Number(h.marketPrice) > 0).map(h => ({ symbol: h.symbol, sector: FinCalc.sectorOf(h.symbol), quantity: Number(h.quantity), price: Number(h.marketPrice) }));
        const adv = {};
        await Promise.all(hs.slice(0, 30).map(async h => { const a = await ptAdv(h.symbol); if (a > 0) adv[h.symbol] = a; }));
        RB.ctx = { holdings: hs, cash: Number(cd && cd.cash) || 0, debt: Number(cd && cd.debt) || 0, adv, limits: LimitsCalc.applicable(rows || [], actor.targetId, 'member'), approval };
        RB.state = 'ok';
        rbCompute();
    } catch (e) { RB.state = 'error'; RB.error = e.message || String(e); }
    rbRender();
}
function closeRebalance() { RB.open = false; document.getElementById('rb-modal').classList.remove('open'); }

function rbCompute() {
    const c = RB.ctx, f = typeof getFeeSettings === 'function' ? getFeeSettings() : null;
    RB.result = RebalanceCalc.plan({
        holdings: c.holdings, cash: c.cash, debt: c.debt, policy: BS.policy.weights || {}, bandPts: RB.band, includeOffPolicy: RB.includeOff, adv: c.adv,
        rates: f ? { buyFeeRate: f.buyFeeRate, sellFeeRate: f.sellFeeRate, sellTaxRate: f.sellTaxRate } : undefined,
        limits: { LC: LimitsCalc, SC: SizingCalc, rows: c.limits },
    });
    RB.selected = new Set();
    if (RB.result.ok) RB.result.trades.forEach((t, i) => { if (rbNeeds(t).needed) RB.selected.add(i); });
}
function rbChange() {
    const b = Number(document.getElementById('rb-band').value);
    RB.band = b >= 0 && b <= 20 ? b : 2; RB.includeOff = !!document.getElementById('rb-off').checked;
    rbCompute(); rbRender();
}

// Lệnh này có cần duyệt không (theo quy định của nhóm)?
function rbNeeds(t) {
    const ap = RB.ctx && RB.ctx.approval;
    if (!ap || !ap.active || !RB.result || !RB.result.ok || typeof ApprovalCalc === 'undefined') return { needed: false };
    return ApprovalCalc.needsApproval(ap, RB.result.nav, { quantity: t.quantity, price: t.price });
}

function rbToggle(i, on) { if (on) RB.selected.add(i); else RB.selected.delete(i); rbRenderFooter(); }

function rbFill(i) {
    const t = RB.result.trades[i];
    if (!t) return;
    const btn = document.querySelector('#txn-form .seg button[data-v="' + t.side + '"]');
    if (btn && typeof pickTxnType === 'function') pickTxnType(btn);
    const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); } };
    set('txn-symbol', t.symbol); set('txn-quantity', t.quantity); set('txn-price', t.price);
    set('txn-plan-reason', 'Cân bằng về danh mục chuẩn chiến lược: ngành ' + t.sector + ' ' + (t.side === 'sell' ? 'đang vượt' : 'đang thiếu') + ' so với chuẩn.');
    closeRebalance();
    const form = document.getElementById('txn-form');
    if (form && form.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('Đã điền lệnh vào form — kiểm tra giá thực tế rồi bấm Lưu lệnh.', 'success');
}

function rbDefaultReason(t) {
    const s = RB.result.sectors.find(x => x.sector === t.sector);
    return 'Cân bằng về danh mục chuẩn chiến lược: ngành ' + t.sector + ' đang ' + rbNum(s.currentPct, 1) + '% so với chuẩn ' + rbNum(s.targetPct, 1) + '% (lệch ' + rbPts(s.driftPts) + ' điểm); ' + (t.side === 'sell' ? 'bán bớt ' : 'mua thêm ') + t.symbol + ' để về chuẩn.';
}

async function rbSend() {
    if (RB.sending) return;
    const idx = [...RB.selected].filter(i => rbNeeds(RB.result.trades[i]).needed);
    if (!idx.length) { showToast('Chưa chọn lệnh nào cần duyệt.', 'error'); return; }
    const custom = String((document.getElementById('rb-reason') || {}).value || '').trim();
    RB.sending = true; rbRenderFooter();
    let ok = 0, fail = '';
    for (const i of idx) {
        const t = RB.result.trades[i];
        try { await rbCall('createOrderRequest', { request: { symbol: t.symbol, side: t.side, quantity: t.quantity, price: t.price, reason: custom.length >= 10 ? custom + ' (' + rbDefaultReason(t) + ')' : rbDefaultReason(t) } }); ok++; }
        catch (e) { fail = e.message || String(e); }
    }
    RB.sending = false;
    if (ok) showToast('Đã gửi ' + ok + ' đề xuất lệnh cho quản lý duyệt.' + (fail ? ' Có lệnh lỗi: ' + fail : ''), fail ? 'error' : 'success');
    else showToast('Lỗi: ' + fail, 'error');
    if (typeof apLoadMine === 'function') apLoadMine();
    if (ok) closeRebalance(); else rbRenderFooter();
}

function rbRender() {
    const body = document.getElementById('rb-body');
    if (!body) return;
    if (RB.state === 'loading') { body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang lấy danh mục, chuẩn chiến lược, giới hạn và thanh khoản…</div>'; document.getElementById('rb-footer').innerHTML = ''; return; }
    if (RB.state === 'error') { body.innerHTML = `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không tính được: ${rbEsc(RB.error)}</div>`; document.getElementById('rb-footer').innerHTML = '<button type="button" class="btn-tool" onclick="closeRebalance()">Đóng</button>'; return; }
    const r = RB.result;
    const controls = `<div class="rb-controls"><label>Biên độ không giao dịch (± điểm %)<input type="number" id="rb-band" class="tl-input num" min="0" max="20" step="0.5" value="${RB.band}" onchange="rbChange()"></label>
        <label class="tl-check"><input type="checkbox" id="rb-off" ${RB.includeOff ? 'checked' : ''} onchange="rbChange()"> Bán cả ngành ngoài chuẩn (coi mục tiêu 0%)</label></div>`;
    if (!r.ok) { body.innerHTML = controls + `<div class="tl-empty"><i class="fa-solid fa-scale-unbalanced"></i>${rbEsc(RB_REASON[r.reason] || 'Chưa tính được.')}</div>`; document.getElementById('rb-footer').innerHTML = '<button type="button" class="btn-tool" onclick="closeRebalance()">Đóng</button>'; return; }
    const s = r.summary;
    const kpi = (k, v, sub) => `<div class="tl-kpi"><span class="k">${k}</span><span class="v">${v}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
    let html = controls + `<div class="tl-kpis">
        ${kpi('Lệch chuẩn', `${rbNum(s.driftBefore, 1)} → ${rbNum(s.driftAfter, 1)} điểm`, 'tổng lệch ngành + tiền mặt ÷ 2')}
        ${kpi('Số lệnh', String(s.count), 'giá trị ' + rbVnd(s.turnover))}
        ${kpi('Phí + thuế', rbVnd(s.cost), rbNum(s.costPctNav, 2) + '% NAV')}
        ${kpi('Tiền mặt', `${rbNum(r.cashPctBefore, 1)}% → ${rbNum(r.cashPctAfter, 1)}%`, 'chuẩn ' + rbNum(r.cashTargetPct, 1) + '%')}</div>`;
    if (r.warnings.length) html += `<div class="rk-warns">${r.warnings.map(w => `<div class="rk-warn low"><i class="fa-solid fa-circle-info"></i><span>${rbEsc(w)}</span></div>`).join('')}</div>`;
    html += `<div class="ce-group-title">Tỷ trọng ngành so với chuẩn (NAV ${rbVnd(r.nav)})</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Ngành</th><th class="text-right">Chuẩn</th><th class="text-right">Hiện tại</th><th class="text-right">Lệch</th><th class="text-right">Sau cân bằng</th><th>Hành động</th></tr></thead><tbody>
        ${r.sectors.map(x => `<tr><td><b>${rbEsc(x.sector)}</b>${x.inPolicy ? '' : ' <span class="tl-badge mute" title="Không có trong chuẩn">ngoài chuẩn</span>'}</td><td class="text-right">${x.inPolicy ? rbNum(x.targetPct, 1) + '%' : '—'}</td><td class="text-right">${rbNum(x.currentPct, 1)}%</td>
            <td class="text-right ${x.action === 'sell' ? 'tl-down' : (x.action === 'buy' ? 'tl-up' : '')}">${x.inScope ? rbPts(x.driftPts) : '—'}</td><td class="text-right">${rbNum(x.afterPct, 1)}%</td>
            <td>${{ sell: '<span class="tl-badge bad">Bán bớt</span>', buy: '<span class="tl-badge ok">Mua thêm</span>', ok: '<span class="tl-badge mute">Trong biên độ</span>', hold: '<span class="tl-badge mute">Giữ nguyên</span>' }[x.action]}</td></tr>`).join('')}
        </tbody></table></div>`;
    if (!r.trades.length) html += '<div class="tl-empty" style="padding:12px"><i class="fa-solid fa-circle-check"></i>Không có lệnh nào cần thiết với biên độ này.</div>';
    else html += `<div class="ce-group-title">Lệnh đề xuất</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th></th><th>Lệnh</th><th>Ngành</th><th class="text-right">Giá</th><th class="text-right">Giá trị</th><th class="text-right">Phí + thuế</th><th class="text-right">Tỷ trọng mã</th><th></th></tr></thead><tbody>
        ${r.trades.map((t, i) => { const n = rbNeeds(t); return `<tr><td>${n.needed ? `<input type="checkbox" ${RB.selected.has(i) ? 'checked' : ''} onchange="rbToggle(${i}, this.checked)" aria-label="Chọn gửi đề xuất">` : ''}</td>
            <td><span class="txn-type-badge ${t.side}">${t.side === 'sell' ? 'Bán' : 'Mua'}</span> <b>${rbEsc(t.symbol)}</b> ${rbNum(t.quantity)} cổ${t.notes.length ? `<span class="symbol-sub">${rbEsc(t.notes.join('; '))}</span>` : ''}</td><td>${rbEsc(t.sector)}</td>
            <td class="text-right">${rbNum(t.price)}</td><td class="text-right">${rbVnd(t.value)}${n.needed ? '<span class="symbol-sub"><span class="tl-badge warn">cần duyệt</span></span>' : ''}</td><td class="text-right">${rbVnd(t.fee + t.tax)}</td>
            <td class="text-right">${rbNum(t.weightBefore, 1)}% → ${rbNum(t.weightAfter, 1)}%</td><td><button type="button" class="btn-tool" onclick="rbFill(${i})"><i class="fa-solid fa-arrow-up-right-from-square"></i> Điền vào form</button></td></tr>`; }).join('')}
        </tbody></table></div>
        <div class="txn-field txn-field-wide" id="rb-reason-wrap" style="margin-top:10px"><label for="rb-reason">Lý do bổ sung cho đề xuất (tuỳ chọn; hệ thống đã tự ghi độ lệch chuẩn của từng ngành)</label><input type="text" id="rb-reason" class="tl-input" maxlength="400" placeholder="VD: thống nhất cân bằng quý 4 theo họp nhóm"></div>`;
    if (r.gaps.length) html += `<div class="ce-group-title">Khoảng trống: ngành thiếu mà chưa có mã</div><ul class="lm-list">${r.gaps.map(g => `<li>${rbEsc(g.sector)}: chuẩn ${rbNum(g.targetPct, 1)}%, hiện ${rbNum(g.currentPct, 1)}% — cần khoảng <b>${rbVnd(g.amount)}</b> (${rbNum(g.pct, 1)}% NAV). Chọn mã ở Tổng Hợp CP / Ý tưởng rồi dùng “Kiểm tra trước lệnh”.</li>`).join('')}</ul>`;
    html += '<p class="tl-hint">Bán ngành thừa theo tỷ lệ giá trị từng mã, mua ngành thiếu bằng tiền bán được và tiền mặt dư (không xuống dưới tiền mặt chuẩn); làm tròn lô 100; khối lượng bị cắt theo thanh khoản (tối đa 3 phiên × 20% khối lượng TB ngày) và giới hạn đầu tư. Chưa tính ảnh hưởng thuế ngoài thuế bán 0,1% và chưa xét triển vọng từng mã: đây là công cụ hỗ trợ quyết định, không phải khuyến nghị.</p>';
    body.innerHTML = html;
    rbRenderFooter();
}

function rbRenderFooter() {
    const f = document.getElementById('rb-footer');
    if (!f || RB.state !== 'ok' || !RB.result || !RB.result.ok) return;
    const n = [...RB.selected].filter(i => RB.result.trades[i] && rbNeeds(RB.result.trades[i]).needed).length;
    const pending = RB.result.trades.filter(t => rbNeeds(t).needed).length;
    f.innerHTML = '<button type="button" class="btn-tool" onclick="closeRebalance()">Đóng</button>'
        + (pending ? `<button type="button" class="btn-save" onclick="rbSend()" ${n && !RB.sending ? '' : 'disabled'}><i class="fa-solid fa-stamp"></i> Gửi đề xuất duyệt (${n} lệnh vượt ngưỡng)</button>` : '');
}
