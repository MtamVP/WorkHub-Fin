/* --- FILE: /mastersheet/assets/pretrade.js ---
   Kiểm tra TRƯỚC lệnh trong form "Thêm Lệnh Giao Dịch": tính khối lượng theo ngân sách rủi ro (rủi ro % NAV ÷ lỗ tới điểm cắt lỗ), rồi cho thấy
   tỷ trọng mã/ngành/tiền mặt sau lệnh, lỗ tối đa, tỷ lệ lời/lỗ, thanh khoản (cần mấy phiên) và các giới hạn đầu tư bị chạm -- trước khi bấm lưu.
   Phép tính ở /lib/sizing-calc.js và /lib/limits-calc.js (có kiểm thử). Dùng global của script.js / limits.js: callGAS, targetEmail, parseMoney, escapeAssetHtml, lmCall, getFeeSettings. */

const PT = { ctx: null, ctxAt: 0, ctxLoading: null, vol: {}, volLoading: {}, timer: null, riskPct: 1, q: {}, lastAuto: null, filling: false, symTimer: null };
const PT_RISK_KEY = 'wh.fin.pt.risk';
const PT_CTX_TTL = 60000;

const ptEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const ptNum = (v, d) => Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: d === undefined ? 0 : d });
const ptVnd = (v) => ptNum(Math.round(v), 0) + ' đ';

function ptLoadRisk() { try { const v = Number(localStorage.getItem(PT_RISK_KEY)); if (v > 0 && v <= 20) PT.riskPct = v; } catch (e) { /* mặc định */ } }
function ptSaveRisk() { try { localStorage.setItem(PT_RISK_KEY, String(PT.riskPct)); } catch (e) { /* không chặn */ } }

// Bối cảnh danh mục + giới hạn (cache 60 giây; xoá khi vừa lưu lệnh)
async function ptContext(force) {
    if (!force && PT.ctx && Date.now() - PT.ctxAt < PT_CTX_TTL) return PT.ctx;
    if (PT.ctxLoading) return PT.ctxLoading;
    PT.ctxLoading = (async () => {
        const [rows, actor, hv, cd, approval, restricted] = await Promise.all([
            lmCall('listLimits').catch(() => []), lmCall('getLimitActor').catch(() => ({})),
            callGAS('getHoldingsView', { email: targetEmail }), callGAS('getCashDebt', { email: targetEmail }),
            lmCall('getApprovalPolicy').catch(() => null), lmCall('listRestricted').catch(() => []),
        ]);
        const holdings = ((hv && hv.data) || []).map(h => ({ symbol: h.symbol, value: Number(h.marketValue) || 0, price: Number(h.marketPrice) || 0 }));
        const cash = Number(cd && cd.data ? cd.data.cash : 0) || 0, debt = Number(cd && cd.data ? cd.data.debt : 0) || 0;
        const limits = LimitsCalc.applicable(rows || [], actor.targetId, 'member');
        const mv = holdings.reduce((s, h) => s + h.value, 0);
        PT.ctx = { holdings, cash, debt, limits, nav: mv + cash - debt, approval, restricted: (restricted || []).filter(r => r.active && (!r.user_id || r.user_id === actor.targetId)) };
        PT.ctxAt = Date.now();
        return PT.ctx;
    })();
    try { return await PT.ctxLoading; } finally { PT.ctxLoading = null; }
}

// Khối lượng trung bình 20 phiên gần nhất của mã (từ Edge Function stock-history, volumes:true). null = chưa có / không lấy được.
async function ptAdv(symbol) {
    if (symbol in PT.vol) return PT.vol[symbol];
    if (PT.volLoading[symbol]) return null;
    PT.volLoading[symbol] = true;
    try {
        const r = await callGAS('getVolumeHistory', { symbols: [symbol], days: 60 });
        const series = (r && r.status === 'success' && r.data && r.data[symbol]) || [];
        const last = series.slice(-20).map(x => Number(x[1])).filter(v => v >= 0);
        PT.vol[symbol] = last.length >= 5 ? last.reduce((s, v) => s + v, 0) / last.length : null;
    } catch (e) { PT.vol[symbol] = null; }
    PT.volLoading[symbol] = false;
    return PT.vol[symbol];
}

// ---- Giá trực tiếp trong form (lib/pretrade-live.js): chỉ gợi ý, không đổi sổ và không chặn lưu lệnh ----
const ptSession = () => (typeof LiveQuotes !== 'undefined' ? LiveQuotes.session() : 'closed');
// Báo giá của một mã: ưu tiên hàm VCI (có trần/sàn), dự phòng giá đang có trong LiveQuotes. Nhớ 15 giây. null = không có.
async function ptLiveQuote(sym) {
    if (!sym || !/^[A-Z0-9]{1,12}$/.test(sym) || typeof PretradeLive === 'undefined') return null;
    const c = PT.q[sym];
    if (c && Date.now() - c.at < 15000) return c.v;
    let raw = null;
    try {
        if (typeof API !== 'undefined' && API.asset && API.asset.market && API.asset.market.liveQuotes) {
            const r = await API.asset.market.liveQuotes([sym]), x = r && r.quotes && r.quotes[sym];
            if (x) raw = Object.assign({}, x, { time: typeof LiveQuotes !== 'undefined' ? LiveQuotes.hhmmss(Math.floor(Date.parse(r.asOf) / 1000)) : null });
        }
    } catch (e) { /* hàm giá VCI lỗi: dùng giá đang có của Danh Mục nếu có */ }
    if (!raw && typeof LiveQuotes !== 'undefined' && LiveQuotes.state.quotes[sym]) { const s = LiveQuotes.state.quotes[sym]; raw = { price: s.price, ref: s.ref, time: s.time }; }
    const v = raw ? PretradeLive.describe(raw, ptSession()) : null;
    PT.q[sym] = { at: Date.now(), v: v };
    return v;
}
// Vẽ lại bối cảnh danh mục theo giá trực tiếp của các mã đang nắm (khi Danh Mục đang bật giá trực tiếp)
function ptApplyLive(ctx) {
    if (typeof PretradeLive === 'undefined' || typeof LiveUI === 'undefined' || !LiveUI.active()) return ctx;
    const o = PretradeLive.overlay(ctx.holdings, LiveQuotes.state.quotes, ctx.cash, ctx.debt);
    if (!o.liveCount) return ctx;
    return Object.assign({}, ctx, { holdings: o.holdings, nav: o.nav, liveCount: o.liveCount, navDelta: o.navDelta });
}
// Khi đổi mã (hoặc loại lệnh): tự điền giá trực tiếp vào ô Giá nếu ô trống hoặc đang giữ giá tự điền lần trước; luôn hiện dòng giá thị trường dưới ô
async function ptAutofillPrice() {
    const symEl = document.getElementById('txn-symbol'), el = document.getElementById('txn-price'), hint = document.getElementById('txn-live-hint');
    if (!symEl || !el || typeof PretradeLive === 'undefined') return;
    const sym = String(symEl.value).trim().toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(sym)) { if (hint) hint.textContent = ''; return; }
    const lq = await ptLiveQuote(sym);
    if (String(symEl.value).trim().toUpperCase() !== sym) return;                 // đã đổi mã trong lúc chờ
    if (hint) hint.textContent = lq ? lq.text : '';
    if (lq && PretradeLive.shouldAutofill(el.value, el.dataset.auto === '1', PT.lastAuto)) {
        PT.filling = true; el.value = lq.price; el.dataset.auto = '1'; PT.lastAuto = lq.price;
        el.dispatchEvent(new Event('input', { bubbles: true })); PT.filling = false;
    }
}
async function ptUseLivePrice() {
    const el = document.getElementById('txn-price'), sym = String((document.getElementById('txn-symbol') || {}).value || '').trim().toUpperCase();
    const lq = await ptLiveQuote(sym);
    if (!el || !lq) return;
    PT.filling = true; el.value = lq.price; el.dataset.auto = '1'; PT.lastAuto = lq.price; el.dispatchEvent(new Event('input', { bubbles: true })); PT.filling = false;
}

function ptInputs() {
    const g = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    return {
        type: g('txn-type'), symbol: String(g('txn-symbol')).trim().toUpperCase(), qty: parseMoney(g('txn-quantity')), price: parseMoney(g('txn-price')),
        stop: parseMoney(g('txn-plan-stop')), target: parseMoney(g('txn-plan-expected')),
    };
}

const PT_TONE_ICON = { bad: 'fa-circle-xmark', warn: 'fa-triangle-exclamation', info: 'fa-circle-info', ok: 'fa-circle-check' };
const PT_BIND = { risk: 'ngân sách rủi ro', cash: 'tiền mặt', limit: 'giới hạn đầu tư', liquidity: 'thanh khoản của mã', nostop: 'chưa có điểm cắt lỗ' };

function ptSchedule() { clearTimeout(PT.timer); PT.timer = setTimeout(ptRender, 250); }

async function ptRender() {
    const body = document.getElementById('pt-body');
    const box = document.getElementById('txn-pretrade');
    if (!body || !box || !box.open) return;
    const x = ptInputs();
    if (x.type !== 'buy') { body.innerHTML = '<p class="tl-hint">Công cụ này tính cho <b>lệnh mua</b>. Chuyển sang “Mua” để tính khối lượng và xem tác động lên danh mục.</p>'; return; }
    if (!x.symbol) { body.innerHTML = '<p class="tl-hint">Nhập mã, giá dự kiến và điểm cắt lỗ (mục “Kế hoạch &amp; lý do” bên dưới) để tính khối lượng nên mua.</p>'; return; }
    let ctx;
    try { ctx = await ptContext(); } catch (e) { body.innerHTML = `<p class="tl-hint text-danger">Không tải được danh mục: ${ptEsc(e.message || e)}</p>`; return; }
    ctx = ptApplyLive(ctx);                         // giá trị vị thế và NAV theo giá trực tiếp (nếu đang bật), không dùng giá lưu 5 phút
    const adv = await ptAdv(x.symbol);
    const lq = await ptLiveQuote(x.symbol);
    // Có thể người dùng đã gõ tiếp trong lúc chờ: chỉ vẽ nếu đầu vào không đổi
    const y = ptInputs();
    if (y.symbol !== x.symbol || y.qty !== x.qty || y.price !== x.price || y.stop !== x.stop || y.target !== x.target || y.type !== x.type) return;

    const rates = (typeof getFeeSettings === 'function') ? { buyFeeRate: getFeeSettings().buyFeeRate, sellFeeRate: getFeeSettings().sellFeeRate, sellTaxRate: getFeeSettings().sellTaxRate } : PortfolioCalc.DEFAULT_RATES;
    const held = ctx.holdings.find(h => h.symbol === x.symbol);
    const price = x.price > 0 ? x.price : (held ? held.price : (lq ? lq.price : 0));
    const pf = { holdings: ctx.holdings.map(h => ({ symbol: h.symbol, value: h.value })), cash: ctx.cash, debt: ctx.debt };
    const base = { nav: ctx.nav, cash: ctx.cash, price: price, stop: x.stop, riskPct: PT.riskPct, rates: rates, adv: adv || 0 };
    const sz = SizingCalc.size(Object.assign({}, base, { limits: { LC: LimitsCalc, rows: ctx.limits, pf: pf, symbol: x.symbol } }));
    const qty = x.qty > 0 ? x.qty : 0;
    const a = SizingCalc.assess({ nav: ctx.nav, cash: ctx.cash, price: price, qty: qty, stop: x.stop, target: x.target, currentValue: held ? held.value : 0, adv: adv || 0, riskPct: PT.riskPct, rates: rates });

    let chk = null;
    if (qty > 0 && price > 0) chk = LimitsCalc.checkTrade(ctx.limits, pf, { type: 'buy', symbol: x.symbol, quantity: qty, price: price, fee: qty * price * rates.buyFeeRate, tax: 0 });

    const sugg = sz.qty > 0
        ? `<div class="pt-sugg"><div><span class="k">Khối lượng gợi ý</span><b>${ptNum(sz.qty)} cổ</b> <span class="s">≈ ${ptVnd(sz.qty * price)} · chặn bởi ${ptEsc(PT_BIND[sz.binding] || '')}</span></div><button type="button" class="btn-tool" onclick="ptUseQty(${sz.qty})"><i class="fa-solid fa-arrow-down-to-line"></i> Dùng khối lượng này</button></div>`
        : `<div class="pt-sugg none"><div><span class="k">Khối lượng gợi ý</span><b>—</b> <span class="s">${ptEsc(sz.warnings[0] || (PT_BIND[sz.binding] ? 'Bị chặn bởi ' + PT_BIND[sz.binding] : 'Chưa đủ thông tin'))}</span></div></div>`;
    const caps = ['risk', 'cash', 'liquidity', 'limit'].filter(k => sz.caps[k] !== null && sz.caps[k] !== undefined)
        .map(k => `<span class="tl-badge ${sz.binding === k ? 'warn' : 'mute'}" title="Trần khối lượng theo ${ptEsc(PT_BIND[k])}">${ptEsc({ risk: 'Rủi ro', cash: 'Tiền mặt', liquidity: 'Thanh khoản', limit: 'Giới hạn' }[k])}: ${ptNum(sz.caps[k])}</span>`).join(' ');

    let impact = '';
    if (a.value > 0) {
        const sector = FinCalc.sectorOf(x.symbol);
        const after = LimitsCalc.applyTrade(pf, { type: 'buy', symbol: x.symbol, quantity: qty, price: price, fee: qty * price * rates.buyFeeRate });
        const secBefore = pf.holdings.filter(h => FinCalc.sectorOf(h.symbol) === sector).reduce((s, h) => s + h.value, 0);
        const secAfter = after.holdings.filter(h => FinCalc.sectorOf(h.symbol) === sector).reduce((s, h) => s + h.value, 0);
        const nav = ctx.nav;
        const pct = (v) => nav > 0 ? ptNum(v / nav * 100, 1) + '%' : '—';
        const kpi = (k, v, s) => `<div class="tl-kpi"><span class="k">${k}</span><span class="v">${v}</span>${s ? `<span class="s">${s}</span>` : ''}</div>`;
        impact = `<div class="tl-kpis pt-kpis">
            ${kpi('Giá trị lệnh', ptVnd(a.value), nav > 0 ? ptNum(a.value / nav * 100, 1) + '% NAV' : '')}
            ${kpi('Tỷ trọng ' + ptEsc(x.symbol), `${a.weightBefore === null ? '—' : ptNum(a.weightBefore, 1) + '%'} → ${a.weightAfter === null ? '—' : ptNum(a.weightAfter, 1) + '%'}`, '')}
            ${kpi('Ngành ' + ptEsc(sector), `${pct(secBefore)} → ${pct(secAfter)}`, '')}
            ${kpi('Tiền mặt sau lệnh', nav > 0 ? ptNum(a.cashAfter / nav * 100, 1) + '%' : '—', ptVnd(a.cashAfter))}
            ${kpi('Mất tối đa tới điểm cắt lỗ', a.maxLoss === null ? '—' : ptVnd(a.maxLoss), a.maxLossPctNav === null ? 'cần điểm cắt lỗ' : ptNum(a.maxLossPctNav, 2) + '% NAV')}
            ${kpi('Lời / lỗ kỳ vọng', a.rewardRisk === null ? '—' : ptNum(a.rewardRisk, 2) + ' : 1', a.expectedGain === null ? 'cần giá mục tiêu' : 'lời ≈ ' + ptVnd(a.expectedGain))}
            ${kpi('Thanh khoản', a.daysToTrade === null ? '—' : (a.daysToTrade < 1 ? '< 1 phiên' : '≈ ' + Math.ceil(a.daysToTrade) + ' phiên'), a.participationPct === null ? (adv === null ? 'chưa có dữ liệu khối lượng' : '') : ptNum(a.participationPct, a.participationPct < 1 ? 2 : 1) + '% khối lượng TB ngày')}
        </div>`;
    }
    const flagLine = (tone, text) => `<li class="pt-flag ${tone}"><i class="fa-solid ${PT_TONE_ICON[tone] || 'fa-circle-info'}"></i> ${ptEsc(text)}</li>`;
    const lines = [];
    a.flags.forEach(f => lines.push(flagLine(f.tone, f.text)));
    if (chk) {
        chk.violations.forEach(v => lines.push(flagLine(v.mode === 'warn' ? 'warn' : 'bad', `${v.text} — ${LimitsCalc.MODES[v.mode].label.toLowerCase()}`)));
        chk.near.forEach(v => lines.push(flagLine('info', v.text)));
    }
    if (lq) PretradeLive.priceFlags(x.price, lq, ptSession()).forEach(f => lines.push(flagLine(f.tone, f.text)));      // giá nhập lệch giá trực tiếp hoặc ngoài trần/sàn
    // Danh sách hạn chế: mã bị cấm thì không ghi được lệnh
    const rs = (ctx.restricted || []).find(r => r.symbol === x.symbol);
    if (rs) lines.unshift(flagLine('bad', `${x.symbol} đang trong danh sách hạn chế của nhóm (${rs.reason}): không được mua hoặc bán cho tới khi quản lý gỡ hạn chế.`));
    // Duyệt lệnh lớn: báo trước nếu lệnh sẽ phải qua quản lý duyệt
    let approvalHtml = '';
    if (ctx.approval && ctx.approval.active && typeof ApprovalCalc !== 'undefined' && qty > 0 && price > 0) {
        const na = ApprovalCalc.needsApproval(ctx.approval, ctx.nav, { quantity: qty, price: price });
        if (na.needed) {
            lines.push(flagLine('warn', `Lệnh vượt ngưỡng duyệt lệnh lớn của nhóm (${na.pct !== null ? ptNum(na.pct, 1) + '% NAV' : ptVnd(na.value)}): cần quản lý duyệt trước khi ghi.`));
            approvalHtml = '<div class="pt-sugg none"><div><span class="k">Duyệt lệnh lớn</span> <span class="s">Gửi đề xuất ngay bây giờ để quản lý duyệt trong lúc bạn chuẩn bị.</span></div><button type="button" class="btn-tool" onclick="apOpenFromForm()"><i class="fa-solid fa-stamp"></i> Gửi đề xuất</button></div>';
        }
    }
    if (!lines.length && a.value > 0) lines.push(flagLine('ok', 'Không có cảnh báo: lệnh nằm trong ngân sách rủi ro và các giới hạn.'));

    body.innerHTML = `
        <div class="pt-controls">
            <label>Ngân sách rủi ro <span class="tl-hint" style="margin:0">(% NAV chịu mất nếu chạm cắt lỗ)</span>
                <input type="number" id="pt-risk" class="tl-input num" min="0.1" max="20" step="0.1" value="${PT.riskPct}" onchange="ptSetRisk(this.value)"></label>
            <div class="pt-meta">NAV hiện tại <b>${ptVnd(ctx.nav)}</b>${ctx.liveCount ? ` <span class="tl-badge info" title="Giá trị vị thế và NAV tính theo giá trực tiếp của ${ctx.liveCount} mã (chỉ để kiểm tra trước lệnh; sổ vẫn dùng giá lưu)">giá trực tiếp</span>` : ''} · tiền mặt <b>${ptVnd(ctx.cash)}</b> · ${ctx.limits.length} giới hạn áp dụng${price > 0 ? '' : ' · <span class="text-danger">chưa có giá</span>'}</div>
        </div>
        ${lq ? `<div class="pt-sugg none"><div><span class="k">Giá thị trường</span> <span class="s">${ptEsc(lq.text)}</span></div><button type="button" class="btn-tool" onclick="ptUseLivePrice()">Dùng giá này</button></div>` : ''}
        ${sugg}
        ${caps ? `<div class="pt-caps">${caps}</div>` : ''}
        ${impact}
        ${lines.length ? `<ul class="pt-flags">${lines.join('')}</ul>` : ''}
        ${approvalHtml}
        <p class="tl-hint">Khối lượng gợi ý = ngân sách rủi ro ÷ lỗ mỗi cổ phiếu tới điểm cắt lỗ (đã gồm phí và thuế), làm tròn xuống lô 100, rồi bị chặn bởi tiền mặt, giới hạn đầu tư và thanh khoản (tối đa 3 phiên × 20% khối lượng trung bình ngày). Đây là công cụ hỗ trợ quyết định, không phải khuyến nghị.</p>`;
}

function ptSetRisk(v) {
    const n = Number(v);
    if (n > 0 && n <= 20) { PT.riskPct = n; ptSaveRisk(); }
    ptRender();
}

function ptUseQty(q) {
    const el = document.getElementById('txn-quantity');
    if (!el) return;
    el.value = q;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    ptRender();
}

document.addEventListener('DOMContentLoaded', () => {
    ptLoadRisk();
    ['txn-symbol', 'txn-quantity', 'txn-price', 'txn-plan-stop', 'txn-plan-expected'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', ptSchedule); });
    const symEl = document.getElementById('txn-symbol'), priceEl = document.getElementById('txn-price');
    if (symEl) symEl.addEventListener('input', () => { clearTimeout(PT.symTimer); PT.symTimer = setTimeout(ptAutofillPrice, 450); });
    if (priceEl) priceEl.addEventListener('input', () => { if (!PT.filling) priceEl.dataset.auto = '0'; });       // người dùng tự gõ giá: không tự điền đè nữa
    const seg = document.querySelector('#txn-form .seg');
    if (seg) seg.addEventListener('click', () => setTimeout(() => { ptRender(); ptAutofillPrice(); }, 0));
    const box = document.getElementById('txn-pretrade');
    if (box) box.addEventListener('toggle', () => { if (box.open) ptRender(); });
    const form = document.getElementById('txn-form');
    if (form) form.addEventListener('submit', () => { PT.ctx = null; setTimeout(() => { PT.ctx = null; if (priceEl) priceEl.dataset.auto = '0'; PT.lastAuto = null; const h = document.getElementById('txn-live-hint'); if (h) h.textContent = ''; }, 3000); });   // sau khi ghi lệnh danh mục đổi nên bối cảnh phải tải lại
});
