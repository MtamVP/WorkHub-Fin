/* --- FILE: /mastersheet/group-limits.js ---
   Trang Toàn Nhóm > "Giới Hạn": quản lý đặt giới hạn đầu tư chung (mỗi thành viên / cả nhóm gộp), xem ai đang vượt giới hạn nào, và các ngoại lệ có lý do
   mà thành viên đã ghi khi vượt giới hạn. Phép tính ở /lib/limits-calc.js (có kiểm thử); việc chặn/ghi lý do thực hiện ở api.js khi ghi lệnh.
   Dùng global của group.js (GR, grCall, grRender) và assets/risk.js (rkEsc, rkNum, rkPct, rkVnd, rkKpi, rkBar). */

const GL = { rows: [], exceptions: [], actor: null, loaded: false, error: '' };

const glModeCls = { warn: 'info', reason: 'warn', block: 'bad' };

// Gọi sau khi dữ liệu nhóm đã tải: đọc giới hạn + ngoại lệ (lỗi không làm hỏng các tab khác)
async function glLoad() {
    GL.loaded = false; GL.error = '';
    try {
        const [rows, ex, actor] = await Promise.all([
            grCall('listLimits'), grCall('listLimitExceptions', { days: 365 }).catch(() => []), grCall('getLimitActor', { email: (GR.data && GR.data.members[0] && GR.data.members[0].email) || '' }).catch(() => ({ isManager: false })),
        ]);
        GL.rows = rows; GL.exceptions = ex; GL.actor = actor; GL.loaded = true;
    } catch (e) { GL.error = e.message || String(e); }
}

// Ngưỡng tập trung của nhóm dùng cho cảnh báo ở tab Danh Mục Chung: lấy từ giới hạn chung nếu có
function grGroupLimits() {
    const out = { singleLimit: 25, sectorLimit: 40 };
    const g = (kind) => GL.rows.filter(r => r.active && r.kind === kind && r.scope === 'member' && !r.symbol && !r.sector).map(r => Number(r.value)).filter(v => v > 0);
    const s = g('max_symbol_pct'), c = g('max_sector_pct');
    if (s.length) out.singleLimit = Math.min.apply(null, s);
    if (c.length) out.sectorLimit = Math.min.apply(null, c);
    return out;
}

function glMemberName(id) { const p = GR.portfolios.find(x => x.id === id); return p ? p.name : 'Thành viên'; }
function glDate(iso) { const d = new Date(iso); return isNaN(d) ? '' : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; }

function glValueText(r) {
    if (r.kind === 'blocked_symbol') return '—';
    const K = LimitsCalc.KINDS[r.kind];
    return `${rkNum(r.value, 2)} ${rkEsc(K.unit)}`;
}

function grLimitsHtml() {
    if (GL.error) return `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không tải được giới hạn: ${rkEsc(GL.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="glReload()">Thử lại</button></div>`;
    if (!GL.loaded) return '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang tải giới hạn…</div>';
    const manager = !!(GL.actor && GL.actor.isManager);
    const groupRows = GL.rows.filter(r => r.scope !== 'user');
    const active = groupRows.filter(r => r.active);
    const m = LimitsCalc.complianceMatrix(GL.rows, GR.portfolios, GR.group);
    const recent = GL.exceptions.filter(e => Date.now() - Date.parse(e.created_at) <= 30 * 86400000);
    let html = `<div class="tl-kpis">${[
        rkKpi('Giới hạn đang bật', String(active.length), `${groupRows.length - active.length} đã tắt`),
        rkKpi('Đang vượt giới hạn', String(m.totalBreaches), m.totalBreaches ? 'cần xem lại' : 'tất cả trong mức', m.totalBreaches ? 'tl-down' : 'tl-up'),
        rkKpi('Ngoại lệ 30 ngày', String(recent.length), `${recent.filter(e => e.override).length} lần quản lý ghi đè`, recent.length ? 'tl-down' : ''),
    ].join('')}</div>`;

    // Ma trận tuân thủ
    const all = m.rows.concat(m.consolidated ? [m.consolidated] : []);
    html += `<div class="ce-group-title">Tuân thủ hiện tại</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Thành viên</th><th class="text-right">NAV</th><th class="text-right">Giới hạn áp dụng</th><th>Tình trạng</th></tr></thead><tbody>
        ${all.map(r => `<tr><td><b>${rkEsc(r.name)}</b></td><td class="text-right">${rkVnd(r.nav)}</td><td class="text-right">${r.limits}</td>
            <td class="gr-holders">${!r.limits ? '<span class="tl-badge mute">Chưa có giới hạn</span>' : (r.breaches.length || r.warns.length
                ? r.breaches.map(b => `<span class="tl-badge bad" title="${rkEsc(LimitsCalc.describe(b, false))}">${rkEsc(b.subject)} ${b.kind === 'blocked_symbol' ? 'bị cấm' : (b.kind === 'max_position_vnd' ? rkVnd(b.current) : rkNum(b.current, 1) + (b.kind === 'max_leverage' ? '×' : '%'))}${b.kind === 'blocked_symbol' ? '' : ' / ' + rkNum(b.threshold, b.kind === 'max_position_vnd' ? 0 : 1)}</span>`).join(' ') + ' ' + r.warns.map(b => `<span class="tl-badge warn" title="Gần chạm hạn mức">${rkEsc(b.subject)} ${rkNum(b.usage * 100, 0)}%</span>`).join(' ')
                : '<span class="tl-badge ok"><i class="fa-solid fa-check"></i> Trong mức</span>')}</td></tr>`).join('')}
        </tbody></table></div>`;

    // Giới hạn chung
    html += `<div class="ce-group-title">Giới hạn chung của nhóm ${manager ? '' : '<small style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-muted)">(chỉ quản lý danh mục / admin được sửa)</small>'}</div>`;
    html += groupRows.length ? `<div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Giới hạn</th><th>Đối tượng</th><th class="text-right">Ngưỡng</th><th>Chế độ</th><th>Áp dụng cho</th><th>Bật</th>${manager ? '<th></th>' : ''}</tr></thead><tbody>
        ${groupRows.map(r => `<tr><td>${rkEsc(LimitsCalc.KINDS[r.kind].label)}</td><td>${rkEsc(r.symbol || r.sector || 'Tất cả')}</td><td class="text-right">${glValueText(r)}</td>
            <td><span class="tl-badge ${glModeCls[r.mode]}">${rkEsc(LimitsCalc.MODES[r.mode].label)}</span></td><td>${r.scope === 'consolidated' ? 'Cả nhóm (gộp)' : 'Mỗi thành viên'}</td>
            <td><input type="checkbox" ${r.active ? 'checked' : ''} ${manager ? `onchange="glToggle('${r.id}', this.checked)"` : 'disabled'} aria-label="Bật giới hạn"></td>
            ${manager ? `<td><button type="button" class="tl-link tl-danger" onclick="glRemove('${r.id}')" aria-label="Xoá"><i class="fa-solid fa-trash"></i></button></td>` : ''}</tr>`).join('')}
        </tbody></table></div>` : '<div class="tl-empty" style="padding:14px"><i class="fa-solid fa-gauge-high"></i>Chưa có giới hạn chung nào.</div>';
    if (manager) {
        html += `<form class="lm-form" onsubmit="glAdd(event)">
            <label>Loại<select id="gl-kind" class="tl-select" onchange="glKindChanged()">${Object.keys(LimitsCalc.KINDS).map(k => `<option value="${k}">${rkEsc(LimitsCalc.KINDS[k].label)}</option>`).join('')}</select></label>
            <label id="gl-subject-wrap">Mã / ngành (tuỳ chọn)<input type="text" id="gl-subject" class="tl-input" maxlength="40"></label>
            <label id="gl-value-wrap"><span id="gl-value-label">Ngưỡng (% NAV)</span><input type="number" id="gl-value" class="tl-input num" step="any" min="0"></label>
            <label>Chế độ<select id="gl-mode" class="tl-select"><option value="reason">Phải ghi lý do</option><option value="warn">Chỉ cảnh báo</option><option value="block">Chặn</option></select></label>
            <label>Áp dụng cho<select id="gl-scope" class="tl-select"><option value="member">Mỗi thành viên</option><option value="consolidated">Cả nhóm (gộp, chỉ theo dõi)</option></select></label>
            <button type="submit" class="btn-tool"><i class="fa-solid fa-plus"></i> Thêm giới hạn</button>
        </form>
        <p class="tl-hint">Mọi tỷ lệ tính trên NAV (gồm tiền mặt). Giới hạn riêng cho một mã/ngành thay thế giới hạn chung của nhóm cho mã/ngành đó; thành viên có thể tự siết chặt thêm bằng giới hạn cá nhân. “Chặn” = thành viên không ghi được lệnh, chỉ quản lý ghi đè kèm lý do.</p>`;
    }

    // Ngoại lệ
    html += `<div class="ce-group-title">Ngoại lệ đã ghi nhận <small style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-muted)">(12 tháng gần nhất)</small></div>`;
    html += GL.exceptions.length ? `<div class="spreadsheet-wrapper"><table class="excel-table asset-table gr-table"><thead><tr><th>Ngày</th><th>Thành viên</th><th>Mã</th><th>Giới hạn</th><th>Trước → sau lệnh</th><th>Lý do</th><th></th></tr></thead><tbody>
        ${GL.exceptions.slice(0, 100).map(e => { const mt = e.metrics || {}; return `<tr><td>${glDate(e.trade_date || e.created_at)}</td><td>${rkEsc(glMemberName(e.user_id))}</td><td>${rkEsc(e.symbol || '—')}</td>
            <td>${rkEsc(LimitsCalc.KINDS[e.kind] ? LimitsCalc.KINDS[e.kind].label : e.kind)}${mt.threshold ? ` <small>(mức ${rkNum(mt.threshold, 1)})</small>` : ''}</td>
            <td>${mt.before !== undefined ? `${rkNum(mt.before, 1)} → <b class="tl-down">${rkNum(mt.after, 1)}</b>` : '—'}</td>
            <td class="gr-reason">${rkEsc(e.reason)}</td><td>${e.override ? '<span class="tl-badge bad">Ghi đè chặn</span>' : `<span class="tl-badge ${glModeCls[e.mode] || 'mute'}">${rkEsc((LimitsCalc.MODES[e.mode] || {}).label || '')}</span>`}</td></tr>`; }).join('')}
        </tbody></table></div>` : '<div class="tl-empty" style="padding:14px"><i class="fa-solid fa-circle-check" style="color:var(--success-color);opacity:1"></i>Chưa có ngoại lệ nào.</div>';
    html += '<p class="tl-hint">Giới hạn được kiểm khi thành viên ghi lệnh trên máy họ và kiểm lại ở máy chủ nên không lách được bằng giao diện. Lệnh nhập hàng loạt từ sao kê không đi qua bước kiểm này — quản lý nên đối chiếu bảng “Tuân thủ hiện tại”.</p>';
    return html;
}

function grLimitsAfterRender() { glKindChanged(); }

function glKindChanged() {
    const k = document.getElementById('gl-kind'); if (!k) return;
    const kind = k.value, K = LimitsCalc.KINDS[kind];
    document.getElementById('gl-subject-wrap').style.display = K.subject === 'portfolio' ? 'none' : '';
    document.getElementById('gl-subject').placeholder = K.subject === 'sector' ? 'VD: Ngân hàng (bỏ trống = mọi ngành)' : (kind === 'blocked_symbol' ? 'Mã cần cấm' : 'VD: FPT (bỏ trống = mọi mã)');
    document.getElementById('gl-value-wrap').style.display = kind === 'blocked_symbol' ? 'none' : '';
    document.getElementById('gl-value-label').textContent = `Ngưỡng (${K.unit})`;
}

async function glReload() {
    await glLoad();
    grCompute();
    grRender();
}

async function glAdd(e) {
    e.preventDefault();
    const kind = document.getElementById('gl-kind').value, K = LimitsCalc.KINDS[kind];
    const subject = document.getElementById('gl-subject').value.trim();
    const limit = { scope: document.getElementById('gl-scope').value, kind, value: document.getElementById('gl-value').value, mode: document.getElementById('gl-mode').value };
    if (K.subject === 'symbol') limit.symbol = subject.toUpperCase(); else if (K.subject === 'sector') limit.sector = subject;
    try {
        const msg = await grCall('saveLimit', { limit, email: (GL.actor && GL.actor.actorEmail) || '' });
        showToast(msg, 'success');
        await glReload();
    } catch (err) { showToast('Lỗi: ' + err.message, 'error'); }
}
async function glToggle(id, on) {
    try { await grCall('setLimitActive', { id, active: on }); await glReload(); } catch (err) { showToast('Lỗi: ' + err.message, 'error'); }
}
async function glRemove(id) {
    if (!confirm('Xoá giới hạn này? Các ngoại lệ đã ghi vẫn được giữ.')) return;
    try { await grCall('removeLimit', { id }); await glReload(); } catch (err) { showToast('Lỗi: ' + err.message, 'error'); }
}
