// Logic thuần của VALUATION BENCH: QUY TRÌNH ĐỊNH GIÁ 7 BƯỚC -- biến "chạy mọi phương pháp rồi lấy trọng số cố định" thành một quy trình có phương pháp rõ ràng và có ghi vết:
//   1. Phân loại mô hình kinh doanh (tự nhận từ số liệu, người dùng chỉnh được)   2. Cổng dữ liệu (đủ dữ liệu để kết luận chưa)
//   3. Kế hoạch phương pháp: mỗi phương pháp có VAI TRÒ (Chính / Hỗ trợ / Đối chiếu / Tham khảo / Loại), trọng số suy ra từ vai trò và lý do   4. Giả định và nguồn gốc
//   5. Chạy và đối chiếu chéo (các phương pháp chính có đồng thuận không)   6. Kiểm tra hợp lý (danh mục kiểm tra có ngưỡng)   7. Kết luận và hồ sơ quyết định (kèm điều chưa giải quyết)
// plan() chạy TRƯỚC khi tổng hợp: cho ra trọng số mặc định theo vai trò; review() chạy SAU khi tổng hợp: đối chiếu, kiểm tra hợp lý, trạng thái kết luận.
// Luật phân loại và bảng vai trò là quy tắc cố định, hiển thị công khai, không phải mô hình hộp đen; ngưỡng là phán đoán thực hành, không phải ước lượng thống kê.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global VBProcess) và module.exports cho Vitest.
const VBProcess = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const FIN = ['BANK', 'SECURITIES', 'INSURANCE'];
  const f = (x, d) => (num(x) === null ? '—' : (Math.round(x * Math.pow(10, d === undefined ? 0 : d)) / Math.pow(10, d === undefined ? 0 : d)).toLocaleString('vi-VN', { minimumFractionDigits: d === undefined ? 0 : d, maximumFractionDigits: d === undefined ? 0 : d }));
  const pc = (x, d) => (num(x) === null ? '—' : f(x * 100, d === undefined ? 1 : d) + '%');

  // Vai trò -> trọng số cơ sở. Chính quyết định kết luận, Hỗ trợ bổ sung, Đối chiếu chỉ kiểm tra chéo (ảnh hưởng nhẹ), Tham khảo chỉ hiển thị, Loại bị tắt có chủ ý.
  const ROLES = {
    core: { label: 'Chính', weight: 2.5, order: 0 }, support: { label: 'Hỗ trợ', weight: 1.2, order: 1 }, check: { label: 'Đối chiếu', weight: 0.5, order: 2 },
    ref: { label: 'Tham khảo', weight: 0, order: 3 }, off: { label: 'Loại', weight: 0, order: 4 },
  };

  const META = {
    dcf: { label: 'DCF dòng tiền doanh nghiệp (FCFF)', lib: 'dcf' }, fcfe: { label: 'FCFE nhiều giai đoạn', lib: 'fcfe' }, ri: { label: 'Thu nhập thặng dư (Residual Income)', lib: 'ri' },
    'justified-pb': { label: 'P/B hợp lý = (ROE − g) / (Ke − g)', lib: 'justified-pb' }, ddm: { label: 'Mô hình cổ tức Gordon', lib: 'ddm' },
    'peer-pe': { label: 'P/E so với ngành', lib: 'peer-multiples' }, 'peer-pb': { label: 'P/B so với ngành', lib: 'peer-multiples' }, 'peer-ps': { label: 'P/S so với ngành', lib: 'peer-multiples' },
    'peer-evEbitda': { label: 'EV/EBITDA so với ngành', lib: 'peer-multiples' }, 'peer-evSales': { label: 'EV/Doanh thu so với ngành', lib: 'peer-multiples' },
    'hist-pe': { label: 'P/E theo lịch sử của chính nó', lib: 'hist-multiples' }, 'hist-pb': { label: 'P/B theo lịch sử của chính nó', lib: 'hist-multiples' },
    epv: { label: 'Giá trị sức sinh lời (EPV)', lib: 'epv' }, graham: { label: 'Số Graham', lib: 'graham' }, grahamGrowth: { label: 'Công thức tăng trưởng của Graham', lib: 'graham' },
    lynch: { label: 'PEG của Lynch', lib: 'peg' }, nav: { label: 'Giá trị tài sản ròng điều chỉnh (NAV)', lib: 'nav' }, sotp: { label: 'Tổng các phần (SOTP)', lib: 'sotp' },
  };
  const list = (core, support, check, ref) => { const o = {}; [[core, 'core'], [support, 'support'], [check, 'check'], [ref, 'ref']].forEach(function (p) { p[0].forEach(function (k) { o[k] = p[1]; }); }); return o; };

  // Mô hình kinh doanh -> vai trò của từng phương pháp. Lý do chung cho mỗi vai trò nằm ở `why`; riêng từng phương pháp có thể có lý do riêng ở `special`.
  const ARCH = {
    MATURE: { label: 'Doanh nghiệp trưởng thành', desc: 'Lợi nhuận và dòng tiền khá ổn định, tăng trưởng vừa phải: dòng tiền chiết khấu cộng bội số ngành là cặp phương pháp chính.',
      roles: list(['dcf', 'peer-evEbitda', 'peer-pe'], ['hist-pe', 'epv'], ['peer-pb', 'hist-pb', 'ddm', 'lynch', 'grahamGrowth'], ['graham', 'peer-ps', 'peer-evSales', 'nav', 'sotp']),
      special: { epv: 'Giá trị không tăng trưởng làm sàn tham chiếu: nếu giá nằm dưới EPV thì thị trường không trả gì cho tăng trưởng.' } },
    GROWTH: { label: 'Doanh nghiệp tăng trưởng cao', desc: 'Doanh thu tăng nhanh: giá trị nằm ở dòng tiền tương lai nên DCF và P/E tương lai là chính; bội số lịch sử và tài sản ít ý nghĩa.',
      roles: list(['dcf', 'peer-pe'], ['peer-evEbitda', 'hist-pe', 'lynch'], ['epv', 'grahamGrowth', 'peer-evSales', 'hist-pb'], ['graham', 'peer-pb', 'peer-ps', 'ddm', 'nav', 'sotp']),
      special: { epv: 'Với doanh nghiệp tăng trưởng, EPV (không tăng trưởng) chỉ là sàn: giá cao hơn nhiều là bình thường.', 'hist-pe': 'Bội số quá khứ thường thấp hơn mức thị trường trả cho tăng trưởng hiện tại: chỉ hỗ trợ.' } },
    CYCLICAL: { label: 'Doanh nghiệp chu kỳ (hàng hoá, vật liệu, năng lượng)', desc: 'Lợi nhuận dao động mạnh theo chu kỳ: dùng lợi nhuận chuẩn hoá (EPV), EV/EBITDA và P/B qua chu kỳ; P/E ở đỉnh chu kỳ nhìn rẻ nhưng là bẫy.',
      roles: list(['epv', 'peer-evEbitda', 'hist-pb'], ['dcf', 'peer-pb'], ['peer-pe', 'hist-pe', 'nav'], ['graham', 'lynch', 'grahamGrowth', 'ddm', 'peer-ps', 'peer-evSales', 'sotp']),
      special: { 'peer-pe': 'P/E của doanh nghiệp chu kỳ thấp nhất đúng lúc lợi nhuận đỉnh: chỉ đối chiếu.', 'hist-pe': 'P/E lịch sử bị méo bởi chu kỳ lợi nhuận: chỉ đối chiếu.', dcf: 'DCF chỉ hợp lý nếu biên lợi nhuận được chuẩn hoá về mức trung bình chu kỳ: hỗ trợ, không phải chính.' } },
    DIVIDEND: { label: 'Doanh nghiệp ổn định, chi trả cổ tức cao', desc: 'Dòng tiền ổn định, trả cổ tức đều: mô hình cổ tức và DCF đáng tin, bội số ngành để đối chiếu.',
      roles: list(['dcf', 'ddm', 'peer-evEbitda'], ['peer-pe', 'hist-pe'], ['epv', 'peer-pb', 'hist-pb', 'grahamGrowth'], ['graham', 'lynch', 'peer-ps', 'peer-evSales', 'nav', 'sotp']), special: {} },
    REAL_ESTATE: { label: 'Bất động sản và phát triển dự án', desc: 'Giá trị nằm ở quỹ đất, dự án và hàng tồn kho; dòng tiền thất thường: NAV (RNAV) và P/B là chính, DCF toàn công ty chỉ đối chiếu.',
      roles: list(['nav', 'peer-pb', 'hist-pb'], ['peer-pe'], ['dcf', 'epv', 'hist-pe'], ['graham', 'lynch', 'grahamGrowth', 'ddm', 'peer-ps', 'peer-evSales', 'peer-evEbitda', 'sotp']),
      special: { nav: 'Cần người dùng nhập điều chỉnh giá trị đất và dự án (tab Định giá > NAV): đây là phương pháp chính của nhóm này.', dcf: 'Dòng tiền bán dự án theo đợt, DCF toàn công ty kém ổn định: chỉ đối chiếu.', 'peer-evEbitda': 'EBITDA của doanh nghiệp bất động sản phụ thuộc thời điểm ghi nhận dự án: không dùng.' } },
    HOLDING: { label: 'Công ty mẹ / tập đoàn đầu tư nhiều mảng', desc: 'Tài sản đầu tư dài hạn lớn: tổng các phần (SOTP) và NAV phản ánh đúng hơn bội số hợp nhất.',
      roles: list(['sotp', 'nav'], ['peer-pb', 'hist-pb'], ['dcf', 'peer-pe', 'epv'], ['graham', 'lynch', 'grahamGrowth', 'ddm', 'hist-pe', 'peer-ps', 'peer-evSales', 'peer-evEbitda']),
      special: { sotp: 'Cần người dùng nhập từng mảng và bội số (tab Định giá > SOTP): đây là phương pháp chính của nhóm này.' } },
    TURNAROUND: { label: 'Đang lỗ hoặc lợi nhuận quanh 0 (phục hồi)', desc: 'P/E và EPV không có nghĩa khi lợi nhuận không dương: dùng bội số doanh thu, giá trị sổ sách và kịch bản; kết luận kém chắc chắn.',
      roles: list(['peer-evSales', 'peer-ps', 'peer-pb'], ['nav', 'hist-pb'], ['dcf'], ['peer-pe', 'hist-pe', 'epv', 'graham', 'grahamGrowth', 'lynch', 'ddm', 'peer-evEbitda', 'sotp']),
      special: { dcf: 'Dòng tiền hiện tại âm hoặc quanh 0, giả định biên phục hồi rất chủ quan: chỉ đối chiếu theo kịch bản.', 'peer-pe': 'Lợi nhuận không dương: P/E không có nghĩa.' } },
    BANK: { label: 'Ngân hàng', desc: 'Nợ là nguyên liệu kinh doanh nên không dùng dòng tiền doanh nghiệp: dùng thu nhập thặng dư, P/B hợp lý và P/B so với ngành.',
      roles: list(['ri', 'justified-pb', 'peer-pb'], ['hist-pb', 'fcfe', 'peer-pe', 'hist-pe', 'ddm'], ['graham'], ['dcf', 'nav']), special: { dcf: 'Không áp dụng cho tổ chức tài chính.', 'hist-pb': 'P/B lịch sử của chính ngân hàng bị méo khi mặt bằng định giá ngành đã đổi: chỉ hỗ trợ.' } },
    SECURITIES: { label: 'Công ty chứng khoán', desc: 'Lợi nhuận theo chu kỳ thị trường, vốn chủ là tài sản kinh doanh: P/B và thu nhập thặng dư là chính.',
      roles: list(['ri', 'justified-pb', 'peer-pb'], ['hist-pb', 'peer-pe', 'hist-pe', 'fcfe'], ['ddm', 'graham'], ['dcf', 'nav']), special: { dcf: 'Không áp dụng cho tổ chức tài chính.' } },
    INSURANCE: { label: 'Bảo hiểm', desc: 'Dự phòng nghiệp vụ và danh mục đầu tư chi phối giá trị: P/B, thu nhập thặng dư là chính.',
      roles: list(['ri', 'justified-pb', 'peer-pb'], ['hist-pb', 'peer-pe', 'hist-pe', 'fcfe'], ['ddm', 'graham'], ['dcf', 'nav']), special: { dcf: 'Không áp dụng cho tổ chức tài chính.' } },
  };
  const WHY = {
    core: 'Phương pháp chính của mô hình kinh doanh này: quyết định giá trị đồng thuận.', support: 'Hỗ trợ: bổ sung góc nhìn nhưng không quyết định.',
    check: 'Đối chiếu: chỉ kiểm tra chéo, ảnh hưởng nhẹ tới giá trị đồng thuận.', ref: 'Tham khảo: hiển thị để so sánh, không tính vào giá trị đồng thuận.', off: 'Bị loại có chủ ý.',
  };
  const CYCLICAL_SECTORS = ['0500', '1300', '1700', '2300'];
  const PEAK_ARCH = ['CYCLICAL', 'MATURE', 'DIVIDEND'];      // chỉ nhóm lợi nhuận không có xu hướng tăng dài hạn mới coi lợi nhuận vượt xa bình quân là dấu hiệu đỉnh

  // ---------- Bước 1: phân loại ----------
  function avg(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; }
  function stdev(a) { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1)); }

  function signals(res, opts) {
    const P = (res && res.periods) || [], last = P.length ? P[P.length - 1] : {}, basis = (res && res.ttm) || last;
    const ni = P.slice(-6).map(function (p) { return num(p.netIncome); }).filter(function (v) { return v !== null; });
    const m = avg(ni), sd = stdev(ni), cvNI = ni.length >= 4 && m !== null && Math.abs(m) > 0 ? sd / Math.abs(m) : null;
    const prevNi = ni.slice(0, -1).slice(-4), prevMean = avg(prevNi);
    const curNi = num(basis.netIncome), eps = res && res.multiples ? num(res.multiples.eps) : null;
    const assets = num(last.totalAssets);
    const growth = res && res.fundamental ? res.fundamental.growth : {};
    return {
      form: res ? res.form : null, sector: opts && opts.sectorCode ? String(opts.sectorCode) : null,
      revCagr3: growth ? num(growth.revenue3y) : null, cvNI: cvNI, years: P.length,
      loss: (curNi !== null && curNi <= 0) || (eps !== null && eps <= 0),
      inventoryShare: assets > 0 && num(last.inventory) !== null ? last.inventory / assets : null,
      investShare: assets > 0 && num(last.ltInvest) !== null ? last.ltInvest / assets : null,
      payout: num(last.netIncome) > 0 && num(last.divPaid) !== null ? last.divPaid / last.netIncome : null,
      peak: curNi > 0 && prevMean > 0 ? curNi / prevMean : null, roe: res && res.dupont ? num(res.dupont.roe) : null,
    };
  }

  function classify(res, opts) {
    const o = opts || {}, s = signals(res, o), why = [];
    let key = 'MATURE';
    if (FIN.indexOf(s.form) !== -1) { key = s.form; why.push('Báo cáo tài chính theo mẫu ' + { BANK: 'ngân hàng', SECURITIES: 'công ty chứng khoán', INSURANCE: 'bảo hiểm' }[s.form] + '.'); }
    else if (s.loss) { key = 'TURNAROUND'; why.push('Lợi nhuận sau thuế (TTM hoặc năm gần nhất) không dương: P/E và EPV không có nghĩa.'); }
    else if (s.investShare !== null && s.investShare >= 0.35 || (o.hasSotp && !(s.sector === '8600'))) { key = 'HOLDING'; why.push(o.hasSotp && !(s.investShare >= 0.35) ? 'Đã nhập các mảng SOTP.' : 'Đầu tư dài hạn chiếm ' + pc(s.investShare, 0) + ' tổng tài sản (ngưỡng 35%).'); }
    else if (s.sector === '8600' || (s.inventoryShare !== null && s.inventoryShare >= 0.35)) { key = 'REAL_ESTATE'; why.push(s.sector === '8600' ? 'Thuộc ngành Bất động sản (ICB 8600).' : 'Hàng tồn kho chiếm ' + pc(s.inventoryShare, 0) + ' tổng tài sản (ngưỡng 35%).'); }
    else if (CYCLICAL_SECTORS.indexOf(s.sector) !== -1 || (s.cvNI !== null && s.cvNI >= 0.6)) { key = 'CYCLICAL'; why.push(CYCLICAL_SECTORS.indexOf(s.sector) !== -1 ? 'Thuộc nhóm ngành chu kỳ (dầu khí, hoá chất, tài nguyên, xây dựng và vật liệu).' : 'Lợi nhuận dao động mạnh: hệ số biến thiên ' + f(s.cvNI, 2) + ' (ngưỡng 0,6).'); }
    else if (s.sector === '7500' || (s.payout !== null && s.payout >= 0.4 && s.revCagr3 !== null && s.revCagr3 <= 0.1 && (s.cvNI === null || s.cvNI <= 0.35))) { key = 'DIVIDEND'; why.push(s.sector === '7500' ? 'Thuộc ngành Tiện ích (ICB 7500).' : 'Chi trả cổ tức tiền mặt ' + pc(s.payout, 0) + ' lợi nhuận, tăng trưởng doanh thu vừa phải (' + pc(s.revCagr3, 1) + '/năm) và lợi nhuận ổn định.'); }
    else if (s.revCagr3 !== null && s.revCagr3 >= 0.15) { key = 'GROWTH'; why.push('Doanh thu tăng ' + pc(s.revCagr3, 1) + '/năm trong 3 năm (ngưỡng 15%).'); }
    else why.push('Không rơi vào nhóm đặc thù nào: coi là doanh nghiệp trưởng thành.');
    const auto = key, ov = o.override && o.override.archetype;
    let source = 'auto';
    if (ov && ARCH[ov] && ov !== auto) { key = ov; source = 'user'; why.unshift('Người dùng chọn lại mô hình (tự nhận: ' + ARCH[auto].label + ').'); }
    return { key: key, label: ARCH[key].label, desc: ARCH[key].desc, why: why, source: source, auto: auto, autoLabel: ARCH[auto].label, signals: s };
  }

  // ---------- Bước 2: cổng dữ liệu ----------
  function gate(res, opts) {
    const o = opts || {}, items = [], now = o.now instanceof Date ? o.now : new Date();
    const add = function (key, label, level, detail) { items.push({ key: key, label: label, level: level, detail: detail }); };
    const P = (res && res.periods) || [], isFin = FIN.indexOf(res && res.form) !== -1;
    add('years', 'Số năm báo cáo', P.length >= 5 ? 'pass' : (P.length >= 3 ? 'warn' : 'fail'), P.length + ' năm báo cáo' + (P.length < 3 ? ': quá ngắn để ước lượng tăng trưởng và biên.' : (P.length < 5 ? ': đủ dùng nhưng nên có từ 5 năm.' : '.')));
    add('price', 'Giá và số cổ phiếu', res && res.price > 0 && res.shares > 0 ? 'pass' : 'fail', res && res.price > 0 && res.shares > 0 ? 'Giá ' + f(res.price) + ' đ, ' + f(res.shares / 1e6, 1) + ' triệu cổ phiếu.' : 'Thiếu giá hoặc số cổ phiếu: không tính được giá trị mỗi cổ phiếu.');
    if (!isFin) add('ttm', 'Số liệu 4 quý gần nhất (TTM)', res && res.ttm ? 'pass' : 'warn', res && res.ttm ? 'Có đủ 4 quý liên tiếp, đến ' + res.ttm.date + '.' : 'Chưa đủ 4 quý liên tiếp: dùng báo cáo năm, có thể lỗi thời.');
    const lastDate = P.length ? P[P.length - 1].date : null, ageM = lastDate ? (now.getTime() - Date.parse(lastDate)) / (30.44 * 86400000) : null;
    add('fresh', 'Độ mới của báo cáo năm', ageM === null ? 'fail' : (ageM <= 15 ? 'pass' : 'warn'), lastDate ? 'Báo cáo năm gần nhất ' + lastDate + ' (' + f(ageM, 0) + ' tháng trước)' + (ageM > 15 ? ': có thể thiếu báo cáo mới.' : '.') : 'Không có báo cáo năm.');
    const candles = res && res.technical && res.technical.ok;
    add('candles', 'Lịch sử giá', candles ? 'pass' : 'warn', candles ? 'Đủ nến ngày để phân tích kỹ thuật.' : 'Thiếu lịch sử giá: phần kỹ thuật và giá hiện tại có thể không đáng tin.');
    const hist = (res && res.bandPE && res.bandPE.n) || (res && res.bandPB && res.bandPB.n) || 0;
    add('history', 'Lịch sử bội số của chính cổ phiếu', hist >= 750 ? 'pass' : (hist >= 250 ? 'warn' : 'warn'), hist ? hist + ' phiên' + (hist < 750 ? ' (nên từ 3 năm ≈ 750 phiên): dải lịch sử kém ổn định.' : '.') : 'Chưa có chuỗi bội số lịch sử: bỏ phương pháp bội số lịch sử.');
    const st = o.peerStats && o.peerStats.pe ? num(o.peerStats.pe.n) : null;
    add('peers', 'Số mã cùng ngành để so sánh', st >= 10 ? 'pass' : 'warn', st ? st + ' mã' + (st < 10 ? ' (nên từ 10): trung vị ngành kém ổn định.' : '.') : 'Chưa có thống kê ngành: bỏ các phương pháp so sánh ngành.');
    const status = items.some(function (x) { return x.level === 'fail'; }) ? 'blocked' : (items.some(function (x) { return x.level === 'warn'; }) ? 'limited' : 'ok');
    return { status: status, label: { ok: 'Đủ dữ liệu', limited: 'Đủ dùng, có hạn chế', blocked: 'Thiếu dữ liệu then chốt' }[status], items: items };
  }

  // ---------- Bước 3: kế hoạch phương pháp ----------
  function missingReason(key, res, opts) {
    const isFin = FIN.indexOf(res && res.form) !== -1, eps = res && res.multiples ? num(res.multiples.eps) : null, o = opts || {};
    if (key === 'dcf') {
      if (isFin) return 'Không áp dụng cho tổ chức tài chính: dùng thu nhập thặng dư và P/B hợp lý.';
      if (!res || !res.dcfAssumptions) return 'Thiếu dữ liệu để dựng giả định DCF (cần doanh thu, EBIT, khấu hao nhiều năm).';
      return (res.dcf && res.dcf.reason) || 'Giả định hiện tại không cho giá trị hợp lệ (WACC phải lớn hơn tăng trưởng dài hạn).';
    }
    if (key.indexOf('peer-') === 0) {
      if ((key === 'peer-pe' || key === 'peer-evEbitda') && eps !== null && eps <= 0) return 'Lợi nhuận không dương: bội số này không có nghĩa.';
      if (isFin && ['peer-evEbitda', 'peer-evSales', 'peer-ps'].indexOf(key) !== -1) return 'Không áp dụng cho tổ chức tài chính.';
      return 'Thống kê ngành chưa đủ (cần từ 5 mã hợp lệ cho bội số này).';
    }
    if (key.indexOf('hist-') === 0) return eps !== null && eps <= 0 && key === 'hist-pe' ? 'Lợi nhuận không dương: P/E lịch sử không có nghĩa.' : 'Chưa đủ lịch sử bội số (cần từ 60 phiên có giá trị).';
    if (key === 'nav') return 'Cần nhập điều chỉnh tài sản (đánh giá lại đất, dự án, khoản đầu tư) ở tab Định giá > NAV.';
    if (key === 'sotp') return 'Cần nhập các mảng kinh doanh và bội số ở tab Định giá > SOTP.';
    if (key === 'epv') return 'Cần biên EBIT hoạt động dương trong các năm gần nhất.';
    if (key === 'ddm') return 'Không có cổ tức tiền mặt để định giá.';
    if (['ri', 'justified-pb', 'fcfe'].indexOf(key) !== -1) return 'Cần ROE, chi phí vốn chủ và giá trị sổ sách hợp lệ.';
    return o.generic || 'Không đủ dữ liệu cho phương pháp này.';
  }

  function eligibility(m, res, opts, archKey) {
    const key = m.key;
    if (key === 'dcf' && res.dcf && res.dcf.ok) {
      const P = (res.periods || []).slice(-3), neg = P.filter(function (p) { return num(p.fcf) !== null && p.fcf < 0; }).length;
      if (num(res.dcf.tvSharePct) !== null && res.dcf.tvSharePct > 75) return { status: 'limited', reason: 'Giá trị cuối kỳ chiếm ' + f(res.dcf.tvSharePct, 0) + '% giá trị DCF (>75%): kết quả phụ thuộc giả định dài hạn.' };
      if (neg >= 2) return { status: 'limited', reason: 'Dòng tiền tự do âm ' + neg + '/3 năm gần nhất: DCF dựa nhiều vào kỳ vọng phục hồi.' };
    }
    if (key.indexOf('peer-') === 0 && num(m.n) !== null && m.n < 10) return { status: 'limited', reason: 'Chỉ ' + m.n + ' mã cùng ngành (<10): trung vị kém ổn định.' };
    if (key.indexOf('hist-') === 0) { const b = key === 'hist-pe' ? res.bandPE : res.bandPB; if (b && b.n < 750) return { status: 'limited', reason: 'Lịch sử ngắn (' + b.n + ' phiên < 3 năm).' }; }
    if (num(m.weightFactor) !== null && m.weightFactor < 1) return { status: 'limited', reason: m.weightFactor === 0 ? 'Cổ tức tiền mặt quá thấp so với lợi nhuận: chỉ hiển thị.' : 'Cổ tức tiền mặt thấp so với lợi nhuận: giảm trọng số.' };
    const sg = signals(res, opts);
    if ((key === 'peer-pe' || key === 'hist-pe') && PEAK_ARCH.indexOf(archKey) !== -1 && sg.peak !== null && sg.peak > 1.4) return { status: 'limited', reason: 'Lợi nhuận hiện tại gấp ' + f(sg.peak, 1) + ' lần bình quân các năm trước: P/E thấp có thể chỉ là lợi nhuận đỉnh.' };
    return { status: 'ok', reason: '' };
  }

  function plan(res, methods, opts) {
    const o = opts || {}, ov = o.override || {}, ovRoles = ov.roles || {}, ovWhy = ov.reasons || {};
    const arch = classify(res, o), table = ARCH[arch.key];
    const rows = [], seen = {};
    (methods || []).forEach(function (m) {
      if (!m || !(num(m.base) > 0)) return;
      const key = m.key, defRole = table.roles[key] || (key.indexOf('peer-') === 0 || key.indexOf('hist-') === 0 ? 'check' : 'ref');
      const role = ROLES[ovRoles[key]] ? ovRoles[key] : defRole, el = eligibility(m, res, o, arch.key), meta = META[key] || { label: m.label || key, lib: null };
      const wf = num(m.weightFactor) !== null ? Math.max(0, Math.min(1, m.weightFactor)) : 1;
      const weight = ROLES[role].weight * (el.status === 'limited' && num(m.weightFactor) === null ? 0.5 : 1) * wf;
      const why = (role === defRole ? (table.special[key] || WHY[role]) : 'Người dùng đổi vai trò từ "' + ROLES[defRole].label + '" sang "' + ROLES[role].label + '".') + (ovWhy[key] ? ' Lý do: ' + ovWhy[key] : '');
      rows.push({ key: key, label: m.label || meta.label, lib: meta.lib, role: role, defaultRole: defRole, roleLabel: ROLES[role].label, computed: true, status: el.status, limit: el.reason, why: why, weight: weight, base: m.base, group: m.group, user: role !== defRole });
      seen[key] = true;
    });
    const gaps = [];
    Object.keys(table.roles).forEach(function (key) {
      if (seen[key]) return;
      const defRole = table.roles[key], role = ROLES[ovRoles[key]] ? ovRoles[key] : defRole, meta = META[key] || { label: key, lib: null };
      if (role === 'ref' || role === 'off') return;      // phương pháp tham khảo/loại mà không tính được thì không cần liệt kê
      const reason = missingReason(key, res, o);
      rows.push({ key: key, label: meta.label, lib: meta.lib, role: role, defaultRole: defRole, roleLabel: ROLES[role].label, computed: false, status: 'na', limit: reason, why: table.special[key] || WHY[defRole], weight: 0, base: null, group: null, user: role !== defRole });
      if (role === 'core' || role === 'support') gaps.push({ key: key, label: meta.label, role: role, reason: reason });
    });
    rows.sort(function (a, b) { return ROLES[a.role].order - ROLES[b.role].order || b.weight - a.weight || (a.label < b.label ? -1 : 1); });
    const weights = {}; rows.forEach(function (r) { if (r.computed) weights[r.key] = r.weight; });
    const coreActive = rows.filter(function (r) { return r.computed && r.role === 'core' && r.weight > 0; }).length;
    return { archetype: arch, gate: gate(res, o), rows: rows, weights: weights, gaps: gaps, coreActive: coreActive, ack: ov.ack || '' };
  }

  // ---------- Bước 5-7: đối chiếu, kiểm tra hợp lý, kết luận ----------
  function wMedian(items) {
    const a = items.filter(function (x) { return x.v > 0 && x.w > 0; }).sort(function (x, y) { return x.v - y.v; });
    if (!a.length) return null;
    const tot = a.reduce(function (s, x) { return s + x.w; }, 0); let acc = 0;
    for (let i = 0; i < a.length; i++) { acc += a[i].w; if (acc >= tot / 2) return a[i].v; }
    return a[a.length - 1].v;
  }

  function triangulate(synth, pl) {
    const byKey = {}; pl.rows.forEach(function (r) { byKey[r.key] = r; });
    const act = (synth.methods || []).filter(function (m) { return m.weight > 0; });
    const core = act.filter(function (m) { return byKey[m.key] && byKey[m.key].role === 'core'; });
    const ranked = core.map(function (m) { return { key: m.key, label: m.label, base: m.base }; }).sort(function (a, b) { return a.base - b.base; });
    let used = ranked, dropped = null, spread = null, verdict = { key: 'few', label: 'Chưa đủ phương pháp chính để đối chiếu', tone: 'warn' };
    if (ranked.length >= 4) {      // bỏ phương pháp lệch xa trung vị nhất để một phương pháp lạc điệu không che sự đồng thuận của số còn lại
      const mid = (ranked[Math.floor((ranked.length - 1) / 2)].base + ranked[Math.ceil((ranked.length - 1) / 2)].base) / 2;
      let worst = ranked[0]; ranked.forEach(function (x) { if (Math.abs(x.base - mid) > Math.abs(worst.base - mid)) worst = x; });
      dropped = worst; used = ranked.filter(function (x) { return x !== worst; });
    }
    if (used.length >= 2) {
      const vals = used.map(function (x) { return x.base; }), med = (vals[Math.floor((vals.length - 1) / 2)] + vals[Math.ceil((vals.length - 1) / 2)]) / 2;
      spread = (vals[vals.length - 1] - vals[0]) / med;
      verdict = spread <= 0.25 ? { key: 'agree', label: 'Các phương pháp chính đồng thuận', tone: 'ok' } : (spread <= 0.5 ? { key: 'moderate', label: 'Các phương pháp chính lệch vừa', tone: 'mute' } : { key: 'disagree', label: 'Các phương pháp chính bất đồng', tone: 'warn' });
    }
    const intr = wMedian(act.filter(function (m) { return m.group === 'intrinsic' || m.group === 'asset' || m.group === 'income'; }).map(function (m) { return { v: m.base, w: m.weight }; }));
    const rel = wMedian(act.filter(function (m) { return m.group === 'relative'; }).map(function (m) { return { v: m.base, w: m.weight }; }));
    let groupNote = null;
    if (intr && rel) {
      const r = intr / rel;
      if (r > 1.25) groupNote = 'Giá trị nội tại (' + f(intr) + ' đ) cao hơn giá trị theo bội số ngành (' + f(rel) + ' đ) ' + f((r - 1) * 100, 0) + '%: ngành đang được định giá thấp hơn kỳ vọng dòng tiền của mã này, hoặc giả định tăng trưởng/biên của DCF đang lạc quan. Soát giả định ở bước 4.';
      else if (r < 0.8) groupNote = 'Giá trị nội tại (' + f(intr) + ' đ) thấp hơn giá trị theo bội số ngành (' + f(rel) + ' đ) ' + f((1 - r) * 100, 0) + '%: thị trường trả giá cao hơn dòng tiền hiện tại cho ngành này, hoặc giả định DCF đang thận trọng. Soát giả định ở bước 4.';
      else groupNote = 'Giá trị nội tại (' + f(intr) + ' đ) và giá trị theo bội số ngành (' + f(rel) + ' đ) gần nhau: hai cách nhìn độc lập cùng dẫn tới một vùng giá.';
    }
    const outliers = act.filter(function (m) { return m.outlier; }).map(function (m) { return { key: m.key, label: m.label, base: m.base, role: byKey[m.key] ? byKey[m.key].role : null }; });
    return { coreCount: core.length, coreLow: used.length ? used[0] : null, coreHigh: used.length ? used[used.length - 1] : null, dropped: dropped, spread: spread, verdict: verdict, intrinsic: intr, relative: rel, groupNote: groupNote, outliers: outliers, consensus: synth.fair ? synth.fair.base : null };
  }

  function checks(res, synth, pl, tri, opts) {
    const o = opts || {}, out = [], a = res.dcfAssumptions, P = res.periods || [];
    const add = function (key, label, level, value, detail, fix) { out.push({ key: key, label: label, level: level, value: value, detail: detail, fix: fix || null }); };
    if (res.dcf && res.dcf.ok && a) {
      const tv = num(res.dcf.tvSharePct);
      if (tv !== null) add('dcf-tv', 'Giá trị cuối kỳ trong DCF', tv <= 70 ? 'pass' : (tv <= 85 ? 'warn' : 'fail'), f(tv, 0) + '%', 'Phần giá trị DCF đến từ sau năm dự báo cuối. Ngưỡng: ≤70% tốt, >85% là phụ thuộc gần hết vào giả định dài hạn.', { tab: 'valuation', hint: 'Giảm tăng trưởng dài hạn hoặc kéo dài giai đoạn dự báo.' });
      const rf = num(a.rf), gT = num(a.gTerminal);
      if (gT !== null) add('dcf-g', 'Tăng trưởng dài hạn', gT <= Math.min(rf === null ? 0.05 : rf, 0.05) + 1e-9 ? 'pass' : 'warn', pc(gT, 1), 'Không nên vượt lãi suất phi rủi ro (' + pc(rf, 1) + ') và 5%: doanh nghiệp không thể tăng nhanh hơn nền kinh tế mãi mãi.', { tab: 'valuation', hint: 'Giảm tăng trưởng dài hạn.' });
      if (num(a.wacc) !== null) add('dcf-wacc', 'WACC', a.wacc >= 0.08 && a.wacc <= 0.16 ? 'pass' : 'warn', pc(a.wacc, 1), 'Khoảng thường gặp ở Việt Nam 8%-16%; ngoài khoảng này cần có lý do (beta, đòn bẩy bất thường).', { tab: 'valuation', hint: 'Soát beta, phần bù rủi ro, chi phí vay.' });
      const cagr = res.fundamental && res.fundamental.growth ? num(res.fundamental.growth.revenue3y) : null;
      if (cagr !== null && num(a.g1) !== null) add('dcf-g1', 'Tăng trưởng giai đoạn đầu so với lịch sử', a.g1 <= Math.max(cagr, 0.08) + 0.05 ? 'pass' : 'warn', pc(a.g1, 1) + ' so với ' + pc(cagr, 1) + ' (CAGR doanh thu 3 năm)', 'Giả định tăng nhanh hơn lịch sử quá 5 điểm % cần luận điểm cụ thể (mở rộng công suất, hợp đồng).', { tab: 'valuation', hint: 'Giảm tăng trưởng giai đoạn đầu hoặc ghi luận điểm.' });
      const ms = P.slice(-5).map(function (p) { return num(p.revenue) > 0 && num(p.ebit) !== null ? p.ebit / p.revenue : null; }).filter(function (v) { return v !== null; });
      const mt = num(a.marginTarget);
      if (ms.length >= 3 && mt !== null) { const hi = Math.max.apply(null, ms), lo = Math.min.apply(null, ms); add('dcf-margin', 'Biên EBIT mục tiêu so với lịch sử', mt <= hi + 0.03 && mt >= lo - 0.03 ? 'pass' : 'warn', pc(mt, 1) + ' so với khoảng ' + pc(lo, 1) + ' – ' + pc(hi, 1), 'Biên mục tiêu nằm ngoài khoảng đã đạt trong ' + ms.length + ' năm gần nhất cộng/trừ 3 điểm % là giả định chưa có tiền lệ.', { tab: 'valuation', hint: 'Đưa biên mục tiêu về trong khoảng lịch sử.' }); }
      const ev = num(res.dcf.ev), ebitda = res.ttm && num(res.ttm.ebitda) > 0 ? res.ttm.ebitda : (P.length && num(P[P.length - 1].ebitda) > 0 ? P[P.length - 1].ebitda : null), st = o.peerStats && o.peerStats.evEbitda;
      if (ev > 0 && ebitda && st && num(st.median) > 0 && num(st.n) >= 5) { const imp = ev / ebitda, r = imp / st.median; add('dcf-evebitda', 'EV/EBITDA ngầm định của DCF so với ngành', r >= 0.6 && r <= 1.6 ? 'pass' : 'warn', f(imp, 1) + 'x so với trung vị ngành ' + f(st.median, 1) + 'x', 'DCF cho EV/EBITDA thấp hơn 60% hoặc cao hơn 160% trung vị ngành là dấu hiệu giả định tăng trưởng/biên khác thường: cần luận điểm vì sao mã này xứng đáng khác ngành.', { tab: 'valuation', hint: 'Soát lại các giả định DCF hoặc nêu rõ vì sao mã này khác ngành.' }); }
    }
    const eps = res.multiples ? num(res.multiples.eps) : null, pe = o.peerStats && o.peerStats.pe;
    if (eps > 0 && synth.fair && pe && Array.isArray(pe.q) && pe.q.length >= 11 && num(pe.n) >= 5) {
      const fp = synth.fair.base / eps, p10 = pe.q[1], p90 = pe.q[9];
      add('fair-pe', 'P/E ngầm định của giá trị đồng thuận', fp >= p10 && fp <= p90 ? 'pass' : 'warn', f(fp, 1) + 'x so với khoảng ngành ' + f(p10, 1) + 'x – ' + f(p90, 1) + 'x (phân vị 10-90)', 'Giá trị đồng thuận ứng với P/E ở rìa phân bố ngành: cần giải thích (tăng trưởng vượt trội, hoặc lợi nhuận bất thường).');
    }
    if (res.implied && a && num(res.implied.impliedGrowthStage1) !== null && num(a.g1) !== null) {
      const d = res.implied.impliedGrowthStage1 - a.g1;
      add('reverse-dcf', 'Kỳ vọng thị trường (DCF ngược)', 'info', pc(res.implied.impliedGrowthStage1, 1) + ' so với giả định ' + pc(a.g1, 1), d > 0.05 ? 'Giá hiện tại đã tính trước tăng trưởng cao hơn giả định của bạn ' + f(d * 100, 1) + ' điểm %: muốn mua phải tin tăng trưởng vượt kỳ vọng của chính bạn.' : (d < -0.05 ? 'Giá hiện tại ngầm định tăng trưởng thấp hơn giả định của bạn ' + f(-d * 100, 1) + ' điểm %: thị trường bi quan hơn bạn; cần biết vì sao.' : 'Kỳ vọng của thị trường gần với giả định của bạn.'));
    }
    const q = res.quality || {};
    if (q.altman && q.altman.zone2) add('altman', 'Altman Z" (nguy cơ tài chính)', q.altman.zone2.key === 'distress' ? 'fail' : (q.altman.zone2.key === 'grey' ? 'warn' : 'pass'), q.altman.zone2.label, 'Vùng nguy cơ làm các phương pháp dựa vào dòng tiền tương lai kém đáng tin.');
    if (q.beneish && q.beneish.flag) add('beneish', 'Beneish M-score (nguy cơ điều chỉnh lợi nhuận)', q.beneish.flag.key === 'risk' ? 'warn' : 'pass', q.beneish.flag.label, 'Vượt ngưỡng −1,78 là dấu hiệu cần soát chất lượng lợi nhuận trước khi tin vào P/E và DCF.');
    if (q.piotroski && q.piotroski.grade) add('piotroski', 'Piotroski F-score', q.piotroski.grade.key === 'weak' ? 'warn' : 'pass', q.piotroski.score + '/' + q.piotroski.available + ' (' + q.piotroski.grade.label + ')', 'Điểm yếu cho thấy xu hướng sinh lời và đòn bẩy đang xấu đi.');
    const sg = pl.archetype.signals;
    if (PEAK_ARCH.indexOf(pl.archetype.key) !== -1 && sg.peak !== null && sg.peak > 1.8) add('peak-earnings', 'Lợi nhuận hiện tại so với bình quân các năm trước', 'warn', f(sg.peak, 1) + ' lần', 'Lợi nhuận gấp quá 1,8 lần bình quân dễ là đỉnh chu kỳ hoặc khoản bất thường: bội số rẻ có thể là bẫy.');
    if (synth.fair && num(synth.price) > 0 && synth.fair.base > 0) {
      const r = synth.price / synth.fair.base;
      add('price-gap', 'Giá thị trường so với giá trị đồng thuận', r > 1.8 || r < 0.5 ? 'warn' : 'pass', f(r * 100, 0) + '% (giá ' + f(synth.price) + ' so với ' + f(synth.fair.base) + ' đ)', 'Giá lệch quá xa giá trị ước tính (ngoài 50%-180%) thường nghĩa là mô hình đang bỏ sót điều thị trường biết (tài sản ngoài bảng, cổ đông chiến lược, rủi ro chưa vào số liệu) hoặc số liệu đầu vào sai. Soát trước khi tin kết luận.', { tab: 'fundamental', hint: 'Đối chiếu số liệu và tìm yếu tố chưa được mô hình tính tới.' });
    }
    add('triangulation', 'Các phương pháp chính có đồng thuận không', tri.verdict.key === 'agree' ? 'pass' : (tri.verdict.key === 'moderate' ? 'warn' : 'fail'), tri.spread === null ? tri.coreCount + ' phương pháp chính' : 'chênh ' + f(tri.spread * 100, 0) + '% giữa ' + tri.coreLow.label + ' (' + f(tri.coreLow.base) + ') và ' + tri.coreHigh.label + ' (' + f(tri.coreHigh.base) + ')' + (tri.dropped ? '; ' + tri.dropped.label + ' (' + f(tri.dropped.base) + ') lệch xa nên đã tách riêng' : ''), 'Ngưỡng: ≤25% đồng thuận, ≤50% lệch vừa, trên 50% là bất đồng và chưa nên kết luận. Với từ 4 phương pháp chính trở lên, phương pháp lệch xa nhất được tách ra và nêu riêng.', { tab: 'process', hint: 'Soát phương pháp lệch xa nhất ở bước 5 và giả định của nó.' });
    add('coverage', 'Số phương pháp chính đang chạy', pl.coreActive >= 2 ? 'pass' : (pl.coreActive === 1 ? 'warn' : 'fail'), pl.coreActive + ' phương pháp', pl.gaps.length ? 'Còn thiếu: ' + pl.gaps.map(function (g) { return g.label; }).join('; ') + '.' : 'Cần ít nhất 2 phương pháp chính độc lập để đối chiếu chéo.', pl.gaps.length ? { tab: 'valuation', hint: 'Bổ sung dữ liệu cho phương pháp còn thiếu.' } : null);
    return out;
  }

  function review(res, synth, pl, opts) {
    const o = opts || {};
    if (!synth || !synth.ok) return { status: 'blocked', statusLabel: 'Chưa kết luận được', statusText: synth && synth.reason ? synth.reason : 'Chưa có giá trị hợp lệ.', triangulation: null, checks: [], fails: 0, warns: 0, needsAck: true, ack: pl.ack, watch: [] };
    const tri = triangulate(synth, pl), cks = checks(res, synth, pl, tri, o);
    const fails = cks.filter(function (c) { return c.level === 'fail'; }).length, warns = cks.filter(function (c) { return c.level === 'warn'; }).length;
    const blocked = pl.gate.status === 'blocked';
    const status = blocked ? 'blocked' : (fails > 0 ? 'review' : (warns > 0 || pl.gate.status === 'limited' ? 'conditional' : 'complete'));
    const label = { blocked: 'Chưa đủ dữ liệu để kết luận', review: 'Cần xử lý trước khi dùng', conditional: 'Kết luận có điều kiện', complete: 'Quy trình hoàn tất' }[status];
    const text = { blocked: 'Dữ liệu then chốt còn thiếu (bước 2): giá trị chỉ mang tính minh hoạ.', review: fails + ' mục kiểm tra không đạt: xử lý hoặc ghi lý do chấp nhận trước khi lưu.', conditional: 'Không có mục nào không đạt nhưng còn ' + warns + ' cảnh báo và ' + (pl.gate.status === 'limited' ? 'hạn chế về dữ liệu' : 'lưu ý') + ': dùng như ước tính có điều kiện.', complete: 'Dữ liệu đủ, các phương pháp chính đồng thuận, mọi kiểm tra hợp lý đạt.' }[status];
    const watch = [];
    (synth.mustBeTrue || []).forEach(function (t) { watch.push(t); });
    if (synth.zones && synth.zones.invalidation && synth.zones.invalidation.price) watch.push('Nếu giá đóng cửa dưới ' + f(synth.zones.invalidation.price) + ' đ thì luận điểm kỹ thuật vô hiệu: xem lại toàn bộ.');
    cks.filter(function (c) { return c.level === 'warn' || c.level === 'fail'; }).slice(0, 3).forEach(function (c) { watch.push('Giải quyết: ' + c.label + ' (' + c.value + ').'); });
    return { status: status, statusLabel: label, statusText: text, triangulation: tri, checks: cks, fails: fails, warns: warns, needsAck: fails > 0 || blocked, ack: pl.ack, watch: watch };
  }

  // Bản gọn lưu cùng bản định giá (finance_vb_valuations.summary.process): đủ để tái hiện vì sao chọn phương pháp nào.
  function compact(p) {
    if (!p) return null;
    return {
      archetype: p.archetype.key, archetypeLabel: p.archetype.label, source: p.archetype.source, why: p.archetype.why, gate: p.gate.status,
      status: p.status, statusLabel: p.statusLabel, fails: p.fails, warns: p.warns, ack: p.ack || null,
      methods: p.rows.filter(function (r) { return r.computed || r.role === 'core' || r.role === 'support'; }).map(function (r) { return { key: r.key, role: r.role, weight: r.weight, status: r.status, computed: r.computed, limit: r.limit || null, user: r.user || false }; }),
      checks: (p.checks || []).map(function (c) { return { key: c.key, level: c.level, value: c.value }; }), gaps: p.gaps.map(function (g) { return g.key; }),
      spread: p.triangulation ? p.triangulation.spread : null,
    };
  }

  return { ROLES, ARCH, META, signals, classify, gate, plan, review, compact, triangulate, STEPS: ['Phân loại', 'Dữ liệu', 'Phương pháp', 'Giả định', 'Đối chiếu', 'Kiểm tra', 'Kết luận'] };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VBProcess;
