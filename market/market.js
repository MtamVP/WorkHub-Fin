/* --- FILE: /market/market.js ---
   Trang "Thị Trường": chỉ số (VN-Index, VN30, HNX-Index, HNX30, UPCoM-Index), biểu đồ trong ngày/1 tháng-1 năm, độ rộng và thanh khoản theo sàn, khối ngoại, cổ phiếu nổi bật,
   ngành trong ngày và định giá thị trường. Mọi phép tính ở lib/market-overview.js (có kiểm thử); file này chỉ lấy dữ liệu, điều phối và vẽ.
   Dữ liệu: VNDirect dchart + finfo gọi thẳng từ ứng dụng (CORS mở, không cần khoá, không ghi gì lên máy chủ). Ngành và định giá cần đăng nhập (đọc ảnh chụp thị trường hằng ngày của WorkHub) nên chỉ là phần bổ sung:
   thiếu thì thẻ đó báo "chưa có" chứ không làm hỏng trang. Mỗi phần tải độc lập: một nguồn lỗi chỉ làm trống phần của nó. Trong phiên giao dịch tự làm mới mỗi 30 giây (dừng khi tab bị ẩn). */
const MarketPage = (function () {
    const MO = MarketOverview;
    const DCHART = 'https://dchart-api.vndirect.com.vn/dchart/history', FINFO = 'https://api-finfo.vndirect.com.vn/v4';
    const KEY = 'wh.fin.market.v1';
    const POLL_MS = 30000, DAILY_TTL = 10 * 60000, FOREIGN_TTL = 60000;
    const S = { index: 'VNINDEX', exchange: 'HOSE', range: '1D', mover: 'gain', secMode: null,
        daily: {}, dailyAt: 0, extraAt: 0, sectorAt: 0, sectorErr: false, morePromise: null, intraday: {}, rows: null, frows: null, date: null, boardDate: null, fetchedAt: 0, foreignAt: 0, errors: {},
        busy: false, started: false, universe: null, uniState: 'idle', val: null, valState: 'idle', timer: null };

    // ---------- tiện ích ----------
    const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const $ = (id) => document.getElementById(id);
    const isNum = (v) => typeof v === 'number' && isFinite(v);
    const dec = (v, d) => (isNum(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
    const sgn = (v, d) => (isNum(v) ? (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
    const tone = (v) => (!isNum(v) || Math.abs(v) < 0.005 ? 'mk-flat' : (v > 0 ? 'mk-up' : 'mk-down'));
    const dmy = (iso) => { const p = String(iso || '').slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : ''; };
    const dm = (iso) => String(iso || '').slice(8, 10) + '/' + String(iso || '').slice(5, 7);
    function ty(v, signed) {                       // đồng -> "x tỷ" hoặc "x nghìn tỷ"
        if (!isNum(v)) return '—';
        const a = Math.abs(v), s = signed ? (v > 0 ? '+' : (v < 0 ? '−' : '')) : (v < 0 ? '−' : '');
        if (a >= 1e12) return s + dec(a / 1e12, 2) + ' nghìn tỷ';
        if (a < 1e9) return Math.round(a / 1e6) === 0 ? '0' : s + dec(a / 1e6, 0) + ' tr';       // dưới 1 tỷ: tính bằng triệu; dưới nửa triệu là 0 (tránh "−0 tr", "−0,0 tỷ")
        return s + dec(a / 1e9, a >= 1e10 ? 0 : 1) + ' tỷ';
    }
    const vol = (v) => (!isNum(v) ? '—' : (v >= 1e6 ? dec(v / 1e6, 1) + ' tr' : (v >= 1e3 ? dec(v / 1e3, 0) + ' k' : dec(v, 0))));
    const priceFmt = (dong) => dec(dong / 1000, 2);
    function load() { try { const o = JSON.parse(localStorage.getItem(KEY) || 'null'); if (o) { if (MO.INDICES.some((i) => i.code === o.index)) S.index = o.index; if (MO.EXCHANGES.indexOf(o.exchange) !== -1) S.exchange = o.exchange; if (MO.RANGES.some((r) => r.key === o.range)) S.range = o.range; if (MO.MOVER_KINDS.some((k) => k.key === o.mover)) S.mover = o.mover; if (o.secMode === 'icb' || o.secMode === 'idx') S.secMode = o.secMode; } } catch (e) { /* mặc định */ } }
    function save() { try { localStorage.setItem(KEY, JSON.stringify({ index: S.index, exchange: S.exchange, range: S.range, mover: S.mover, secMode: S.secMode })); } catch (e) { /* bỏ qua */ } }
    const ixOf = (code) => MO.INDICES.filter((i) => i.code === code)[0] || MO.INDICES[0];
    const sessionState = () => (typeof LiveQuotes !== 'undefined' ? LiveQuotes.session() : 'closed');

    async function getJson(url, ms) {
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = ctl ? setTimeout(() => ctl.abort(), ms || 12000) : null;
        try { const r = await fetch(url, ctl ? { signal: ctl.signal } : {}); if (!r || !r.ok) return null; return await r.json(); } catch (e) { return null; } finally { if (timer) clearTimeout(timer); }
    }

    // ---------- dữ liệu ----------
    const merged = (code) => MO.mergeToday(S.daily[code], S.intraday[code], sessionState() === 'open' || sessionState() === 'break');
    async function loadIndices(force) {
        const now = Math.floor(Date.now() / 1000), needDaily = force || !S.dailyAt || Date.now() - S.dailyAt > DAILY_TTL || MO.INDICES.some((ix) => !S.daily[ix.code]);
        let gotDaily = 0, got = 0;
        await Promise.all(MO.INDICES.map(async (ix) => {
            const [dj, ij] = await Promise.all([
                needDaily ? getJson(DCHART + '?resolution=D&symbol=' + ix.code + '&from=' + (now - 400 * 86400) + '&to=' + (now + 600)) : null,
                getJson(DCHART + '?resolution=1&symbol=' + ix.code + '&from=' + (now - 4 * 86400) + '&to=' + (now + 600)),
            ]);
            const d = dj ? MO.parseDaily(dj) : [], p = ij ? MO.parseIntraday(ij) : [];
            if (d.length) { S.daily[ix.code] = d; gotDaily++; }
            if (p.length) { S.intraday[ix.code] = p; got++; }
        }));
        if (needDaily && gotDaily) S.dailyAt = Date.now();
        S.errors.indices = (gotDaily || got) ? null : (Object.keys(S.daily).length ? 'Không cập nhật được chỉ số — đang hiển thị số liệu cũ.' : 'Không lấy được chỉ số từ VNDirect.');
        const vn = merged('VNINDEX') || [], any = vn.length ? vn : (merged(S.index) || []);
        S.date = any.length ? any[any.length - 1].date : S.date;
        const t = typeof LiveQuotes !== 'undefined' ? LiveQuotes.vnParts(Date.now()).date : null;     // lịch lễ chỉ là gợi ý: nếu nguồn có nến của hôm nay thì tin dữ liệu
        if (t && S.date === t && LiveQuotes.session() === 'holiday') LiveQuotes.state.holidayLiveDate = t;
    }
    function prevDate() { const d = merged('VNINDEX') || []; return d.length > 1 ? d[d.length - 2].date : null; }
    async function loadBoard(force) {
        if (!S.date) return;
        const tryDates = [S.date].concat(prevDate() ? [prevDate()] : []);
        let rows = null, used = null;
        for (const d of tryDates) {
            const pj = await getJson(FINFO + '/stock_prices?q=date:' + d + '&size=3000', 25000);
            const r = pj ? MO.parsePrices(pj, d) : [];
            if (r.length) { rows = r; used = d; break; }
        }
        if (rows) { S.rows = rows; S.boardDate = used; S.errors.board = null; } else S.errors.board = S.rows ? 'Không cập nhật được bảng giá — đang hiển thị số liệu cũ.' : 'Không lấy được bảng giá từ VNDirect.';
        if (rows && (force || !S.frows || Date.now() - S.foreignAt > FOREIGN_TTL || S.foreignDate !== used)) {
            const fj = await getJson(FINFO + '/foreigns?q=tradingDate:' + used + '&size=3000', 25000);
            const f = fj ? MO.parseForeign(fj, used) : [];
            if (f.length) { S.frows = f; S.foreignAt = Date.now(); S.foreignDate = used; S.errors.foreign = null; } else S.errors.foreign = S.frows ? 'Không cập nhật được khối ngoại.' : 'Chưa có số liệu khối ngoại.';
        }
        S.fetchedAt = Date.now();
    }
    // Nến ngày của các chỉ số bổ sung (VN100, VN Small Cap...) và chỉ số ngành HOSE. Tải sau phần chính để không làm chậm lần mở đầu; lỗi chỉ làm trống phần của nó.
    async function fetchDaily(code, days) {
        const now = Math.floor(Date.now() / 1000), j = await getJson(DCHART + '?resolution=D&symbol=' + code + '&from=' + (now - days * 86400) + '&to=' + (now + 600)), d = j ? MO.parseDaily(j) : [];
        if (d.length) { S.daily[code] = d; return true; }
        return false;
    }
    async function loadMore(force) {
        const open = sessionState() === 'open';
        const needExtra = force || !S.extraAt || Date.now() - S.extraAt > DAILY_TTL, needSec = force || !S.sectorAt || Date.now() - S.sectorAt > (open ? 60000 : DAILY_TTL);
        const jobs = [];
        if (needExtra) { S.extraAt = Date.now(); MO.EXTRA_INDICES.forEach((ix) => jobs.push(fetchDaily(ix.code, 400))); }
        if (needSec) { S.sectorAt = Date.now(); MO.SECTOR_INDICES.forEach((ix) => jobs.push(fetchDaily(ix.code, 120))); }
        if (jobs.length) await Promise.all(jobs);
        if (needSec) S.sectorErr = !MO.SECTOR_INDICES.some((ix) => S.daily[ix.code]);        // không có chỉ số ngành nào (kể cả bản cũ): báo lỗi thay vì chờ mãi
        renderPerf(); renderSectors();
    }
    async function refresh(force) {
        if (S.busy) return;
        S.busy = true;
        const btn = $('mk-refresh'); if (btn) { btn.disabled = true; btn.querySelector('i').classList.add('fa-spin'); }
        try {
            await loadIndices(!!force);
            renderIndices(); renderDetail(); renderStatus();
            await loadBoard(!!force);
        } catch (e) { S.errors.indices = 'Lỗi: ' + (e && e.message ? e.message : e); }
        finally {
            S.busy = false;
            if (btn) { btn.disabled = false; btn.querySelector('i').classList.remove('fa-spin'); }
            renderAll();
            S.morePromise = loadMore(!!force).catch(() => { /* phần bổ sung lỗi thì bỏ qua */ });
        }
    }
    async function loadOptional() {
        S.uniState = 'loading'; S.valState = 'loading'; renderSectors(); renderValuation();
        const call = async (action, params) => { if (typeof callGAS !== 'function') throw new Error('Chưa sẵn sàng'); const r = await callGAS(action, params || {}); if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Không đọc được ' + action); return r.data; };
        const u = call('getMarketUniverse', {}).then((d) => { S.universe = d && Array.isArray(d.snapshot) ? d : null; S.uniState = S.universe && S.universe.snapshot.length ? 'ok' : 'empty'; }, () => { S.uniState = 'unavailable'; }).then(() => { renderSectors(); renderContrib(); });
        const v = call('getValuationHistory', { years: 6 }).then((d) => { S.val = d || null; S.valState = d && d.rows && d.rows.length ? 'ok' : 'empty'; }, () => { S.valState = 'unavailable'; }).then(renderValuation);
        await Promise.all([u, v]);
    }

    // ---------- vẽ ----------
    function renderStatus() {
        const st = sessionState(), box = $('mk-session'), meta = $('mk-meta');
        const lab = { open: 'Đang giao dịch', break: 'Nghỉ trưa', pre: 'Chưa mở cửa', closed: 'Đã đóng cửa', holiday: 'Ngày nghỉ' }[st] || 'Đã đóng cửa';
        if (box) { box.className = 'mk-session ' + st; box.textContent = lab; }
        if (!meta) return;
        const parts = [];
        if (S.date) parts.push('Phiên ' + dmy(S.date));
        if (S.boardDate && S.boardDate !== S.date) parts.push('bảng giá của phiên ' + dmy(S.boardDate) + ' (phiên mới chưa có số liệu)');
        if (S.fetchedAt) { const p = LiveQuotes.vnParts(S.fetchedAt); parts.push('cập nhật ' + String(Math.floor(p.min / 60)).padStart(2, '0') + ':' + String(p.min % 60).padStart(2, '0') + ':' + String(p.sec).padStart(2, '0')); }
        if (st === 'open') parts.push('tự làm mới mỗi 30 giây');
        const errs = ['indices', 'board', 'foreign'].map((k) => S.errors[k]).filter(Boolean);
        meta.innerHTML = esc(parts.join(' · ')) + errs.map((e) => ' · <span class="mk-err">' + esc(e) + '</span>').join('');
    }

    function sparkSvg(rows, toneCls) {
        const pts = rows.slice(-30).map((r, i) => ({ x: i, y: r.c })), g = MO.lineGeometry(pts, 120, 30, { pad: { l: 1, r: 1, t: 2, b: 2 }, padY: 0.05 });
        if (!g) return '';
        return '<svg viewBox="0 0 120 30" preserveAspectRatio="none" class="' + toneCls + '" aria-hidden="true" focusable="false"><path d="' + g.d + '" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>';
    }
    function renderIndices() {
        const box = $('mk-indices'); if (!box) return;
        box.innerHTML = MO.INDICES.map((ix) => {
            const d = merged(ix.code), q = MO.quote(d);
            if (!q) return '<div class="mk-ix-skel" aria-hidden="true"></div>';
            const t = tone(q.pct);
            return '<button type="button" class="mk-ix" aria-pressed="' + (ix.code === S.index) + '" title="' + esc(ix.hint) + '" onclick="MarketPage.selectIndex(\'' + ix.code + '\')">' +
                '<span class="mk-ix-name">' + esc(ix.label) + '</span><span class="mk-ix-val mk-num">' + dec(q.last, 2) + '</span>' +
                '<span class="mk-ix-chg mk-num ' + t + '"><span>' + (isNum(q.change) ? (q.change > 0 ? '▲' : (q.change < 0 ? '▼' : '■')) + ' ' + dec(Math.abs(q.change), 2) : '—') + '</span><span>' + sgn(q.pct, 2) + '%</span></span>' + sparkSvg(d, t) + '</button>';
        }).join('');
    }

    // ----- biểu đồ chi tiết -----
    const CH = { geo: null, kind: null, label: null, ref: null, first: null };
    function chartSpec() {
        const code = S.index, d = merged(code), q = MO.quote(d), sess = MO.lastSession(S.intraday[code]);
        if (S.range === '1D' && sess.points.length >= 2) {
            const pts = MO.intradayPoints(sess.points), ref = q && q.date === sess.date && isNum(q.prev) ? q.prev : null;
            return { kind: 'intraday', pts: pts, ref: ref, date: sess.date, xMin: 0, xMax: 270, up: pts[pts.length - 1].y >= (ref !== null ? ref : pts[0].y) };
        }
        const r = MO.RANGES.filter((x) => x.key === S.range)[0], n = r && r.key !== '1D' ? r.sessions : 22;
        const w = MO.windowOf(d, n), pts = w.map((x, i) => ({ x: i, y: x.c, label: dmy(x.date), date: x.date }));
        return { kind: 'daily', pts: pts, ref: null, fallback: S.range === '1D', up: pts.length > 1 ? pts[pts.length - 1].y >= pts[0].y : true, xMin: 0, xMax: Math.max(1, pts.length - 1) };
    }
    function drawChart() {
        const host = $('mk-chart'); if (!host) return;
        const spec = chartSpec();
        if (spec.pts.length < 2) { host.innerHTML = '<div class="mk-empty"><i class="fa-solid fa-chart-line"></i>Chưa có dữ liệu biểu đồ cho khoảng thời gian này.</div>'; CH.geo = null; return; }
        const W = Math.max(280, Math.round(host.clientWidth || 640)), H = host.clientWidth && host.clientWidth < 420 ? 200 : 240, pad = { l: 8, r: 56, t: 12, b: 24 };
        const g = MO.lineGeometry(spec.pts, W, H, { pad: pad, xMin: spec.xMin, xMax: spec.xMax, include: spec.ref !== null ? [spec.ref] : [], padY: 0.1 });
        CH.geo = g; CH.spec = spec;
        const col = spec.up ? 'var(--mk-up)' : 'var(--mk-down)', gid = 'mkg' + Math.floor(Math.random() * 1e6);
        let grid = '';
        for (let i = 0; i <= 3; i++) {
            const v = g.yMin + (g.yMax - g.yMin) * i / 3, y = Math.round((pad.t + (g.yMax - v) / (g.yMax - g.yMin) * (H - pad.t - pad.b)) * 10) / 10;
            grid += '<line class="mk-grid-line" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y + '" y2="' + y + '"/><text class="mk-axis" x="' + (W - pad.r + 6) + '" y="' + (y + 3) + '">' + dec(v, v >= 1000 ? 0 : 2) + '</text>';
        }
        let xt = '';
        const xAt = (x) => Math.round((pad.l + (x - g.xMin) / (g.xMax - g.xMin) * (W - pad.l - pad.r)) * 10) / 10;
        if (spec.kind === 'intraday') MO.SESSION_TICKS.forEach((t) => { xt += '<text class="mk-axis" x="' + xAt(t.x) + '" y="' + (H - 6) + '" text-anchor="' + (t.x === 0 ? 'start' : (t.x === 270 ? 'end' : 'middle')) + '">' + t.label + '</text>'; });
        else { const n = spec.pts.length, step = Math.max(1, Math.floor((n - 1) / 4)); for (let i = 0; i < n; i += step) { if (n - 1 - i < step * 0.6 && i !== 0) continue; xt += '<text class="mk-axis" x="' + xAt(i) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : 'middle') + '">' + dm(spec.pts[i].date) + (S.range === '1Y' || S.range === '6M' ? '/' + String(spec.pts[i].date).slice(2, 4) : '') + '</text>'; } }
        const refLine = g.refY !== null ? '<line class="mk-ref-line" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + g.refY + '" y2="' + g.refY + '"/><text class="mk-axis" x="' + (pad.l + 2) + '" y="' + (g.refY - 4) + '" style="fill:var(--mk-ref)">TC ' + dec(spec.ref, 2) + '</text>' : '';
        const lastC = g.coords[g.coords.length - 1];
        host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(ixOf(S.index).label + ': ' + dec(spec.pts[spec.pts.length - 1].y, 2) + ' điểm') + '">' +
            '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + col + '" stop-opacity="0.22"/><stop offset="1" stop-color="' + col + '" stop-opacity="0"/></linearGradient></defs>' +
            grid + xt + refLine + '<path d="' + g.area + '" fill="url(#' + gid + ')"/><path class="mk-line" d="' + g.d + '" stroke="' + col + '"/>' +
            '<circle cx="' + lastC.px + '" cy="' + lastC.py + '" r="3.5" fill="' + col + '"/>' +
            '<line class="mk-cross" id="mk-cross" x1="0" x2="0" y1="' + pad.t + '" y2="' + (H - pad.b) + '"/><circle class="mk-dot" id="mk-dot" r="4" fill="' + col + '" stroke="var(--card-bg)" stroke-width="2" cx="0" cy="0"/></svg>' +
            '<div class="mk-tip" id="mk-tip"></div>';
        const svg = host.querySelector('svg'), tip = $('mk-tip'), cross = $('mk-cross'), dot = $('mk-dot');
        const move = (ev) => {
            const rect = svg.getBoundingClientRect(); if (!rect.width) return;
            const x = (ev.clientX - rect.left) / rect.width * W;
            let best = 0, bd = Infinity; g.coords.forEach((c, i) => { const dd = Math.abs(c.px - x); if (dd < bd) { bd = dd; best = i; } });
            const c = g.coords[best], p = spec.pts[best];
            cross.setAttribute('x1', c.px); cross.setAttribute('x2', c.px); dot.setAttribute('cx', c.px); dot.setAttribute('cy', c.py);
            const base = spec.ref !== null ? spec.ref : spec.pts[0].y, ch = (c.y / base - 1) * 100;
            tip.innerHTML = esc(p.label) + '<br><b>' + dec(c.y, 2) + '</b> <span class="' + tone(ch) + '">' + sgn(ch, 2) + '%</span>';
            const left = c.px / W * rect.width, tw = tip.offsetWidth || 80;
            tip.style.left = Math.max(0, Math.min(rect.width - tw, left - tw / 2)) + 'px';
            host.classList.add('hover');
        };
        svg.addEventListener('pointermove', move);
        svg.addEventListener('pointerdown', move);
        svg.addEventListener('pointerleave', () => host.classList.remove('hover'));
    }

    function renderDetail() {
        const box = $('mk-detail'); if (!box) return;
        const ix = ixOf(S.index), d = merged(S.index), q = MO.quote(d);
        if (!q) { box.innerHTML = '<div class="mk-skel" aria-hidden="true"></div>'; return; }
        const chips = MO.RANGES.map((r) => '<button type="button" class="mk-chip" aria-pressed="' + (r.key === S.range) + '" onclick="MarketPage.setRange(\'' + r.key + '\')">' + esc(r.label) + '</button>').join('');
        const wholeEx = ix.code === 'VNINDEX' || ix.code === 'HNX' || ix.code === 'UPCOM';
        const b = S.rows && wholeEx ? MO.breadth(S.rows, ix.exchange) : null;
        const t = tone(q.pct);
        const stat = (k, v, s, cls) => '<div class="mk-stat"><span class="k">' + k + '</span><span class="v mk-num ' + (cls || '') + '">' + v + '</span>' + (s ? '<span class="s">' + s + '</span>' : '') + '</div>';
        const range = q.high > q.low ? (q.high / q.low - 1) * 100 : 0;
        box.innerHTML = '<div class="tl-card-head"><h3><i class="fa-solid fa-chart-line"></i> ' + esc(ix.label) + ' <span class="mk-card-sub">' + esc(ix.hint) + '</span></h3><div class="mk-chips" role="group" aria-label="Khoảng thời gian">' + chips + '</div></div>' +
            '<div class="mk-hero"><span class="mk-hero-val mk-num">' + dec(q.last, 2) + '</span><span class="mk-hero-chg mk-num ' + t + '">' + (isNum(q.change) ? (q.change > 0 ? '▲ ' : (q.change < 0 ? '▼ ' : '■ ')) + dec(Math.abs(q.change), 2) + ' (' + sgn(q.pct, 2) + '%)' : '—') + '</span></div>' +
            '<div class="mk-chart" id="mk-chart"></div>' +
            '<div class="mk-stats">' +
            stat('Tham chiếu', dec(q.prev, 2), 'đóng cửa phiên trước') + stat('Mở cửa', dec(q.open, 2), q.prev ? sgn((q.open / q.prev - 1) * 100, 2) + '% so với TC' : '') +
            stat('Cao nhất', dec(q.high, 2), q.prev ? sgn((q.high / q.prev - 1) * 100, 2) + '%' : '', 'mk-up') + stat('Thấp nhất', dec(q.low, 2), q.prev ? sgn((q.low / q.prev - 1) * 100, 2) + '%' : '', 'mk-down') +
            stat('Biên độ', dec(range, 2) + '%', 'cao so với thấp') +
            stat('KL khớp lệnh', vol(q.volume), isNum(q.volVsAvgPct) ? sgn(q.volVsAvgPct, 0) + '% so với TB 20 phiên' : 'chưa đủ 20 phiên để so') +
            (b ? stat('GTGD cả sàn ' + esc(MO.EXCHANGE_LABEL[ix.exchange]), ty(b.value), 'khớp lệnh + thỏa thuận') : '') + '</div>';
        drawChart();
        const spec = CH.spec;
        if (spec && spec.fallback) { const n = document.createElement('p'); n.className = 'tl-hint'; n.textContent = 'Chưa có nến trong ngày (nguồn không trả hoặc ngoài giờ giao dịch) — đang hiển thị 1 tháng.'; box.appendChild(n); }
    }

    function exchangeChips() {
        return '<div class="mk-chips" role="group" aria-label="Chọn sàn">' + MO.EXCHANGES.map((e) => '<button type="button" class="mk-chip" aria-pressed="' + (e === S.exchange) + '" onclick="MarketPage.setExchange(\'' + e + '\')">' + esc(MO.EXCHANGE_LABEL[e]) + '</button>').join('') + '</div>';
    }
    function renderBreadth() {
        const box = $('mk-breadth'); if (!box) return;
        const head = '<div class="tl-card-head"><h3><i class="fa-solid fa-scale-unbalanced-flip"></i> Độ rộng &amp; thanh khoản</h3>' + exchangeChips() + '</div>';
        if (!S.rows) { box.innerHTML = head + (S.errors.board ? '<div class="mk-empty"><i class="fa-solid fa-triangle-exclamation"></i>' + esc(S.errors.board) + '</div>' : '<div class="mk-skel" aria-hidden="true"></div>'); return; }
        const b = MO.breadth(S.rows, S.exchange), tot = Math.max(1, b.total), pc = (n) => Math.max(0, n / tot * 100).toFixed(2);
        const pt = b.value > 0 ? b.ptValue / b.value * 100 : 0;
        box.innerHTML = head +
            '<div class="mk-bar" role="img" aria-label="' + b.up + ' mã tăng, ' + b.flat + ' mã đứng giá, ' + b.down + ' mã giảm"><span class="u" style="width:' + pc(b.up) + '%"></span><span class="f" style="width:' + pc(b.flat) + '%"></span><span class="d" style="width:' + pc(b.down) + '%"></span></div>' +
            '<div class="mk-counts mk-num"><div><b class="mk-up">' + b.up + '</b><small>Tăng</small><small class="x mk-ceil">' + (b.ceil ? b.ceil + ' trần' : '') + '</small></div><div><b class="mk-flat">' + b.flat + '</b><small>Đứng giá</small><small class="x"></small></div><div><b class="mk-down">' + b.down + '</b><small>Giảm</small><small class="x mk-floor">' + (b.floor ? b.floor + ' sàn' : '') + '</small></div></div>' +
            '<ul class="mk-rows"><li><span>Giá trị giao dịch</span><b>' + ty(b.value) + '</b></li><li><span>Trong đó thỏa thuận</span><b>' + ty(b.ptValue) + ' (' + dec(pt, 0) + '%)</b></li><li><span>KL khớp lệnh</span><b>' + vol(b.nmVolume) + '</b></li><li><span>Mã có giao dịch</span><b>' + b.traded + ' / ' + b.total + '</b></li></ul>';
    }
    function renderForeign() {
        const box = $('mk-foreign'); if (!box) return;
        const head = '<div class="tl-card-head"><h3><i class="fa-solid fa-globe"></i> Khối ngoại <span class="mk-card-sub">' + esc(MO.EXCHANGE_LABEL[S.exchange]) + '</span></h3></div>';
        if (!S.frows) { box.innerHTML = head + (S.errors.foreign ? '<div class="mk-empty"><i class="fa-solid fa-triangle-exclamation"></i>' + esc(S.errors.foreign) + '</div>' : '<div class="mk-skel" style="height:110px" aria-hidden="true"></div>'); return; }
        const f = MO.foreignFlow(S.frows, S.exchange), tot = Math.max(1, f.buy + f.sell);
        box.innerHTML = head + '<div class="mk-net mk-num ' + tone(f.net) + '">' + (f.net > 0 ? 'Mua ròng ' : (f.net < 0 ? 'Bán ròng ' : 'Cân bằng ')) + ty(Math.abs(f.net)) + '</div>' +
            '<div class="mk-split" role="img" aria-label="Mua ' + ty(f.buy) + ', bán ' + ty(f.sell) + '"><span class="b" style="width:' + (f.buy / tot * 100).toFixed(2) + '%"></span><span class="s" style="width:' + (f.sell / tot * 100).toFixed(2) + '%"></span></div>' +
            '<div class="mk-split-legend mk-num"><span class="mk-up">Mua ' + ty(f.buy) + '</span><span class="mk-down">Bán ' + ty(f.sell) + '</span></div>' +
            '<p class="tl-hint">Cổ phiếu và chứng chỉ quỹ ETF; không gồm chứng quyền.</p>';
    }

    function renderMovers() {
        const box = $('mk-movers'); if (!box) return;
        const kinds = MO.MOVER_KINDS.map((k) => '<button type="button" class="mk-chip" aria-pressed="' + (k.key === S.mover) + '" onclick="MarketPage.setMover(\'' + k.key + '\')">' + esc(k.label) + '</button>').join('');
        const head = '<div class="tl-card-head"><h3><i class="fa-solid fa-ranking-star"></i> Cổ phiếu nổi bật</h3><div class="tl-card-tools"><div class="mk-chips" role="group" aria-label="Loại xếp hạng">' + kinds + '</div>' + exchangeChips() + '</div></div>';
        if (!S.rows) { box.innerHTML = head + (S.errors.board ? '<div class="mk-empty"><i class="fa-solid fa-triangle-exclamation"></i>' + esc(S.errors.board) + '</div>' : '<div class="mk-skel" aria-hidden="true"></div>'); return; }
        const foreignKind = S.mover === 'fbuy' || S.mover === 'fsell';
        if (foreignKind && !S.frows) { box.innerHTML = head + '<div class="mk-empty"><i class="fa-solid fa-globe"></i>' + esc(S.errors.foreign || 'Đang tải khối ngoại…') + '</div>'; return; }
        const list = MO.movers(S.rows, S.frows, S.mover, S.exchange, { n: 10 });
        if (!list.length) { box.innerHTML = head + '<div class="mk-empty"><i class="fa-regular fa-folder-open"></i>Chưa có mã nào phù hợp ở sàn này.</div>'; return; }
        const rows = list.map((r, i) => {
            const t = r.atCeil ? 'mk-ceil' : (r.atFloor ? 'mk-floor' : tone(r.pct)), badge = r.atCeil ? '<span class="mk-badge mk-ceil">Trần</span>' : (r.atFloor ? '<span class="mk-badge mk-floor">Sàn</span>' : '');
            return '<tr><td class="mk-num">' + (i + 1) + '</td><td><a href="/valuation/#stock/' + encodeURIComponent(r.symbol) + '" title="Mở hồ sơ ' + esc(r.symbol) + ' ở Valuation Bench">' + esc(r.symbol) + '</a>' + badge + '</td><td class="mk-ex">' + esc(MO.EXCHANGE_LABEL[r.exchange]) + '</td>' +
                '<td class="r mk-num ' + t + '">' + priceFmt(r.price) + '</td><td class="r mk-num ' + t + '">' + sgn(r.change / 1000, 2) + '</td><td class="r mk-num ' + t + '">' + sgn(r.pct, 2) + '%</td>' +
                '<td class="r mk-num">' + vol(r.volume) + '</td><td class="r mk-num">' + ty(r.value) + '</td><td class="r mk-num ' + (isNum(r.foreignNet) ? tone(Math.abs(r.foreignNet) < 5e5 ? 0 : r.foreignNet) : '') + '">' + (isNum(r.foreignNet) ? ty(r.foreignNet, true) : '—') + '</td></tr>';
        }).join('');
        box.innerHTML = head + '<div class="mk-table-wrap"><table class="mk-table"><thead><tr><th>#</th><th>Mã</th><th>Sàn</th><th class="r">Giá</th><th class="r">+/−</th><th class="r">%</th><th class="r">KL</th><th class="r">GTGD</th><th class="r">NN ròng</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
            '<p class="tl-hint">Giá tính bằng nghìn đồng. Tăng/giảm mạnh chỉ xét mã có giá trị giao dịch từ 1 tỷ đồng để loại mã gần như không giao dịch. Bấm mã để mở hồ sơ định giá.</p>';
    }

    // Chế độ ngành: 'icb' (toàn thị trường theo ICB, cần đăng nhập) hoặc 'idx' (10 chỉ số ngành của HOSE, không cần đăng nhập). Chưa chọn thì tự lấy 'icb' khi có ảnh chụp, không thì 'idx'.
    const secModeNow = () => S.secMode || (S.uniState === 'unavailable' || S.uniState === 'empty' ? 'idx' : 'icb');
    function sectorHead(mode) {
        const chip = (k, label) => '<button type="button" class="mk-chip" aria-pressed="' + (k === mode) + '" onclick="MarketPage.setSecMode(\'' + k + '\')">' + label + '</button>';
        return '<div class="tl-card-head"><h3><i class="fa-solid fa-layer-group"></i> Ngành hôm nay</h3><div class="mk-chips" role="group" aria-label="Cách xem ngành">' + chip('icb', 'Toàn thị trường (ICB)') + chip('idx', 'Chỉ số ngành HOSE') + '</div></div>';
    }
    function renderSectorIdx(box, head) {
        const list = MO.SECTOR_INDICES.map((s) => { const d = S.daily[s.code], r = d && d.length > 1 ? MO.returns(d) : null; return r ? { label: s.label, code: s.code, r: r, date: d[d.length - 1].date } : null; }).filter(Boolean);
        if (!list.length) { box.innerHTML = head + (S.sectorErr ? '<div class="mk-empty"><i class="fa-solid fa-triangle-exclamation"></i>Không lấy được chỉ số ngành từ VNDirect.</div>' : '<div class="mk-skel" aria-hidden="true"></div>'); return; }
        list.sort((a, b) => (b.r.d1 === null ? -99 : b.r.d1) - (a.r.d1 === null ? -99 : a.r.d1));
        const span = Math.max(1, Math.ceil(Math.max.apply(null, list.map((s) => Math.abs(s.r.d1 || 0)))));
        const row = (s) => { const v = s.r.d1, w = isNum(v) ? Math.min(50, Math.abs(v) / span * 50).toFixed(1) : 0; return '<div class="mk-sec" title="' + esc('1 tuần ' + sgn(s.r.w1, 2) + '% · 1 tháng ' + sgn(s.r.m1, 2) + '% · 3 tháng ' + sgn(s.r.m3, 2) + '%') + '"><span class="mk-sec-name">' + esc(s.label) + '</span><span class="mk-sec-bar"><i class="' + (v >= 0 ? 'p' : 'n') + '" style="width:' + w + '%"></i></span><b class="' + tone(v) + '">' + sgn(v, 2) + '%</b></div>'; };
        box.innerHTML = head + list.map(row).join('') + '<p class="tl-hint">Mười chỉ số ngành của HOSE (VNFIN, VNREAL, VNIT...), biến động so với phiên trước; rê chuột để xem 1 tuần, 1 tháng, 3 tháng. Không cần đăng nhập.</p>';
    }
    function renderSectors() {
        const box = $('mk-sectors'); if (!box) return;
        const mode = secModeNow(), head = sectorHead(mode);
        if (mode === 'idx') { renderSectorIdx(box, head); return; }
        if (S.uniState === 'loading' || S.uniState === 'idle') { box.innerHTML = head + '<div class="mk-skel" aria-hidden="true"></div>'; return; }
        if (S.uniState !== 'ok') { box.innerHTML = head + '<div class="mk-empty"><i class="fa-solid fa-lock"></i>' + (S.uniState === 'empty' ? 'Chưa có ảnh chụp thị trường để phân ngành.' : 'Cần đăng nhập WorkHub để xem ngành.') + '</div>'; return; }
        if (!S.rows) { box.innerHTML = head + '<div class="mk-skel" aria-hidden="true"></div>'; return; }
        const names = {}; Object.keys(SectorMap.ICB2).forEach((k) => { names[k] = SectorMap.ICB2[k].name; });
        const r = MO.sectorsToday(S.rows, S.universe.snapshot, names);
        if (!r.sectors.length) { box.innerHTML = head + '<div class="mk-empty"><i class="fa-regular fa-folder-open"></i>Không ghép được mã nào với ảnh chụp ngành.</div>'; return; }
        const span = Math.max(1, Math.ceil(Math.max.apply(null, r.sectors.map((s) => Math.abs(s.pct)))));
        const row = (s) => { const w = Math.min(50, Math.abs(s.pct) / span * 50).toFixed(1); return '<div class="mk-sec" title="' + esc(s.n + ' mã · ' + s.up + ' tăng · ' + s.down + ' giảm · ' + ty(s.value) + ' giao dịch') + '"><span class="mk-sec-name">' + esc(s.name) + '</span><span class="mk-sec-bar"><i class="' + (s.pct >= 0 ? 'p' : 'n') + '" style="width:' + w + '%"></i></span><b class="' + tone(s.pct) + '">' + sgn(s.pct, 2) + '%</b></div>'; };
        box.innerHTML = head + r.sectors.map(row).join('') +
            '<p class="tl-hint">Thị trường chung ' + '<b class="' + tone(r.market) + '">' + sgn(r.market, 2) + '%</b> theo cùng cách tính. Phủ ' + dec(r.coverage * 100, 0) + '% vốn hoá của ảnh chụp ngày ' + esc(dmy(S.universe.asOf) || '—') + '. Ngành chỉ có 1 mã bị ẩn.</p>';
    }

    // ----- hiệu suất nhiều kỳ -----
    function renderPerf() {
        const box = $('mk-perf'); if (!box) return;
        const head = '<div class="tl-card-head"><h3><i class="fa-solid fa-table-cells"></i> Hiệu suất các chỉ số <span class="mk-card-sub">so với các phiên trước</span></h3></div>';
        const mainRows = MO.INDICES.map((ix) => ({ ix: ix, d: merged(ix.code), main: true })), extraRows = MO.EXTRA_INDICES.map((ix) => ({ ix: ix, d: S.daily[ix.code] || null, main: false }));
        const have = mainRows.concat(extraRows).filter((x) => x.d && x.d.length > 1);
        if (!have.length) { box.innerHTML = head + '<div class="mk-skel" style="height:120px" aria-hidden="true"></div>'; return; }
        const cell = (v) => '<td class="r mk-num ' + (isNum(v) ? tone(v) : '') + '">' + (isNum(v) ? sgn(v, 2) + '%' : '—') + '</td>';
        const rows = have.map((x) => {
            const r = MO.returns(x.d), last = x.d[x.d.length - 1].c;
            const name = x.main ? '<button type="button" class="tl-link" style="font-weight:700;color:var(--text-primary);padding:0" onclick="MarketPage.selectIndex(\'' + x.ix.code + '\')" title="Xem biểu đồ">' + esc(x.ix.label) + '</button>' : '<span title="' + esc(x.ix.hint || '') + '" style="font-weight:700">' + esc(x.ix.label) + '</span>';
            return '<tr' + (x.main && x.ix.code === S.index ? ' class="mk-row-on"' : '') + '><td>' + name + '</td><td class="r mk-num">' + dec(last, 2) + '</td>' + MO.PERIODS.map((p) => cell(r[p.key])).join('') + '</tr>';
        }).join('');
        box.innerHTML = head + '<div class="mk-table-wrap"><table class="mk-table"><thead><tr><th>Chỉ số</th><th class="r">Điểm</th>' + MO.PERIODS.map((p) => '<th class="r">' + esc(p.label) + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
            '<p class="tl-hint">Biến động % của phiên mới nhất so với đóng cửa cách đó 1 phiên, 1 tuần (5 phiên), 1 tháng (22), 3 tháng (64), 6 tháng (127), 1 năm (252) và so với phiên cuối năm trước. “—” là chưa đủ lịch sử.</p>';
    }

    // ----- xu hướng kỹ thuật của chỉ số đang chọn -----
    function renderTech() {
        const box = $('mk-tech'); if (!box) return;
        const ix = ixOf(S.index), t = MO.technical(merged(S.index));
        const head = '<div class="tl-card-head"><h3><i class="fa-solid fa-wave-square"></i> Xu hướng kỹ thuật <span class="mk-card-sub">' + esc(ix.label) + '</span></h3></div>';
        if (!t) { box.innerHTML = head + '<div class="mk-skel" style="height:140px" aria-hidden="true"></div>'; return; }
        const ma = (k, label) => { const m = t.ma[k]; return '<li><span>' + label + '</span><b>' + (m.value ? dec(m.value, 2) + ' <span class="' + tone(m.vsPct) + '">(' + sgn(m.vsPct, 2) + '%)</span>' : 'chưa đủ ' + m.n + ' phiên') + '</b></li>'; };
        const gauge = isNum(t.rsi) ? '<div class="mk-gauge" role="img" aria-label="RSI ' + dec(t.rsi, 0) + '"><span class="z lo"></span><span class="z hi"></span><i style="left:' + Math.max(0, Math.min(100, t.rsi)).toFixed(1) + '%"></i></div><div class="mk-range-legend mk-num"><span>0</span><span>100</span></div>' : '';
        const r = t.range52;
        box.innerHTML = head +
            (t.place ? '<p class="mk-place">' + esc(t.place) + (t.ma50AboveMa200 === null ? '' : ' · MA50 ' + (t.ma50AboveMa200 ? 'trên' : 'dưới') + ' MA200') + '</p>' : '') +
            '<ul class="mk-rows">' + ma('ma20', 'MA20') + ma('ma50', 'MA50') + ma('ma200', 'MA200') + '</ul>' +
            '<div class="mk-val-row" style="margin-top:14px"><div class="top"><span class="nm">RSI (14 phiên)</span><span class="big mk-num">' + (isNum(t.rsi) ? dec(t.rsi, 0) : '—') + '</span></div>' + gauge + (t.rsiState ? '<p class="tl-hint" style="margin-top:4px">' + esc(t.rsiState) + ' (dưới 30 là quá bán, trên 70 là quá mua)</p>' : '') + '</div>' +
            (r ? '<div class="mk-val-row" style="margin-top:14px"><div class="top"><span class="nm">Vùng giá ' + r.n + ' phiên</span><span class="big mk-num">' + (isNum(r.posPct) ? dec(r.posPct, 0) + '%' : '—') + '</span></div><div class="mk-range" role="img" aria-label="Vị trí trong vùng giá"><i style="left:' + Math.max(0, Math.min(100, r.posPct || 0)).toFixed(1) + '%"></i></div><div class="mk-range-legend mk-num"><span>Đáy ' + dec(r.low, 0) + '</span><span class="' + tone(r.fromHighPct) + '">' + sgn(r.fromHighPct, 1) + '% so với đỉnh</span><span>Đỉnh ' + dec(r.high, 0) + '</span></div></div>' : '') +
            '<p class="tl-hint">Mô tả hiện trạng từ nến ngày (MA = trung bình giá đóng cửa), không phải tín hiệu mua bán.</p>';
    }

    // ----- cổ phiếu tác động nhiều nhất lên chỉ số của sàn -----
    const WHOLE = { HOSE: 'VNINDEX', HNX: 'HNX', UPCOM: 'UPCOM' };
    function renderContrib() {
        const box = $('mk-contrib'); if (!box) return;
        const ex = S.exchange === 'ALL' ? 'HOSE' : S.exchange, ix = ixOf(WHOLE[ex]);
        const head = '<div class="tl-card-head"><h3><i class="fa-solid fa-arrows-up-down"></i> Tác động lên ' + esc(ix.label) + ' <span class="mk-card-sub">ước tính</span></h3></div>';
        if (S.uniState === 'loading' || S.uniState === 'idle') { box.innerHTML = head + '<div class="mk-skel" aria-hidden="true"></div>'; return; }
        if (S.uniState !== 'ok') { box.innerHTML = head + '<div class="mk-empty"><i class="fa-solid fa-lock"></i>' + (S.uniState === 'empty' ? 'Chưa có ảnh chụp thị trường (cần vốn hoá từng mã).' : 'Cần đăng nhập WorkHub để xem.') + '</div>'; return; }
        const q = MO.quote(merged(ix.code));
        if (!S.rows || !q || !isNum(q.prev)) { box.innerHTML = head + '<div class="mk-skel" aria-hidden="true"></div>'; return; }
        const c = MO.contributions(S.rows, S.universe.snapshot, ex, q.prev);
        if (!c.n) { box.innerHTML = head + '<div class="mk-empty"><i class="fa-regular fa-folder-open"></i>Không ghép được mã nào với vốn hoá.</div>'; return; }
        const top = (list) => list.slice(0, 5), span = Math.max(0.01, Math.max.apply(null, top(c.up).concat(top(c.down)).map((i) => Math.abs(i.points))));
        const row = (i) => '<div class="mk-sec"><span class="mk-sec-name"><a href="/valuation/#stock/' + encodeURIComponent(i.symbol) + '" style="color:var(--text-primary);font-weight:700;text-decoration:none">' + esc(i.symbol) + '</a> <small class="' + tone(i.pct) + '">' + sgn(i.pct, 2) + '%</small></span><span class="mk-sec-bar"><i class="' + (i.points >= 0 ? 'p' : 'n') + '" style="width:' + Math.min(50, Math.abs(i.points) / span * 50).toFixed(1) + '%"></i></span><b class="' + tone(i.points) + '">' + sgn(i.points, 2) + '</b></div>';
        box.innerHTML = head +
            '<p class="mk-contrib-sum mk-num">Ước tính <b class="' + tone(c.sumPoints) + '">' + sgn(c.sumPoints, 2) + '</b> điểm · thực tế <b class="' + tone(q.change) + '">' + sgn(q.change, 2) + '</b> điểm</p>' +
            '<h4 class="mk-subhead mk-up">Kéo chỉ số lên</h4>' + (top(c.up).length ? top(c.up).map(row).join('') : '<p class="tl-hint">Không có mã nào.</p>') +
            '<h4 class="mk-subhead mk-down">Kéo chỉ số xuống</h4>' + (top(c.down).length ? top(c.down).map(row).join('') : '<p class="tl-hint">Không có mã nào.</p>') +
            '<p class="tl-hint">Điểm đóng góp ≈ chỉ số hôm trước × vốn hoá × % thay đổi ÷ tổng vốn hoá (cách tính của chỉ số toàn sàn). Dùng vốn hoá của ảnh chụp ngày ' + esc(dmy(S.universe.asOf) || '—') + ' và ' + c.n + ' cổ phiếu ghép được, nên chỉ là ước tính; không có ở VN30/HNX30 vì hai chỉ số này điều chỉnh theo tỷ lệ tự do chuyển nhượng.</p>';
    }

    function renderValuation() {
        const box = $('mk-valuation'); if (!box) return;
        const head = '<div class="tl-card-head"><h3><i class="fa-solid fa-scale-balanced"></i> Định giá thị trường <span class="mk-card-sub">so với 5 năm của chính nó</span></h3></div>';
        if (S.valState === 'loading' || S.valState === 'idle') { box.innerHTML = head + '<div class="mk-skel" aria-hidden="true"></div>'; return; }
        if (S.valState !== 'ok') { box.innerHTML = head + '<div class="mk-empty"><i class="fa-solid fa-lock"></i>' + (S.valState === 'empty' ? 'Chưa có lịch sử định giá.' : 'Cần đăng nhập WorkHub để xem định giá.') + '</div>'; return; }
        const VH = ValuationHistory, rows = S.val.rows;
        const block = (name, key) => {
            const sum = VH.summarize(VH.seriesOf(rows, 'ALL', key), { years: 5 });
            if (!sum) return '';
            const pos = sum.enough ? Math.max(0, Math.min(100, sum.pct)) : null;
            return '<div class="mk-val-row"><div class="top"><span class="nm">' + name + '</span><span class="big mk-num">' + dec(sum.now, 1) + 'x</span></div>' +
                (sum.enough ? '<div class="mk-range" role="img" aria-label="Phân vị ' + dec(sum.pct, 0) + ' trong 5 năm"><i style="left:' + pos.toFixed(1) + '%"></i></div><div class="mk-range-legend mk-num"><span>Rẻ ' + dec(sum.min, 1) + 'x</span><span><b>' + (sum.label ? esc(sum.label.label) : '') + '</b> · phân vị ' + dec(sum.pct, 0) + ' (TB ' + dec(sum.mean, 1) + 'x)</span><span>Đắt ' + dec(sum.max, 1) + 'x</span></div>'
                    : '<p class="tl-hint">Chưa đủ ' + VH.MIN_POINTS + ' tháng dữ liệu để so với lịch sử.</p>') + '</div>';
        };
        const peS = VH.summarize(VH.seriesOf(rows, 'ALL', 'pe_agg'), { years: 5 }), sp = peS ? VH.earningsYieldSpread(peS.now, S.val.bond10y) : null;
        const spread = sp ? '<div class="mk-val-row"><div class="top"><span class="nm">Cổ phiếu so với trái phiếu</span><span class="big mk-num ' + (sp.spreadPct === null ? '' : tone(sp.spreadPct)) + '">' + (sp.spreadPct === null ? '—' : sgn(sp.spreadPct, 1) + ' điểm') + '</span></div>' +
            '<p class="tl-hint" style="margin-top:2px">Lợi suất lợi nhuận <b>' + dec(sp.earningsYieldPct, 1) + '%</b> (1 / P/E)' + (sp.bondPct !== null ? ' so với lợi suất trái phiếu chính phủ 10 năm <b>' + dec(sp.bondPct, 1) + '%</b>' + (S.val.bondDate ? ' (' + esc(dmy(S.val.bondDate)) + ')' : '') : ' — chưa có lợi suất trái phiếu để so') + '.</p></div>' : '';
        const body = block('P/E tổng hợp', 'pe_agg') + block('P/B tổng hợp', 'pb_agg') + spread;
        box.innerHTML = head + (body ? '<div class="mk-val">' + body + '</div>' : '<div class="mk-empty"><i class="fa-regular fa-folder-open"></i>Chưa có số liệu.</div>') +
            '<p class="tl-hint">Tổng hợp theo vốn hoá, chỉ tính mã có lãi nên thấp hơn P/E của chỉ số khi nhiều doanh nghiệp lỗ. “Rẻ so với lịch sử” không có nghĩa là sẽ tăng.</p>';
    }

    function renderAll() { renderStatus(); renderIndices(); renderDetail(); renderBreadth(); renderForeign(); renderMovers(); renderPerf(); renderTech(); renderContrib(); renderSectors(); renderValuation(); }

    // ---------- thao tác ----------
    function selectIndex(code) { if (!MO.INDICES.some((i) => i.code === code)) return; S.index = code; S.exchange = ixOf(code).exchange; save(); renderIndices(); renderDetail(); renderBreadth(); renderForeign(); renderMovers(); renderPerf(); renderTech(); renderContrib(); renderSectors(); }
    function setRange(k) { if (!MO.RANGES.some((r) => r.key === k)) return; S.range = k; save(); renderDetail(); }
    function setExchange(e) { if (MO.EXCHANGES.indexOf(e) === -1) return; S.exchange = e; save(); renderBreadth(); renderForeign(); renderMovers(); renderDetail(); renderContrib(); }
    function setSecMode(m) { if (m !== 'icb' && m !== 'idx') return; S.secMode = m; save(); renderSectors(); }
    function setMover(k) { if (!MO.MOVER_KINDS.some((x) => x.key === k)) return; S.mover = k; save(); renderMovers(); }

    function tick() {
        if (typeof document !== 'undefined' && document.hidden) return;
        if (sessionState() === 'open') refresh(false);
    }
    function start() {
        if (S.started) return; S.started = true;
        load(); renderAll();
        refresh(true).then(loadOptional);
        S.timer = setInterval(tick, POLL_MS);
        document.addEventListener('visibilitychange', () => { if (!document.hidden && S.fetchedAt && Date.now() - S.fetchedAt > POLL_MS * 2 && (sessionState() === 'open' || sessionState() === 'break')) refresh(false); });
        let rz = null; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(drawChart, 150); });
    }

    return { S, start, refresh, loadOptional, loadMore, selectIndex, setRange, setExchange, setMover, setSecMode, renderAll, drawChart };
})();

function applyThemeIcon() { const ic = document.getElementById('theme-ic'); if (ic) ic.className = document.documentElement.getAttribute('data-theme') === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon'; }
function toggleDeskTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('user-theme', next); } catch (e) { /* bỏ qua */ }
    applyThemeIcon();
}
document.addEventListener('DOMContentLoaded', function () {
    applyThemeIcon();
    if (typeof BenchNav !== 'undefined') BenchNav.mount({ bench: 'investment', active: 'market' });
    MarketPage.start();
});
