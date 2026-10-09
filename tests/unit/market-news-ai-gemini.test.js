// supabase/functions/market-news-ai/ai.ts, nhánh Gemini: chọn nhà cung cấp theo khoá, gọi generateContent bằng fetch giả, phân loại lỗi của Gemini. Không gọi mạng, không dùng khoá thật.
import { describe, it, expect } from 'vitest';
import { GEMINI_MAX_TOKENS, MODEL_DEFAULTS, callAi, callGemini, messageFor, parseModel, pickProvider } from '../../supabase/functions/market-news-ai/ai.ts';

const base = { key: 'AIza-KHONG-THAT', model: 'gemini-3.1-flash-lite', system: 'SYS', user: 'USR' };
const okRes = (parts) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts }, finishReason: 'STOP' }] }) });
const GOOD = JSON.stringify({ headline: 'Thị trường giằng co', points: [{ topic: 'Khối ngoại', text: 'Khối ngoại bán ròng.', refs: [1, 2] }] });

describe('chọn nhà cung cấp theo khoá', () => {
  it('tự chọn: có khoá Gemini thì dùng Gemini (ưu tiên gói miễn phí), chỉ có khoá Claude thì dùng Claude, không có khoá là null', () => {
    expect(pickProvider({ geminiKey: 'g', anthropicKey: 'c' })).toEqual({ provider: 'gemini', key: 'g' });
    expect(pickProvider({ geminiKey: 'g' })).toEqual({ provider: 'gemini', key: 'g' });
    expect(pickProvider({ anthropicKey: 'c' })).toEqual({ provider: 'claude', key: 'c' });
    expect(pickProvider({})).toBe(null);
    expect(pickProvider({ geminiKey: '   ', anthropicKey: '' })).toBe(null);
  });
  it('AI_PROVIDER ép nhà cung cấp; thiếu khoá tương ứng thì null (không tự đổi sang nhà khác ngoài ý muốn)', () => {
    expect(pickProvider({ provider: 'claude', geminiKey: 'g', anthropicKey: 'c' })).toEqual({ provider: 'claude', key: 'c' });
    expect(pickProvider({ provider: 'GEMINI', geminiKey: 'g', anthropicKey: 'c' })).toEqual({ provider: 'gemini', key: 'g' });
    expect(pickProvider({ provider: 'gemini', anthropicKey: 'c' })).toBe(null);
    expect(pickProvider({ provider: 'claude', geminiKey: 'g' })).toBe(null);
    expect(pickProvider({ provider: 'anthropic', anthropicKey: 'c' })).toEqual({ provider: 'claude', key: 'c' });
    expect(pickProvider({ provider: 'khác', geminiKey: 'g' })).toEqual({ provider: 'gemini', key: 'g' });
  });
  it('mô hình mặc định cho từng nhà cung cấp', () => {
    expect(MODEL_DEFAULTS.gemini).toBe('gemini-3.8-flash');                // mô hình đầu chuỗi
    expect(MODEL_DEFAULTS.claude).toBe('claude-haiku-4-5-20251001');
  });
});

describe('gọi Gemini (fetch giả)', () => {
  it('đúng địa chỉ, khoá ở tiêu đề x-goog-api-key (không ở địa chỉ hay thân), đủ systemInstruction/contents/generationConfig', async () => {
    let seen;
    const r = await callGemini(Object.assign({}, base, { fetchFn: async (url, init) => { seen = { url, init }; return okRes([{ text: GOOD }]); } }));
    expect(r).toEqual({ ok: true, text: GOOD });
    expect(seen.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
    expect(seen.init.method).toBe('POST');
    expect(seen.init.headers['x-goog-api-key']).toBe(base.key);
    expect(seen.url).not.toContain(base.key);
    expect(seen.init.body).not.toContain(base.key);
    const b = JSON.parse(seen.init.body);
    expect(b.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
    expect(b.contents).toEqual([{ role: 'user', parts: [{ text: 'USR' }] }]);
    expect(b.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: GEMINI_MAX_TOKENS, responseMimeType: 'application/json' });
  });
  it('tên mô hình được mã hoá trong địa chỉ (không chèn được đường dẫn lạ)', async () => {
    let url;
    await callGemini(Object.assign({}, base, { model: 'x/../../evil?y=1', fetchFn: async (u) => { url = u; return okRes([{ text: 'a' }]); } }));
    expect(url).toContain('/models/x%2F..%2F..%2Fevil%3Fy%3D1:generateContent');
  });
  it('ghép các khối chữ, bỏ khối "suy nghĩ" (thought) của mô hình', async () => {
    const r = await callGemini(Object.assign({}, base, { fetchFn: async () => okRes([{ text: 'suy nghĩ riêng', thought: true }, { text: '{"a":' }, { text: '1}' }]) }));
    expect(r).toEqual({ ok: true, text: '{"a":1}' });
  });
  it('phân loại lỗi: khoá sai (400 API key not valid, 403), sai mô hình (404), hết hạn mức (429), lỗi máy chủ, mạng', async () => {
    const code = async (res) => (await callGemini(Object.assign({}, base, { fetchFn: async () => res }))).code;
    expect(await code({ ok: false, status: 400, json: async () => ({ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } }) })).toBe('invalid_key');
    expect(await code({ ok: false, status: 400, json: async () => ({ error: { message: 'API_KEY_INVALID' } }) })).toBe('invalid_key');
    expect(await code({ ok: false, status: 400, json: async () => ({ error: { message: 'Billing account required' } }) })).toBe('billing');
    expect(await code({ ok: false, status: 400, json: async () => ({ error: { message: 'Unknown field' } }) })).toBe('upstream');
    expect(await code({ ok: false, status: 403 })).toBe('invalid_key');
    expect(await code({ ok: false, status: 401 })).toBe('invalid_key');
    expect(await code({ ok: false, status: 404 })).toBe('bad_model');
    expect(await code({ ok: false, status: 429 })).toBe('rate_limited');
    expect(await code({ ok: false, status: 503 })).toBe('upstream');
    expect(await code({ ok: false, status: 500 })).toBe('upstream');
    expect((await callGemini(Object.assign({}, base, { fetchFn: async () => { throw new Error('ENOTFOUND'); } }))).code).toBe('network');
  });
  it('không có ứng viên (bị bộ lọc an toàn chặn), nội dung rỗng, chỉ có khối suy nghĩ, JSON phản hồi hỏng: bad_output hoặc upstream', async () => {
    const code = async (res) => (await callGemini(Object.assign({}, base, { fetchFn: async () => res }))).code;
    expect(await code({ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }) })).toBe('bad_output');
    expect(await code({ ok: true, status: 200, json: async () => ({ candidates: [] }) })).toBe('bad_output');
    expect(await code({ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'SAFETY' }] }) })).toBe('bad_output');
    expect(await code(okRes([{ text: '   ' }]))).toBe('bad_output');
    expect(await code(okRes([{ text: 'chỉ nghĩ', thought: true }]))).toBe('bad_output');
    expect(await code({ ok: true, status: 200, json: async () => { throw new Error('x'); } })).toBe('upstream');
  });
  it('lỗi không chép nội dung phản hồi của nhà cung cấp (không lộ khoá)', async () => {
    const r = await callGemini(Object.assign({}, base, { fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'API key not valid: AIza-KHONG-THAT' } }) }) }));
    expect(JSON.stringify(r)).not.toContain('AIza');
    expect(r.error).toBe(messageFor('invalid_key'));
  });
  it('văn bản JSON do Gemini trả về đi qua cùng bộ kiểm khuôn: ý không căn cứ bị bỏ', async () => {
    const r = await callGemini(Object.assign({}, base, { fetchFn: async () => okRes([{ text: '```json\n' + JSON.stringify({ headline: 'h', points: [{ topic: 'A', text: 'Có căn cứ', refs: [1] }, { topic: 'B', text: 'Không căn cứ', refs: [] }] }) + '\n```' }]) }));
    expect(parseModel(r.text, 3).points.map((p) => p.topic)).toEqual(['A']);
  });
});

describe('mức suy nghĩ và chẩn đoán lỗi của Gemini', () => {
  it('có thinking thì gửi generationConfig.thinkingConfig.thinkingLevel; không có thì không gửi; maxTokens tuỳ chỉnh', async () => {
    let body;
    const f = async (u, init) => { body = JSON.parse(init.body); return okRes([{ text: 'a' }]); };
    await callGemini(Object.assign({}, base, { fetchFn: f, thinking: 'low', maxTokens: 512 }));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    expect(body.generationConfig.maxOutputTokens).toBe(512);
    await callGemini(Object.assign({}, base, { fetchFn: f }));
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
    expect(body.generationConfig.maxOutputTokens).toBe(GEMINI_MAX_TOKENS);
  });
  it('lỗi kèm mã HTTP và lời báo ngắn của Google (đã bỏ khoá) để chẩn đoán: 503 nhu cầu cao', async () => {
    const r = await callGemini(Object.assign({}, base, { fetchFn: async () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary.' } }) }) }));
    expect(r).toMatchObject({ ok: false, code: 'upstream', status: 503 });
    expect(r.detail).toContain('high demand');
    expect(r.detail.length).toBeLessThanOrEqual(160);
  });
  it('lời báo lỗi chứa khoá thì bị che; thân lỗi không đọc được thì vẫn có mã', async () => {
    const r = await callGemini(Object.assign({}, base, { fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad request near AIza-KHONG-THAT in header' } }) }) }));
    expect(r.detail).not.toContain('AIza-KHONG-THAT');
    expect(r.detail).toContain('[khoá]');
    const r2 = await callGemini(Object.assign({}, base, { fetchFn: async () => ({ ok: false, status: 502, json: async () => { throw new Error('x'); } }) }));
    expect(r2).toMatchObject({ ok: false, code: 'upstream', status: 502 });
    expect(r2.detail).toBe('');
  });
});

describe('callAi chuyển đúng nhà cung cấp', () => {
  it('gemini gọi địa chỉ Google, claude gọi địa chỉ Anthropic', async () => {
    const urls = [];
    const f = async (u) => { urls.push(u); return u.includes('anthropic') ? { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'c' }] }) } : okRes([{ text: 'g' }]); };
    expect((await callAi(Object.assign({}, base, { provider: 'gemini', fetchFn: f }))).text).toBe('g');
    expect((await callAi(Object.assign({}, base, { provider: 'claude', fetchFn: f }))).text).toBe('c');
    expect(urls[0]).toContain('generativelanguage.googleapis.com');
    expect(urls[1]).toContain('api.anthropic.com');
  });
  it('thông báo mới: không có khoá nhắc cả hai tên biến; sai mô hình có hướng dẫn', () => {
    expect(messageFor('no_key')).toMatch(/GEMINI_API_KEY.*ANTHROPIC_API_KEY/);
    expect(messageFor('bad_model')).toMatch(/AI_MODEL/);
  });
});
