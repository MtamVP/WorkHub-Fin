/* --- FILE: /lab/lab-views.js ---
   Giao diện Phòng kiểm thử (chỉ dựng chuỗi HTML, không đụng DOM nên kiểm thử được bằng Vitest): thanh dữ liệu, bộ dựng chiến lược, kết quả kiểm thử kèm các phép thử độ tin cậy, lịch sử các lần kiểm thử.
   Phụ thuộc: InsUtil (insight/insight-util.js), StrategyBacktest (lib/strategy-backtest.js). Nạp bằng thẻ <script> thường (global LabViews) và module.exports. */
const LabViews = (function () {
  const NODE = typeof require === 'function' && typeof module !== 'undefined';
  const U = NODE ? require('../insight/insight-util.js') : InsUtil;
  const SB = NODE ? require('../lib/strategy-backtest.js') : StrategyBacktest;
  const e = U.esc;
  const GROUPS = { price: 'Từ chuỗi giá', fund: 'Số liệu cơ bản (theo thời điểm)' };
  const FREQ = { W: 'Hằng tuần', M: 'Hằng tháng', Q: 'Hằng quý', Y: 'Hằng năm' };
  const WEIGHT = { equal: 'Chia đều', invvol: 'Nghịch đảo biến động', score: 'Theo điểm xếp hạng' };

  // ---------- đơn vị nhập / hiển thị theo tiêu chí ----------
  const unitOf = (key) => (SB.BY_KEY[key] ? SB.BY_KEY[key].unit : 'x');
  function toDisplay(key, v) {                       // giá trị lưu -> chữ trong ô nhập (% với tỷ lệ, tỷ đồng với số tiền)
    if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '';
    const u = unitOf(key), n = Number(v);
    return String(Math.round((u === 'pct' ? n * 100 : (u === 'vnd' ? n / 1e9 : n)) * 1e6) / 1e6);
  }
  function fromDisplay(key, text) {                  // chữ nhập -> giá trị lưu; rỗng -> null
    const t = String(text === null || text === undefined ? '' : text).trim().replace(/\s/g, '').replace(',', '.');
    if (t === '' || !isFinite(Number(t))) return null;
    const u = unitOf(key), n = Number(t);
    return u === 'pct' ? n / 100 : (u === 'vnd' ? n * 1e9 : n);
  }
  const unitLabel = (key) => ({ pct: '%', vnd: 'tỷ đ', x: '' }[unitOf(key)] || '');

  // ---------- thanh dữ liệu ----------
  function dataBarHtml(S) {
    const d = S.data || {};
    if (d.state === 'loading') {
      const p = d.progress || {};
      return U.card('database', 'Kho giá lịch sử', '<div style="display:flex;align-items:center;gap:12px"><div style="flex:1">' + U.meter(p.frac || 0) + '</div><b class="ins-num">' + U.dec((p.frac || 0) * 100, 0) + '%</b></div><p class="tl-hint">' + e(p.text || 'Đang tải…') + ' Lần đầu mất khoảng 1-2 phút; các lần sau chỉ tải thêm ngày mới (kho được lưu trên máy này).</p>');
    }
    if (d.state === 'error') return U.card('database', 'Kho giá lịch sử', U.empty('triangle-exclamation', e(d.error || 'Không tải được kho giá')) + '<div style="text-align:center"><button class="ins-btn sm" onclick="labLoad(true)"><i class="fa-solid fa-rotate"></i> Thử lại</button></div>');
    if (d.state !== 'ready') return U.card('database', 'Kho giá lịch sử', U.empty('database', 'Chưa tải kho giá.') + '<div style="text-align:center"><button class="ins-btn sm" onclick="labLoad(true)"><i class="fa-solid fa-download"></i> Tải kho giá</button></div>');
    const sm = d.summary, pit = d.pit || { n: 0 };
    const k = U.kpis([
      U.kpi('Phiên giao dịch', U.int(sm.days), U.date(sm.first) + ' → ' + U.date(sm.last)),
      U.kpi('Mã trong kho', U.int(sm.symbols), U.int(sm.ended) + ' mã đã ngừng giao dịch (không bị loại)'),
      U.kpi('Số liệu cơ bản', U.int(pit.n) + ' ngày', pit.first ? U.date(pit.first) + ' → ' + U.date(pit.last) + ' (cuối tháng)' : 'chưa có', pit.n ? '' : 'warn'),
      U.kpi('Phiên còn thiếu', U.int(sm.missing), sm.missing > 5 ? 'lợi suất các phiên này bị bỏ' : 'đủ', sm.missing > 5 ? 'warn' : 'good'),
    ]);
    const bits = [];
    if (d.fromCache !== undefined) bits.push(d.downloaded ? 'vừa tải thêm ' + U.int(d.downloaded) + ' ngày' : 'dùng kho đã lưu trên máy');
    bits.push('bộ nhớ ~' + U.int(d.memoryMb || 0) + ' MB');
    return k + '<p class="tl-hint" style="margin-top:-6px">' + e(bits.join(' · ')) + '. Giá là lợi suất tổng (đã gồm cổ tức, chia thưởng) tính từ giá tham chiếu của sàn; gồm cả mã đã hủy niêm yết. <button class="ins-link" onclick="labLoad(true)">Tải lại</button></p>';
  }

  // ---------- bộ dựng ----------
  function factorOptions(sel, only) {
    const groups = {};
    SB.FACTORS.forEach((f) => { if (!only || f.group === only) (groups[f.group] = groups[f.group] || []).push(f); });
    return Object.keys(groups).map((g) => '<optgroup label="' + e(GROUPS[g] || g) + '">' + groups[g].map((f) => '<option value="' + e(f.key) + '"' + (f.key === sel ? ' selected' : '') + '>' + e(f.label) + '</option>').join('') + '</optgroup>').join('');
  }
  function builderHtml(S) {
    const sp = S.draft, errs = (S.errors || []).concat(S.specWarnings || []);
    const num = (v, d) => (v === null || v === undefined ? '' : String(Math.round(v * Math.pow(10, d || 4)) / Math.pow(10, d || 4)));
    const chips = SB.PRESETS.map((p) => '<button type="button" aria-pressed="' + (S.preset === p.id ? 'true' : 'false') + '" onclick="labPreset(\'' + p.id + '\')" title="' + e(p.note) + '">' + e(p.label) + '</button>').join('');
    const preset = SB.PRESETS.find((p) => p.id === S.preset);
    const filters = sp.filters.map((f, i) => '<div class="lab-row"><label class="ins-field">Tiêu chí<select onchange="labFilter(' + i + ',\'key\',this.value)">' + factorOptions(f.key) + '</select></label>' +
      '<label class="ins-field">Từ' + (unitLabel(f.key) ? ' (' + unitLabel(f.key) + ')' : '') + '<input type="text" inputmode="decimal" value="' + e(toDisplay(f.key, f.min)) + '" onchange="labFilter(' + i + ',\'min\',this.value)"></label>' +
      '<label class="ins-field">Đến' + (unitLabel(f.key) ? ' (' + unitLabel(f.key) + ')' : '') + '<input type="text" inputmode="decimal" value="' + e(toDisplay(f.key, f.max)) + '" onchange="labFilter(' + i + ',\'max\',this.value)"></label>' +
      '<button type="button" class="ins-btn ghost sm" onclick="labDelFilter(' + i + ')" aria-label="Xoá bộ lọc"><i class="fa-solid fa-xmark"></i></button></div>').join('');
    const ranks = sp.rank.map((r, i) => '<div class="lab-row"><label class="ins-field">Tiêu chí<select onchange="labRank(' + i + ',\'key\',this.value)">' + factorOptions(r.key) + '</select></label>' +
      '<label class="ins-field">Ưu tiên<select onchange="labRank(' + i + ',\'dir\',this.value)"><option value="high"' + (r.dir === 'high' ? ' selected' : '') + '>Cao hơn tốt hơn</option><option value="low"' + (r.dir === 'low' ? ' selected' : '') + '>Thấp hơn tốt hơn</option></select></label>' +
      '<label class="ins-field">Trọng số<input type="text" inputmode="decimal" value="' + e(num(r.w, 2)) + '" onchange="labRank(' + i + ',\'w\',this.value)"></label>' +
      '<button type="button" class="ins-btn ghost sm" onclick="labDelRank(' + i + ')" aria-label="Xoá tiêu chí xếp hạng"' + (sp.rank.length <= 1 ? ' disabled' : '') + '><i class="fa-solid fa-xmark"></i></button></div>').join('');
    const ex = ['HOSE', 'HNX', 'UPCOM'].map((x) => '<label class="lab-check"><input type="checkbox" ' + (sp.universe.exchanges.indexOf(x) !== -1 ? 'checked ' : '') + 'onchange="labExchange(\'' + x + '\',this.checked)"> ' + x + '</label>').join('');
    const seg = (items, cur, fn) => '<div class="ins-seg" role="group">' + Object.keys(items).map((k) => '<button type="button" aria-pressed="' + (String(cur) === String(k) ? 'true' : 'false') + '" onclick="' + fn + '(\'' + k + '\')">' + e(items[k]) + '</button>').join('') + '</div>';
    const f = (label, input, hint) => '<label class="ins-field">' + label + input + (hint ? '<span class="lab-hint">' + hint + '</span>' : '') + '</label>';
    const inp = (path, val, extra) => '<input type="text" inputmode="decimal" value="' + e(val) + '" onchange="labSet(\'' + path + '\',this.value)"' + (extra || '') + '>';
    return U.card('flask', 'Dựng chiến lược', '<div class="lab-presets"><span class="lab-lbl">Mẫu</span><div class="ins-seg" role="group" aria-label="Mẫu chiến lược">' + chips + '</div></div>' +
      (preset ? '<p class="tl-hint" style="margin:6px 0 12px">' + e(preset.note) + '</p>' : '<p class="tl-hint" style="margin:6px 0 12px">Cấu hình tuỳ chỉnh: bạn đã đổi mẫu hoặc tự dựng.</p>') +
      '<div class="lab-sect"><h4>1. Vũ trụ và giai đoạn</h4><div class="ins-form">' +
        f('Tên', '<input type="text" maxlength="120" value="' + e(sp.name) + '" onchange="labSet(\'name\',this.value)">') +
        f('Từ ngày', '<input type="date" value="' + e(sp.period.from || '') + '" onchange="labSet(\'period.from\',this.value)">', 'để trống = từ đầu kho') +
        f('Đến ngày', '<input type="date" value="' + e(sp.period.to || '') + '" onchange="labSet(\'period.to\',this.value)">', 'để trống = tới nay') +
        f('Thanh khoản tối thiểu (tỷ đ/ngày)', inp('universe.minAdv', num(sp.universe.minAdv / 1e9, 3)), 'trung vị 20 phiên') +
        f('Giá tối thiểu (đồng)', inp('universe.minPrice', num(sp.universe.minPrice, 0))) +
        f('Lịch sử tối thiểu (phiên)', inp('universe.minHistory', num(sp.universe.minHistory, 0)), 'loại mã mới niêm yết') +
        f('Chỉ các ngành ICB', '<input type="text" value="' + e(sp.universe.icbIn.join(',')) + '" onchange="labSet(\'universe.icbIn\',this.value)" placeholder="vd 8300,8700">', 'mã ICB cấp 2, cách nhau bằng dấu phẩy') +
        f('Loại các ngành ICB', '<input type="text" value="' + e(sp.universe.icbOut.join(',')) + '" onchange="labSet(\'universe.icbOut\',this.value)" placeholder="vd 8300,8500,8700">', 'vd bỏ ngân hàng, bảo hiểm, chứng khoán') +
      '</div><div class="lab-checks"><span class="lab-lbl">Sàn</span>' + ex + '</div></div>' +
      '<div class="lab-sect"><h4>2. Bộ lọc <span class="ins-muted">(mã phải thoả TẤT CẢ điều kiện; thiếu số liệu thì bị loại)</span></h4>' + (filters || '<p class="tl-hint">Chưa có bộ lọc: mọi mã trong vũ trụ đều được xếp hạng.</p>') +
        '<button type="button" class="ins-btn ghost sm" onclick="labAddFilter()"><i class="fa-solid fa-plus"></i> Thêm bộ lọc</button></div>' +
      '<div class="lab-sect"><h4>3. Xếp hạng <span class="ins-muted">(điểm = trung bình có trọng số của thứ hạng phân vị từng tiêu chí)</span></h4>' + ranks +
        '<button type="button" class="ins-btn ghost sm" onclick="labAddRank()"' + (sp.rank.length >= 8 ? ' disabled' : '') + '><i class="fa-solid fa-plus"></i> Thêm tiêu chí</button></div>' +
      '<div class="lab-sect"><h4>4. Chọn mã và chia tỷ trọng</h4><div class="ins-form">' +
        f('Số mã', inp('select.n', num(sp.select.n, 0))) +
        f('Giữ mã cũ nếu còn trong top (%)', inp('select.keep', num(sp.select.keep * 100, 0)), '0 = bỏ ngay; 50 = giữ nếu còn trong top ×1,5 (bớt vòng quay)') +
        f('Trần tỷ trọng một mã (%)', inp('maxWeight', num(sp.maxWeight * 100, 1))) +
        f('Cách chia', '<select onchange="labSet(\'weighting\',this.value)">' + Object.keys(WEIGHT).map((k) => '<option value="' + k + '"' + (sp.weighting === k ? ' selected' : '') + '>' + e(WEIGHT[k]) + '</option>').join('') + '</select>') +
      '</div></div>' +
      '<div class="lab-sect"><h4>5. Cân bằng và khớp lệnh</h4><div class="ins-bar" style="margin-bottom:8px"><span class="lab-lbl">Tần suất</span>' + seg(FREQ, sp.rebalance, 'labFreq') + '</div><div class="ins-form">' +
        f('Trễ khớp (phiên)', inp('lag', num(sp.lag, 0)), 'quyết định cuối phiên t, khớp giá đóng cửa phiên t + trễ') +
        f('Tối đa % giá trị giao dịch mỗi phiên', inp('participation', num(sp.participation * 100, 0)), 'phần dư để lại kỳ sau') +
      '</div></div>' +
      '<div class="lab-sect"><h4>6. Chi phí và vốn</h4><div class="ins-form">' +
        f('Phí mỗi chiều (%)', inp('costs.fee', num(sp.costs.fee * 100, 3))) + f('Thuế bán (%)', inp('costs.tax', num(sp.costs.tax * 100, 3))) +
        f('Tác động giá', '<select onchange="labSet(\'costs.impact\',this.value)"><option value="1"' + (sp.costs.impact ? ' selected' : '') + '>Bật (căn bậc hai)</option><option value="0"' + (sp.costs.impact ? '' : ' selected') + '>Tắt</option></select>') +
        f('Vốn (tỷ đồng)', inp('capital', num(sp.capital / 1e9, 3)), 'quyết định mức khớp được') +
        f('Lãi tiền mặt (%/năm)', inp('rf', num(sp.rf * 100, 2)), 'cũng là lãi suất phi rủi ro cho Sharpe') +
      '</div></div>' +
      (errs.length ? '<div class="ins-note bad"><b>Cần sửa trước khi chạy:</b><ul style="margin:6px 0 0 18px">' + errs.map((x) => '<li>' + e(x) + '</li>').join('') + '</ul></div>' : '') +
      '<div class="ins-bar" style="margin:14px 0 0"><button type="button" class="ins-btn" onclick="labRun()" id="lab-run"' + (S.running || (S.data || {}).state !== 'ready' ? ' disabled' : '') + '><i class="fa-solid fa-play"></i> ' + (S.running ? 'Đang chạy…' : 'Chạy kiểm thử') + '</button>' +
      '<button type="button" class="ins-btn ghost" onclick="labReset()">Đặt lại mặc định</button><span class="ins-muted" style="font-size:.76rem">' + (S.running ? e(S.progress || '') : 'Chạy trong máy bạn, thường 2-6 giây.') + '</span></div>');
  }

  // ---------- biểu đồ ----------
  const COLORS = { strat: 'var(--finance-accent)', bench: 'var(--text-muted)', univ: 'var(--ins-up)' };
  function curveSvg(c, log) {
    if (!c || !c.dates || c.dates.length < 2) return '';
    const W = 760, H = 270, L = 46, R = 12, T = 12, B = 26, n = c.dates.length;
    const series = [['strat', c.strat], ['bench', c.bench], ['univ', c.univ]].filter((s) => s[1]);
    const tf = (v) => (log ? Math.log(v) : v);
    let lo = Infinity, hi = -Infinity;
    series.forEach((s) => s[1].forEach((v) => { const x = tf(v); if (x < lo) lo = x; if (x > hi) hi = x; }));
    if (!(hi > lo)) hi = lo + 1;
    const x = (i) => L + (W - L - R) * i / (n - 1), y = (v) => T + (H - T - B) * (1 - (tf(v) - lo) / (hi - lo));
    const ticks = U.niceTicks(log ? Math.exp(lo) : lo, log ? Math.exp(hi) : hi, 4);
    const grid = ticks.filter((v) => (log ? v > 0 : true)).map((v) => '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/><text x="' + (L - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + (v >= 10 ? U.dec(v, 0) : U.dec(v, 2)) + '×</text>').join('');
    const yrs = []; c.dates.forEach((d, i) => { if (d.slice(5, 7) === '01' && (i === 0 || c.dates[i - 1].slice(5, 7) !== '01')) yrs.push([i, d.slice(0, 4)]); });
    const xl = yrs.map((p) => '<text x="' + x(p[0]).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + p[1] + '</text>').join('');
    const lines = series.map((s) => '<polyline fill="none" stroke="' + COLORS[s[0]] + '" stroke-width="' + (s[0] === 'strat' ? 2.2 : 1.5) + '"' + (s[0] === 'bench' ? ' stroke-dasharray="4 3"' : '') + ' points="' + s[1].map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ') + '"/>').join('');
    return '<svg class="ins-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Giá trị 1 đồng đầu tư theo thời gian">' + grid + '<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '"/>' + xl + lines + '</svg>' +
      '<div class="ins-legend"><span><i style="display:inline-block;width:16px;height:3px;background:' + COLORS.strat + ';vertical-align:middle"></i> Chiến lược</span><span><i style="display:inline-block;width:16px;border-top:2px dashed ' + COLORS.bench + ';vertical-align:middle"></i> VN-Index (giá, chưa gồm cổ tức)</span>' + (c.univ ? '<span><i style="display:inline-block;width:16px;height:3px;background:' + COLORS.univ + ';vertical-align:middle"></i> Rổ đều toàn vũ trụ (cùng chi phí)</span>' : '') + '</div>';
  }
  function ddSeries(v) { let pk = v[0]; return v.map((x) => { if (x > pk) pk = x; return x / pk - 1; }); }
  function ddSvg(c) {
    if (!c || !c.dates || c.dates.length < 2) return '';
    const W = 760, H = 150, L = 46, R = 12, T = 8, B = 20, n = c.dates.length;
    const a = ddSeries(c.strat), b = ddSeries(c.bench), lo = Math.min(-0.05, Math.min.apply(null, a), Math.min.apply(null, b));
    const x = (i) => L + (W - L - R) * i / (n - 1), y = (v) => T + (H - T - B) * (v / lo);
    const area = 'M' + x(0).toFixed(1) + ',' + y(0).toFixed(1) + ' ' + a.map((v, i) => 'L' + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ') + ' L' + x(n - 1).toFixed(1) + ',' + y(0).toFixed(1) + ' Z';
    const ticks = U.niceTicks(lo, 0, 3).filter((v) => v <= 0);
    return '<svg class="ins-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Sụt giảm từ đỉnh">' + ticks.map((v) => '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/><text x="' + (L - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + U.dec(v * 100, 0) + '%</text>').join('') +
      '<path d="' + area + '" fill="var(--finance-accent)" fill-opacity="0.18" stroke="var(--finance-accent)" stroke-width="1.6"/><polyline fill="none" stroke="' + COLORS.bench + '" stroke-width="1.2" stroke-dasharray="4 3" points="' + b.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ') + '"/></svg>';
  }
  function histSvg(h) {
    if (!h || !h.counts) return '';
    const W = 560, H = 140, L = 10, R = 10, T = 14, B = 26, k = h.counts.length, mx = Math.max.apply(null, h.counts) || 1, bw = (W - L - R) / k;
    const bars = h.counts.map((c, i) => '<rect x="' + (L + i * bw + 1).toFixed(1) + '" y="' + (H - B - (H - B - T) * c / mx).toFixed(1) + '" width="' + (bw - 2).toFixed(1) + '" height="' + ((H - B - T) * c / mx).toFixed(1) + '" fill="var(--text-muted)" fill-opacity="0.45"/>').join('');
    const mxX = L + (h.mark - h.min) / ((h.max - h.min) || 1) * (W - L - R);
    return '<svg class="ins-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Phân bố CAGR của các rổ ngẫu nhiên">' + bars + '<line x1="' + mxX.toFixed(1) + '" x2="' + mxX.toFixed(1) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--finance-accent)" stroke-width="2.4"/><text x="' + L + '" y="' + (H - 8) + '">' + U.pct(h.min, 0) + '</text><text x="' + (W - R) + '" y="' + (H - 8) + '" text-anchor="end">' + U.pct(h.max, 0) + '</text><text x="' + Math.min(W - 70, Math.max(L, mxX - 28)).toFixed(1) + '" y="10" style="fill:var(--finance-accent);font-weight:700">chiến lược</text></svg>';
  }

  // ---------- đánh giá độ tin cậy ----------
  // Mỗi phép thử cho ra { tone: 'good' | 'warn' | 'bad', title, text }. Không có phép thử nào "chứng minh" chiến lược tốt: chúng chỉ cho biết kết quả có dễ là may rủi hay mong manh hay không.
  function checks(r) {
    const out = [];
    const rd = r.random;
    if (rd) {
      const pc = rd.cagr.rank;
      out.push({ tone: pc >= 0.95 ? 'good' : (pc >= 0.8 ? 'warn' : 'bad'), title: 'So với rổ ngẫu nhiên', text: 'CAGR cao hơn ' + U.dec(pc * 100, 0) + '% trong ' + rd.runs + ' rổ chọn ngẫu nhiên cùng vũ trụ, cùng số mã, cùng chi phí (p ≈ ' + U.dec(rd.cagr.p, 3) + '). ' + (pc >= 0.95 ? 'Khó là may rủi thuần tuý.' : (pc >= 0.8 ? 'Nghiêng về tốt hơn ngẫu nhiên nhưng chưa chắc.' : 'Không tốt hơn rõ rệt việc chọn bừa.')) });
    }
    const ex = r.bootstrap.excess;
    out.push({ tone: ex[0] > 0 ? 'good' : (ex[1] < 0 ? 'bad' : 'warn'), title: 'Khoảng tin cậy của lợi suất vượt VN-Index', text: 'Khoảng 90% (bootstrap theo khối 21 phiên): ' + U.pct(ex[0], 1, true) + ' đến ' + U.pct(ex[1], 1, true) + '/năm' + (ex[0] > 0 ? '; không chứa 0.' : '; chứa cả giá trị âm: chưa đủ bằng chứng là vượt thật.') });
    const sp = r.split;
    if (sp && sp.early && sp.late && sp.earlyBench && sp.lateBench && isFinite(sp.early.cagr) && isFinite(sp.late.cagr)) {
      const e1 = sp.early.cagr - sp.earlyBench.cagr, e2 = sp.late.cagr - sp.lateBench.cagr;
      out.push({ tone: e1 > 0 && e2 > 0 ? 'good' : (e1 <= 0 && e2 <= 0 ? 'bad' : 'warn'), title: 'Nhất quán hai nửa giai đoạn', text: 'Nửa đầu (đến ' + U.date(sp.at) + '): ' + U.pct(e1, 1, true) + '/năm so với VN-Index; nửa sau: ' + U.pct(e2, 1, true) + '/năm. ' + (e1 > 0 && e2 > 0 ? 'Cả hai nửa đều vượt.' : 'Chỉ vượt ở một nửa: dấu hiệu của khớp quá mức hoặc phụ thuộc giai đoạn.') });
    }
    const full = (r.yearly || []).filter((y) => !y.partial && y.strat !== null && y.bench !== null);
    if (full.length >= 3) {
      const beat = full.filter((y) => y.strat > y.bench).length;
      out.push({ tone: beat / full.length >= 0.7 ? 'good' : (beat / full.length >= 0.5 ? 'warn' : 'bad'), title: 'Vượt VN-Index theo từng năm', text: 'Vượt ở ' + beat + '/' + full.length + ' năm trọn vẹn.' + (beat / full.length < 0.5 ? ' Kết quả dồn vào ít năm.' : '') });
    }
    const sens = (r.sensitivity || []).filter((s) => s.id !== 'base');
    if (sens.length >= 3) {
      const ok = sens.filter((s) => s.cagr > r.bench.cagr).length;
      out.push({ tone: ok / sens.length >= 0.75 ? 'good' : (ok / sens.length >= 0.5 ? 'warn' : 'bad'), title: 'Độ nhạy với tham số', text: ok + '/' + sens.length + ' biến thể (đổi số mã, tần suất, độ trễ, chi phí gấp đôi) vẫn vượt VN-Index. ' + (ok / sens.length < 0.5 ? 'Kết quả mong manh: đổi nhẹ là mất lợi thế.' : '') });
    }
    if (r.dsr && r.dsr.trials > 1) {
      out.push({ tone: r.dsr.dsr >= 0.95 ? 'good' : (r.dsr.dsr >= 0.75 ? 'warn' : 'bad'), title: 'Sharpe đã trừ may rủi cho số lần thử', text: 'Bạn đã thử ' + r.dsr.trials + ' cấu hình trên cùng dữ liệu: xác suất Sharpe thật dương sau khi trừ cho việc chọn cấu hình tốt nhất = ' + U.dec(r.dsr.dsr * 100, 0) + '% (chưa trừ: ' + U.dec(r.dsr.psr0 * 100, 0) + '%).' });
    } else if (r.dsr) {
      out.push({ tone: r.dsr.psr0 >= 0.95 ? 'good' : (r.dsr.psr0 >= 0.8 ? 'warn' : 'bad'), title: 'Xác suất Sharpe thật dương', text: U.dec(r.dsr.psr0 * 100, 0) + '% (đã tính độ lệch và đuôi dày của lợi suất). Đây mới là lần thử đầu: thử thêm cấu hình khác thì con số này sẽ bị trừ.' });
    }
    if (r.trade) {
      out.push({ tone: r.trade.fillRatio >= 0.9 ? 'good' : (r.trade.fillRatio >= 0.7 ? 'warn' : 'bad'), title: 'Khả năng khớp lệnh', text: 'Khớp được ' + U.dec(r.trade.fillRatio * 100, 0) + '% khối lượng muốn giao dịch; kẹt trần ' + r.trade.lockedBuy + ' lần mua, kẹt sàn ' + r.trade.lockedSell + ' lần bán.' });
      const ex2 = r.metrics.cagr - r.bench.cagr;
      if (ex2 > 0 && r.trade.costDrag > 0.3 * ex2) out.push({ tone: 'warn', title: 'Chi phí nuốt lợi thế', text: 'Phí, thuế, tác động giá mất ' + U.pct(r.trade.costDrag, 1) + '/năm, bằng ' + U.dec(r.trade.costDrag / ex2 * 100, 0) + '% phần vượt VN-Index.' });
    }
    return out;
  }
  function verdict(r) {
    const c = checks(r), bad = c.filter((x) => x.tone === 'bad').length, warn = c.filter((x) => x.tone === 'warn').length;
    if (!c.length) return { tone: 'warn', text: 'Chưa đủ phép thử để kết luận.' };
    if (bad >= 1) return { tone: 'bad', text: 'Chưa đủ bằng chứng: có ' + bad + ' phép thử không đạt. Đừng coi con số lãi là bằng chứng chiến lược hiệu quả.' };
    if (warn >= 3) return { tone: 'warn', text: 'Bằng chứng yếu: ' + warn + ' phép thử chỉ đạt mức cảnh báo. Kết quả đẹp có thể một phần do may rủi hoặc phụ thuộc giai đoạn.' };
    if (warn >= 1) return { tone: 'warn', text: 'Khá ổn nhưng chưa chắc: ' + warn + ' phép thử cần lưu ý. Lịch sử không bảo đảm tương lai.' };
    return { tone: 'good', text: 'Qua các phép thử độ tin cậy. Vẫn chỉ là lịch sử: thị trường đổi chế độ, và số lần bạn thử cấu hình làm giảm giá trị của kết quả đẹp.' };
  }

  // ---------- kết quả ----------
  function metricRow(label, fn, a, b, c, hint) {
    const cell = (x) => (x ? fn(x) : '—');
    return '<tr><td class="t">' + e(label) + (hint ? ' <span class="lab-hint">' + e(hint) + '</span>' : '') + '</td><td>' + cell(a) + '</td><td>' + cell(b) + '</td><td>' + cell(c) + '</td></tr>';
  }
  function resultHtml(S) {
    const r = S.result;
    if (S.running && !r) return U.loading(S.progress || 'Đang chạy…');
    if (!r) return '';
    if (!r.ok) return U.card('triangle-exclamation', 'Không chạy được', '<ul style="margin:0 0 0 18px">' + r.errors.map((x) => '<li>' + e(x) + '</li>').join('') + '</ul>');
    const m = r.metrics, b = r.bench, u = r.univ, rel = r.rel || {}, t = r.trade;
    const pc = (k, d) => (x) => U.pct(x[k], d === undefined ? 1 : d, k === 'cagr' || k === 'total');
    const v = verdict(r);
    const head = U.kpis([
      U.kpi('Lãi kép năm (CAGR)', U.pct(m.cagr, 1, true), 'VN-Index ' + U.pct(b.cagr, 1, true) + (u ? ' · rổ đều ' + U.pct(u.cagr, 1, true) : ''), m.cagr > b.cagr ? 'good' : 'warn'),
      U.kpi('Sharpe', U.dec(m.sharpe, 2), 'VN-Index ' + U.dec(b.sharpe, 2)),
      U.kpi('Sụt giảm tối đa', U.pct(m.maxDD, 1), 'VN-Index ' + U.pct(b.maxDD, 1) + ' · ' + U.dateShort(m.ddFrom) + '→' + U.dateShort(m.ddTo), m.maxDD < b.maxDD - 0.1 ? 'warn' : ''),
      U.kpi('Vòng quay / chi phí', U.pct(t.turnover, 0) + '/năm', 'chi phí ' + U.pct(t.costDrag, 1) + '/năm'),
    ]);
    const rows = [
      metricRow('Tổng lợi suất', pc('total', 0), m, b, u), metricRow('Lãi kép năm', pc('cagr'), m, b, u),
      metricRow('Biến động năm', pc('annVol'), m, b, u), metricRow('Sharpe', (x) => U.dec(x.sharpe, 2), m, b, u, 'trừ lãi suất tiền mặt'),
      metricRow('Sortino', (x) => U.dec(x.sortino, 2), m, b, u), metricRow('Sụt giảm tối đa', pc('maxDD'), m, b, u),
      metricRow('Calmar', (x) => U.dec(x.calmar, 2), m, b, u), metricRow('Tháng tốt nhất / xấu nhất', (x) => U.pct(x.bestMonth, 1) + ' / ' + U.pct(x.worstMonth, 1), m, b, u),
      metricRow('Tỷ lệ tháng có lãi', pc('positiveMonths', 0), m, b, u),
    ].join('');
    const relRows = rel.beta === undefined || rel.beta === null ? '' : U.kpis([
      U.kpi('Beta', U.dec(rel.beta, 2), 'so với VN-Index'), U.kpi('Alpha năm', U.pct(rel.alpha, 1, true), 't = ' + U.dec(rel.tAlpha, 2) + (Math.abs(rel.tAlpha) < 2 ? ' (chưa khác 0 rõ rệt)' : ''), Math.abs(rel.tAlpha) >= 2 ? 'good' : 'warn'),
      U.kpi('Tracking error', U.pct(rel.trackingError, 1), 'IR ' + U.dec(rel.infoRatio, 2)), U.kpi('Bắt tăng / giảm', U.dec(rel.upCapture * 100, 0) + '% / ' + U.dec(rel.downCapture * 100, 0) + '%', 'tháng VN-Index tăng / giảm'),
    ]);
    const chk = checks(r).map((c) => '<li class="lab-chk ' + c.tone + '"><i class="fa-solid fa-' + ({ good: 'circle-check', warn: 'triangle-exclamation', bad: 'circle-xmark' }[c.tone]) + '"></i><div><b>' + e(c.title) + '</b><br>' + e(c.text) + '</div></li>').join('');
    const yearTable = U.table(['Năm', 'Chiến lược', 'VN-Index', 'Rổ đều', 'Hơn VN-Index'], [r.yearly.map((y) => '<tr><td>' + y.year + (y.partial ? ' <span class="lab-hint">(một phần)</span>' : '') + '</td><td class="' + U.sign(y.strat) + '">' + U.pct(y.strat, 1, true) + '</td><td class="' + U.sign(y.bench) + '">' + U.pct(y.bench, 1, true) + '</td><td class="' + U.sign(y.univ) + '">' + U.pct(y.univ, 1, true) + '</td><td class="' + U.sign(y.strat - y.bench) + '">' + (y.strat !== null && y.bench !== null ? U.pct(y.strat - y.bench, 1, true) : '—') + '</td></tr>').join('')]);
    const sens = r.sensitivity && r.sensitivity.length ? U.table(['Biến thể', 'Lãi kép năm', 'Sharpe', 'Sụt giảm tối đa'], [r.sensitivity.map((s) => '<tr' + (s.id === 'base' ? ' class="sel"' : '') + '><td class="t">' + e(s.label) + '</td><td class="' + U.sign(s.cagr - b.cagr) + '">' + U.pct(s.cagr, 1, true) + '</td><td>' + U.dec(s.sharpe, 2) + '</td><td>' + U.pct(s.maxDD, 1) + '</td></tr>').join('')]) : '';
    const reb = r.rebalances.slice(-24).reverse().map((x) => '<tr><td>' + U.date(x.date) + '</td><td>' + x.n + '</td><td>' + U.int(x.eligible) + '</td><td>' + (x.passed ? U.int(x.passed) : '—') + '</td><td>' + U.pct(x.cash, 0) + '</td><td class="t">' + x.top.slice(0, 8).map((h) => Links.symHtml(h.sym, { from: 'lab', plain: true }) + ' ' + U.dec(h.w * 100, 0) + '%').join(', ') + '</td></tr>').join('');
    const warn = r.warnings && r.warnings.length ? U.note('<b>Lưu ý:</b><ul style="margin:6px 0 0 18px">' + r.warnings.map((w) => '<li>' + e(w) + '</li>').join('') + '</ul>', 'warn') : '';
    const lim = U.note('<b>Giới hạn phải nhớ:</b> (1) VN-Index là chỉ số giá, không gồm cổ tức, nên chiến lược được lợi khoảng 1-2 điểm %/năm khi so với nó; hãy nhìn thêm rổ đều và rổ ngẫu nhiên. (2) Kho gồm mã đã hủy niêm yết nhưng không có mã UPCoM thanh khoản rất thấp. (3) Số liệu cơ bản lấy từ chỉ số VNDirect tính theo ngày (P/E, P/B đổi đúng ngày công bố báo cáo); chỉ số theo quý chỉ lấy quý đã qua hạn công bố bảo thủ. (4) Không mô phỏng lô 100, T+2 và margin. (5) Quá khứ không bảo đảm tương lai.');
    const save = '<div class="ins-bar" style="margin:12px 0 0"><label class="ins-field">Ghi chú khi lưu<input type="text" id="lab-note" maxlength="300" placeholder="vd: thử lại sau khi bỏ nhóm bất động sản"></label><button type="button" class="ins-btn" onclick="labSave()"' + (S.saving ? ' disabled' : '') + '><i class="fa-solid fa-floppy-disk"></i> Lưu lần kiểm thử này</button><span class="ins-muted" style="font-size:.76rem">Lưu cả cấu hình và kết quả; số lần thử được dùng để trừ may rủi cho Sharpe.</span></div>';
    return '<div class="lab-verdict ' + v.tone + '"><i class="fa-solid fa-' + ({ good: 'circle-check', warn: 'triangle-exclamation', bad: 'circle-xmark' }[v.tone]) + '"></i><div><b>' + e(r.spec.name) + '</b> · ' + U.date(r.period.from) + ' → ' + U.date(r.period.to) + ' (' + U.dec(r.period.days / 252, 1) + ' năm)<br>' + e(v.text) + '</div></div>' + head + warn +
      U.card('chart-line', 'Giá trị 1 đồng đầu tư', curveSvg(r.curve, S.logScale) + '<div class="ins-bar" style="margin:6px 0 0"><label class="lab-check"><input type="checkbox"' + (S.logScale ? ' checked' : '') + ' onchange="labLog(this.checked)"> Thang logarit</label></div><h4 style="margin:14px 0 4px;font-size:.84rem">Sụt giảm từ đỉnh</h4>' + ddSvg(r.curve)) +
      U.card('shield-halved', 'Có đáng tin không?', '<ul class="lab-chks">' + chk + '</ul>') +
      '<div class="ins-grid even">' + U.card('table', 'Chỉ số', U.table(['Chỉ số', 'Chiến lược', 'VN-Index', 'Rổ đều'], [rows], { left: [0] }) + relRows) +
      U.card('dice', 'Rổ ngẫu nhiên', r.random ? histSvg(r.random.hist) + '<p class="tl-hint">' + r.random.runs + ' rổ ngẫu nhiên (cùng vũ trụ, số mã, lịch, chi phí): trung vị ' + U.pct(r.random.cagr.median, 1, true) + '/năm, 90% nằm trong ' + U.pct(r.random.cagr.p05, 1, true) + ' đến ' + U.pct(r.random.cagr.p95, 1, true) + '. Chiến lược: ' + U.pct(m.cagr, 1, true) + '.</p>' : U.empty('dice', 'Không dựng được rổ ngẫu nhiên.')) + '</div>' +
      '<div class="ins-grid even">' + U.card('calendar', 'Từng năm', yearTable) + U.card('sliders', 'Độ nhạy với tham số', sens || U.empty('sliders', 'Không có.')) + '</div>' +
      U.card('list', 'Các kỳ cân bằng gần nhất (24 kỳ)', U.table(['Ngày', 'Số mã', 'Đủ điều kiện', 'Qua bộ lọc', 'Tiền mặt', 'Mã lớn nhất'], [reb], { left: [5] }), '') + lim + save;
  }

  // ---------- lịch sử ----------
  function runsHtml(S) {
    const R = S.runs || {};
    if (R.state === 'loading') return U.card('clock-rotate-left', 'Các lần kiểm thử đã lưu', U.loading('Đang tải…'));
    if (R.state === 'error') return U.card('clock-rotate-left', 'Các lần kiểm thử đã lưu', U.empty('triangle-exclamation', e(R.error)));
    const list = R.list || [];
    const rows = list.map((x) => { const br = x.brief || {}; return '<tr><td class="t"><a class="ins-link" href="' + e(Links.lab('backtest', x.id)) + '" title="Liên kết tới lần kiểm thử này"><b>' + e(x.name) + '</b></a>' + (x.note ? '<br><span class="lab-hint">' + e(x.note) + '</span>' : '') + '</td><td>' + U.date(x.created_at) + '</td><td class="' + U.sign(br.cagr) + '">' + U.pct(br.cagr, 1, true) + '</td><td>' + U.dec(br.sharpe, 2) + '</td><td>' + U.pct(br.maxDD, 1) + '</td><td>' + (br.randomRank !== null && br.randomRank !== undefined ? U.dec(br.randomRank * 100, 0) + '%' : '—') + '</td><td><button class="ins-link" onclick="labOpenRun(\'' + e(x.id) + '\')">Mở lại</button> · <button class="ins-link" onclick="labDelRun(\'' + e(x.id) + '\')">Xoá</button></td></tr>'; }).join('');
    const tr = S.trials || { count: 0 };
    return U.card('clock-rotate-left', 'Các lần kiểm thử đã lưu', (list.length ? U.table(['Tên', 'Ngày', 'CAGR', 'Sharpe', 'Sụt giảm', 'Hơn rổ ngẫu nhiên', ''], [rows], { left: [0, 6] }) : U.empty('clock-rotate-left', 'Chưa lưu lần kiểm thử nào.')) +
      '<p class="tl-hint">Số cấu hình khác nhau bạn đã chạy trên kho dữ liệu này: <b>' + tr.count + '</b>. Con số này dùng để trừ may rủi cho Sharpe: thử càng nhiều, kết quả đẹp nhất càng dễ chỉ là ngẫu nhiên.</p>');
  }

  function backtestHtml(S) {
    return dataBarHtml(S) + builderHtml(S) + '<div id="lab-result">' + resultHtml(S) + '</div>' + runsHtml(S);
  }

  return { dataBarHtml, builderHtml, resultHtml, runsHtml, backtestHtml, curveSvg, ddSvg, histSvg, checks, verdict, toDisplay, fromDisplay, unitLabel, FREQ, WEIGHT };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = LabViews;
