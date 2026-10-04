/* --- FILE: /mastersheet/group-activity.js ---
   Trang Toàn Nhóm > "Hoạt Động" (sổ lệnh chung: ai mua/bán gì, mã nào nhiều người cùng mua, trái chiều, mức hoạt động từng người, lệnh có ngoại lệ giới hạn)
   và "Báo Cáo" (báo cáo định kỳ của nhóm: xem, in/PDF, tải Excel). Phép tính ở /lib/group-calc.js (blotter, flow) và /lib/group-report.js (có kiểm thử).
   Dùng global của group.js (GR, grRender, grCall), group-limits.js (GL), assets/risk.js (rkEsc, rkNum, rkPct, rkVnd, rkKpi), lib/save-file.js (saveBytesToDisk) và XlsxWriter. */

const GA = { days: 30, member: '', side: '', symbol: '', period: 'last-month', busy: false };

const gaDmy = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const gaToday = () => new Date().toISOString().slice(0, 10);
const gaIso = (d) => d.toISOString().slice(0, 10);
const gaAddDays = (iso, n) => gaIso(new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000));

const gaPeriod = (key, today) => GroupReport.periodFor(key, today || gaToday());

function gaSet(key, value) { GA[key] = value; grRender(); }

// ---------- Hoạt động ----------
function gaRows() {
    const from = gaAddDays(gaToday(), -GA.days);
    return GroupCalc.blotter({ members: GR.data.members, txns: GR.data.txns }, { from, userId: GA.member || null, symbol: GA.symbol || null, side: GA.side || null, exceptions: (typeof GL !== 'undefined' && GL.exceptions) || [] });
}

const GA_STANCE = {
    consensus_buy: ['ok', 'Nhiều người cùng mua'], consensus_sell: ['warn', 'Nhiều người cùng bán'], conflict: ['bad', 'Mua bán trái chiều'],
    buy: ['mute', 'Mua'], sell: ['mute', 'Bán'], mixed: ['mute', 'Hỗn hợp'],
};

function gaActivityHtml() {
    const rows = gaRows();
    const f = GroupCalc.flow(rows, GR.portfolios);
    const opts = (list, sel) => list.map(([v, t]) => `<option value="${rkEsc(v)}" ${String(sel) === String(v) ? 'selected' : ''}>${rkEsc(t)}</option>`).join('');
    let html = `<div class="ga-filters">
        <label>Khoảng thời gian<select class="tl-select" onchange="gaSet('days', Number(this.value))">${opts([[7, '7 ngày'], [30, '30 ngày'], [90, '3 tháng'], [180, '6 tháng'], [365, '12 tháng']], GA.days)}</select></label>
        <label>Thành viên<select class="tl-select" onchange="gaSet('member', this.value)">${opts([['', 'Tất cả']].concat(GR.portfolios.map(p => [p.id, p.name])), GA.member)}</select></label>
        <label>Loại<select class="tl-select" onchange="gaSet('side', this.value)">${opts([['', 'Mua và bán'], ['buy', 'Chỉ mua'], ['sell', 'Chỉ bán']], GA.side)}</select></label>
        <label>Mã<input type="text" class="tl-input" maxlength="12" value="${rkEsc(GA.symbol)}" placeholder="VD: FPT" style="width:100px;text-transform:uppercase" onchange="gaSet('symbol', this.value.trim().toUpperCase())"></label>
    </div>`;
    if (!rows.length) return html + '<div class="tl-empty"><i class="fa-solid fa-receipt"></i>Không có lệnh nào trong khoảng này.</div>';
    const exCount = rows.filter(r => r.exception).length;
    html += `<div class="tl-kpis">${[
        rkKpi('Số lệnh', String(f.totals.trades), `${f.members.filter(m => m.trades).length} thành viên có giao dịch`),
        rkKpi('Tổng mua', rkVnd(f.totals.buyValue)), rkKpi('Tổng bán', rkVnd(f.totals.sellValue)),
        rkKpi('Mua ròng', rkVnd(f.totals.net), f.totals.net >= 0 ? 'nhóm đang tăng vị thế' : 'nhóm đang giảm vị thế', f.totals.net >= 0 ? 'tl-up' : 'tl-down'),
        rkKpi('Lệnh có ngoại lệ giới hạn', String(exCount), exCount ? 'xem cột Ngoại lệ' : 'không có', exCount ? 'tl-down' : ''),
    ].join('')}</div>`;

    const chips = (list, tone) => list.length ? list.slice(0, 8).map(s => `<span class="gr-chip" title="${rkEsc(s.buyers.concat(s.sellers).join(', '))}">${rkEsc(s.symbol)} <b>${rkEsc(s.stance === 'conflict' ? s.buyers.length + '↑ ' + s.sellers.length + '↓' : (s.stance === 'consensus_sell' ? s.sellers.length : s.buyers.length) + ' người')}</b></span>`).join('') : '<span class="tl-hint" style="margin:0">Không có</span>';
    html += `<div class="ga-signals">
        <div><span class="tl-badge ok">Nhiều người cùng mua</span><div class="gr-holders">${chips(f.consensusBuy)}</div></div>
        <div><span class="tl-badge warn">Nhiều người cùng bán</span><div class="gr-holders">${chips(f.consensusSell)}</div></div>
        <div><span class="tl-badge bad">Mua bán trái chiều</span><div class="gr-holders">${chips(f.conflicts)}</div></div>
    </div><p class="tl-hint">“Cùng mua/bán” = từ 2 thành viên trở lên cùng một chiều trong kỳ — dấu hiệu rủi ro bị nhân lên hoặc một quan điểm chung. “Trái chiều” = người này mua trong khi người khác bán cùng một mã.</p>`;

    html += `<div class="ce-group-title">Mức hoạt động từng thành viên</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Thành viên</th><th class="text-right">Số lệnh</th><th class="text-right">Số mã</th><th class="text-right">Mua</th><th class="text-right">Bán</th><th class="text-right">Ròng</th><th class="text-right" title="(mua + bán) / 2 / NAV hiện tại">Vòng quay</th><th class="text-right">Ngoại lệ</th></tr></thead><tbody>
        ${f.members.filter(m => m.trades).map(m => `<tr><td><b>${rkEsc(m.name)}</b></td><td class="text-right">${m.trades}</td><td class="text-right">${m.symbolCount}</td><td class="text-right">${rkVnd(m.buyValue)}</td><td class="text-right">${rkVnd(m.sellValue)}</td>
            <td class="text-right ${m.net >= 0 ? 'tl-up' : 'tl-down'}">${rkVnd(m.net)}</td><td class="text-right">${m.turnoverPct === null ? '—' : rkPct(m.turnoverPct, 0)}</td><td class="text-right">${m.exceptions ? `<span class="tl-badge warn">${m.exceptions}</span>` : '—'}</td></tr>`).join('')}
        </tbody></table></div>`;

    html += `<div class="ce-group-title">Theo mã</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Mã</th><th class="text-right">Mua</th><th class="text-right">Bán</th><th class="text-right">Ròng</th><th>Người mua</th><th>Người bán</th><th>Nhận định</th></tr></thead><tbody>
        ${f.symbols.slice(0, 30).map(s => { const st = GA_STANCE[s.stance] || GA_STANCE.mixed; return `<tr><td><span class="symbol-name">${rkEsc(s.symbol)}<span class="symbol-sub">${rkEsc(s.sector)}</span></span></td><td class="text-right">${rkVnd(s.buyValue)}</td><td class="text-right">${rkVnd(s.sellValue)}</td>
            <td class="text-right ${s.net >= 0 ? 'tl-up' : 'tl-down'}">${rkVnd(s.net)}</td><td class="gr-holders">${rkEsc(s.buyers.join(', '))}</td><td class="gr-holders">${rkEsc(s.sellers.join(', '))}</td><td><span class="tl-badge ${st[0]}">${st[1]}</span></td></tr>`; }).join('')}
        </tbody></table></div>`;

    const shown = rows.slice(0, 300);
    html += `<div class="ce-group-title">Sổ lệnh chung (${shown.length}${rows.length > shown.length ? ' / ' + rows.length : ''} lệnh mới nhất)</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Ngày</th><th>Thành viên</th><th>Loại</th><th>Mã</th><th class="text-right">Khối lượng</th><th class="text-right">Giá</th><th class="text-right">Giá trị</th><th>Ngoại lệ giới hạn</th></tr></thead><tbody>
        ${shown.map(r => `<tr><td>${gaDmy(r.date)}</td><td>${rkEsc(r.name)}</td><td><span class="tl-badge ${r.type === 'buy' ? 'ok' : 'warn'}">${r.type === 'buy' ? 'Mua' : 'Bán'}</span></td><td><b>${rkEsc(r.symbol)}</b>${r.imported ? ' <small class="tl-hint" style="margin:0">(sao kê)</small>' : ''}</td>
            <td class="text-right">${rkNum(r.quantity, 0)}</td><td class="text-right">${rkNum(r.price, 0)}</td><td class="text-right">${rkVnd(r.value)}</td>
            <td class="gr-reason">${r.exception ? `<span class="tl-badge ${r.exception.override ? 'bad' : 'warn'}">${r.exception.override ? 'Ghi đè' : 'Có lý do'}</span> ${rkEsc(r.exception.reason)}` : ''}</td></tr>`).join('')}
        </tbody></table></div>`;
    return html;
}

// ---------- Báo cáo ----------
// Các mục cho hội đồng đầu tư (lib/committee-pack.js): quản trị/duyệt lệnh, kịch bản căng thẳng, hành trình ý tưởng, chất lượng khớp lệnh. Mục nào chưa tải được thì bỏ qua (không làm hỏng báo cáo).
function gaCommittee(p) {
    const c = {}, safe = (f) => { try { return f(); } catch (e) { return null; } };
    if (typeof GQ !== 'undefined' && GQ.state === 'ok') c.governance = safe(() => CommitteePack.governance({ AC: ApprovalCalc, requests: GQ.rows || [], audit: GQ.audit || [], restricted: (typeof GL !== 'undefined' && GL.restricted) || [], policy: GQ.policy, from: p.start, to: p.to, today: gaToday(), nameOf: (id) => glMemberName(id) }));
    c.stress = safe(() => CommitteePack.stress({ risk: GR.risk, RiskCalc, StressCalc, LC: LimitsCalc, limits: typeof rkxLimitsFor === 'function' ? rkxLimitsFor('grp') : [], maintenancePct: typeof rkxState === 'function' ? rkxState('grp').maintenance : undefined }));
    if (typeof GJ !== 'undefined' && GJ.state === 'ok' && GJ.out) c.journey = safe(() => CommitteePack.journey(GJ.out.summary));
    if (typeof GX !== 'undefined' && GX.state === 'ok' && GX.out) c.execution = safe(() => CommitteePack.execution(GX.out.summary, GX.months));
    return c;
}

// Dựng báo cáo cho kỳ đang chọn. Hiệu quả tính lại trên đúng kỳ này (không dùng khoảng của tab Thành Viên).
function gaBuildReport() {
    const p = gaPeriod(GA.period);
    const navAll = GroupCalc.groupNavHistory(GR.data.navHistory);
    const range = { from: p.from, to: p.to };
    const groupPerf = PerfCalc.analyze({ navHistory: navAll, bench: GR.bench, rf: GR.rf, rfSeries: grRfSeries(), dividends: grDividends(null), range });
    const perfBy = {};
    GR.portfolios.forEach(pf => { perfBy[pf.id] = PerfCalc.analyze({ navHistory: GR.data.navHistory.filter(r => r.user_id === pf.id), bench: GR.bench, rf: GR.rf, rfSeries: grRfSeries(), dividends: grDividends(pf.id), range }); });
    const trades = GroupCalc.blotter({ members: GR.data.members, txns: GR.data.txns }, { from: p.start, to: p.to, exceptions: GL.exceptions });
    const exceptions = (GL.exceptions || []).filter(e => { const d = String(e.created_at || '').slice(0, 10); return d >= p.start && d <= p.to; });
    const comp = LimitsCalc.complianceMatrix(GL.rows || [], GR.portfolios, GR.group);
    return GroupReport.build({
        committee: gaCommittee(p),
        asOf: gaToday(), period: { from: p.start, to: p.to, label: p.label }, benchLabel: 'VN-Index',
        group: GR.group, portfolios: GR.portfolios, groupPerf, memberRows: GroupCalc.memberTable(GR.portfolios, perfBy, GR.group),
        risk: GR.risk, compliance: comp, exceptions, flow: GroupCalc.flow(trades, GR.portfolios), trades,
    });
}

function gaReportHtml() {
    const periods = [['last-month', 'Tháng trước'], ['this-month', 'Tháng này (đến nay)'], ['last-quarter', 'Quý trước'], ['this-quarter', 'Quý này (đến nay)'], ['ytd', 'Từ đầu năm'], ['12m', '12 tháng gần nhất']];
    let body;
    try { body = GroupReport.toHtml(gaBuildReport()); }
    catch (e) { body = `<div class="tl-empty text-danger">Không dựng được báo cáo: ${rkEsc(e.message || String(e))}</div>`; }
    const loading = (typeof GQ !== 'undefined' && GQ.state === 'loading') || (typeof GJ !== 'undefined' && GJ.state === 'loading') || (typeof GX !== 'undefined' && GX.state === 'loading');
    return `${loading ? '<p class="tl-hint no-print"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải thêm số liệu cho hội đồng đầu tư (duyệt lệnh, hành trình ý tưởng, khớp lệnh)…</p>' : ''}<div class="ga-filters no-print">
        <label>Kỳ báo cáo<select class="tl-select" onchange="gaSet('period', this.value)">${periods.map(([v, t]) => `<option value="${v}" ${GA.period === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <button type="button" class="btn-save" onclick="gaDownloadXlsx()"><i class="fa-solid fa-file-excel"></i> Tải Excel (.xlsx)</button>
        <button type="button" class="btn-tool" onclick="window.print()"><i class="fa-solid fa-print"></i> In / lưu PDF</button>
    </div>${body}`;
}

async function gaDownloadXlsx() {
    try {
        const r = gaBuildReport();
        const bytes = XlsxWriter.build(GroupReport.toSheets(r));
        const name = `bao-cao-nhom-${r.meta.from}-den-${r.meta.to}.xlsx`;
        const p = await saveBytesToDisk(name, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        if (p) showToast('Đã lưu ' + escapeAssetHtml(name), 'success');
    } catch (e) { showToast('Lỗi: ' + escapeAssetHtml(e.message || String(e)), 'error'); }
}
