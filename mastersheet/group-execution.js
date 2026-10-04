/* --- FILE: /mastersheet/group-execution.js ---
   Trang Toàn Nhóm > "Khớp Lệnh": chất lượng thực hiện lệnh của cả nhóm -- giá khớp so với giá đề xuất đã duyệt và giá đóng cửa cùng ngày, chi phí phí/thuế, và giá 5 phiên sau lệnh.
   Chỉ có giá đóng cửa hằng ngày (không có giá trong ngày) nên là thước đo THÔ: đọc theo xu hướng nhiều lệnh. Phép tính ở /lib/execution-quality.js (có kiểm thử).
   Dùng global của group.js (GR, grCall, grRender), group-limits.js (glDate) và assets/risk.js (rkEsc, rkNum, rkPct, rkVnd, rkKpi). */

const GX = { state: 'idle', error: '', out: null, months: 6, symbolsErr: '', loadedKey: '' };

function gxName(id) { const p = GR.portfolios && GR.portfolios.find(x => x.id === id); return p ? p.name : 'Thành viên'; }
function gxSetMonths(v) { GX.months = Number(v) || 6; GX.loadedKey = ''; gxLoad(true); }

async function gxLoad(force) {
    if (GX.state === 'loading') return;
    const key = (GR.data ? GR.data.fetchedAt : '') + '|' + GX.months;
    if (GX.state === 'ok' && !force && GX.loadedKey === key) { grRender(); return; }
    GX.state = 'loading'; GX.error = ''; GX.symbolsErr = '';
    grRender();
    try {
        const from = new Date(Date.now() - GX.months * 30.5 * 86400000).toISOString().slice(0, 10);
        const txns = ((GR.data && GR.data.txns) || []).filter(t => !t.deleted_at && String(t.trade_date).slice(0, 10) >= from);
        const requests = await grCall('listAllOrderRequests', { days: 540 }).catch(() => []);
        const symbols = [...new Set(txns.map(t => String(t.symbol).toUpperCase()))];
        let series = {};
        if (symbols.length) {
            const r = await grCall('getPriceHistories', { symbols, from: new Date(Date.parse(from + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10) });
            series = (r && r.histories) || {};
            if (r && r.error) GX.symbolsErr = r.error;
        }
        GX.out = ExecQuality.build({ txns, requests, series, from });
        GX.state = 'ok'; GX.loadedKey = key;
    } catch (e) { GX.state = 'error'; GX.error = e.message || String(e); }
    grRender();
}

function gxPct(v, d) { return v === null || v === undefined ? '—' : rkPct(v, d === undefined ? 2 : d, true); }
function gxBad(v, thr) { return v !== null && v !== undefined && v > thr ? 'tl-down' : ''; }

function grExecutionHtml() {
    if (GX.state === 'loading' || GX.state === 'idle') return '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang phân tích chất lượng khớp lệnh…</div>';
    if (GX.state === 'error') return `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không tải được: ${rkEsc(GX.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="gxLoad(true)">Thử lại</button></div>`;
    const o = GX.out, S = o.summary;
    const sel = `<select class="tl-select" onchange="gxSetMonths(this.value)" aria-label="Khoảng thời gian">${[[3, '3 tháng'], [6, '6 tháng'], [12, '12 tháng']].map(([v, l]) => `<option value="${v}" ${GX.months === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    if (!o.rows.length) return `<div class="ce-group-title">Chất lượng khớp lệnh ${sel}</div><div class="tl-empty"><i class="fa-solid fa-bullseye"></i>Chưa có lệnh nào trong ${GX.months} tháng gần đây.</div>`;
    let html = (GX.symbolsErr ? `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không lấy đủ giá lịch sử: ${rkEsc(GX.symbolsErr)}. Một số lệnh thiếu so sánh với giá đóng cửa.</span></div>` : '')
        + `<div class="ce-group-title">Chất lượng khớp lệnh ${sel}</div><div class="tl-kpis">${[
        rkKpi('Số lệnh', String(S.n), rkVnd(S.value) + ' tổng giá trị'),
        rkKpi('Mua so với đóng cửa', gxPct(S.vsCloseBuy.pct), S.vsCloseBuy.n + ' lệnh · dương = mua cao hơn', gxBad(S.vsCloseBuy.pct, 0.5)),
        rkKpi('Bán so với đóng cửa', gxPct(S.vsCloseSell.pct), S.vsCloseSell.n + ' lệnh · dương = bán thấp hơn', gxBad(S.vsCloseSell.pct, 0.5)),
        rkKpi('Chi phí phí + thuế', S.costPct === null ? '—' : rkPct(S.costPct, 2), rkVnd(S.cost) + ' tổng'),
        rkKpi('Giá dịch chuyển đề xuất → khớp', gxPct(S.vsRef.pct), S.vsRef.n + ' lệnh có đề xuất' + (S.delay.days !== null ? ' · trễ ' + rkNum(S.delay.days, 1) + ' ngày' : ''), gxBad(S.vsRef.pct, 1)),
    ].join('')}</div>`;
    html += `<div class="rk-warns">${S.insights.map(i => `<div class="rk-warn ${{ good: 'good', warn: 'med', info: 'low', mute: 'low' }[i.tone] || 'low'}"><i class="fa-solid ${i.tone === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info'}"></i><span>${rkEsc(i.text)}</span></div>`).join('')}</div>`;

    html += `<div class="ce-group-title">Theo thành viên</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Thành viên</th><th class="text-right">Số lệnh</th><th class="text-right">Giá trị</th><th class="text-right">Mua vs đóng cửa</th><th class="text-right">Bán vs đóng cửa</th><th class="text-right">Chi phí</th><th class="text-right">Sau mua ${o.forwardDays} phiên</th><th class="text-right">Sau bán ${o.forwardDays} phiên</th></tr></thead><tbody>
        ${o.members.map(m => `<tr><td><b>${rkEsc(gxName(m.userId))}</b></td><td class="text-right">${m.n}</td><td class="text-right">${rkVnd(m.value)}</td>
            <td class="text-right ${gxBad(m.vsCloseBuy.pct, 0.5)}">${gxPct(m.vsCloseBuy.pct)}<span class="symbol-sub">${m.vsCloseBuy.n} lệnh</span></td>
            <td class="text-right ${gxBad(m.vsCloseSell.pct, 0.5)}">${gxPct(m.vsCloseSell.pct)}<span class="symbol-sub">${m.vsCloseSell.n} lệnh</span></td>
            <td class="text-right">${m.costPct === null ? '—' : rkPct(m.costPct, 2)}</td>
            <td class="text-right ${m.forwardBuy.pct !== null && m.forwardBuy.pct < -1 ? 'tl-down' : ''}">${gxPct(m.forwardBuy.pct, 1)}<span class="symbol-sub">${m.forwardBuy.n} lệnh</span></td>
            <td class="text-right ${m.forwardSell.pct !== null && m.forwardSell.pct < -1 ? 'tl-down' : ''}">${gxPct(m.forwardSell.pct, 1)}<span class="symbol-sub">${m.forwardSell.n} lệnh</span></td></tr>`).join('')}
        </tbody></table></div>`;

    const worst = o.rows.filter(r => r.vsClosePct !== null && r.vsClosePct > 0).sort((a, b) => b.vsClosePct - a.vsClosePct).slice(0, 10);
    if (worst.length) html += `<div class="ce-group-title">Lệnh khớp bất lợi nhất so với giá đóng cửa <small style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-muted)">(chỉ các lệnh khớp xấu hơn)</small></div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Ngày</th><th>Thành viên</th><th>Lệnh</th><th class="text-right">Giá khớp</th><th class="text-right">Bất lợi</th><th class="text-right">Giá trị</th></tr></thead><tbody>
        ${worst.map(r => `<tr><td>${glDate(r.date + 'T00:00:00')}</td><td>${rkEsc(gxName(r.userId))}</td><td><span class="txn-type-badge ${r.side}">${r.side === 'sell' ? 'Bán' : 'Mua'}</span> <b>${rkEsc(r.symbol)}</b>${r.imported ? ' <span class="tl-badge mute">nhập sao kê</span>' : ''}</td>
            <td class="text-right">${rkNum(r.price, 0)}</td><td class="text-right tl-down">${gxPct(r.vsClosePct)}</td><td class="text-right">${rkVnd(r.value)}</td></tr>`).join('')}
        </tbody></table></div>`;
    html += `<p class="tl-hint">Dương = khớp xấu hơn tham chiếu (mua cao hơn, bán thấp hơn). “Sau lệnh ${o.forwardDays} phiên”: dương = giá đi đúng hướng có lợi cho lệnh (mua rồi tăng, bán rồi giảm). Dữ liệu chỉ có giá đóng cửa, không có giá trong ngày nên từng lệnh có thể lệch vì may rủi — chỉ có ý nghĩa khi nhiều lệnh cùng một phía cho cùng xu hướng (các nhận xét chỉ nêu khi có từ ${o.minN} lệnh). Lệnh nhập từ sao kê vẫn được tính; so sánh với giá đề xuất chỉ có cho lệnh đi qua Duyệt Lệnh. Không phải đánh giá năng lực của ai: phụ thuộc thanh khoản và loại lệnh đã đặt.</p>`;
    return html;
}
