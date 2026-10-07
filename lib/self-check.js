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

  return { ORDER, withTimeout, runOne, runAll, summarize, toText, daysBetween };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SelfCheck;
