/* --- FILE: /lab/lab-factors.js ---
   Tab "Yếu tố và phong cách": lấy tỷ trọng danh mục (của tôi / nhóm / mã tự chọn), dựng lợi suất yếu tố từ kho giá, hồi quy và đo độ nghiêng từng mã đang nắm. Dùng LAB, labCall, render từ lab-app.js (nạp trước). */
'use strict';
function parseCustom(text) {
    // "FPT, HPG VCB" -> chia đều; "FPT:40 HPG:30" -> theo tỷ trọng (chuẩn hoá về 100%)
    const parts = String(text || '').split(/[,;\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean), w = {};
    parts.forEach((p) => {
        const m = /^([A-Z0-9]{1,12})(?::(\d+(?:[.,]\d+)?))?$/.exec(p);
        if (m) w[m[1]] = m[2] ? Number(m[2].replace(',', '.')) : 1;
    });
    const total = Object.keys(w).reduce((s, k) => s + w[k], 0);
    if (!(total > 0)) return {};
    Object.keys(w).forEach((k) => { w[k] = w[k] / total; });
    return w;
}
async function facWeights() {
    const S = LAB.fac;
    if (S.subject === 'custom') {
        const w = parseCustom(S.custom);
        if (!Object.keys(w).length) throw new Error('Nhập ít nhất một mã (vd FPT, HPG, VCB).');
        return { weights: w, label: 'Mã tự chọn' };
    }
    let positions, cash = 0;
    if (S.subject === 'mine') {
        const [hold, cd] = await Promise.all([labCall('getHoldingsView', {}), labCall('getCashDebt', {})]);
        positions = (hold || []).filter((h) => Number(h.quantity) > 0).map((h) => ({ symbol: String(h.symbol).toUpperCase(), value: Number(h.quantity) * (Number(h.marketPrice) || 0) }));
        cash = Math.max(0, Number(cd && cd.cash) || 0);
    } else {
        const data = await labCall('getGroupData', {});
        const g = GroupCalc.consolidate(GroupCalc.memberPortfolios(data));
        positions = g.symbols.filter((s) => s.quantity > 0).map((s) => ({ symbol: String(s.symbol).toUpperCase(), value: s.quantity * (s.price || 0) }));
        cash = Math.max(0, g.cash || 0);
    }
    positions = positions.filter((p) => p.value > 0);
    if (!positions.length) throw new Error(S.subject === 'mine' ? 'Danh mục của bạn chưa có vị thế nào có giá.' : 'Danh mục nhóm chưa có vị thế nào có giá.');
    const nav = positions.reduce((s, p) => s + p.value, 0) + cash, w = {};
    positions.forEach((p) => { w[p.symbol] = p.value / nav; });
    return { weights: w, label: SUBJECTS_LABEL(S.subject), cashPct: cash / nav };
}
const SUBJECTS_LABEL = (k) => (LabFactorViews.SUBJECTS[k] || k);
function labFacSubject(k) { LAB.fac.subject = k; LAB.fac.res = null; LAB.fac.state = 'idle'; render(); }
function labFacWindow(k) { LAB.fac.window = Number(k) || 504; LAB.fac.res = null; LAB.fac.state = 'idle'; render(); }
function labFacCustom(v) { LAB.fac.custom = String(v || ''); }
async function labFacRun() {
    const S = LAB.fac;
    if (LAB.data.state !== 'ready') { showToast('Kho giá chưa tải xong.', 'error'); return; }
    if (S.state === 'running') return;
    S.state = 'running'; S.progress = 'Lấy tỷ trọng danh mục…'; S.res = null; render();
    await tick();
    try {
        const w = await facWeights();
        S.holdings = w;
        S.progress = 'Dựng lợi suất các yếu tố (lần đầu mất vài giây)…'; const el = document.getElementById('lab-result'); if (el) el.innerHTML = U.loading(S.progress);
        await tick();
        if (!S.F || S.Fkey !== LAB.panel.T + '|' + LAB.pit.length) {
            S.F = FactorModel.buildFactorReturns(LAB.panel, LAB.pit, { rf: 0.03 }); S.Fkey = LAB.panel.T + '|' + LAB.pit.length;
            S.curve = FactorModel.curves(S.F, LAB.panel.dates, 5);
        }
        S.res = FactorModel.analyze(LAB.panel, LAB.pit, w.weights, { window: S.window, rf: 0.03 }, S.F);
        S.expo = S.res.ok ? FactorModel.exposures(LAB.panel, LAB.pit, w.weights, LAB.panel.T - 1) : null;
        S.state = 'ok';
    } catch (e) { console.error(e); S.state = 'error'; S.error = e.message || String(e); }
    render();
}
