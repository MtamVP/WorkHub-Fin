// supabase/functions/market-news-ai/ai.ts: chuỗi mô hình dự phòng (thử từ Gemini 3.8 xuống dần), nhớ mô hình hết hạn mức, danh sách AI_MODEL. Đồng hồ giả, không gọi mạng.
import { describe, it, expect } from 'vitest';
import { GEMINI_CHAIN, MODEL_DEFAULT, chainFor, createCooldown, fail, parseModel, parseModelList, summarizeWithFallback } from '../../supabase/functions/market-news-ai/ai.ts';

const GOOD_TEXT = JSON.stringify({ headline: 'h', points: [{ topic: 'T', text: 'ý', refs: [1] }] });
const parse = (t) => parseModel(t, 3);
const clock = () => { let t = Date.parse('2026-10-09T03:00:00Z'); return { now: () => t, adv: (ms) => { t += ms; } }; };
// attempt giả: bảng { mô hình: 'ok' | mã lỗi | 'junk' }, ghi lại thứ tự được gọi
const make = (table, c) => { const calls = []; return { calls, attempt: async (m) => { calls.push(m); if (c && c.step) c.adv(c.step); const v = table[m]; if (v === 'ok') return { ok: true, text: GOOD_TEXT }; if (v === 'junk') return { ok: true, text: 'không phải json' }; return fail(v || 'upstream'); } }; };
const run = (models, table, c, extra) => { const k = c || clock(), cd = (extra && extra.cooldown) || createCooldown(k.now), f = make(table, k); return summarizeWithFallback(Object.assign({ models, cooldown: cd, now: k.now, attempt: f.attempt, parse }, extra || {})).then((r) => ({ r, calls: f.calls, cd, k })); };

describe('chuỗi mô hình mặc định', () => {
  it('đi dần từ Gemini 3.8 xuống 3.1 Flash-Lite, không trùng, tên hợp lệ', () => {
    expect(GEMINI_CHAIN).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    expect(new Set(GEMINI_CHAIN).size).toBe(GEMINI_CHAIN.length);
    expect(chainFor('gemini', '')).toEqual(GEMINI_CHAIN);
    expect(chainFor('gemini', undefined)).toEqual(GEMINI_CHAIN);
    expect(chainFor('claude', '')).toEqual([MODEL_DEFAULT]);
  });
  it('chainFor trả bản sao (sửa kết quả không làm hỏng hằng số)', () => { chainFor('gemini', '').pop(); expect(GEMINI_CHAIN.length).toBe(6); });
});

describe('AI_MODEL: danh sách mô hình tuỳ chỉnh', () => {
  it('tách theo dấu phẩy/khoảng trắng/xuống dòng, bỏ trùng, giữ thứ tự', () => {
    expect(parseModelList('gemini-3.8-flash, gemini-3.5-flash\ngemini-3.8-flash;gemini-3.1-flash-lite')).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite']);
  });
  it('bỏ tên không an toàn (đường dẫn, ký tự lạ, quá ngắn/dài), tối đa 10 mô hình', () => {
    expect(parseModelList('../etc/passwd a?b=1 x gemini-ok <script> ' + 'a'.repeat(70) + ' 3.5-flash')).toEqual(['gemini-ok', '3.5-flash']);
    expect(parseModelList(Array.from({ length: 20 }, (_, i) => 'model-' + i).join(','))).toHaveLength(10);
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList('')).toEqual([]);
  });
  it('AI_MODEL đặt thì thay hẳn chuỗi mặc định; toàn tên xấu thì quay về mặc định', () => {
    expect(chainFor('gemini', 'gemini-3.5-flash-lite')).toEqual(['gemini-3.5-flash-lite']);
    expect(chainFor('gemini', 'gemini-3.7-flash, gemini-3.1-flash-lite')).toEqual(['gemini-3.7-flash', 'gemini-3.1-flash-lite']);
    expect(chainFor('gemini', '../x ;;; <b>')).toEqual(GEMINI_CHAIN);
    expect(chainFor('claude', 'claude-opus-x')).toEqual(['claude-opus-x']);
  });
});

describe('thử lần lượt các mô hình', () => {
  it('mô hình đầu chạy được thì dùng luôn, không gọi các mô hình dưới', async () => {
    const { r, calls } = await run(GEMINI_CHAIN, { 'gemini-3.8-flash': 'ok' });
    expect(r.ok).toBe(true); expect(r.model).toBe('gemini-3.8-flash'); expect(r.skipped).toEqual([]);
    expect(calls).toEqual(['gemini-3.8-flash']);
  });
  it('mô hình đầu hết hạn mức (429) thì chuyển xuống mô hình kế; ghi lại mô hình đã bỏ qua và lý do', async () => {
    const { r, calls } = await run(GEMINI_CHAIN, { 'gemini-3.8-flash': 'rate_limited', 'gemini-3.7-flash': 'ok' });
    expect(r.model).toBe('gemini-3.7-flash');
    expect(calls).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash']);
    expect(r.skipped).toEqual([{ model: 'gemini-3.8-flash', code: 'rate_limited' }]);
  });
  it('đi dần nhiều bậc cho tới mô hình còn dùng được', async () => {
    const t = { 'gemini-3.8-flash': 'rate_limited', 'gemini-3.7-flash': 'rate_limited', 'gemini-3.6-flash': 'bad_model', 'gemini-3.5-flash': 'upstream', 'gemini-3.5-flash-lite': 'ok' };
    const { r, calls } = await run(GEMINI_CHAIN, t);
    expect(r.model).toBe('gemini-3.5-flash-lite');
    expect(calls).toEqual(GEMINI_CHAIN.slice(0, 5));
    expect(r.skipped.map((x) => x.code)).toEqual(['rate_limited', 'rate_limited', 'bad_model', 'upstream']);
  });
  it('mô hình trả sai khuôn hoặc lỗi mạng/quá giờ cũng được thay bằng mô hình kế tiếp', async () => {
    const { r } = await run(GEMINI_CHAIN, { 'gemini-3.8-flash': 'junk', 'gemini-3.7-flash': 'network', 'gemini-3.6-flash': 'ok' });
    expect(r.model).toBe('gemini-3.6-flash');
    expect(r.skipped.map((x) => x.code)).toEqual(['bad_output', 'network']);
  });
  it('khoá sai hoặc hết tiền (dùng chung mọi mô hình): dừng ngay, không thử tiếp', async () => {
    for (const code of ['invalid_key', 'billing']) {
      const { r, calls } = await run(GEMINI_CHAIN, { 'gemini-3.8-flash': code, 'gemini-3.7-flash': 'ok' });
      expect(r.ok).toBe(false); expect(r.code).toBe(code); expect(calls).toEqual(['gemini-3.8-flash']);
    }
  });
  it('tất cả hết hạn mức: báo rate_limited kèm danh sách; tất cả lỗi khác: báo lỗi cuối', async () => {
    const all = Object.fromEntries(GEMINI_CHAIN.map((m) => [m, 'rate_limited']));
    const a = await run(GEMINI_CHAIN, all);
    expect(a.r.ok).toBe(false); expect(a.r.code).toBe('rate_limited'); expect(a.r.skipped).toHaveLength(6); expect(a.calls).toHaveLength(6);
    const b = await run(GEMINI_CHAIN, Object.fromEntries(GEMINI_CHAIN.map((m) => [m, 'upstream'])));
    expect(b.r.code).toBe('upstream');
    const c = await run(GEMINI_CHAIN, Object.assign(Object.fromEntries(GEMINI_CHAIN.map((m) => [m, 'upstream'])), { 'gemini-3.8-flash': 'rate_limited' }));
    expect(c.r.code).toBe('rate_limited');                // có mô hình hết hạn mức thì ưu tiên báo điều đó
  });
  it('chuỗi chỉ một mô hình (Claude hoặc AI_MODEL một tên): lỗi thì báo thẳng', async () => {
    const { r, calls } = await run(['claude-haiku-4-5-20251001'], { 'claude-haiku-4-5-20251001': 'upstream' });
    expect(r.code).toBe('upstream'); expect(calls).toHaveLength(1);
  });
  it('danh sách rỗng: báo rate_limited, không gọi gì', async () => {
    const { r, calls } = await run([], {});
    expect(r.ok).toBe(false); expect(calls).toEqual([]);
  });
  it('quá ngân sách thời gian thì không thử thêm mô hình (nhưng luôn thử ít nhất một)', async () => {
    const c = clock(); c.step = 30000;
    const t = Object.fromEntries(GEMINI_CHAIN.map((m) => [m, 'rate_limited']));
    const { r, calls } = await run(GEMINI_CHAIN, t, c, { budgetMs: 50000 });
    expect(calls).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash']);        // 2 lần x 30 giây vượt 50 giây
    expect(r.skipped.filter((x) => x.code === 'budget')).toHaveLength(4);
  });
});

describe('mô hình quá chậm hoặc lỗi máy chủ cũng được cho nghỉ (đo thật: 3.8/3.7 quá 25 giây hoặc 503 lúc đông)', () => {
  it('quá giờ (network) và lỗi máy chủ (upstream) bị nhớ nghỉ tăng dần như hết hạn mức', () => {
    for (const code of ['network', 'upstream']) {
      const k = clock(), cd = createCooldown(k.now), m = 'gemini-3.8-flash';
      for (const min of [2, 10, 30, 60]) { cd.mark(m, code); k.adv(min * 60000 - 1000); expect(cd.isCool(m)).toBe(true); k.adv(2000); expect(cd.isCool(m)).toBe(false); }
    }
  });
  it('lượt sau không tốn thời gian chờ lại mô hình vừa quá giờ: bỏ qua ngay và dùng mô hình kế', async () => {
    const k = clock(), cd = createCooldown(k.now), t = { 'gemini-3.8-flash': 'network', 'gemini-3.7-flash': 'upstream', 'gemini-3.6-flash': 'ok' };
    const first = await run(GEMINI_CHAIN, t, k, { cooldown: cd });
    expect(first.calls).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']);
    const second = await run(GEMINI_CHAIN, t, k, { cooldown: cd });
    expect(second.calls).toEqual(['gemini-3.6-flash']);
    expect(second.r.skipped.map((x) => x.code)).toEqual(['cooldown', 'cooldown']);
    k.adv(2 * 60000 + 1000);
    const third = await run(GEMINI_CHAIN, t, k, { cooldown: cd });
    expect(third.calls[0]).toBe('gemini-3.8-flash');                         // hết thời gian nghỉ thì thử lại mô hình tốt nhất
  });
});

describe('nhớ mô hình vừa hết hạn mức', () => {
  it('lượt sau bỏ qua mô hình đang nghỉ (không tốn một lượt gọi vô ích); hết thời gian nghỉ thì thử lại', async () => {
    const k = clock(), cd = createCooldown(k.now), t = { 'gemini-3.8-flash': 'rate_limited', 'gemini-3.7-flash': 'ok' };
    await run(GEMINI_CHAIN, t, k, { cooldown: cd });
    const second = await run(GEMINI_CHAIN, t, k, { cooldown: cd });
    expect(second.calls).toEqual(['gemini-3.7-flash']);
    expect(second.r.skipped).toEqual([{ model: 'gemini-3.8-flash', code: 'cooldown' }]);
    k.adv(2 * 60000 + 1000);
    const third = await run(GEMINI_CHAIN, t, k, { cooldown: cd });
    expect(third.calls[0]).toBe('gemini-3.8-flash');
  });
  it('hết hạn mức liên tiếp thì thời gian nghỉ tăng dần 2, 10, 30, 60 phút', () => {
    const k = clock(), cd = createCooldown(k.now), m = 'gemini-3.8-flash';
    for (const min of [2, 10, 30, 60, 60]) {
      cd.mark(m, 'rate_limited');
      k.adv(min * 60000 - 1000); expect(cd.isCool(m)).toBe(true);
      k.adv(2000); expect(cd.isCool(m)).toBe(false);
    }
  });
  it('thành công thì xoá nhớ và về bước nghỉ ngắn nhất; sai tên mô hình nghỉ 6 giờ; lỗi khác không bị nhớ', () => {
    const k = clock(), cd = createCooldown(k.now);
    cd.mark('a', 'rate_limited'); cd.mark('a', 'rate_limited'); cd.ok('a');
    expect(cd.isCool('a')).toBe(false);
    cd.mark('a', 'rate_limited'); k.adv(2 * 60000 + 1000); expect(cd.isCool('a')).toBe(false);       // lại là bước 2 phút
    cd.mark('b', 'bad_model'); k.adv(5 * 3600000); expect(cd.isCool('b')).toBe(true); k.adv(2 * 3600000); expect(cd.isCool('b')).toBe(false);
    cd.mark('c', 'bad_output'); cd.mark('c', 'invalid_key'); expect(cd.isCool('c')).toBe(false);          // sai khuôn / lỗi khoá không đưa mô hình vào danh sách nghỉ
    cd.mark('d', 'rate_limited'); expect(cd.state().map((x) => x.model)).toEqual(['d']);
  });
  it('tất cả mô hình đang nghỉ: báo rate_limited ngay, không gọi API', async () => {
    const k = clock(), cd = createCooldown(k.now);
    GEMINI_CHAIN.forEach((m) => cd.mark(m, 'rate_limited'));
    const { r, calls } = await run(GEMINI_CHAIN, {}, k, { cooldown: cd });
    expect(calls).toEqual([]); expect(r.ok).toBe(false); expect(r.code).toBe('rate_limited');
    expect(r.skipped.every((x) => x.code === 'cooldown')).toBe(true);
  });
  it('mô hình trả sai khuôn không bị đưa vào danh sách nghỉ', async () => {
    const { cd } = await run(GEMINI_CHAIN, { 'gemini-3.8-flash': 'junk', 'gemini-3.7-flash': 'ok' });
    expect(cd.isCool('gemini-3.8-flash')).toBe(false);
  });
});
