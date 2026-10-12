/* --- FILE: /insight/insight-views-c.js ---
   Màn hình Độ chính xác dự phóng và Kho dữ liệu theo thời điểm: chỉ dựng chuỗi HTML từ kết quả đã tính (lib/forecast-accuracy.js, pit-calc.js). Sự kiện do insight-app.js xử lý. */
const InsViewsC = (function () {
  const U = (typeof require === 'function' && typeof module !== 'undefined') ? require('./insight-util.js') : InsUtil, e = U.esc;
  const FA = (typeof require === 'function' && typeof module !== 'undefined') ? require('../lib/forecast-accuracy.js') : ForecastAccuracy;
  const PC = (typeof require === 'function' && typeof module !== 'undefined') ? require('../lib/pit-calc.js') : PitCalc;

  // Tỷ lệ kèm khoảng tin cậy: "72% (khoảng 52–86%, n=12)"; mẫu nhỏ thì gắn nhãn
  function rate(w) {
    if (!w || w.p === null) return '<span class="ins-muted">—</span>';
    return U.dec(w.p * 100, 0) + '% <span class="ins-muted" style="font-size:.74rem">(' + U.dec(w.lo * 100, 0) + '–' + U.dec(w.hi * 100, 0) + '%, ' + w.k + '/' + w.n + ')</span>' + (w.small ? ' ' + U.tag('mẫu nhỏ', 'warn') : '');
  }
  const biasText = { optimistic: ['Thiên lạc quan', 'bad'], pessimistic: ['Thiên thận trọng', 'warn'], balanced: ['Cân bằng', 'ok'] };
  const biasTag = (b) => (b && biasText[b] ? U.tag(biasText[b][0], biasText[b][1]) : '');

  function valuationsCard(S) {
    const V = S.val, hk = S.hk;
    if (!V.total) return U.card('scale-balanced', 'Giá trị hợp lý đã lưu (Valuation Bench)', U.empty('scale-balanced', 'Chưa có định giá nào được lưu. Mỗi lần bấm <b>Lưu</b> ở hồ sơ cổ phiếu (Valuation Bench) tạo một bản <b>bất biến</b>; sau 3 / 6 / 12 tháng trang này tự đối chiếu với giá thực tế (đã điều chỉnh cổ tức, thưởng) và so với VN-Index.'));
    const seg = '<div class="ins-seg" role="group" aria-label="Kỳ chấm">' + FA.HORIZONS.map((h) => '<button aria-pressed="' + (hk === h.key) + '" onclick="insAcc(\'hk\',\'' + h.key + '\')">' + h.label + '</button>').join('') + '</div>';
    const s = V.summaries[hk];
    let body = '<div class="ins-bar">' + seg + '<span class="ins-muted" style="font-size:.76rem">' + V.total + ' bản đã lưu · ' + V.scorable + ' chấm được · ' + (s ? s.n : 0) + ' đã đủ ' + FA.HORIZONS.find((h) => h.key === hk).label + '</span></div>';
    if (!s || !s.n) body += U.empty('hourglass-half', 'Chưa có bản định giá nào đã đủ ' + FA.HORIZONS.find((h) => h.key === hk).label + ' để chấm. Bản sớm nhất sẽ đủ kỳ vào ' + (V.firstDue ? U.date(V.firstDue[hk]) : '—') + '.');
    else {
      body += U.kpis([
        U.kpi('Hướng đúng (vượt/kém VN-Index như dự báo)', rate(s.direction), 'bỏ qua định giá chênh dưới 2%', s.direction.p !== null && !s.small && s.direction.hi < 0.5 ? 'bad' : ''),
        U.kpi('Giá kỳ này so với giá trị hợp lý (trung vị)', (s.errMedian > 0 ? '+' : '') + U.dec(s.errMedian * 100, 1) + '%', biasTag(s.bias) + ' · lệch tuyệt đối trung vị ' + U.dec(s.absErrMedian * 100, 1) + '%'),
        U.kpi('Nằm trong dải thấp–cao', rate(s.inRange), 'dải giá trị hợp lý đã lưu'),
        U.kpi('Phần chênh lệch đã thu hẹp (trung vị)', s.closedMedian === null ? '—' : U.dec(s.closedMedian * 100, 0) + '%', '100% = giá tới đúng giá trị hợp lý'),
        U.kpi('Tương quan hạng: chênh lệch ban đầu ↔ lợi suất vượt trội', s.rho === null ? '—' : U.dec(s.rho, 2), s.rho === null ? 'cần ít nhất 3 bản' : (s.rho > 0.2 ? 'định giá rẻ → quả có vượt trội' : (s.rho < -0.2 ? 'ngược chiều dự báo' : 'gần như không liên quan')), s.rho !== null && s.rho < 0 ? 'warn' : ''),
      ]);
      if (s.small) body += U.note('<b>Mẫu nhỏ</b> (' + s.n + ' &lt; ' + FA.MIN_N + '): các tỷ lệ ở trên chưa đủ để kết luận mô hình tốt hay xấu — hãy nhìn khoảng tin cậy, không nhìn con số giữa.', 'warn');
      if (V.methods.length) body += '<h4 style="margin:14px 0 6px;font-size:.84rem">Từng phương pháp (giá thực tế so với giá trị của chính phương pháp đó)</h4>' + U.table(['Phương pháp', 'Số bản', 'Lệch trung vị (có dấu)', 'Lệch tuyệt đối trung vị'], [V.methods.map((m) => '<tr><td>' + e(m.name) + (m.small ? ' ' + U.tag('mẫu nhỏ', 'warn') : '') + '</td><td>' + m.n + '</td><td class="' + (m.errMedian > 0 ? 'ins-up' : 'ins-down') + '">' + (m.errMedian > 0 ? '+' : '') + U.dec(m.errMedian * 100, 1) + '%</td><td>' + U.dec(m.absErrMedian * 100, 1) + '%</td></tr>').join('')]);
      if (V.authors.length > 1) body += '<h4 style="margin:14px 0 6px;font-size:.84rem">Theo người lập</h4>' + U.table(['Người lập', 'Số bản', 'Lệch trung vị', 'Hướng đúng'], [V.authors.map((a) => '<tr><td>' + e(a.name) + '</td><td>' + a.n + '</td><td>' + (a.errMedian > 0 ? '+' : '') + U.dec(a.errMedian * 100, 1) + '%</td><td>' + rate(a.direction) + '</td></tr>').join('')]);
    }
    return U.card('scale-balanced', 'Giá trị hợp lý đã lưu (Valuation Bench)', body);
  }

  function outcomesCard(title, icon, O, emptyHtml, calHead, calRows, kind) {
    if (!O.total) return U.card(icon, title, U.empty(icon, emptyHtml));
    const s = O.summary;
    let body = U.kpis([
      U.kpi('Đã chấm / đang chờ', s.n + ' / ' + s.pending, O.total + ' ' + kind + ' tổng cộng'),
      U.kpi('Thành công (so với VN-Index)', rate(s.success), kind === 'quyết định' ? 'mua/giữ: vượt trội; bán/bỏ qua: kém hơn thị trường' : 'ý tưởng mua: vượt trội; ý tưởng tránh: kém hơn thị trường', ''),
      U.kpi('Vượt trội trung vị', s.excessMedian === null ? '—' : (s.excessMedian > 0 ? '+' : '') + U.dec(s.excessMedian * 100, 1) + '%', 'lợi suất ' + (s.retMedian === null ? '—' : (s.retMedian > 0 ? '+' : '') + U.dec(s.retMedian * 100, 1) + '%')),
      U.kpi('Chạm giá mục tiêu', rate(s.hitTarget), 'theo giá đóng cửa'),
      s.hitStop && s.hitStop.n ? U.kpi('Chạm giá cắt lỗ', rate(s.hitStop), 'theo giá đóng cửa') : '',
    ]);
    if (s.small && s.n) body += U.note('<b>Mẫu nhỏ</b> (' + s.n + ' &lt; ' + FA.MIN_N + '): chưa đủ để kết luận.', 'warn');
    if (!s.n) body += U.empty('hourglass-half', 'Chưa có ' + kind + ' nào đã đủ kỳ để chấm.' + (O.firstDue ? ' Sớm nhất: ' + U.date(O.firstDue) + '.' : ''));
    if (calRows && calRows.length) body += '<h4 style="margin:14px 0 6px;font-size:.84rem">' + calHead + '</h4>' + U.table(['Mức', 'Thành công', 'Số mẫu'], [calRows.map((c) => '<tr><td>' + c.level + ' / 5</td><td>' + rate(c) + '</td><td>' + c.n + '</td></tr>').join('')]) + '<p class="tl-hint">Nếu mức cao không thành công nhiều hơn mức thấp, độ tự tin của bạn chưa phản ánh chất lượng thật (tự tin thái quá).</p>';
    return U.card(icon, title, body);
  }

  function earningsCard(S) {
    const E = S.earn, F = S.forecastForm || {};
    const form = '<div class="ins-form">' +
      '<label class="ins-field">Mã<input type="text" id="ins-fc-sym" maxlength="12" value="' + e(F.symbol || '') + '" placeholder="FPT"></label>' +
      '<label class="ins-field">Chỉ tiêu<select id="ins-fc-metric"><option value="lnst">Lợi nhuận sau thuế</option><option value="revenue">Doanh thu</option></select></label>' +
      '<label class="ins-field">Năm<input type="text" inputmode="numeric" id="ins-fc-year" value="' + e(F.year || new Date().getFullYear()) + '"></label>' +
      '<label class="ins-field">Quý (trống = cả năm)<input type="text" inputmode="numeric" id="ins-fc-q" maxlength="1" value="' + e(F.quarter || '') + '" placeholder="1-4"></label>' +
      '<label class="ins-field">Giá trị dự phóng (tỷ đồng)<input type="text" inputmode="decimal" id="ins-fc-val" placeholder="vd 1250"></label>' +
      '<label class="ins-field">Ghi chú<input type="text" id="ins-fc-note" maxlength="200"></label>' +
      '<button class="ins-btn sm" onclick="insForecastAdd()"><i class="fa-solid fa-plus"></i> Ghi dự phóng</button></div>' +
      '<p class="tl-hint">Dự phóng đã ghi <b>không sửa được</b> và ngày ghi do máy chủ đặt — để không thể "dự đoán" sau khi đã biết kết quả. Muốn đổi thì ghi dự phóng mới; bản cũ vẫn được chấm.</p>';
    let table = '';
    if (E.rows.length) {
      const rows = E.rows.map((r) => '<tr><td>' + Links.symHtml(r.symbol, { from: 'insight' }) + ' ' + (r.metric === 'lnst' ? 'LNST' : 'Doanh thu') + ' ' + (r.quarter ? 'Q' + r.quarter + '/' : '') + r.year + '</td><td>' + U.date(r.madeAt) + '</td><td>' + e(r.authorName || '') + '</td><td>' + U.money(r.forecast, 1) + '</td><td>' + (r.matured ? U.money(r.actual, 1) : '<span class="ins-muted">' + (r.noData ? 'chưa lấy được' : 'chưa công bố') + '</span>') + '</td><td class="' + (r.err === null || r.err === undefined ? '' : (r.err > 0 ? 'ins-down' : 'ins-up')) + '">' + (r.matured && r.err !== null ? (r.err > 0 ? '+' : '') + U.dec(r.err * 100, 1) + '%' : '—') + '</td><td>' + (r.canDelete ? '<button class="ins-btn ghost sm danger" title="Xoá" onclick="insForecastDel(\'' + e(r.id) + '\')"><i class="fa-solid fa-trash"></i></button>' : '') + '</td></tr>').join('');
      table = U.table(['Dự phóng', 'Ngày ghi', 'Người lập', 'Dự phóng', 'Thực tế', 'Sai số (+: lạc quan)', ''], [rows], { left: [0] });
    }
    let sum = '';
    if (E.summary && E.summary.n) sum = U.kpis([U.kpi('Đã chấm / đang chờ', E.summary.n + ' / ' + E.summary.pending, ''), U.kpi('Sai số trung vị (có dấu)', (E.summary.errMedian > 0 ? '+' : '') + U.dec(E.summary.errMedian * 100, 1) + '%', biasTag(E.summary.bias)), U.kpi('Lệch tuyệt đối trung vị', U.dec(E.summary.apeMedian * 100, 1) + '%', ''), U.kpi('Trong ±10%', rate(E.summary.within10), '')]) + (E.summary.small ? U.note('<b>Mẫu nhỏ</b> (' + E.summary.n + ' &lt; ' + FA.MIN_N + '): chưa đủ để kết luận.', 'warn') : '');
    return U.card('chart-line', 'Dự phóng lợi nhuận / doanh thu của bạn', sum + form + (table || U.empty('chart-line', 'Chưa có dự phóng nào. Ghi dự phóng lợi nhuận một quý hoặc một năm; khi doanh nghiệp công bố báo cáo, trang tự đối chiếu.')));
  }

  function accuracyHtml(S) {
    if (S.state === 'loading') return U.loading(S.step || 'Đang tải dự phóng đã lưu và giá thực tế…');
    if (S.state === 'error') return U.card('bullseye', 'Độ chính xác dự phóng', U.empty('triangle-exclamation', e(S.error)) + '<div style="text-align:center"><button class="ins-btn sm" onclick="insLoad(\'accuracy\',true)"><i class="fa-solid fa-rotate"></i> Thử lại</button></div>');
    const head = '<div class="ins-bar"><button class="ins-btn ghost sm" onclick="insLoad(\'accuracy\',true)"><i class="fa-solid fa-rotate"></i> Tải lại</button><span class="ins-muted" style="font-size:.76rem">Giá thực tế tới ' + U.date(S.lastDate) + ' · ' + (S.pricedSymbols || 0) + ' mã có giá' + (S.missingPrices && S.missingPrices.length ? ' · thiếu giá: ' + e(S.missingPrices.join(', ')) : '') + '</span></div>';
    const how = U.note('<b>Cách chấm:</b> giá đã điều chỉnh cổ tức tiền, thưởng, chia tách; so với <b>VN-Index cùng kỳ</b> (dự phóng "giá lên" mà cả thị trường lên thì chưa chứng tỏ gì); chỉ chấm khi đã đủ kỳ; tỷ lệ luôn kèm khoảng tin cậy Wilson 95% và nhãn "mẫu nhỏ" dưới ' + FA.MIN_N + ' mẫu. Chạm mục tiêu / cắt lỗ xét theo giá đóng cửa, bỏ qua trượt giá và phí.');
    return head + valuationsCard(S) +
      outcomesCard('Ý tưởng đầu tư', 'lightbulb', S.ideas, 'Chưa có ý tưởng nào. Tạo ý tưởng (kèm giá mục tiêu, cắt lỗ, thời hạn) ở trang Nghiên Cứu → Ý tưởng; khi đóng ý tưởng hoặc hết thời hạn, trang tự chấm.', 'Theo mức tin tưởng bạn gán cho ý tưởng', S.ideas.calibration, 'ý tưởng') +
      outcomesCard('Nhật ký quyết định', 'book', S.decisions, 'Chưa có quyết định nào. Ghi quyết định (mua / bán / giữ / bỏ qua) kèm giá kỳ vọng và thời hạn ở Nhật Ký Quyết Định; hết thời hạn trang tự chấm.', 'Theo mức tự tin bạn gán cho quyết định', S.decisions.calibration, 'quyết định') +
      earningsCard(S) + how;
  }

  // ---------- Kho dữ liệu ----------
  function archiveHtml(S) {
    if (S.state === 'loading') return U.loading('Đang đọc kho dữ liệu…');
    if (S.state === 'error') return U.card('box-archive', 'Kho dữ liệu theo thời điểm', U.empty('triangle-exclamation', e(S.error)) + '<div style="text-align:center"><button class="ins-btn sm" onclick="insLoad(\'archive\',true)"><i class="fa-solid fa-rotate"></i> Thử lại</button></div>');
    const st = S.status, cov = S.cov, rd = S.ready;
    const k = U.kpis([
      U.kpi('Ngày đã chụp', String(cov.days), cov.first ? U.date(cov.first) + ' → ' + U.date(cov.last) : 'chưa có'),
      U.kpi('Số mã mỗi ngày', U.int(cov.avgSymbols), 'thấp nhất ' + U.int(cov.minSymbols)),
      U.kpi('Ngày thiếu', String(cov.missingDays), cov.gaps.length ? cov.gaps.length + ' khoảng hở' : 'không hở', cov.missingDays ? 'warn' : 'good'),
      U.kpi('Báo cáo tài chính đã lưu', U.int(st.fundamentals.count), st.fundamentals.first ? 'từ ' + U.date(st.fundamentals.first) : ''),
      U.kpi('Tin đã lưu', U.int(st.news.count), st.news.first ? 'từ ' + U.date(st.news.first) : ''),
    ]);
    const ready = U.card('hourglass-half', 'Tiến độ tới lúc backtest được', '<div style="display:flex;align-items:center;gap:12px"><div style="flex:1">' + U.meter(rd.pct, rd.ok ? 'good' : '') + '</div><b class="ins-num">' + U.dec(rd.pct * 100, 0) + '%</b></div><p class="tl-hint" style="margin-top:8px">' + (rd.ok ? 'Đã đủ dữ liệu cho một backtest cân bằng lại hằng tháng với ' + rd.periods + ' kỳ.' : 'Cần khoảng ' + rd.need + ' ngày chụp (63 ngày xếp hạng + 12 kỳ cân bằng hằng tháng); hiện có ' + rd.have + '. Kho chỉ tích luỹ được từ ngày bắt đầu chụp nên không bù ngược được — mỗi ngày trì hoãn là mất một ngày dữ liệu.') + '</p>');
    const runs = st.runs.slice(0, 14).map((r) => '<tr><td>' + U.date(r.run_at) + ' ' + String(r.run_at).slice(11, 16) + '</td><td class="t">' + e(r.fn) + ' · ' + e(r.mode) + '</td><td>' + U.tag(r.ok ? 'Thành công' : 'Lỗi', r.ok ? 'ok' : 'bad') + '</td><td class="t">' + e(runSummary(r)) + '</td></tr>').join('');
    const lookup = lookupCard(S);
    return k + '<div class="ins-grid even">' + ready + U.card('clock-rotate-left', 'Lần chạy gần đây', st.runs.length ? U.table(['Lúc', 'Việc', 'Kết quả', 'Chi tiết'], [runs], { left: [1, 3] }) : U.empty('clock-rotate-left', 'Chưa có lần chạy nào.')) + '</div>' + lookup +
      U.note('<b>Kho lưu gì:</b> mỗi ngày làm việc, lúc 19:05 giờ VN, chụp chỉ số của cả thị trường (giá, vốn hoá, P/E, P/B, ROE, tăng trưởng, thanh khoản, sức mạnh giá…) theo ngày của số liệu; mỗi khi báo cáo tài chính một mã đổi thì thêm một dòng kèm ngày LẦN ĐẦU thấy; tin các báo mỗi 3 giờ. Bản chụp đã lưu không bị sửa lại bằng bản kém đầy đủ hơn. Báo cáo tài chính đã có trước khi kho bắt đầu chụp được ghi nhận ngày đầu tiên thấy = ngày bắt đầu, không bịa ngày công bố sớm hơn; khi cần dùng số liệu giai đoạn cũ, dùng hạn công bố bảo thủ (quý +45 ngày, năm +90 ngày). Dung lượng khoảng 50–60 MB mỗi năm.');
  }
  function runSummary(r) {
    const d = r.detail || {};
    if (r.fn === 'pit-capture') return d.reason ? 'Không có ảnh chụp thị trường' : (d.symbols || 0) + ' mã, ngày số liệu ' + U.date(d.as_of) + (d.fundamentals_added ? ' · +' + d.fundamentals_added + ' báo cáo' : '');
    if (r.mode === 'news') return (d.items || 0) + ' tin, ' + (d.tagged || 0) + ' gắn mã, ' + (d.feedsOk || 0) + '/' + (d.feeds || 0) + ' báo';
    if (r.mode === 'ownership') return (d.synced || 0) + ' mã đồng bộ' + (d.failed ? ', ' + d.failed + ' lỗi' : '') + ', ' + (d.trades || 0) + ' giao dịch';
    if (r.mode === 'thesis') return (d.conditions || 0) + ' điều kiện, ' + (d.broken || 0) + ' bị phá vỡ, ' + (d.alerts || 0) + ' cảnh báo';
    return '';
  }
  function lookupCard(S) {
    const L = S.lookup || {};
    const form = '<div class="ins-bar"><label class="ins-field">Ngày<input type="date" id="ins-pit-date" value="' + e(L.date || S.defaultDate || '') + '"></label>' +
      '<label class="ins-field">Mã (tra cứu)<input type="text" id="ins-pit-sym" maxlength="12" value="' + e(L.symbol || '') + '" placeholder="FPT"></label>' +
      '<button class="ins-btn sm" onclick="insPitLookup()"><i class="fa-solid fa-magnifying-glass"></i> Xem như ngày đó</button></div>';
    let out = '';
    if (L.state === 'loading') out = U.loading('Đang đọc bản chụp…');
    else if (L.state === 'error') out = U.note(e(L.error), 'bad');
    else if (L.state === 'ok') {
      if (!L.day) out = U.note('Không có bản chụp nào vào hoặc trước ngày <b>' + U.date(L.date) + '</b>. Kho bắt đầu chụp từ ' + U.date(S.cov.first) + '.', 'warn');
      else {
        const d = L.day, stale = PC.diffDays(L.date, d.asOf);
        const head = U.note('Bản chụp: <b>' + U.date(d.asOf) + '</b>' + (stale > 0 ? ' (cũ hơn ngày hỏi ' + stale + ' ngày' + (stale > 7 ? ' — quá cũ để dùng cho kiểm thử' : '') + ')' : '') + ' · ' + U.int(d.n) + ' mã.', stale > 7 ? 'warn' : '');
        let sym = '';
        if (L.symbol) {
          const m = d.get(L.symbol);
          if (!m) sym = U.note('Mã <b>' + e(L.symbol) + '</b> không có trong bản chụp ngày đó (chưa niêm yết hoặc thiếu số liệu).', 'warn');
          else {
            const P = (v) => (v === null || v === undefined ? '—' : U.pct(v, 1));
            sym = U.kpis([U.kpi('Giá', U.int(m.price), 'đ'), U.kpi('Vốn hoá', U.money(m.marketcap, 1), ''), U.kpi('P/E · P/B', U.dec(m.pe, 1) + ' · ' + U.dec(m.pb, 1), ''), U.kpi('ROE', P(m.roae), 'biên ròng ' + P(m.netMargin)), U.kpi('Tăng trưởng LN / DT', P(m.netProfitGrowthYoY, 0) + ' / ' + P(m.salesGrowthYoY, 0), 'so với cùng kỳ'), U.kpi('Biến động 1T / 3T / 1N', P(m.chg1m) + ' / ' + P(m.chg3m) + ' / ' + P(m.chg1y), ''), U.kpi('GTGD TB 20 phiên', U.money(m.advValue20, 1), ''), U.kpi('Sức mạnh giá / đà', U.dec(m.jdkRs, 0) + ' / ' + U.dec(m.jdkMom, 0), 'thang 0–100')]);
            const f = L.fund && L.fund.length ? PC.fundamentalAsOf(L.fund, L.symbol, L.date) : null;
            sym += f ? U.note('Báo cáo tài chính đã biết vào ngày đó: kỳ <b>' + e(f.quarterKey || ('năm ' + f.annualYear)) + '</b>, thấy lần đầu <b>' + U.date(f.seenAt) + '</b>.') : U.note('Chưa có báo cáo tài chính nào của mã này được ghi nhận vào ngày đó (kho chỉ ghi báo cáo từ lúc bắt đầu chụp).', 'warn');
          }
        }
        out = head + sym + screenHtml(S, d);
      }
    }
    return U.card('magnifying-glass-chart', 'Xem số liệu "như ngày D"', form + out + (L.state ? '' : '<p class="tl-hint">Chọn một ngày và (tuỳ chọn) một mã: trang đọc đúng bản chụp của ngày đó, không phải số liệu đã được cập nhật về sau. Đây là nền để backtest không nhìn trước tương lai.</p>'));
  }
  function screenHtml(S, day) {
    const F = S.screen || { pe: '15', roe: '15', mcap: '1000' };
    const form = '<h4 style="margin:14px 0 6px;font-size:.84rem">Bộ lọc chạy trên số liệu của ngày đó</h4><div class="ins-bar"><label class="ins-field">P/E tối đa<input type="text" id="ins-sc-pe" inputmode="decimal" value="' + e(F.pe) + '" style="width:90px"></label><label class="ins-field">ROE tối thiểu (%)<input type="text" id="ins-sc-roe" inputmode="decimal" value="' + e(F.roe) + '" style="width:90px"></label><label class="ins-field">Vốn hoá tối thiểu (tỷ đồng)<input type="text" id="ins-sc-mcap" inputmode="decimal" value="' + e(F.mcap) + '" style="width:120px"></label><button class="ins-btn ghost sm" onclick="insPitScreen()">Lọc</button></div>';
    if (!S.screenRes) return form;
    const r = S.screenRes;
    return form + '<p class="tl-hint">' + r.total + ' mã thoả điều kiện trong ' + U.int(day.n) + ' mã' + (r.total > r.rows.length ? ' (hiện ' + r.rows.length + ' mã vốn hoá lớn nhất)' : '') + '.</p>' +
      (r.rows.length ? U.table(['Mã', 'Giá', 'Vốn hoá', 'P/E', 'ROE', 'Biến động 3T'], [r.rows.map((x) => '<tr><td>' + Links.symHtml(x.symbol, { from: 'insight' }) + '</td><td>' + U.int(x.m.price) + '</td><td>' + U.money(x.m.marketcap, 1) + '</td><td>' + U.dec(x.m.pe, 1) + '</td><td>' + U.pct(x.m.roae, 1) + '</td><td class="' + U.sign(x.m.chg3m) + '">' + U.pct(x.m.chg3m, 1, true) + '</td></tr>').join('')]) : '');
  }

  return { accuracyHtml, archiveHtml, valuationsCard, outcomesCard, earningsCard, lookupCard, rate, runSummary };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = InsViewsC;
