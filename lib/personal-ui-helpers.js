// Hàm thuần cho giao diện Không Gian Riêng (không đụng DOM): nhóm sự kiện theo ngày, tìm kiếm bỏ dấu tiếng Việt,
// thống kê việc riêng, lời chào theo giờ... Nạp bằng thẻ <script> thường (thành global) trước script.js, và
// module.exports cho Vitest -- cùng kiểu với lib/pure-helpers.js.

const PERSONAL_WEEKDAYS_VI = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

function personalDayKey(date) {
  const d = new Date(date);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function personalGreeting(hour) {
  if (hour < 11) return 'Chào buổi sáng';
  if (hour < 13) return 'Chào buổi trưa';
  if (hour < 18) return 'Chào buổi chiều';
  return 'Chào buổi tối';
}

// "Thứ Sáu, 2/10" -- dùng khi cần nhãn ngày đầy đủ.
function personalDateLabel(date) {
  const d = new Date(date);
  return PERSONAL_WEEKDAYS_VI[d.getDay()] + ', ' + d.getDate() + '/' + (d.getMonth() + 1);
}

// Nhãn thân thiện: Hôm nay / Ngày mai / Thứ Hai, 5/10.
function personalRelativeDayLabel(date, now) {
  const base = new Date(now || Date.now());
  const todayKey = personalDayKey(base);
  const tomorrow = new Date(base); tomorrow.setDate(tomorrow.getDate() + 1);
  const key = personalDayKey(date);
  if (key === todayKey) return 'Hôm nay';
  if (key === personalDayKey(tomorrow)) return 'Ngày mai';
  return personalDateLabel(date);
}

// Sự kiện "cả ngày" của WorkHub được lưu 00:00 -> 23:59 (giây :59 khi kéo từ Google) theo giờ địa phương (xem calendar-connect.js).
// Không đòi đúng giây để sự kiện nhập tay 00:00 -> 23:59 cũng hiện "Cả ngày".
function personalIsAllDay(startTime, endTime) {
  const s = new Date(startTime);
  const e = new Date(endTime);
  return s.getHours() === 0 && s.getMinutes() === 0 && s.getSeconds() === 0
    && e.getHours() === 23 && e.getMinutes() === 59;
}

function personalTimeLabel(ev) {
  if (personalIsAllDay(ev.startTime, ev.endTime)) return 'Cả ngày';
  const fmt = (v) => {
    const d = new Date(v);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  return fmt(ev.startTime) + ' – ' + fmt(ev.endTime);
}

// Nhóm sự kiện theo NGÀY (giờ địa phương), mỗi nhóm sắp theo giờ bắt đầu. Sự kiện nhiều ngày xuất hiện ở từng ngày nó trải qua
// (tối đa maxDaysSpan ngày để tránh sự kiện lặp vô hạn làm phình danh sách). Chỉ giữ ngày nằm trong [fromDate, toDate].
function groupAgendaByDay(events, opts) {
  const now = (opts && opts.now) || Date.now();
  const from = new Date(opts && opts.from ? opts.from : now); from.setHours(0, 0, 0, 0);
  const to = opts && opts.to ? new Date(opts.to) : new Date(from.getTime() + 45 * 86400000);
  const maxSpan = (opts && opts.maxDaysSpan) || 7;
  const byDay = new Map();
  (events || []).forEach(ev => {
    const start = new Date(ev.startTime);
    const end = new Date(ev.endTime);
    if (isNaN(start.getTime())) return;
    const cursor = new Date(start); cursor.setHours(0, 0, 0, 0);
    const lastDay = isNaN(end.getTime()) ? new Date(cursor) : new Date(end);
    lastDay.setHours(0, 0, 0, 0);
    // Sự kiện kết thúc đúng 00:00:00 ngày sau không chiếm ngày sau.
    if (!isNaN(end.getTime()) && end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0 && end > start) {
      lastDay.setDate(lastDay.getDate() - 1);
    }
    for (let i = 0; i < maxSpan && cursor <= lastDay; i++) {
      if (cursor >= from && cursor <= to) {
        const key = personalDayKey(cursor);
        if (!byDay.has(key)) byDay.set(key, { dayKey: key, date: new Date(cursor), events: [] });
        byDay.get(key).events.push(ev);
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  });
  const todayKey = personalDayKey(now);
  return Array.from(byDay.values())
    .sort((a, b) => a.date - b.date)
    .map(g => ({
      dayKey: g.dayKey,
      isToday: g.dayKey === todayKey,
      label: personalRelativeDayLabel(g.date, now),
      dateText: personalDateLabel(g.date),
      events: g.events.slice().sort((a, b) => new Date(a.startTime) - new Date(b.startTime)),
    }));
}

// Bỏ dấu tiếng Việt + hạ chữ thường, để tìm "bao cao" khớp "Báo cáo", "dong" khớp "Đồng".
function personalNormalize(text) {
  return String(text == null ? '' : text)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase();
}

// Tìm trong mọi trường chữ của 1 mục cá nhân. Mọi từ trong truy vấn đều phải xuất hiện (không cần liền nhau).
function personalItemMatches(item, query) {
  const words = personalNormalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const data = item.data || {};
  const hay = personalNormalize([item.title, data.text, data.url, (item.tags || []).join(' ')].join(' \n '));
  return words.every(w => hay.includes(w));
}

function personalEventMatches(ev, query) {
  const words = personalNormalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = personalNormalize([ev.title, ev.location, ev.description].join(' \n '));
  return words.every(w => hay.includes(w));
}

// Tô sáng các từ tìm kiếm trong 1 đoạn chữ (không phân biệt hoa/thường và dấu), trả về HTML đã escape.
function personalHighlightHtml(text, query) {
  const chars = Array.from(String(text == null ? '' : text));
  const esc = (t) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const words = personalNormalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return esc(chars.join(''));
  let norm = '';
  const map = []; // vị trí trong chuỗi đã chuẩn hoá -> chỉ số ký tự gốc
  chars.forEach((ch, i) => {
    const n = personalNormalize(ch);
    for (let k = 0; k < n.length; k++) { norm += n[k]; map.push(i); }
  });
  const marked = new Array(chars.length).fill(false);
  words.forEach(w => {
    let from = 0;
    for (;;) {
      const at = norm.indexOf(w, from);
      if (at < 0) break;
      for (let p = map[at]; p <= map[at + w.length - 1]; p++) marked[p] = true;
      from = at + w.length;
    }
  });
  let html = '';
  let open = false;
  chars.forEach((ch, i) => {
    if (marked[i] && !open) { html += '<mark>'; open = true; }
    if (!marked[i] && open) { html += '</mark>'; open = false; }
    html += esc(ch);
  });
  return html + (open ? '</mark>' : '');
}

// { total, done, open, percent } cho tab "Việc riêng".
function personalChecklistStats(items) {
  const list = (items || []).filter(i => i.type === 'checklist');
  const done = list.filter(i => (i.data || {}).done).length;
  const total = list.length;
  return { total, done, open: total - done, percent: total ? Math.round((done / total) * 100) : 0 };
}

function personalDomainOf(url) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '');
  } catch (e) {
    return String(url || '');
  }
}

// Chữ cái đại diện + số màu 0..5 ổn định theo tên (tránh mọi lối tắt cùng 1 màu).
function personalAvatar(text) {
  const s = String(text || '?').trim();
  let hash = 0;
  for (const ch of s) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return { letter: (Array.from(s)[0] || '?').toUpperCase(), tone: hash % 6 };
}

// "Đồng bộ lúc 14:05" / "Đồng bộ hôm qua 21:10" / "Đồng bộ 03/10 08:00".
function personalSyncedAtLabel(ms, now) {
  if (!ms) return 'Chưa đồng bộ';
  const d = new Date(ms);
  const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const base = new Date(now || Date.now());
  const yesterday = new Date(base); yesterday.setDate(yesterday.getDate() - 1);
  if (personalDayKey(d) === personalDayKey(base)) return 'Đồng bộ lúc ' + hhmm;
  if (personalDayKey(d) === personalDayKey(yesterday)) return 'Đồng bộ hôm qua ' + hhmm;
  return 'Đồng bộ ' + String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + ' ' + hhmm;
}

function personalFolderName(root) {
  const parts = String(root || '').replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || String(root || '');
}

function personalFormatBytes(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    personalDayKey, personalGreeting, personalDateLabel, personalRelativeDayLabel, personalIsAllDay, personalTimeLabel,
    groupAgendaByDay, personalNormalize, personalHighlightHtml, personalItemMatches, personalEventMatches, personalChecklistStats,
    personalDomainOf, personalAvatar, personalSyncedAtLabel, personalFolderName, personalFormatBytes,
  };
}
