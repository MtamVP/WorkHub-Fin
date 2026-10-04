/* --- FILE: /mastersheet/assets/vn-rules.js ---
   Nhắc QUY ĐỊNH THỊ TRƯỜNG ngay dưới form "Thêm Lệnh Giao Dịch": giá trần/sàn theo sàn của mã (HOSE ±7%, HNX ±10%, UPCoM ±15%), bước giá, lô chẵn 100, và T+2 (cổ phiếu mua chưa về chưa bán được,
   tiền bán chưa về). Lệnh sai biên độ/bước giá bị sàn từ chối, bán cổ phiếu chưa về bị công ty chứng khoán từ chối -- báo trước để khỏi ghi một lệnh không thể xảy ra.
   Phép tính ở /lib/vn-market.js (có kiểm thử). Chỉ nhắc, KHÔNG chặn lưu (lệnh có thể đã khớp ở công ty chứng khoán rồi mới ghi lại). Dùng global: callGAS, targetEmail, parseMoney, escapeAssetHtml. */

const VR = { timer: null, ref: {}, settle: null, settleAt: 0, seq: 0 };
const VR_REF_TTL = 300000, VR_SETTLE_TTL = 60000;

const vrEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const vrNum = (v, d) => Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: d === undefined ? 0 : d });
const vrDmy = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}` : ''; };

async function vrCall(action, params) {
    const r = await callGAS(action, Object.assign({ email: targetEmail }, params || {}));
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}
async function vrRef(symbol) {
    const c = VR.ref[symbol];
    if (c && Date.now() - c.at < VR_REF_TTL) return c.v;
    const v = await vrCall('getMarketReference', { symbol });
    VR.ref[symbol] = { at: Date.now(), v };
    return v;
}
async function vrSettle(force) {
    if (!force && VR.settle && Date.now() - VR.settleAt < VR_SETTLE_TTL) return VR.settle;
    VR.settle = await vrCall('getSettlement');
    VR.settleAt = Date.now();
    return VR.settle;
}
function vrInvalidate() { VR.settle = null; VR.settleAt = 0; }

function vrSchedule() { clearTimeout(VR.timer); VR.timer = setTimeout(vrRender, 300); }

const vrLine = (tone, html) => `<div class="vr-line ${tone}"><i class="fa-solid ${{ bad: 'fa-circle-xmark', warn: 'fa-triangle-exclamation', info: 'fa-circle-info', ok: 'fa-circle-check' }[tone] || 'fa-circle-info'}"></i><span>${html}</span></div>`;

async function vrRender() {
    const box = document.getElementById('txn-rules');
    if (!box) return;
    const g = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const type = g('txn-type'), symbol = String(g('txn-symbol')).trim().toUpperCase(), qty = parseMoney(g('txn-quantity')), price = parseMoney(g('txn-price'));
    if (!/^[A-Z0-9]{1,12}$/.test(symbol)) { box.innerHTML = ''; return; }
    const seq = ++VR.seq;
    let ref = null, st = null, err = '';
    try { [ref, st] = await Promise.all([vrRef(symbol), type === 'sell' || type === 'buy' ? vrSettle() : Promise.resolve(null)]); }
    catch (e) { err = e.message || String(e); }
    if (seq !== VR.seq) return;                                      // người dùng đã gõ tiếp
    const lines = [];
    if (ref && ref.limits) {
        const L = ref.limits;
        lines.push(vrLine('info', `<b>${vrEsc(ref.exchange)}</b>${ref.listingKnown ? '' : ' <small>(chưa rõ sàn, tạm coi là HOSE)</small>'} · tham chiếu <b>${vrNum(ref.ref)}</b> (phiên ${vrDmy(ref.refDate)}) · sàn <b>${vrNum(L.floor)}</b> – trần <b>${vrNum(L.ceiling)}</b>${L.tick ? ' · bước giá ' + vrNum(L.tick) : ''}${L.approx ? ' <small>(UPCoM: xấp xỉ)</small>' : ''}`));
        if (price > 0) {
            const c = VnMarket.checkPrice(price, ref.ref, ref.exchange, ref.type);
            if (c.reasons.indexOf('above_ceiling') >= 0) lines.push(vrLine('bad', `Giá ${vrNum(price)} cao hơn giá trần ${vrNum(L.ceiling)}: sàn sẽ từ chối lệnh đặt ở mức này. Nếu lệnh đã khớp ở giá khác, kiểm tra lại giá.`));
            if (c.reasons.indexOf('below_floor') >= 0) lines.push(vrLine('bad', `Giá ${vrNum(price)} thấp hơn giá sàn ${vrNum(L.floor)} của phiên tham chiếu ${vrDmy(ref.refDate)}.`));
            if (c.reasons.indexOf('off_tick') >= 0) lines.push(vrLine('warn', `Giá ${vrNum(price)} không đúng bước giá ${vrNum(c.tick || L.tick)} đồng.`));
            if (c.ok && !c.skipped) lines.push(vrLine('ok', 'Giá nằm trong biên độ và đúng bước giá.'));
            if (new Date(g('txn-date') || Date.now()).toISOString().slice(0, 10) < (ref.today || '')) lines.push(vrLine('info', 'Ngày lệnh trước hôm nay: biên độ tính theo phiên tham chiếu gần nhất nên chỉ mang tính tham khảo.'));
        }
    } else if (err) lines.push(vrLine('info', `Chưa lấy được giá tham chiếu (${vrEsc(err)}).`));
    if (qty > 0 && !VnMarket.lotCheck(qty).ok) lines.push(vrLine('info', `Khối lượng ${vrNum(qty)} lẻ lô (lô chẵn ${VnMarket.LOT}): lô lẻ khớp ở bảng riêng, có thể chậm và khác giá.`));
    if (st && type === 'sell') {
        const s = st.sellable[symbol], held = st.held[symbol] || 0;
        if (s && s.locked > 0) {
            lines.push(vrLine(qty > s.sellable ? 'bad' : 'warn', `Đang giữ <b>${vrNum(held)}</b> cổ phiếu ${vrEsc(symbol)}, trong đó <b>${vrNum(s.locked)}</b> mới mua chưa về tài khoản (về ngày ${vrDmy(s.nextSettle)}, T+2): bán được hôm nay <b>${vrNum(s.sellable)}</b>.${qty > s.sellable ? ' Lệnh bán vượt số này sẽ bị công ty chứng khoán từ chối.' : ''}`));
        }
    }
    if (st && type === 'buy' && st.unsettled && st.unsettled.cashPending > 0) {
        const next = st.unsettled.sellCash.map(c => c.settleDate).sort()[0];
        lines.push(vrLine('info', `Tiền bán chưa về: <b>${vrNum(Math.round(st.unsettled.cashPending))} đ</b> (về từ ${vrDmy(next)}, T+2). Một số công ty chứng khoán cho dùng ngay để mua, một số thì không: kiểm tra sức mua của bạn.`));
    }
    box.innerHTML = lines.length ? `<div class="vr-box">${lines.join('')}</div>` : '';
}

document.addEventListener('DOMContentLoaded', () => {
    ['txn-type', 'txn-symbol', 'txn-quantity', 'txn-price', 'txn-date'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.addEventListener('input', vrSchedule); el.addEventListener('change', vrSchedule); }
    });
    const seg = document.querySelector('#txn-form .seg');                      // nút Mua/Bán đặt giá trị ô ẩn txn-type bằng code nên không phát sự kiện input
    if (seg) seg.addEventListener('click', () => setTimeout(vrRender, 0));
    const form = document.getElementById('txn-form');
    if (form) form.addEventListener('submit', () => { setTimeout(vrInvalidate, 1500); setTimeout(vrRender, 1600); });   // lệnh vừa lưu làm đổi số chưa về
});
