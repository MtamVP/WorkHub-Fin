/* --- FILE: /mastersheet/group-rebalance.js ---
   Toàn Nhóm > "Chiến Lược" > "Cân bằng về chuẩn": chạy đề xuất cân bằng (lib/rebalance-calc.js) cho TỪNG thành viên theo cùng danh mục chuẩn của nhóm, rồi gộp
   (lib/group-rebalance.js, có kiểm thử): ai lệch nhiều nhất, cần mua/bán gì, tổng khối lượng của cả nhóm theo mã so với thanh khoản, tổng chi phí.
   Chỉ để xem và điều phối: mỗi thành viên tự giao dịch trên tài khoản của mình (công cụ "Cân bằng về chuẩn" ở Danh Mục > Phân Bổ Ngành cho ra đúng các lệnh này và gửi duyệt).
   Dùng global của group.js (GR, grCall, grRender), group-strategy.js (BS qua assets/brinson.js), group-limits.js (GL), assets/risk.js (rk*). */

const GRB = { state: 'idle', error: '', out: null, band: 2, includeOff: false, adv: {}, open: new Set() };

async function grbAdv(symbols) {
    const out = {};
    if (!symbols.length) return out;
    try {
        const data = await grCall('getVolumeHistory', { symbols: symbols.slice(0, 40), days: 60 });
        symbols.forEach(s => {
            const last = ((data && data[s]) || []).slice(-20).map(x => Number(x[1])).filter(v => v >= 0);
            if (last.length >= 5) out[s] = last.reduce((a, v) => a + v, 0) / last.length;
        });
    } catch (e) { /* không có thanh khoản: bỏ qua phần cắt theo thanh khoản */ }
    return out;
}

function grbCompute() {
    GRB.out = GroupRebalance.build({
        portfolios: GR.portfolios.filter(p => p.nav > 0), policy: (BS.policy && BS.policy.weights) || {}, sectorOf: FinCalc.sectorOf, RC: RebalanceCalc, bandPts: GRB.band, includeOffPolicy: GRB.includeOff, adv: GRB.adv,
        LC: LimitsCalc, SC: SizingCalc, limitsFor: (id) => (GL.rows ? LimitsCalc.applicable(GL.rows, id, 'member') : []),
    });
}

async function grbRun() {
    GRB.state = 'loading'; GRB.error = ''; grRender();
    try {
        await bsLoadPolicy(true);
        const symbols = [...new Set(GR.portfolios.flatMap(p => p.holdings.map(h => h.symbol)))];
        GRB.adv = await grbAdv(symbols);
        grbCompute();
        GRB.state = 'ok';
    } catch (e) { GRB.state = 'error'; GRB.error = e.message || String(e); }
    grRender();
}
function grbChange() {
    const b = Number(document.getElementById('grb-band').value);
    GRB.band = b >= 0 && b <= 20 ? b : 2; GRB.includeOff = !!document.getElementById('grb-off').checked;
    grbCompute(); grRender();
}
function grbToggle(id) { if (GRB.open.has(id)) GRB.open.delete(id); else GRB.open.add(id); grRender(); }

const GRB_REASON = { noPolicy: 'Nhóm chưa đặt danh mục chuẩn chiến lược. Quản lý đặt ở bảng phía trên rồi bấm Lưu.', badPolicy: 'Danh mục chuẩn không hợp lệ (tổng vượt 100%).', noLib: 'Thiếu thư viện cân bằng.' };
const GRB_MEMBER_REASON = { noNav: 'chưa có NAV', noPolicy: 'chưa có chuẩn', badPolicy: 'chuẩn không hợp lệ' };

function grbTradeRows(plan) {
    return plan.trades.map(t => `<tr><td><span class="txn-type-badge ${t.side}">${t.side === 'sell' ? 'Bán' : 'Mua'}</span> <b>${rkEsc(t.symbol)}</b></td><td class="text-right">${rkNum(t.quantity, 0)}</td><td class="text-right">${rkNum(t.price, 0)}</td><td class="text-right">${rkVnd(t.value)}</td><td class="text-right">${rkVnd(t.fee + t.tax)}</td>
        <td class="gr-reason">${rkEsc((t.notes || []).join('; '))}</td></tr>`).join('');
}

function grbHtml() {
    const head = '<div class="ce-group-title">Cân bằng về chuẩn — cả nhóm</div>';
    if (GRB.state === 'idle') return head + `<p class="tl-hint" style="margin:0 0 10px">Tính xem mỗi thành viên cần mua/bán gì để về danh mục chuẩn ở trên (có phí, thuế, thanh khoản và giới hạn đầu tư của từng người), và tổng khối lượng của cả nhóm có vượt thanh khoản thị trường không.</p>
        <button type="button" class="btn-tool" onclick="grbRun()"><i class="fa-solid fa-scale-balanced"></i> Tính đề xuất cân bằng cả nhóm</button>`;
    if (GRB.state === 'loading') return head + '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang tính… (lấy khối lượng giao dịch từng mã)</div>';
    if (GRB.state === 'error') return head + `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không tính được: ${rkEsc(GRB.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="grbRun()">Thử lại</button></div>`;
    const o = GRB.out;
    const controls = `<div class="tl-opts" style="margin:0 0 10px"><label class="tl-check">Biên độ lệch (điểm %) <input type="number" id="grb-band" class="tl-input num" min="0" max="20" step="0.5" value="${GRB.band}" onchange="grbChange()" style="width:70px"></label>
        <label class="tl-check"><input type="checkbox" id="grb-off" ${GRB.includeOff ? 'checked' : ''} onchange="grbChange()"> Bán dần ngành ngoài chuẩn</label>
        <button type="button" class="btn-tool" onclick="grbRun()"><i class="fa-solid fa-rotate"></i> Tính lại</button></div>`;
    if (!o.ok) return head + controls + `<div class="conc-warn"><i class="fa-solid fa-circle-info"></i><span>${rkEsc(GRB_REASON[o.reason] || 'Không tính được.')}</span></div>`;
    const T = o.totals;
    let html = head + controls + `<div class="tl-kpis">${[
        rkKpi('Thành viên cần giao dịch', `${T.needAction} / ${o.members.filter(m => m.ok).length}`, `${T.count} lệnh`),
        rkKpi('Lệch chuẩn (TB theo NAV)', `${T.driftBefore === null ? '—' : rkNum(T.driftBefore, 1)} → ${T.driftAfter === null ? '—' : rkNum(T.driftAfter, 1)} điểm`, 'trước → sau khi thực hiện'),
        rkKpi('Giá trị giao dịch', rkVnd(T.turnover), 'mua + bán'),
        rkKpi('Phí + thuế', rkVnd(T.cost), T.nav > 0 ? rkPct(T.cost / T.nav * 100, 2) + ' NAV nhóm' : ''),
    ].join('')}</div>`;
    if (o.warnings.length) html += `<div class="rk-warns">${o.warnings.map(w => `<div class="rk-warn med"><i class="fa-solid fa-triangle-exclamation"></i><span>${rkEsc(w)}</span></div>`).join('')}</div>`;
    if (o.gaps.length) html += `<div class="conc-warn"><i class="fa-solid fa-circle-info"></i><span>Ngành thiếu so với chuẩn mà chưa có mã nào trong danh mục: ${o.gaps.map(g => `<b>${rkEsc(g.sector)}</b> (cần khoảng ${rkVnd(g.amount)}, ${g.members.length} người)`).join('; ')}. Cần chọn mã (Tổng Hợp CP / Ý tưởng), không tự chọn mã.</span></div>`;

    html += `<div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Thành viên</th><th class="text-right">NAV</th><th class="text-right">Lệch chuẩn</th><th class="text-right">Số lệnh</th><th class="text-right">Giá trị giao dịch</th><th class="text-right">Phí + thuế</th><th></th></tr></thead><tbody>
        ${o.members.map(m => {
            if (!m.ok) return `<tr><td><b>${rkEsc(m.name)}</b></td><td colspan="6"><span class="tl-badge mute">Bỏ qua: ${rkEsc(GRB_MEMBER_REASON[m.reason] || m.reason)}</span></td></tr>`;
            const s = m.plan.summary, open = GRB.open.has(m.id);
            return `<tr><td><b>${rkEsc(m.name)}</b></td><td class="text-right">${rkVnd(m.plan.nav)}</td><td class="text-right">${rkNum(s.driftBefore, 1)} → ${rkNum(s.driftAfter, 1)}</td><td class="text-right">${s.count || '<span class="tl-badge ok">Đúng chuẩn</span>'}</td>
                <td class="text-right">${s.count ? rkVnd(s.turnover) : '—'}</td><td class="text-right">${s.count ? rkVnd(s.cost) : '—'}</td>
                <td>${s.count ? `<button type="button" class="tl-link" onclick="grbToggle('${m.id}')">${open ? 'Ẩn lệnh' : 'Xem lệnh'}</button>` : ''}</td></tr>
                ${open && s.count ? `<tr><td colspan="7"><table class="excel-table asset-table"><thead><tr><th>Lệnh</th><th class="text-right">Khối lượng</th><th class="text-right">Giá</th><th class="text-right">Giá trị</th><th class="text-right">Phí + thuế</th><th>Ghi chú</th></tr></thead><tbody>${grbTradeRows(m.plan)}</tbody></table>
                    ${m.plan.warnings.length ? `<p class="tl-hint">${m.plan.warnings.map(rkEsc).join(' ')}</p>` : ''}</td></tr>` : ''}`;
        }).join('')}
        </tbody></table></div>`;

    if (o.symbols.length) html += `<div class="ce-group-title">Tổng cả nhóm theo mã <small style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-muted)">(trần: ${o.liqDays} phiên × ${Math.round(o.liqPct * 100)}% khối lượng TB ngày)</small></div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Mã</th><th>Ngành</th><th class="text-right">Mua (cổ)</th><th class="text-right">Bán (cổ)</th><th class="text-right">Khối lượng TB ngày</th><th class="text-right">% KL TB ngày</th><th>Ai mua / bán</th></tr></thead><tbody>
        ${o.symbols.map(s => `<tr><td><b>${rkEsc(s.symbol)}</b>${s.opposing ? ' <span class="tl-badge info" title="Người này mua, người kia bán cùng mã. Không gợi ý khớp chéo: mỗi người giao dịch trên tài khoản của mình.">ngược chiều</span>' : ''}</td><td>${rkEsc(s.sector)}</td>
            <td class="text-right">${s.buyQty ? rkNum(s.buyQty, 0) : '—'}</td><td class="text-right">${s.sellQty ? rkNum(s.sellQty, 0) : '—'}</td><td class="text-right">${s.adv ? rkNum(s.adv, 0) : '<span class="text-muted">chưa có</span>'}</td>
            <td class="text-right ${s.overCap ? 'tl-down' : ''}">${s.adv ? rkNum(Math.max(s.advPctBuy, s.advPctSell), 0) + '%' : '—'}</td><td>${[s.buyers.length ? 'Mua: ' + rkEsc(s.buyers.join(', ')) : '', s.sellers.length ? 'Bán: ' + rkEsc(s.sellers.join(', ')) : ''].filter(Boolean).join(' · ')}</td></tr>`).join('')}
        </tbody></table></div>`;
    html += '<p class="tl-hint">Chỉ là tính toán để xem và điều phối, không phải khuyến nghị và không tự đặt lệnh. Mỗi thành viên giao dịch trên tài khoản của mình (công cụ “Cân bằng về chuẩn” ở Danh Mục &gt; Phân Bổ Ngành tính ra đúng các lệnh này, gửi duyệt khi vượt ngưỡng). Giá lấy theo giá thị trường đang lưu của từng người nên có thể lệch nhẹ so với lúc họ mở công cụ.</p>';
    return html;
}
