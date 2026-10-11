/* --- FILE: /insight/insight-views-d.js ---
   Màn hình Việc cần làm (hộp tín hiệu gom từ mọi công cụ) và Sự kiện (trích từ tin theo mã): chỉ dựng chuỗi HTML từ kết quả đã tính (lib/action-inbox.js, lib/news-events.js). Sự kiện do insight-app.js xử lý. */
const InsViewsD = (function () {
  const U = (typeof require === 'function' && typeof module !== 'undefined') ? require('./insight-util.js') : InsUtil, e = U.esc;
  const AI = (typeof require === 'function' && typeof module !== 'undefined') ? require('../lib/action-inbox.js') : ActionInbox;
  const NE = (typeof require === 'function' && typeof module !== 'undefined') ? require('../lib/news-events.js') : NewsEvents;

  const SEV_TONE = { 1: 'bad', 2: 'warn', 3: '', 4: 'muted' };
  const isExternal = (u) => /^https:\/\//i.test(String(u || ''));
  const err = (S) => U.card('triangle-exclamation', 'Không tải được', U.empty('triangle-exclamation', e(S.error || 'Lỗi không xác định') + '<br><button class="ins-btn" onclick="insReload()">Tải lại</button>'));

  // ---------- Việc cần làm ----------
  const SEV_RULES = [
    [1, 'Luận điểm bị phá vỡ (điều kiện quan trọng sai); tin xấu nghiêm trọng (pháp lý, đình chỉ, giải chấp, nợ) của mã bạn ĐANG NẮM; vượt giới hạn ở chế độ chặn lệnh.'],
    [2, 'Luận điểm cần chú ý; tin xấu nghiêm trọng của mã đang THEO DÕI; nhiều người trong cuộc cùng bán mã đang nắm; vượt giới hạn ở chế độ cảnh báo; lệnh chờ duyệt quá 24 giờ; thiếu tiền trong 7 ngày tới; cảnh báo dữ liệu mức lỗi.'],
    [3, 'Tin cấp theo dõi của mã đang nắm (đổi nhân sự, kết quả kinh doanh, phát hành…); nhiều người trong cuộc cùng mua; gần chạm giới hạn; lệnh chờ duyệt mới; sắp tới ngày không hưởng quyền (≤ 3 ngày); hàm tự chạy lỗi.'],
    [4, 'Tin cấp theo dõi của mã chỉ theo dõi; ngày không hưởng quyền trong 4–7 ngày tới.'],
  ];

  function itemHtml(x, now) {
    const sev = AI.SEV[x.sev], kind = AI.KINDS[x.kind] || { label: x.kind, icon: 'circle' };
    const external = isExternal(x.link);
    const when = x.at ? U.ago(x.at, now) : '';
    return '<li class="ins-inbox-item s' + x.sev + '">' +
      '<div class="ins-inbox-top">' + U.tag(sev.label, SEV_TONE[x.sev]) + ' <span class="ins-tag muted"><i class="fa-solid fa-' + e(kind.icon) + '" aria-hidden="true"></i> ' + e(kind.label) + '</span>' + (x.symbol ? ' <b class="ins-sym">' + e(x.symbol) + '</b>' : '') + (when && when !== '—' ? '<span class="ins-muted ins-inbox-when">' + e(when) + '</span>' : '') + '</div>' +
      '<div class="ins-inbox-title">' + e(x.title) + '</div>' +
      (x.detail ? '<div class="ins-inbox-detail">' + e(x.detail) + '</div>' : '') +
      (x.link ? '<a class="ins-link" href="' + e(x.link) + '"' + (external ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + (external ? 'Đọc tin gốc' : 'Mở ' + e(kind.label.toLowerCase())) + ' <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>' : '') +
      '</li>';
  }

  function inboxHtml(S) {
    if (S.state === 'loading' || S.state === 'idle') return U.loading('Đang gom tín hiệu từ các công cụ…');
    if (S.state === 'error') return err(S);
    const sum = S.summary, F = S.filter || { sev: 'all', kind: 'all' };
    const kinds = Object.keys(sum.byKind).sort();
    let list = S.items;
    if (F.sev === 'urgent') list = list.filter((x) => x.sev <= 2); else if (F.sev === 'rest') list = list.filter((x) => x.sev >= 3);
    if (F.kind !== 'all') list = list.filter((x) => x.kind === F.kind);
    const seg = '<div class="ins-seg" role="group" aria-label="Mức khẩn cấp">' + [['all', 'Tất cả'], ['urgent', 'Cần xem ngay (1–2)'], ['rest', 'Vừa và thông tin (3–4)']].map((o) => '<button aria-pressed="' + (F.sev === o[0]) + '" onclick="insInbox(\'sev\',\'' + o[0] + '\')">' + o[1] + '</button>').join('') + '</div>';
    const sel = '<label class="ins-field ins-field-inline">Loại<select onchange="insInbox(\'kind\',this.value)"><option value="all">Tất cả</option>' + kinds.map((k) => '<option value="' + e(k) + '"' + (F.kind === k ? ' selected' : '') + '>' + e((AI.KINDS[k] || { label: k }).label) + ' (' + sum.byKind[k] + ')</option>').join('') + '</select></label>';
    let body = U.kpis([
      U.kpi('Nghiêm trọng', String(sum.bySev[1]), 'xem ngay', sum.bySev[1] ? 'bad' : ''),
      U.kpi('Cao', String(sum.bySev[2]), 'xem trong ngày', sum.bySev[2] ? 'warn' : ''),
      U.kpi('Vừa', String(sum.bySev[3]), 'xem trong tuần'),
      U.kpi('Thông tin', String(sum.bySev[4]), 'bối cảnh'),
    ]);
    body += '<div class="ins-bar">' + seg + sel + '<span class="ins-muted" style="font-size:.76rem">' + e(sum.headline) + ' · cập nhật ' + e(U.ago(new Date(S.now).toISOString(), S.now)) + ' <button class="ins-btn" onclick="insReload()"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Tải lại</button></span></div>';
    if (S.notes && S.notes.length) body += U.note('Không đọc được: <b>' + S.notes.map(e).join(', ') + '</b>. Các mục thuộc nguồn đó có thể thiếu (bạn có thể không có quyền xem, hoặc nguồn đang lỗi).', 'warn');
    if (!S.items.length) body += U.empty('circle-check', 'Không có việc cần chú ý. Hộp này chỉ nêu tín hiệu ĐÃ có từ các công cụ khác; không có mục không có nghĩa là mọi thứ ổn, chỉ là chưa có tín hiệu nào vượt ngưỡng.');
    else if (!list.length) body += U.empty('filter', 'Không có mục nào khớp bộ lọc.');
    else body += '<ul class="ins-inbox">' + list.map((x) => itemHtml(x, S.now)).join('') + '</ul>';
    const rules = '<details class="ins-details"><summary>Vì sao một mục nằm ở mức này?</summary><div class="ins-prose">' + SEV_RULES.map((r) => '<p>' + U.tag(AI.SEV[r[0]].label, SEV_TONE[r[0]]) + ' ' + e(r[1]) + '</p>').join('') + '<p>Tin xấu của mã bạn không nắm giữ và không theo dõi KHÔNG xuất hiện ở đây. Lệnh chờ duyệt, cảnh báo dữ liệu và hàm lỗi chỉ hiện với quản lý danh mục / admin.</p></div></details>';
    const mail = U.note('<b>Email buổi sáng:</b> lúc 08:30 các ngày làm việc, máy chủ gửi email tóm tắt các mục mức 1–3 cho người đã bật <i>email cảnh báo</i>, và <b>chỉ gửi khi có mục mới</b> mức nghiêm trọng hoặc cao so với email trước (không gửi chỉ vì có việc mức vừa). Danh sách trên trang này là bản trực tiếp, có thể nhiều hơn email vì gồm cả dòng tiền và ngày không hưởng quyền.');
    return U.card('inbox', 'Việc cần làm hôm nay', body) + U.card('scale-balanced', 'Cách xếp mức khẩn cấp', rules + mail);
  }

  // ---------- Sự kiện ----------
  const DIR = { '-1': ['Xấu', 'bad'], '0': ['Chưa rõ', 'muted'], '1': ['Tốt', 'ok'] };
  const SEV_EV = { alert: ['Nghiêm trọng', 'bad'], watch: ['Theo dõi', 'warn'], info: ['Thông tin', 'muted'] };

  function eventsHtml(S) {
    if (S.state === 'loading' || S.state === 'idle') return U.loading('Đang tải sự kiện…');
    if (S.state === 'error') return err(S);
    const F = S.filter, rows = S.rows;
    const types = NE.TYPES.map((t) => t.key).concat(['insider_buy', 'insider_sell', 'holder_trade']);
    const seg = (k, opts) => '<div class="ins-seg" role="group">' + opts.map((o) => '<button aria-pressed="' + (String(F[k]) === String(o[0])) + '" onclick="insEvt(\'' + k + '\',\'' + o[0] + '\')">' + o[1] + '</button>').join('') + '</div>';
    const ctl = '<div class="ins-bar">' +
      seg('scope', [['mine', 'Mã của tôi'], ['all', 'Toàn thị trường']]) + seg('days', [[7, '7 ngày'], [30, '30 ngày'], [90, '90 ngày']]) +
      '<label class="ins-field ins-field-inline">Loại<select onchange="insEvt(\'type\',this.value)"><option value="all">Tất cả</option>' + types.map((k) => '<option value="' + k + '"' + (F.type === k ? ' selected' : '') + '>' + e(NE.LABELS[k] || k) + '</option>').join('') + '</select></label>' +
      '<label class="ins-field ins-field-inline">Hướng<select onchange="insEvt(\'dir\',this.value)">' + [['all', 'Tất cả'], ['-1', 'Xấu'], ['1', 'Tốt'], ['0', 'Chưa rõ']].map((o) => '<option value="' + o[0] + '"' + (String(F.dir) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></label>' +
      '<label class="ins-field ins-field-inline">Mức<select onchange="insEvt(\'sev\',this.value)">' + [['all', 'Tất cả'], ['alert', 'Nghiêm trọng'], ['watch', 'Theo dõi'], ['info', 'Thông tin']].map((o) => '<option value="' + o[0] + '"' + (F.sev === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></label>' +
      '<label class="ins-field ins-field-inline">Mã<input type="text" maxlength="12" value="' + e(F.q) + '" placeholder="FPT" onchange="insEvt(\'q\',this.value)"></label></div>';
    const sum = S.summary;
    let body = U.kpis([
      U.kpi('Sự kiện trong bộ lọc', String(rows.length), S.total + ' sự kiện ' + F.days + ' ngày qua'),
      U.kpi('Nghiêm trọng', String(sum.alert), 'pháp lý, đình chỉ, giải chấp, nợ', sum.negAlert ? 'bad' : ''),
      U.kpi('Theo dõi', String(sum.watch), 'kết quả, nhân sự, phát hành, hợp đồng'),
      U.kpi('Cập nhật tin gần nhất', S.lastRun ? e(U.ago(S.lastRun.run_at, S.now)) : '—', S.lastRun && S.lastRun.ok === false ? 'lần chạy cuối bị lỗi' : 'máy chủ đọc tin mỗi 3 giờ', S.lastRun && S.lastRun.ok === false ? 'warn' : ''),
    ]) + ctl;
    if (!S.total) body += U.empty('newspaper', 'Chưa có sự kiện nào trong ' + F.days + ' ngày qua. Máy chủ chỉ trích sự kiện từ tin đã gắn mã cổ phiếu trong tiêu đề; kho tin tích luỹ dần từ lúc bật.');
    else if (!rows.length) body += U.empty('filter', 'Không có sự kiện nào khớp bộ lọc.' + (F.scope === 'mine' && !S.tracked.length ? ' Bạn chưa giữ hay theo dõi mã nào — chuyển sang "Toàn thị trường" để xem tất cả.' : ''));
    else {
      const shown = rows.slice(0, 200);
      body += U.table(['Ngày', 'Mã', 'Sự kiện', 'Hướng', 'Mức', 'Tiêu đề tin', 'Tin cậy', 'Vì sao xếp loại này'], [shown.map((r) => {
        const d = DIR[String(r.direction)] || DIR['0'], s = SEV_EV[r.severity] || SEV_EV.info;
        return '<tr><td>' + e(U.dateShort(r.published_at)) + '</td><td><b>' + e(r.symbol) + '</b>' + (S.held.indexOf(r.symbol) !== -1 ? ' ' + U.tag('đang giữ', 'ok') : '') + '</td><td class="t">' + e(NE.LABELS[r.event_type] || r.event_type) + '</td><td>' + U.tag(d[0], d[1]) + '</td><td>' + U.tag(s[0], s[1]) + '</td><td class="t ins-evt-title">' + (isExternal(r.link) ? '<a class="ins-link" href="' + e(r.link) + '" target="_blank" rel="noopener noreferrer">' + e(r.title) + '</a>' : e(r.title)) + (r.multi ? ' <span class="ins-muted" title="Tiêu đề nhắc nhiều mã">(nhiều mã)</span>' : '') + '</td><td>' + U.dec(Number(r.confidence) * 100, 0) + '%</td><td class="ins-muted t">' + e((r.matched || []).join(', ')) + '</td></tr>';
      }).join('')], { left: [2, 5, 7] });
      if (rows.length > shown.length) body += '<p class="tl-hint">Hiển thị ' + shown.length + ' trong ' + rows.length + ' sự kiện mới nhất; thu hẹp bộ lọc để xem phần còn lại.</p>';
    }
    const limits = U.note('<b>Giới hạn nói thẳng:</b> sự kiện được nhận ra bằng LUẬT TỪ KHOÁ trên tiêu đề (và tóm tắt ngắn), không dùng mô hình ngôn ngữ — nên bỏ sót tin diễn đạt lạ và có thể xếp nhầm cụm từ đa nghĩa. <b>Hướng</b> (xấu/tốt) là gợi ý theo từ ngữ, không phải đánh giá tác động lên giá. Tiêu đề nhắc nhiều mã thì gắn cho tất cả các mã đó với độ tin cậy thấp hơn. Cột cuối cho thấy cụm từ đã khớp để bạn tự kiểm tra. Đây là công cụ lọc và cảnh báo, không phải khuyến nghị đầu tư.', 'warn');
    return U.card('newspaper', 'Sự kiện theo mã', body) + limits;
  }

  return { inboxHtml, eventsHtml, itemHtml, SEV_RULES };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = InsViewsD;
