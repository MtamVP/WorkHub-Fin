/* --- FILE: /insight/insight-views-a.js ---
   Màn hình Thanh khoản và sức chứa, Dòng tiền, Luân chuyển ngành: chỉ dựng chuỗi HTML từ kết quả đã tính (lib/liquidity-calc.js, cashflow-calc.js, sector-rotation.js).
   Sự kiện do insight-app.js xử lý (các hàm insXxx gọi từ thuộc tính onclick / onchange). */
const InsViewsA = (function () {
  const U = (typeof require === 'function' && typeof module !== 'undefined') ? require('./insight-util.js') : InsUtil, e = U.esc;

  const daysFmt = (d) => (d < 0.1 ? '&lt;0,1' : U.dec(d, 1));

  // ---------- Thanh khoản và sức chứa ----------
  function liquidityHtml(S) {
    if (S.state === 'loading') return U.loading(S.step || 'Đang lấy khối lượng giao dịch và giá…');
    if (S.state === 'error') return U.card('droplet', 'Thanh khoản và sức chứa', U.empty('triangle-exclamation', e(S.error)) + '<div style="text-align:center"><button class="ins-btn sm" onclick="insLoad(\'liquidity\',true)"><i class="fa-solid fa-rotate"></i> Thử lại</button></div>');
    const r = S.res;
    const controls = '<div class="ins-bar">' +
      '<div class="ins-seg" role="group" aria-label="Đối tượng"><button aria-pressed="' + (S.subject === 'mine') + '" onclick="insLiq(\'subject\',\'mine\')">Danh mục của tôi</button><button aria-pressed="' + (S.subject === 'group') + '" onclick="insLiq(\'subject\',\'group\')">Cả nhóm (gộp)</button></div>' +
      '<label class="ins-field">Tỷ lệ tối đa của khối lượng ngày<select onchange="insLiq(\'rate\',this.value)">' + [0.1, 0.2, 0.3].map((v) => '<option value="' + v + '"' + (S.rate === v ? ' selected' : '') + '>' + Math.round(v * 100) + '%</option>').join('') + '</select></label>' +
      '<label class="ins-field">Phải thoát trong<select onchange="insLiq(\'exitDays\',this.value)">' + [3, 5, 10].map((v) => '<option value="' + v + '"' + (S.exitDays === v ? ' selected' : '') + '>' + v + ' phiên</option>').join('') + '</select></label>' +
      '<button class="ins-btn ghost sm" onclick="insLoad(\'liquidity\',true)"><i class="fa-solid fa-rotate"></i> Tải lại</button></div>';
    if (!r || !r.rows.length) {
      return controls + U.card('droplet', 'Thanh khoản và sức chứa', U.empty('droplet', S.holdingsN ? 'Chưa lấy được khối lượng giao dịch của ' + S.holdingsN + ' vị thế (' + e((r && r.missing || []).join(', ')) + '). Thử tải lại sau ít phút.' : 'Danh mục đang trống: chưa có gì để đo thanh khoản. Thêm lệnh ở trang Danh Mục, hoặc chọn "Cả nhóm".'));
    }
    const t = r.totals, sc = r.scale, o = r.params;
    const k = U.kpis([
      U.kpi('Số ngày thoát TB (theo giá trị)', U.dec(t.weightedDays, 1) + ' phiên', 'với ' + Math.round(o.rate * 100) + '% khối lượng ngày', t.weightedDays > o.exitDays ? 'warn' : 'good'),
      U.kpi('Vị thế khó nhất', e(r.rows[0].symbol), U.dec(r.rows[0].days, 1) + ' phiên · ' + U.dec(r.rows[0].pctOfAdv, 0) + '% khối lượng ngày', r.rows[0].days > o.maxDays ? 'bad' : (r.rows[0].days > o.exitDays ? 'warn' : 'good')),
      U.kpi('Giá trị thoát chậm hơn ' + o.exitDays + ' phiên', U.dec(t.slowPct, 0) + '%', 'của phần có dữ liệu', t.slowPct > 20 ? 'warn' : ''),
      U.kpi('Chi phí tác động giá ước tính', U.dec(t.exitCostPct, 2) + '%', U.money(t.exitCost) + ' nếu thoát hết', ''),
      U.kpi('Hệ số quy mô', sc ? U.dec(sc.k, 2) + 'x' : '—', sc ? (sc.canGrow ? 'nhân danh mục lên tối đa ~' + U.dec(sc.k, 1) + ' lần; mã chặn trước: ' + e(sc.symbol) : 'ĐÃ vượt: ' + e(sc.symbol) + ' đã vượt ngưỡng ' + o.exitDays + ' phiên') : '', sc && !sc.canGrow ? 'bad' : (sc && sc.k < 2 ? 'warn' : 'good')),
    ]);
    const rows = r.rows.map((x) => '<tr' + (x.over ? '' : '') + '><td><b>' + e(x.symbol) + '</b> ' + (x.level === 'high' ? U.tag('Rất khó thoát', 'bad') : (x.level === 'med' ? U.tag('Thoát chậm', 'warn') : '')) + '</td>' +
      '<td>' + U.int(x.quantity) + '</td><td>' + U.money(x.value) + '</td><td>' + U.money(x.advValue, 1) + '</td><td>' + U.dec(x.pctOfAdv, x.pctOfAdv < 1 ? 2 : 0) + '%</td>' +
      '<td class="' + (x.level === 'high' ? 'ins-down' : (x.level === 'med' ? 'ins-warn' : '')) + '">' + daysFmt(x.days) + '</td><td>' + (x.exitCostPct === null ? '—' : U.dec(x.exitCostPct, 2) + '%') + (x.sigmaKnown ? '' : '*') + '</td>' +
      '<td>' + (x.headroomQty > 0 ? U.int(x.headroomQty) : '<span class="ins-muted">0</span>') + '</td></tr>').join('');
    const table = U.table(['Mã', 'Số cổ phiếu', 'Giá trị', 'GTGD/ngày', '% khối lượng ngày', 'Ngày thoát', 'Tác động giá', 'Mua thêm được (cp)'], [rows]);
    let pipe = '';
    if (S.pipe && S.pipe.length) {
      const pr = S.pipe.filter((x) => !x.unknown).map((x) => '<tr><td><b>' + e(x.symbol) + '</b> ' + (x.ok ? U.tag('Xây được', 'ok') : U.tag('Quá lớn', 'bad')) + '</td><td>' + U.money(x.value) + '</td><td>' + daysFmt(x.buildDays) + ' phiên</td><td>' + U.money(x.maxValue) + '</td><td>' + (x.shortfall > 0 ? '<span class="ins-down">' + U.money(x.shortfall) + '</span>' : '—') + '</td><td>' + (x.costPct === null ? '—' : U.dec(x.costPct, 2) + '%') + '</td></tr>');
      const unk = S.pipe.filter((x) => x.unknown).map((x) => e(x.symbol));
      pipe = U.card('bullseye', 'Ứng viên: quy mô dự định có xây được không?', '<p class="tl-hint">Quy mô dự định mỗi mã = ' + U.money(S.pipeValue) + ' (' + (S.pipeValue === S.pipeDefault ? '5% giá trị danh mục' : 'bạn nhập') + '). Xây trong ' + o.exitDays + ' phiên với ' + Math.round(o.rate * 100) + '% khối lượng ngày.</p>' +
        '<div class="ins-bar"><label class="ins-field">Quy mô dự định mỗi mã (đồng)<input type="text" inputmode="numeric" id="ins-pipe-val" value="' + e(S.pipeValue ? String(Math.round(S.pipeValue)) : '') + '" onchange="insLiq(\'pipeValue\',this.value)"></label></div>' +
        (pr.length ? U.table(['Mã', 'Dự định', 'Cần để xây', 'Tối đa trong ' + o.exitDays + ' phiên', 'Còn thiếu', 'Tác động giá'], [pr.join('')]) : '') + (unk.length ? '<p class="tl-hint">Chưa đủ dữ liệu cho: ' + unk.join(', ') + '.</p>' : ''));
    }
    const miss = r.missing.length ? U.note('Chưa có khối lượng giao dịch cho: <b>' + e(r.missing.join(', ')) + '</b> (' + U.dec(100 - (t.coveragePct || 0), 0) + '% giá trị danh mục chưa được đo).', 'warn') : '';
    const caveat = U.note('<b>Giới hạn:</b> khối lượng giao dịch quá khứ không bảo đảm thanh khoản lúc cần bán — khi thị trường hoảng loạn, thanh khoản thường biến mất đúng lúc cần; mã chạm sàn có thể không bán được trong nhiều phiên liên tiếp. Tác động giá theo mô hình căn bậc hai (cùng công thức với Market Simulation), không phải sổ lệnh thật. Mọi con số là cận trên lạc quan về khả năng thoát. ' + (r.rows.some((x) => !x.sigmaKnown) ? '(*) chưa đủ giá để đo biến động: dùng mặc định 2%/ngày.' : ''));
    return controls + k + U.card('droplet', 'Từng vị thế', table + miss + caveat) + pipe;
  }

  // ---------- Dòng tiền ----------
  const KIND_TONE = { dividend: 'ok', sell_settle: 'ok', plan_sell: 'ok', deposit: 'ok', other_in: 'ok', plan_buy: 'warn', withdraw: 'warn', interest: 'warn', other_out: 'warn' };
  function balanceChart(days, buffer) {
    const W = 760, H = 220, pl = 8, pr = 74, pt = 14, pb = 26, w = W - pl - pr, h = H - pt - pb;
    const vals = days.map((d) => d.balance).concat([0, buffer || 0]);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const X = (i) => pl + (days.length > 1 ? i / (days.length - 1) * w : 0), Y = (v) => pt + (hi - v) / (hi - lo) * h;
    let g = '';
    U.niceTicks(lo, hi, 4).forEach((v) => { g += '<line class="grid" x1="' + pl + '" x2="' + (pl + w) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '"/><text x="' + (pl + w + 6) + '" y="' + (Y(v) + 4).toFixed(1) + '">' + e(U.money(v, 1)) + '</text>'; });
    // dải thiếu tiền (âm) tô nhạt
    let path = '', area = '';
    days.forEach((d, i) => { path += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(d.balance).toFixed(1) + ' '; });
    area = path + 'L' + X(days.length - 1).toFixed(1) + ' ' + Y(Math.max(lo, Math.min(hi, 0))).toFixed(1) + ' L' + X(0).toFixed(1) + ' ' + Y(Math.max(lo, Math.min(hi, 0))).toFixed(1) + ' Z';
    let ticks = '';
    days.forEach((d, i) => { if (i % 14 === 0 ? (i === 0 || days.length - 1 - i >= 7) : i === days.length - 1) ticks += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : (i === days.length - 1 ? 'end' : 'middle')) + '">' + U.dateShort(d.date) + '</text>'; });
    const zero = '<line x1="' + pl + '" x2="' + (pl + w) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '" stroke="var(--ins-down)" stroke-width="1" stroke-dasharray="4 3"/>';
    const buf = buffer > 0 ? '<line x1="' + pl + '" x2="' + (pl + w) + '" y1="' + Y(buffer).toFixed(1) + '" y2="' + Y(buffer).toFixed(1) + '" stroke="var(--ins-warn)" stroke-width="1" stroke-dasharray="2 3"/>' : '';
    return '<svg class="ins-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Số dư tiền mặt dự kiến theo ngày">' + g + zero + buf + '<path d="' + area + '" fill="var(--finance-accent-subtle)"/><path d="' + path + '" fill="none" stroke="var(--finance-accent)" stroke-width="2" stroke-linejoin="round"/>' + ticks + '</svg>' +
      '<div class="ins-legend"><span><i style="display:inline-block;width:14px;height:2px;background:var(--finance-accent);vertical-align:middle;margin-right:6px"></i>Số dư dự kiến</span><span style="color:var(--ins-down)">- - - 0 đ</span>' + (buffer > 0 ? '<span style="color:var(--ins-warn)">· · · mức đệm</span>' : '') + '</div>';
  }
  function cashHtml(S) {
    if (S.state === 'loading') return U.loading('Đang lấy sổ lệnh, cổ tức và đề xuất lệnh…');
    if (S.state === 'error') return U.card('wallet', 'Dòng tiền', U.empty('triangle-exclamation', e(S.error)) + '<div style="text-align:center"><button class="ins-btn sm" onclick="insLoad(\'cash\',true)"><i class="fa-solid fa-rotate"></i> Thử lại</button></div>');
    const r = S.res; if (!r) return '';
    const s = r.summary, p = S.params;
    const controls = '<div class="ins-bar">' +
      '<label class="ins-field">Tầm nhìn<select onchange="insCash(\'weeks\',this.value)">' + [8, 13, 26].map((v) => '<option value="' + v + '"' + (p.weeks === v ? ' selected' : '') + '>' + v + ' tuần</option>').join('') + '</select></label>' +
      '<label class="ins-field">Mức tiền mặt tối thiểu muốn giữ (đồng)<input type="text" inputmode="numeric" value="' + e(p.buffer || '') + '" placeholder="0" onchange="insCash(\'buffer\',this.value)"></label>' +
      '<label class="ins-field">Lãi vay (%/năm, nếu có dư nợ)<input type="text" inputmode="decimal" value="' + e(p.debtRate || '') + '" placeholder="vd 11" onchange="insCash(\'debtRate\',this.value)"></label>' +
      '<button class="ins-btn ghost sm" onclick="insLoad(\'cash\',true)"><i class="fa-solid fa-rotate"></i> Tải lại</button></div>';
    const short = s.firstShortfall;
    const k = U.kpis([
      U.kpi('Tiền mặt hiện có', U.money(s.cash0), S.debt > 0 ? 'dư nợ ' + U.money(S.debt) : ''),
      U.kpi('Số dư thấp nhất', U.money(s.minBalance), U.date(s.minDate), s.minBalance < 0 ? 'bad' : (s.buffer > 0 && s.minBalance < s.buffer ? 'warn' : 'good')),
      U.kpi('Thiếu tiền từ', short ? U.date(short) : 'Không', short ? 'cần bổ sung ít nhất ' + U.money(-s.minBalance) : 'trong ' + p.weeks + ' tuần', short ? 'bad' : 'good'),
      U.kpi('Tiền triển khai được', U.money(s.deployable), 'mà không phá mức tối thiểu ở ngày nào', ''),
      U.kpi('Thu / chi dự kiến', U.money(s.inflow, 1) + ' / ' + U.money(-s.outflow, 1), 'trong đó thu chắc chắn ' + U.money(s.sureInflow, 1), ''),
    ]);
    const warn = r.warnings.map((w) => U.note(e(w.text), w.key === 'short' ? 'bad' : 'warn')).join('');
    const weekRows = r.weeks.map((w) => '<tr' + (w.short ? ' class="sel"' : '') + '><td>' + U.dateShort(w.from) + ' – ' + U.dateShort(w.to) + (w.short ? ' ' + U.tag('Thiếu tiền', 'bad') : (w.low ? ' ' + U.tag('Dưới mức tối thiểu', 'warn') : '')) + '</td><td class="ins-up">' + (w.inflow ? '+' + U.money(w.inflow, 1) : '—') + '</td><td class="ins-down">' + (w.outflow ? U.money(w.outflow, 1) : '—') + '</td><td>' + U.money(w.end, 1) + '</td><td class="' + (w.min < 0 ? 'ins-down' : '') + '">' + U.money(w.min, 1) + '</td></tr>').join('');
    const evRows = r.events.map((ev) => '<tr><td>' + U.date(ev.date) + '</td><td class="t">' + U.tag(S.KINDS[ev.kind] ? S.KINDS[ev.kind].label : ev.kind, KIND_TONE[ev.kind]) + (ev.symbol ? ' <b>' + e(ev.symbol) + '</b>' : '') + (ev.sure ? '' : ' <span class="ins-muted">(chưa chắc)</span>') + (ev.note ? '<br><span class="ins-muted" style="font-size:.74rem">' + e(ev.note) + '</span>' : '') + '</td><td class="' + (ev.amount > 0 ? 'ins-up' : 'ins-down') + '">' + (ev.amount > 0 ? '+' : '') + U.money(ev.amount, 1) + '</td><td class="t">' + (ev.source === 'plan' && ev.id ? '<button class="ins-btn ghost sm danger" onclick="insCashDel(\'' + e(ev.id) + '\')" title="Xoá khỏi kế hoạch"><i class="fa-solid fa-xmark"></i></button>' : '') + '</td></tr>').join('');
    const form = '<div class="ins-form">' +
      '<label class="ins-field">Loại<select id="ins-cp-kind"><option value="buy">Mua cổ phiếu</option><option value="sell">Bán cổ phiếu (tiền về T+2)</option><option value="deposit">Nạp tiền</option><option value="withdraw">Rút tiền</option><option value="in">Khoản thu khác</option><option value="out">Khoản chi khác</option></select></label>' +
      '<label class="ins-field">Ngày<input type="date" id="ins-cp-date" value="' + U.today() + '"></label>' +
      '<label class="ins-field">Số tiền (đồng)<input type="text" inputmode="numeric" id="ins-cp-amount" placeholder="vd 500000000"></label>' +
      '<label class="ins-field">Mã (nếu có)<input type="text" id="ins-cp-symbol" maxlength="12" placeholder="FPT"></label>' +
      '<label class="ins-field">Ghi chú<input type="text" id="ins-cp-note" maxlength="80"></label>' +
      '<button class="ins-btn sm" onclick="insCashAdd()"><i class="fa-solid fa-plus"></i> Thêm vào kế hoạch</button></div>' +
      '<p class="tl-hint">Kế hoạch chỉ lưu trên máy này (không đồng bộ). Đề xuất lệnh đang chờ duyệt hoặc đã duyệt chưa khớp được tự đưa vào.</p>';
    const assume = U.note('<b>Giả định:</b> số dư tiền mặt hiện tại <b>đã trừ</b> các lệnh mua đã ghi và <b>chưa cộng</b> tiền bán chưa về; tiền bán về sau T+2 (bỏ cuối tuần và ngày lễ); lệnh mua dự kiến trừ tiền ngay ngày đặt (thận trọng). Cổ tức ước tính theo khoản đã trả năm trước có thể không xảy ra. Đây là kế hoạch tiền mặt, không phải dự báo thị trường.');
    return controls + warn + k + U.card('wallet', 'Số dư tiền mặt dự kiến theo ngày', balanceChart(r.days, s.buffer)) +
      '<div class="ins-grid even">' + U.card('calendar-week', 'Theo tuần', U.table(['Tuần', 'Thu', 'Chi', 'Cuối tuần', 'Thấp nhất'], [weekRows])) + U.card('plus', 'Thêm khoản dự kiến', form) + '</div>' +
      U.card('list', 'Các khoản dự kiến (' + r.events.length + ')', r.events.length ? U.table(['Ngày', 'Khoản', 'Số tiền', ''], [evRows], { left: [1] }) : U.empty('wallet', 'Chưa có khoản nào trong tầm nhìn. Cổ tức, tiền bán chưa về và đề xuất lệnh sẽ tự xuất hiện; bạn có thể thêm lệnh mua/bán dự kiến ở bên trên.')) + assume;
  }

  // ---------- Luân chuyển ngành ----------
  function rrgChart(an) {
    const W = 560, H = 440, pl = 40, pr = 16, pt = 16, pb = 36, w = W - pl - pr, h = H - pt - pb;
    // thang theo vị trí HIỆN TẠI của các ngành, bỏ bớt 1 giá trị lớn nhất để một ngành vượt trội không ép các ngành còn lại vào góc; mốc ngoài thang bị kẹp ở mép
    const dev = (arr) => arr.map((v) => Math.abs(v - 100)).sort((a, b) => b - a);
    const cur = an.sectors.map((s) => s.ratio), curM = an.sectors.map((s) => s.mom);
    const dx = Math.max(2, (dev(cur)[Math.min(1, cur.length - 1)] || 0) * 1.35), dy = Math.max(2, (dev(curM)[Math.min(1, curM.length - 1)] || 0) * 1.35);
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    const X0 = (v) => pl + (v - (100 - dx)) / (2 * dx) * w, Y0 = (v) => pt + ((100 + dy) - v) / (2 * dy) * h;
    const X = (v) => cl(X0(v), pl + 6, pl + w - 6), Y = (v) => cl(Y0(v), pt + 6, pt + h - 6);
    const quad = (x0, y0, x1, y1, label, color) => '<rect x="' + x0 + '" y="' + y0 + '" width="' + (x1 - x0) + '" height="' + (y1 - y0) + '" fill="' + color + '" opacity="0.07"/><text x="' + (x0 === pl ? x0 + 8 : x1 - 8) + '" y="' + (y0 === pt ? y0 + 16 : y1 - 8) + '" text-anchor="' + (x0 === pl ? 'start' : 'end') + '" style="font-family:inherit;font-weight:700;font-size:11px">' + label + '</text>';
    const cx = X(100), cy = Y(100);
    let g = quad(pl, pt, cx, cy, 'CẢI THIỆN', 'var(--ins-warn)') + quad(cx, pt, pl + w, cy, 'DẪN ĐẦU', 'var(--ins-up)') + quad(pl, cy, cx, pt + h, 'TỤT HẬU', 'var(--ins-down)') + quad(cx, cy, pl + w, pt + h, 'SUY YẾU', 'var(--ins-warn)');
    g += '<line class="axis" x1="' + cx + '" x2="' + cx + '" y1="' + pt + '" y2="' + (pt + h) + '"/><line class="axis" x1="' + pl + '" x2="' + (pl + w) + '" y1="' + cy + '" y2="' + cy + '"/>';
    g += '<text x="' + (pl + w / 2) + '" y="' + (H - 8) + '" text-anchor="middle">Sức mạnh tương đối so với VN-Index (RS-Ratio) →</text><text transform="rotate(-90)" x="' + (-(pt + h / 2)) + '" y="12" text-anchor="middle">Đà (RS-Mom) →</text>';
    const color = (q) => (q === 'leading' ? 'var(--ins-up)' : (q === 'lagging' ? 'var(--ins-down)' : 'var(--ins-warn)'));
    an.sectors.forEach((s) => {
      const c = color(s.quadrant.key);
      if (s.trail.length > 1) g += '<polyline clip-path="url(#rrg-clip)" fill="none" stroke="' + c + '" stroke-width="1.5" opacity="0.45" points="' + s.trail.map((t) => X0(t.ratio).toFixed(1) + ',' + Y0(t.mom).toFixed(1)).join(' ') + '"/>';
      s.trail.slice(0, -1).forEach((t) => { const x = X0(t.ratio), y = Y0(t.mom); if (x >= pl && x <= pl + w && y >= pt && y <= pt + h) g += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2" fill="' + c + '" opacity="0.5"/>'; });
      g += '<circle cx="' + X(s.ratio).toFixed(1) + '" cy="' + Y(s.mom).toFixed(1) + '" r="5.5" fill="' + c + '" stroke="var(--card-bg)" stroke-width="1.5"><title>' + e(s.name) + ' — RS-Ratio ' + s.ratio.toFixed(1) + ', RS-Mom ' + s.mom.toFixed(1) + '</title></circle>';
      g += '<text x="' + (X(s.ratio) + 8).toFixed(1) + '" y="' + (Y(s.mom) + 4).toFixed(1) + '" style="fill:var(--text-primary);font-family:inherit;font-weight:600">' + e(s.code.replace(/^VN/, '')) + '</text>';
    });
    return '<svg class="ins-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Biểu đồ luân chuyển ngành"><defs><clipPath id="rrg-clip"><rect x="' + pl + '" y="' + pt + '" width="' + w + '" height="' + h + '"/></clipPath></defs>' + g + '</svg>';
  }
  function rotationHtml(S) {
    if (S.state === 'loading') return U.loading('Đang lấy lịch sử các chỉ số ngành HOSE…');
    if (S.state === 'error') return U.card('arrows-spin', 'Luân chuyển ngành', U.empty('triangle-exclamation', e(S.error)) + '<div style="text-align:center"><button class="ins-btn sm" onclick="insLoad(\'rotation\',true)"><i class="fa-solid fa-rotate"></i> Thử lại</button></div>');
    const an = S.res;
    if (!an || !an.sectors.length) return U.card('arrows-spin', 'Luân chuyển ngành', U.empty('arrows-spin', 'Chưa đủ lịch sử để tính (cần ít nhất ~80 phiên của chỉ số ngành và VN-Index).' + (an && an.skipped.length ? ' Thiếu: ' + e(an.skipped.join(', ')) + '.' : '')));
    const lines = S.lines.map((l) => '<p>' + e(l) + '</p>').join('');
    const rows = an.sectors.map((s) => {
      const tone = s.quadrant.key === 'leading' ? 'ok' : (s.quadrant.key === 'lagging' ? 'bad' : 'warn');
      const rel = (v) => (v === null ? '<td>—</td>' : '<td class="' + U.sign(v) + '">' + (v > 0 ? '+' : '') + U.dec(v, 1) + '</td>');
      const rc = s.rankChange;
      return '<tr><td><b>' + e(s.name) + '</b> <span class="ins-muted">' + e(s.code) + '</span></td><td>' + U.tag(s.quadrant.label, tone) + '</td><td>' + U.dec(s.ratio, 1) + '</td><td>' + U.dec(s.mom, 1) + '</td>' + rel(s.rel.m1) + rel(s.rel.m3) + rel(s.rel.m6) + '<td class="' + (rc > 0 ? 'ins-up' : (rc < 0 ? 'ins-down' : '')) + '">' + (rc === null ? '—' : (rc > 0 ? '▲ ' + rc : (rc < 0 ? '▼ ' + (-rc) : '='))) + '</td></tr>';
    }).join('');
    const how = U.note('<b>Cách đọc:</b> mỗi chấm là một chỉ số ngành HOSE so với VN-Index. Phải = mạnh hơn thị trường so với chính xu hướng dài của nó; trên = sức mạnh đang tăng. Ngành thường đi vòng <b>Cải thiện → Dẫn đầu → Suy yếu → Tụt hậu</b>, nhưng không đều đặn và không đảm bảo. Đuôi chấm là ' + an.params.trail + ' mốc cách nhau ' + an.params.step + ' phiên. Tự tính từ giá đóng cửa theo kiểu Relative Rotation Graph (không phải số liệu JdK của nhà cung cấp, không so trực tiếp được với phần mềm khác). Chỉ số ngành tính theo giá, chưa gồm cổ tức.');
    return U.kpis([U.kpi('Dẫn đầu', an.sectors.filter((s) => s.quadrant.key === 'leading').length + ' ngành', 'số liệu tới ' + U.date(an.asOf)), U.kpi('Cải thiện', an.sectors.filter((s) => s.quadrant.key === 'improving').length + ' ngành', ''), U.kpi('Suy yếu', an.sectors.filter((s) => s.quadrant.key === 'weakening').length + ' ngành', ''), U.kpi('Tụt hậu', an.sectors.filter((s) => s.quadrant.key === 'lagging').length + ' ngành', '')]) +
      '<div class="ins-grid">' + U.card('arrows-spin', 'Vòng luân chuyển so với VN-Index', rrgChart(an)) +
      U.card('align-left', 'Tóm tắt', '<div class="ins-prose">' + lines + '</div>' + how) + '</div>' +
      U.card('table', 'Bảng xếp hạng sức mạnh', U.table(['Ngành', 'Góc', 'RS-Ratio', 'RS-Mom', 'Hơn/kém VNI 1T (đ.%)', '3T', '6T', 'Đổi hạng 1T'], [rows]) + (an.skipped.length ? '<p class="tl-hint">Chưa đủ dữ liệu cho: ' + e(an.skipped.join(', ')) + '.</p>' : ''));
  }

  return { liquidityHtml, cashHtml, rotationHtml, balanceChart, rrgChart };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = InsViewsA;
