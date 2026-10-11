/* --- FILE: /insight/insight-api.js ---
   Lớp dữ liệu của khu Insight: kho dữ liệu theo thời điểm, sở hữu và giao dịch nội bộ, luận điểm đầu tư, nhật ký dự phóng, đầu vào chấm dự phóng.
   Phép tính nằm ở lib/pit-calc.js, ownership-calc.js, thesis-calc.js, forecast-accuracy.js; ở đây chỉ đọc/ghi bảng (RLS của cơ sở dữ liệu quyết định ai được làm gì) và gọi Edge Function insight-sync.
   Nạp SAU api.js (cần API, sbClient, getUserId); gắn vào API.insight để callGAS dùng chung phiên và xử lý lỗi với phần còn lại của ứng dụng. */
API.insight = {
    _symbols: (symbols, cap) => [...new Set((symbols || []).map(s => String(s || '').trim().toUpperCase()).filter(s => /^[A-Z0-9]{1,12}$/.test(s)))].slice(0, cap || 60),
    _invoke: async (name, body) => {
        const { data, error } = await sbClient.functions.invoke(name, { body });
        if (error) {
            let detail = error.message;
            try { const j = await error.context.json(); if (j && j.error) detail = j.error; } catch (e) { /* giữ message mặc định */ }
            throw new Error(detail);
        }
        return data;
    },

    // ---------- Kho dữ liệu theo thời điểm ----------
    pitStatus: async () => {
        const [days, fund, news, runs] = await Promise.all([
            API.asset._fetchAll(() => sbClient.from('finance_pit_market_daily').select('as_of, n, captured_at').order('as_of', { ascending: true })),
            sbClient.from('finance_pit_fundamentals').select('seen_at', { count: 'exact' }).order('seen_at', { ascending: true }).limit(1),
            sbClient.from('finance_pit_news').select('first_seen', { count: 'exact' }).order('first_seen', { ascending: true }).limit(1),
            sbClient.from('finance_function_runs').select('fn, mode, run_at, ok, detail').in('fn', ['pit-capture', 'insight-sync']).order('run_at', { ascending: false }).limit(40),
        ]);
        return {
            days: days || [],
            fundamentals: { count: fund.count || 0, first: fund.data && fund.data[0] ? fund.data[0].seen_at : null },
            news: { count: news.count || 0, first: news.data && news.data[0] ? news.data[0].first_seen : null },
            runs: runs.data || [],
        };
    },
    // Bản chụp thị trường mới nhất có ngày <= date (một dòng, đủ dữ liệu từng mã)
    pitDay: async (date) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('Ngày không hợp lệ');
        const { data, error } = await sbClient.from('finance_pit_market_daily').select('as_of, n, cols, data').lte('as_of', date).order('as_of', { ascending: false }).limit(1);
        if (error) throw error;
        return data && data[0] ? data[0] : null;
    },
    pitFundamentals: async (symbol) => {
        const sym = API.insight._symbols([symbol], 1)[0];
        if (!sym) throw new Error('Mã không hợp lệ');
        const { data, error } = await sbClient.from('finance_pit_fundamentals').select('symbol, seen_at, quarter_key, annual_year, form, data').eq('symbol', sym).order('seen_at', { ascending: true });
        if (error) throw error;
        return data || [];
    },

    // ---------- Sở hữu ----------
    ownership: async (symbol) => {
        const sym = API.insight._symbols([symbol], 1)[0];
        if (!sym) throw new Error('Mã không hợp lệ');
        const since = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
        const [holders, trades, sync, ratio] = await Promise.all([
            sbClient.from('finance_shareholders').select('*').eq('symbol', sym).order('pct', { ascending: false }),
            sbClient.from('finance_insider_trades').select('*').eq('symbol', sym).gte('public_date', since).order('public_date', { ascending: false }).limit(300),
            sbClient.from('finance_ownership_sync').select('*').eq('symbol', sym).maybeSingle(),
            sbClient.from('finance_stock_ratios').select('metrics, updated_at').eq('symbol', sym).maybeSingle(),
        ]);
        if (holders.error) throw holders.error;
        return { symbol: sym, holders: holders.data || [], trades: trades.data || [], sync: sync.data || null, ratios: ratio.data ? ratio.data.metrics : null };
    },
    ownershipOverview: async (symbols) => {
        const list = API.insight._symbols(symbols, 60);
        if (!list.length) return { symbols: [], trades: [], sync: [], ratios: {} };
        const since = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
        const [trades, sync, ratios] = await Promise.all([
            sbClient.from('finance_insider_trades').select('id, symbol, trader, position, action, status, shares_before, shares_after, registered, acquired, start_date, end_date, public_date').in('symbol', list).gte('public_date', since).order('public_date', { ascending: false }).limit(3000),
            sbClient.from('finance_ownership_sync').select('*').in('symbol', list),
            sbClient.from('finance_stock_ratios').select('symbol, metrics').in('symbol', list),
        ]);
        const r = {}; (ratios.data || []).forEach(x => { r[x.symbol] = x.metrics; });
        return { symbols: list, trades: trades.data || [], sync: sync.data || [], ratios: r };
    },
    // Nhờ máy chủ đồng bộ các mã (tối đa 10); máy chủ bỏ qua mã vừa đồng bộ trong 60 phút
    syncOwnership: async (symbols) => {
        const list = API.insight._symbols(symbols, 10);
        if (!list.length) throw new Error('Chưa có mã nào để đồng bộ');
        const r = await API.insight._invoke('insight-sync', { mode: 'ownership', symbols: list });
        if (!r || r.ok === false) throw new Error((r && r.error) || 'Đồng bộ sở hữu thất bại');
        return r;
    },

    // ---------- Luận điểm ----------
    thesisList: async () => {
        const open = ['idea', 'research', 'review', 'approved', 'in_portfolio'];
        const [ideas, conds, log, users] = await Promise.all([
            sbClient.from('finance_ideas').select('id, user_id, symbol, title, direction, status, thesis, entry_price, target_price, stop_price, conviction, horizon_months, updated_at').in('status', open).order('updated_at', { ascending: false }).limit(500),
            sbClient.from('finance_thesis_conditions').select('*').limit(5000),
            sbClient.from('finance_thesis_log').select('id, condition_id, idea_id, at, from_state, to_state, value').order('at', { ascending: false }).limit(150),
            sbClient.from('users').select('id, email, nickname').in('group_key', ['finance', 'admin']),
        ]);
        if (ideas.error) throw ideas.error;
        const members = {}; ((users && users.data) || []).forEach(u => { members[u.id] = u.nickname || String(u.email || '').split('@')[0]; });
        return { ideas: ideas.data || [], conditions: conds.data || [], log: log.data || [], members };
    },
    // Số liệu hiện tại để trang tự kiểm điều kiện ngay (cùng ThesisCalc với máy chủ): ảnh chụp thị trường, phòng khối ngoại, giao dịch nội bộ 100 ngày
    thesisContext: async (symbols) => {
        const list = API.insight._symbols(symbols, 100);
        if (!list.length) return { snapshots: {}, ratios: {}, insider: {}, synced: [], snapshotDate: null };
        const since = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
        const [snap, ratios, ins, sync] = await Promise.all([
            sbClient.from('finance_market_snapshot').select('symbol, metrics, daily_date').in('symbol', list),
            sbClient.from('finance_stock_ratios').select('symbol, metrics').in('symbol', list),
            sbClient.from('finance_insider_trades').select('id, symbol, trader, action, status, shares_before, shares_after, registered, acquired, start_date, end_date, public_date').in('symbol', list).gte('public_date', since),
            sbClient.from('finance_ownership_sync').select('symbol').eq('ok', true).in('symbol', list),
        ]);
        const s = {}, r = {}, i = {}; let asOf = null;
        (snap.data || []).forEach(x => { s[x.symbol] = x.metrics; if (x.daily_date && (!asOf || x.daily_date > asOf)) asOf = x.daily_date; });
        (ratios.data || []).forEach(x => { r[x.symbol] = x.metrics; });
        (ins.data || []).forEach(x => { (i[x.symbol] = i[x.symbol] || []).push(x); });
        return { snapshots: s, ratios: r, insider: i, synced: (sync.data || []).map(x => x.symbol), snapshotDate: asOf };
    },
    // input: { id?, ideaId, metric, op, threshold, severity, label, manualMet }
    saveThesisCondition: async (email, input) => {
        if (typeof ThesisCalc === 'undefined') throw new Error('Thiếu thư viện luận điểm (lib/thesis-calc.js)');
        const v = ThesisCalc.validate(input || {});
        if (!v.ok) throw new Error(v.error);
        if (!input.ideaId) throw new Error('Thiếu ý tưởng');
        const actor = await API.asset.limits._actor(email);
        const c = v.cond;
        const row = { metric: c.metric, op: c.op, threshold: c.threshold, severity: c.severity, label: c.label || null, manual_met: c.manualMet };
        if (input.id) {
            const { error } = await sbClient.from('finance_thesis_conditions').update(row).eq('id', input.id);
            if (error) throw error;
            return 'Đã cập nhật điều kiện';
        }
        const { count } = await sbClient.from('finance_thesis_conditions').select('id', { count: 'exact', head: true }).eq('idea_id', input.ideaId);
        if ((count || 0) >= 12) throw new Error('Mỗi ý tưởng tối đa 12 điều kiện: hãy giữ những điều kiện thật sự quyết định luận điểm.');
        const { error } = await sbClient.from('finance_thesis_conditions').insert(Object.assign({ idea_id: input.ideaId, user_id: actor.actorId }, row));
        if (error) throw error;
        return 'Đã thêm điều kiện';
    },
    deleteThesisCondition: async (email, id) => {
        const { error } = await sbClient.from('finance_thesis_conditions').delete().eq('id', id);
        if (error) throw error;
        return 'Đã xoá điều kiện';
    },
    setThesisManual: async (email, id, met) => {
        const { error } = await sbClient.from('finance_thesis_conditions').update({ manual_met: met === true ? true : (met === false ? false : null) }).eq('id', id);
        if (error) throw error;
        return 'Đã cập nhật';
    },

    // ---------- Độ chính xác dự phóng ----------
    accuracyInputs: async () => {
        const [vb, ideas, decisions, forecasts, users] = await Promise.all([
            sbClient.from('finance_vb_valuations').select('id, user_id, symbol, as_of, price, fair_low, fair_base, fair_high, methods, created_at').order('created_at', { ascending: false }).limit(3000),
            sbClient.from('finance_ideas').select('id, user_id, symbol, direction, status, entry_price, target_price, stop_price, horizon_months, conviction, tags, created_at, closed_at, close_price, close_reason').limit(2000),
            sbClient.from('finance_decisions').select('id, user_id, symbol, action, decided_at, price_at_decision, expected_price, stop_price, horizon_months, confidence, tags').is('deleted_at', null).limit(3000),
            sbClient.from('finance_forecasts').select('*').order('made_at', { ascending: false }).limit(2000),
            sbClient.from('users').select('id, email, nickname').in('group_key', ['finance', 'admin']),
        ]);
        [vb, ideas, decisions, forecasts].forEach(r => { if (r.error) throw r.error; });
        const members = {}; ((users && users.data) || []).forEach(u => { members[u.id] = u.nickname || String(u.email || '').split('@')[0]; });
        return { valuations: vb.data || [], ideas: ideas.data || [], decisions: decisions.data || [], forecasts: forecasts.data || [], members };
    },
    // Giá lịch sử (thô) + sự kiện doanh nghiệp để điều chỉnh giá; from = ngày đầu cần. Không lấy khối lượng.
    forwardInputs: async (symbols, from) => {
        const list = API.insight._symbols(symbols, 40);
        const to = new Date().toISOString().slice(0, 10);
        const floor = new Date(Date.now() - 2590 * 86400000).toISOString().slice(0, 10);
        let start = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? String(from) : floor;
        if (start < floor) start = floor;
        const histories = {}; let error = null;
        for (let i = 0; i < list.length || i === 0; i += 20) {
            try { Object.assign(histories, await API.asset.getPriceHistory(list.slice(i, i + 20).concat(i === 0 ? ['VNINDEX'] : []), start, to)); }
            catch (e) { error = e.message || String(e); }
            if (i + 20 >= list.length) break;
        }
        let events = [], eventsError = null;
        if (list.length) { try { events = (await API.asset.events._fetchEvents(list, start)).events; } catch (e) { eventsError = e.message || String(e); } }
        return { histories, events, error, eventsError, from: start, to, symbols: list };
    },
    // Số liệu thực tế (báo cáo tài chính) để chấm dự phóng lợi nhuận: bảng đệm trước, mã thiếu thì hỏi stock-financials
    forecastActuals: async (symbols) => {
        const list = API.insight._symbols(symbols, 20);
        if (!list.length) return { results: {}, errors: {} };
        const results = {}, errors = {};
        const cache = await API.stock.getFinancialsCache(list).catch(() => ({}));
        Object.keys(cache).forEach(s => { results[s] = cache[s]; });
        const missing = list.filter(s => !results[s]);
        if (missing.length) {
            try { const r = await API.stock.fetchFinancials(missing); Object.assign(results, r.results || {}); Object.assign(errors, r.errors || {}); }
            catch (e) { missing.forEach(s => { errors[s] = e.message || String(e); }); }
        }
        return { results, errors };
    },
    saveForecast: async (email, f) => {
        const sym = API.insight._symbols([f && f.symbol], 1)[0];
        if (!sym) throw new Error('Mã không hợp lệ');
        if (!['lnst', 'revenue'].includes(f.metric)) throw new Error('Chọn chỉ tiêu: lợi nhuận sau thuế hoặc doanh thu');
        const year = Math.round(Number(f.year)), quarter = f.quarter === null || f.quarter === undefined || f.quarter === '' ? null : Math.round(Number(f.quarter));
        if (!(year >= 2015 && year <= 2100)) throw new Error('Năm không hợp lệ');
        if (quarter !== null && !(quarter >= 1 && quarter <= 4)) throw new Error('Quý phải từ 1 đến 4 (để trống nếu dự phóng cả năm)');
        const value = Number(f.value);
        if (!isFinite(value)) throw new Error('Giá trị dự phóng phải là số');
        const actor = await API.asset.limits._actor(email);
        const { error } = await sbClient.from('finance_forecasts').insert({ user_id: actor.actorId, symbol: sym, metric: f.metric, year, quarter, value, note: f.note ? String(f.note).slice(0, 300) : null });
        if (error) throw error;
        return 'Đã ghi dự phóng. Dự phóng đã ghi không sửa được; muốn đổi thì ghi dự phóng mới.';
    },
    deleteForecast: async (email, id) => {
        const { error } = await sbClient.from('finance_forecasts').delete().eq('id', id);
        if (error) throw error;
        return 'Đã xoá dự phóng';
    },
};
