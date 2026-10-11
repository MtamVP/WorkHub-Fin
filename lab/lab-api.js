/* --- FILE: /lab/lab-api.js ---
   Lớp dữ liệu của Phòng kiểm thử: tải kho giá theo ngày (finance_price_days) và số liệu cơ bản theo thời điểm (finance_pit_market_daily) về máy, DỰNG DẦN bảng giá (lib/bt-panel.js), lưu / đọc các lần kiểm thử.
   Mỗi dòng ngày của kho KHÔNG BAO GIỜ đổi sau khi đã ghi (lợi suất tính từ giá tham chiếu của sàn), nên bản lưu trong IndexedDB của máy luôn đúng và lần sau chỉ tải thêm ngày mới.
   Phép tính nằm ở lib/bt-panel.js và lib/strategy-backtest.js; ở đây chỉ đọc/ghi bảng (RLS quyết định ai được làm gì). Nạp SAU api.js (cần API, sbClient, getUserId); gắn vào API.lab. */
API.lab = {
    _kv: undefined,                                   // undefined = chưa thử mở; null = không dùng được (bị chặn); đối tượng = { keys, get, put, each }
    _hash: (spec) => {                                // băm cấu hình (bỏ tên) để đếm số cấu hình KHÁC NHAU đã thử
        const s = JSON.stringify(Object.assign({}, spec, { name: '' }));
        let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    },
    // IndexedDB tối giản: 2 kho (days, pit). Mọi lỗi (chế độ riêng tư, bị chặn) -> không dùng bộ nhớ đệm, vẫn chạy bình thường.
    _openKv: () => new Promise((resolve) => {
        try {
            if (typeof indexedDB === 'undefined') { resolve(null); return; }
            const req = indexedDB.open('wh-lab', 1);
            req.onupgradeneeded = () => { const db = req.result; db.createObjectStore('days', { keyPath: 'day' }); db.createObjectStore('pit', { keyPath: 'key' }); };
            req.onerror = () => resolve(null); req.onblocked = () => resolve(null);
            req.onsuccess = () => {
                const db = req.result;
                const tx = (store, mode) => db.transaction(store, mode).objectStore(store);
                const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
                resolve({
                    keys: async (store) => new Set(await wrap(tx(store, 'readonly').getAllKeys())),
                    get: (store, key) => wrap(tx(store, 'readonly').get(key)),
                    put: (store, value) => wrap(tx(store, 'readwrite').put(value)),
                    each: (store, fn) => new Promise((res, rej) => { const c = tx(store, 'readonly').openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { fn(cur.value); cur.continue(); } else res(); }; c.onerror = () => rej(c.error); }),
                    clear: async () => { await wrap(tx('days', 'readwrite').clear()); await wrap(tx('pit', 'readwrite').clear()); },
                });
            };
        } catch (e) { resolve(null); }
    }),
    _getKv: async () => { if (API.lab._kv === undefined) API.lab._kv = await API.lab._openKv(); return API.lab._kv; },

    // Tải kho giá và dựng bảng. onProgress({ frac, text }). Trả { panel, downloaded, fromCache, serverDays }.
    loadPanel: async (onProgress) => {
        const prog = (frac, text) => { if (onProgress) onProgress({ frac, text }); };
        if (typeof BtPanel === 'undefined') throw new Error('Thiếu thư viện bảng giá (lib/bt-panel.js)');
        prog(0.02, 'Đọc chuỗi chỉ số…');
        const idx = await API.asset._fetchAll(() => sbClient.from('finance_bt_index').select('symbol, data').order('symbol'));
        const vn = idx.find((r) => r.symbol === 'VNINDEX');
        if (!vn || !vn.data || !Array.isArray(vn.data.d) || vn.data.d.length < 100) throw new Error('Kho giá chưa được dựng (hàm bt-data chưa chạy). Xem RUNBOOK mục 15.');
        const calendar = vn.data.d.filter((d) => d >= '2020-01-02');
        prog(0.05, 'Đọc danh sách ngày trên máy chủ…');
        const serverDays = (await API.asset._fetchAll(() => sbClient.from('finance_price_days').select('day').order('day'))).map((r) => String(r.day));
        if (serverDays.length < 300) throw new Error('Kho giá mới có ' + serverDays.length + ' ngày (cần ít nhất 300).');
        const kv = await API.lab._getKv();
        const cached = kv ? await kv.keys('days').catch(() => new Set()) : new Set();
        const have = serverDays.filter((d) => cached.has(d)), need = serverDays.filter((d) => !cached.has(d));
        const builder = BtPanel.create(calendar);
        let done = 0; const total = serverDays.length;
        if (have.length && kv) {
            prog(0.08, 'Đọc kho đã lưu trên máy (' + have.length + ' ngày)…');
            const haveSet = new Set(have);
            await kv.each('days', (row) => { if (haveSet.has(row.day)) { builder.add(row); done++; } });
            prog(0.08 + 0.2 * done / total, 'Đã đọc ' + done + ' ngày từ máy…');
        }
        const chunks = []; for (let i = 0; i < need.length; i += 20) chunks.push(need.slice(i, i + 20));
        let next = 0, fetched = 0;
        const worker = async () => {
            while (next < chunks.length) {
                const part = chunks[next++];
                const { data, error } = await sbClient.from('finance_price_days').select('day, data').in('day', part);
                if (error) throw error;
                for (const row of (data || [])) {
                    const r = { day: String(row.day), data: row.data };
                    builder.add(r); fetched++; done++;
                    if (kv) { try { await kv.put('days', r); } catch (e) { /* hết dung lượng: bỏ qua, lần sau tải lại */ } }
                }
                prog(0.3 + 0.65 * fetched / Math.max(1, need.length), 'Đã tải ' + fetched + '/' + need.length + ' ngày mới…');
            }
        };
        await Promise.all([worker(), worker(), worker()]);
        prog(0.97, 'Dựng bảng giá…');
        const panel = builder.finish(idx);
        return { panel, downloaded: fetched, fromCache: have.length, serverDays: serverDays.length };
    },
    // Bản chụp số liệu cơ bản theo thời điểm (mọi ngày: cuối tháng dựng ngược + ngày chụp thật). Trả mảng đã giải mã (PitCalc.decodeDays).
    loadPit: async (onProgress) => {
        if (typeof PitCalc === 'undefined') throw new Error('Thiếu thư viện kho theo thời điểm (lib/pit-calc.js)');
        const list = await API.asset._fetchAll(() => sbClient.from('finance_pit_market_daily').select('as_of, n, source').order('as_of'));
        if (!list.length) return { days: [], first: null, last: null, n: 0, backfill: 0 };
        const kv = await API.lab._getKv();
        const keyOf = (r) => String(r.as_of) + '|' + r.n;
        const cached = kv ? await kv.keys('pit').catch(() => new Set()) : new Set();
        const rows = [], need = [];
        for (const r of list) { if (cached.has(keyOf(r)) && kv) { const c = await kv.get('pit', keyOf(r)); if (c && c.row) { rows.push(c.row); continue; } } need.push(r); }
        for (let i = 0; i < need.length; i += 6) {
            const part = need.slice(i, i + 6);
            const { data, error } = await sbClient.from('finance_pit_market_daily').select('as_of, n, cols, data').in('as_of', part.map((r) => r.as_of));
            if (error) throw error;
            for (const row of (data || [])) { rows.push(row); if (kv) { try { await kv.put('pit', { key: String(row.as_of) + '|' + row.n, row }); } catch (e) { /* bỏ qua */ } } }
            if (onProgress) onProgress({ frac: Math.min(1, (i + part.length) / Math.max(1, need.length)), text: 'Đã tải ' + Math.min(need.length, i + part.length) + '/' + need.length + ' ngày số liệu cơ bản…' });
        }
        const days = PitCalc.decodeDays(rows);
        return { days, first: days.length ? days[0].asOf : null, last: days.length ? days[days.length - 1].asOf : null, n: days.length, backfill: list.filter((r) => r.source === 'backfill').length };
    },
    clearCache: async () => { const kv = await API.lab._getKv(); if (kv) await kv.clear(); return 'Đã xoá kho đã lưu trên máy này.'; },

    // ---------- các lần kiểm thử đã lưu ----------
    listRuns: async () => {
        const { data, error } = await sbClient.from('finance_bt_runs').select('id, name, note, created_at, data_through, spec, brief:summary->brief').is('deleted_at', null).order('created_at', { ascending: false }).limit(200);
        if (error) throw error;
        return data || [];
    },
    getRun: async (id) => {
        const { data, error } = await sbClient.from('finance_bt_runs').select('id, name, note, created_at, data_through, spec, summary').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!data) throw new Error('Không tìm thấy lần kiểm thử');
        return data;
    },
    // Tóm tắt gọn của một kết quả (để liệt kê và để tính số lần thử): không chứa mảng lớn
    brief: (res) => {
        if (!res || !res.ok) return null;
        const rd = res.random, ex = res.metrics.cagr - res.bench.cagr;
        const sdD = res.metrics.sharpe / Math.sqrt(252);
        return { cagr: res.metrics.cagr, sharpe: res.metrics.sharpe, srDaily: sdD, maxDD: res.metrics.maxDD, excess: ex, randomRank: rd ? rd.cagr.rank : null, dsr: res.dsr ? res.dsr.dsr : null, hash: API.lab._hash(res.spec), from: res.period.from, to: res.period.to };
    },
    // input: { name, note, result }. Cắt bớt phần lớn để vừa giới hạn kích thước (giữ 60 kỳ cân bằng cuối).
    saveRun: async (email, input) => {
        const res = input && input.result;
        if (!res || !res.ok) throw new Error('Chưa có kết quả để lưu');
        const name = String(input.name || res.spec.name || '').trim().slice(0, 120) || 'Kiểm thử';
        const actor = await API.asset.limits._actor(email);
        const summary = Object.assign({}, res, { rebalances: (res.rebalances || []).slice(-60), brief: API.lab.brief(res) });
        const { data, error } = await sbClient.from('finance_bt_runs').insert({ user_id: actor.actorId, name, spec: res.spec, summary, data_through: res.dataThrough, note: input.note ? String(input.note).slice(0, 1000) : null }).select('id').single();
        if (error) throw error;
        return { id: data.id, message: 'Đã lưu lần kiểm thử' };
    },
    deleteRun: async (email, id) => {
        const { error } = await sbClient.from('finance_bt_runs').update({ deleted_at: new Date().toISOString() }).eq('id', id);
        if (error) throw error;
        return 'Đã xoá lần kiểm thử';
    },
    // Số cấu hình KHÁC NHAU đã thử (trên máy này + các lần đã lưu) và phương sai Sharpe theo ngày giữa chúng -> đầu vào của Sharpe đã trừ may rủi.
    trials: (savedRuns, excludeHash) => {
        const m = new Map();
        try { const loc = JSON.parse(localStorage.getItem('lab-trials') || '{}'); Object.keys(loc).forEach((h) => { if (isFinite(loc[h].sr)) m.set(h, loc[h].sr); }); } catch (e) { /* chưa có hoặc bị chặn */ }
        (savedRuns || []).forEach((r) => { const b = r.brief; if (b && b.hash && isFinite(b.srDaily)) m.set(b.hash, b.srDaily); });
        if (excludeHash) m.delete(excludeHash);          // chạy lại đúng cấu hình đã thử thì không tính là một lần thử mới
        const v = [...m.values()], n = v.length;
        let variance = null;
        if (n >= 3) { const mean = v.reduce((a, b) => a + b, 0) / n; variance = v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1); }
        return { count: n, srVarDaily: variance && variance > 0 ? variance : null };
    },
    noteTrial: (res) => {
        const b = API.lab.brief(res); if (!b) return;
        try {
            const loc = JSON.parse(localStorage.getItem('lab-trials') || '{}');
            loc[b.hash] = { sr: b.srDaily, at: Date.now() };
            const keys = Object.keys(loc); if (keys.length > 300) keys.sort((a, c) => loc[a].at - loc[c].at).slice(0, keys.length - 300).forEach((k) => { delete loc[k]; });
            localStorage.setItem('lab-trials', JSON.stringify(loc));
        } catch (e) { /* bị chặn */ }
    },
};
