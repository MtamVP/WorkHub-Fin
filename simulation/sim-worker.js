/* --- FILE: /simulation/sim-worker.js ---
   Luồng nền (Web Worker) của Market Simulation: ước lượng mô hình, chạy hàng chục nghìn đường mô phỏng và kiểm chứng ngược mà không làm đứng giao diện.
   Mọi phép tính nằm ở /lib/sim-models.js và /lib/market-sim.js (có kiểm thử); file này chỉ nhận lệnh và trả kết quả.
   Lệnh: { id, type: 'prepare', input, opts } -> mô tả mô hình; { id, type: 'simulate', book, policies, opts }; { id, type: 'backtest', opts }. */
importScripts('../lib/sim-models.js?v=1792400000000', '../lib/market-sim.js?v=1792400000001');

let ctx = null, lastIndex = null;
self.onmessage = function (e) {
    const m = e.data || {};
    const reply = (ok, data) => self.postMessage(ok ? { id: m.id, ok: true, data: data } : { id: m.id, ok: false, error: data });
    try {
        if (m.type === 'prepare') {
            ctx = MarketSim.prepare(m.input, m.opts); lastIndex = (m.input && m.input.index) || null;
            reply(true, MarketSim.describe(ctx));
        } else if (m.type === 'simulate') {
            if (!ctx || !ctx.ok) { reply(false, 'Mô hình chưa sẵn sàng.'); return; }
            reply(true, MarketSim.simulate(ctx, m.book, m.policies, m.opts));
        } else if (m.type === 'backtest') {
            if (!lastIndex) { reply(false, 'Chưa có lịch sử VN-Index.'); return; }
            reply(true, MarketSim.backtest(MarketSim.logRets(lastIndex), m.opts));
        } else reply(false, 'Lệnh không hợp lệ.');
    } catch (err) { reply(false, String((err && err.message) || err)); }
};
