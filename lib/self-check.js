// Logic thuần: BỘ CHẠY "Kiểm tra hệ thống". Chạy lần lượt danh sách phép kiểm (mỗi phép có giới hạn thời gian), thu kết quả { id, label, status, detail, ms } rồi tóm tắt và dựng báo cáo văn bản để sao chép.
// status: 'ok' | 'warn' (chạy được nhưng cần chú ý) | 'fail' (hỏng) | 'skip' (không áp dụng ở môi trường này, ví dụ bản web không có ghi tệp).
// Phép kiểm cụ thể (gọi Supabase, Tauri, VNDirect) nằm ở /self-check.js; ở đây không đụng mạng/DOM nên kiểm thử được. Báo cáo KHÔNG chứa khoá, token hay email.
// Nạp bằng thẻ <script> thường (global SelfCheck) và module.exports cho Vitest.
const SelfCheck = (function () {
  const ORDER = { fail: 0, warn: 1, ok: 2, skip: 3 };
  const ICON = { ok: 'OK', warn: 'CHÚ Ý', fail: 'LỖI', skip: 'BỎ QUA' };

  const withTimeout = (p, ms, label) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Quá ' + Math.round(ms / 1000) + ' giây không phản hồi' + (label ? ' (' + label + ')' : ''))), ms);
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
  const clean = (s) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').slice(0, 300);

  // def: { id, label, run(ctx) -> { status, detail } hoặc ném lỗi, timeoutMs? }. Lỗi ném ra = 'fail' kèm lý do; ctx.now trả giờ hiện tại (kiểm thử truyền vào).
  async function runOne(def, ctx, now) {
    const t0 = now();
    try {
      const r = await withTimeout(def.run(ctx), def.timeoutMs || 15000, def.label);
      const status = r && ORDER[r.status] !== undefined ? r.status : 'ok';
      return { id: def.id, label: def.label, status: status, detail: clean(r && r.detail), ms: Math.round(now() - t0) };
    } catch (e) {
      return { id: def.id, label: def.label, status: 'fail', detail: clean(e && e.message || e), ms: Math.round(now() - t0) };
    }
  }

  async function runAll(defs, ctx, opts) {
    const o = opts || {}, now = o.now || (() => Date.now()), out = [];
    for (const d of defs) {
      if (o.onProgress) o.onProgress({ id: d.id, label: d.label, status: 'running', done: out.length, total: defs.length });
      const r = await runOne(d, ctx || {}, now);
      out.push(r);
      if (o.onProgress) o.onProgress(Object.assign({ done: out.length, total: defs.length }, r));
    }
    return out;
  }

  function summarize(results) {
    const c = { ok: 0, warn: 0, fail: 0, skip: 0 };
    (results || []).forEach((r) => { if (c[r.status] !== undefined) c[r.status]++; });
    const verdict = c.fail ? 'fail' : (c.warn ? 'warn' : 'ok');
    const text = c.fail ? c.fail + ' phép kiểm lỗi' + (c.warn ? ', ' + c.warn + ' cần chú ý' : '') : (c.warn ? 'Chạy được, ' + c.warn + ' mục cần chú ý' : 'Mọi phép kiểm đều đạt');
    return Object.assign({ verdict: verdict, text: text, total: (results || []).length }, c);
  }

  // Báo cáo văn bản (dán vào tin nhắn khi cần hỗ trợ). meta: { version, when, platform }
  function toText(results, meta) {
    const m = meta || {}, s = summarize(results);
    const lines = ['WorkHub Fin: kiểm tra hệ thống' + (m.version ? ' (phiên bản ' + m.version + ')' : '') + (m.when ? ' lúc ' + m.when : '') + (m.platform ? ' · ' + m.platform : ''), 'Kết quả: ' + s.text, ''];
    (results || []).slice().sort((a, b) => ORDER[a.status] - ORDER[b.status]).forEach((r) => {
      lines.push('[' + ICON[r.status] + '] ' + r.label + (r.detail ? ': ' + r.detail : '') + (r.ms ? ' (' + r.ms + ' ms)' : ''));
    });
    return lines.join('\n');
  }

  // Tiện ích cho các phép kiểm: số ngày giữa hai ngày YYYY-MM-DD (b - a)
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }

  // Kết luận cho phép kiểm "Lịch nghỉ lễ": xét cả NĂM SAU vì lịch nghỉ Tết do Chính phủ công bố vào cuối năm. coverageOf(iso) -> 'complete' | 'partial' | 'none' (VnHolidays.coverage).
  // Từ tháng 11 mà lịch năm sau chưa đầy đủ thì báo "chú ý" để nhà phát triển cập nhật trước ngày 1/1; trước đó chỉ ghi chú (chưa có gì để cập nhật).
  function holidayOutlook(today, coverageOf, extra) {
    const x = extra || {}, y = Number(String(today).slice(0, 4)), mo = Number(String(today).slice(5, 7));
    const cur = coverageOf(today), next = coverageOf((y + 1) + '-06-15');
    const hereName = x.holidayName ? ' Hôm nay nghỉ lễ: ' + x.holidayName + '.' : '';
    if (cur !== 'complete') return { status: 'warn', detail: 'Lịch nghỉ lễ năm ' + y + ' chưa đầy đủ (mới có Tết Dương lịch). Nếu gặp ngày nghỉ chưa có trong lịch, app vẫn tự nhận biết nhờ VNDirect không có giá hôm nay; nên cập nhật khi có thông báo mới.' + (x.nextTradingDay ? ' Ngày giao dịch kế tiếp: ' + x.nextTradingDay + '.' : '') };
    if (next === 'complete') return { status: 'ok', detail: 'Có đủ lịch năm ' + y + ' và ' + (y + 1) + '.' + hereName };
    if (mo >= 11) return { status: 'warn', detail: 'Sắp sang năm ' + (y + 1) + ' mà lịch nghỉ lễ năm đó chưa đầy đủ (mới có Tết Dương lịch). Cần thêm lịch nghỉ Tết Nguyên đán và các ngày lễ khi Chính phủ công bố; khi chưa có, app vẫn nhận ngày nghỉ nhờ VNDirect không có giá hôm nay.' + hereName };
    return { status: 'ok', detail: 'Có đủ lịch năm ' + y + '. Lịch năm ' + (y + 1) + ' mới có Tết Dương lịch (lịch nghỉ Tết thường công bố vào cuối năm) và sẽ cần cập nhật trước ngày 1/1.' + hereName };
  }

  // ---------- Sức khoẻ lịch chạy nền (pg_cron) và độ tươi dữ liệu phía máy chủ (RPC fn_cron_health / fn_data_freshness, finance-system-health-migration.sql) ----------
  // Lịch pg_cron tính theo UTC. Khớp một trường: '*', số, danh sách 'a,b', khoảng 'a-b', bước '*/n' hoặc 'a-b/n'.
  function fieldMatches(field, value, min, max) {
    return String(field).split(',').some((part) => {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
      if (!m) return false;
      let lo = min, hi = max;
      if (m[1] !== '*') { const r = m[1].split('-'); lo = Number(r[0]); hi = r.length > 1 ? Number(r[1]) : (m[2] ? max : lo); }
      const step = m[2] ? Number(m[2]) : 1;
      return value >= lo && value <= hi && (value - lo) % step === 0;
    });
  }
  function cronMatches(schedule, ms) {
    const f = String(schedule || '').trim().split(/\s+/);
    if (f.length !== 5) return false;
    const d = new Date(ms), dow = d.getUTCDay();
    return fieldMatches(f[0], d.getUTCMinutes(), 0, 59) && fieldMatches(f[1], d.getUTCHours(), 0, 23) && fieldMatches(f[2], d.getUTCDate(), 1, 31) && fieldMatches(f[3], d.getUTCMonth() + 1, 1, 12)
      && (fieldMatches(f[4], dow, 0, 6) || (dow === 0 && fieldMatches(f[4], 7, 0, 7)));
  }
  // Thời điểm (ms) đã lên lịch gần nhất không muộn hơn `ms`, lùi tối đa maxDays ngày; null nếu không thấy
  function lastScheduled(schedule, ms, maxDays) {
    const t0 = Math.floor(ms / 60000) * 60000, limit = (maxDays || 8) * 1440;
    for (let i = 0; i <= limit; i++) { const t = t0 - i * 60000; if (cronMatches(schedule, t)) return t; }
    return null;
  }
  const utcMin = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  // rows: kết quả fn_cron_health(). Mỗi job đang bật phải có lần chạy gần nhất không sớm hơn lần đã lên lịch gần nhất (dung sai graceMs, mặc định 3 phút).
  // Job chưa chạy lần nào (mới tạo, chưa tới lần đầu) chỉ là "chú ý", không phải lỗi vì không biết ngày tạo. Lần chạy gần nhất báo 'failed' là LỖI; có lỗi trong 48 giờ là chú ý.
  // Lưu ý: đây là việc pg_cron có PHÁT lệnh hay không, không phải kết quả HTTP của Edge Function (xem độ tươi dữ liệu).
  function cronHealth(rows, nowMs, opts) {
    const o = opts || {}, grace = o.graceMs === undefined ? 3 * 60000 : o.graceMs, problems = [], warns = [];
    const list = rows || [];
    list.forEach((r) => {
      if (!r.active) { warns.push(r.jobname + ': đang tắt'); return; }
      const exp = lastScheduled(r.schedule, nowMs - grace, 8);
      const last = r.last_start ? Date.parse(r.last_start) : null;
      if (last === null) { warns.push(r.jobname + ': chưa chạy lần nào (lịch ' + r.schedule + ')'); return; }
      if (exp !== null && last < exp - 2 * 60000) problems.push(r.jobname + ': lỡ lần chạy ' + utcMin(exp) + ' (lần cuối ' + utcMin(last) + ')');
      else if (r.last_status === 'failed') problems.push(r.jobname + ': lần chạy gần nhất báo lỗi' + (r.last_message ? ' (' + String(r.last_message).slice(0, 80) + ')' : ''));
      else if (Number(r.fails_48h) > 0) warns.push(r.jobname + ': ' + r.fails_48h + ' lần lỗi trong 48 giờ');
    });
    if (!list.length) return { status: 'warn', detail: 'Không đọc được danh sách lịch chạy (tài khoản không có quyền, hoặc hàm chưa được cài).', problems, warns };
    const status = problems.length ? 'fail' : (warns.length ? 'warn' : 'ok');
    const head = list.length + ' lịch chạy nền';
    const detail = status === 'ok' ? head + ': đều chạy đúng giờ gần nhất.' : head + '. ' + problems.concat(warns).slice(0, 5).join('; ') + (problems.length + warns.length > 5 ? '; …' : '') + '.';
    return { status, detail, problems, warns };
  }

  // Ngày (YYYY-MM-DD, UTC) gần nhất đủ điều kiện mà mốc hourUtc:minuteUtc của ngày đó đã qua tại nowMs; isTradingDay(iso) tuỳ chọn (mặc định thứ 2-6)
  function lastDueDay(nowMs, hourUtc, minuteUtc, isTradingDay) {
    const ok = isTradingDay || ((iso) => { const w = new Date(iso + 'T00:00:00Z').getUTCDay(); return w >= 1 && w <= 5; });
    for (let i = 0; i < 12; i++) {
      const iso = new Date(nowMs - i * 86400000).toISOString().slice(0, 10);
      if (Date.parse(iso + 'T00:00:00Z') + (hourUtc * 60 + minuteUtc) * 60000 <= nowMs && ok(iso)) return iso;
    }
    return null;
  }
  const vnDate = (ms) => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
  // f: kết quả fn_data_freshness(). Trả [{ key, label, status, detail }]. Mốc "đến hạn" lấy theo giờ cron tương ứng (UTC) cộng 30 phút chờ; isTradingDay chỉ áp cho dữ liệu theo phiên.
  function dataFreshness(f, nowMs, opts) {
    const o = opts || {}, F = f || {}, out = [];
    const dayOf = (v) => (v ? String(v).slice(0, 10) : null);
    const ageH = (v) => (v ? (nowMs - Date.parse(v)) / 3600000 : null);
    const byDay = (key, label, latest, h, m, note, tradingOnly) => {
      const exp = lastDueDay(nowMs - 30 * 60000, h, m, tradingOnly ? o.isTradingDay : null), got = dayOf(latest);
      if (!got) { out.push({ key, label, status: 'warn', detail: 'Chưa có dữ liệu.' }); return; }
      if (exp && got < exp) { out.push({ key, label, status: 'warn', detail: 'Mới nhất ' + got + ', cần tới ' + exp + (note ? ' (' + note + ')' : '') + '.' }); return; }
      out.push({ key, label, status: 'ok', detail: 'Mới nhất ' + got + '.' });
    };
    const byAge = (key, label, v, maxH, note, noneText) => {
      const h = ageH(v);
      if (h === null) { out.push({ key, label, status: 'warn', detail: noneText || 'Chưa có.' }); return; }
      const txt = h > 48 ? Math.round(h / 24) + ' ngày' : (h >= 2 ? Math.round(h) : Math.max(0, Math.round(h * 10) / 10)) + ' giờ';
      out.push({ key, label, status: h > maxH ? 'warn' : 'ok', detail: (h > maxH ? 'Đã ' : '') + 'cách đây ' + txt + (h > maxH && note ? ' (' + note + ')' : '') + '.' });
    };
    byDay('price_days', 'Kho giá theo ngày', F.price_days, 12, 30, 'bt-fill-daily chạy 19:30 giờ VN', true);
    byDay('pit_market', 'Kho dữ liệu theo thời điểm (PIT)', F.pit_market, 12, 5, 'pit-capture-daily chạy 19:05 giờ VN', true);
    // NAV chụp lúc 23:50 UTC mỗi ngày, ghi theo ngày VN của hôm sau: không được thiếu ngày nào trong 26 giờ qua
    const nav = dayOf(F.nav_history), navExp = vnDate(nowMs - 26 * 3600000);
    out.push(!nav ? { key: 'nav_history', label: 'NAV chụp hằng ngày', status: 'warn', detail: 'Chưa có.' } : (nav < navExp ? { key: 'nav_history', label: 'NAV chụp hằng ngày', status: 'warn', detail: 'Mới nhất ' + nav + ', cần tới ' + navExp + '.' } : { key: 'nav_history', label: 'NAV chụp hằng ngày', status: 'ok', detail: 'Mới nhất ' + nav + '.' }));
    if (Number(F.sim_runs_open) > 0) byDay('sim_watch', 'Máy chủ chấm lần mô phỏng đã lưu', F.sim_watch, 11, 55, 'sim-watch-daily chạy 18:55 giờ VN', false);
    byAge('pit_news', 'Tin trong kho Insight', F.pit_news, 5, 'lịch quét 3 giờ một lần', 'Chưa có tin.');
    byAge('financials', 'Bộ đệm báo cáo tài chính', F.financials, 36, 'lịch 2 lần/ngày');
    byAge('ownership', 'Đồng bộ sở hữu', F.ownership, 24 * 4, 'lịch hằng ngày làm việc', 'Chưa đồng bộ mã nào.');
    byAge('market_snapshot', 'Ảnh chụp thị trường (bộ lọc)', F.market_snapshot, 24 * 4, 'lịch hằng ngày làm việc');
    if (Number(F.data_health_open_errors) > 0) out.push({ key: 'data_health', label: 'Cảnh báo chất lượng dữ liệu mức lỗi', status: 'warn', detail: F.data_health_open_errors + ' cảnh báo chưa xử lý (Toàn Nhóm > Dữ Liệu).' });
    return out;
  }
  function freshnessVerdict(items) {
    const bad = (items || []).filter((i) => i.status !== 'ok');
    if (!bad.length) return { status: 'ok', detail: (items || []).length + ' nguồn dữ liệu nền đều cập nhật đúng hạn.' };
    return { status: 'warn', detail: bad.slice(0, 4).map((i) => i.label + ': ' + i.detail).join(' ') + (bad.length > 4 ? ' …' : '') };
  }

  return { ORDER, withTimeout, runOne, runAll, summarize, toText, daysBetween, holidayOutlook, cronMatches, lastScheduled, cronHealth, lastDueDay, dataFreshness, freshnessVerdict };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SelfCheck;
