// market/market.js THẬT chạy trong vm cùng các thư viện của trang (vn-holidays, live-quotes, sector-map, valuation-history, market-overview); fetch và callGAS giả trả dữ liệu mẫu thật
// (tests/fixtures/market-overview-sample.json) hoặc báo lỗi theo kịch bản. DOM giả tối thiểu: chỉ kiểm HTML sinh ra, trạng thái và hành vi (lỗi nguồn, tự làm mới, lưu lựa chọn).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const REPO = process.cwd().replace(/\\/g, '/');
const FX = JSON.parse(fs.readFileSync(REPO + '/tests/fixtures/market-overview-sample.json', 'utf8'));

function boot(opts) {
  const o = opts || {};
  const els = {}, store = new Map(), urls = [], intervals = [], docHandlers = {};
  const stub = () => ({ classList: { add() {}, remove() {}, contains: () => false }, addEventListener() {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 720 }), style: {}, textContent: '' });
  const el = (id) => els[id] || (els[id] = Object.assign(stub(), { id, innerHTML: '', className: '', clientWidth: 720, offsetWidth: 80, disabled: false, children: [],
    querySelector: () => stub(), querySelectorAll: () => [], appendChild(c) { this.children.push(c); } }));
  const route = (url) => {
    if (o.failAll) return null;
    if (/resolution=D/.test(url)) return o.failDaily ? null : FX.daily;
    if (/resolution=1/.test(url)) return o.failIntraday ? null : FX.intraday;
    if (/stock_prices/.test(url)) return o.failBoard ? null : FX.prices;
    if (/foreigns/.test(url)) return o.failForeign ? null : FX.foreign;
    return null;
  };
  const ctx = vm.createContext({
    console, Date, JSON, Math, Promise, Object, Array, Number, String, isFinite, encodeURIComponent, Set, setTimeout, clearTimeout, AbortController,
    document: { getElementById: el, createElement: () => Object.assign(stub(), { className: '', textContent: '' }), addEventListener: (n, f) => { docHandlers[n] = f; }, hidden: !!o.hidden },
    window: { addEventListener() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    setInterval: (f, ms) => { intervals.push({ f, ms }); return intervals.length; },
    fetch: async (url) => { urls.push(url); const j = route(url); return j === null ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => j }; },
    callGAS: o.callGAS,
  });
  ['lib/vn-holidays.js', 'lib/live-quotes.js', 'lib/sector-map.js', 'lib/valuation-history.js', 'lib/market-overview.js', 'market/market.js'].forEach((f) => vm.runInContext(fs.readFileSync(REPO + '/' + f, 'utf8'), ctx, { filename: f }));
  vm.runInContext("LiveQuotes.session = () => '" + (o.session || 'closed') + "';", ctx);
  vm.runInContext('globalThis.MP = MarketPage;', ctx);
  return { MP: vm.runInContext('MP', ctx), els, store, urls, intervals, docHandlers, ctx };
}
const MAIN_D = /resolution=D&symbol=(VNINDEX|VN30|HNX|HNX30|UPCOM)&/;
const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('trang Thị Trường (market.js): đường chạy chính với dữ liệu thật', () => {
  it('hiện đủ 5 chỉ số, số khớp nến ngày, chọn mặc định VN-Index', async () => {
    const t = boot();
    await t.MP.refresh(true);
    const h = t.els['mk-indices'].innerHTML;
    ['VN-Index', 'VN30', 'HNX-Index', 'HNX30', 'UPCoM-Index'].forEach((n) => expect(h.toUpperCase()).toContain(n.toUpperCase()));
    expect((h.match(/class="mk-ix"/g) || []).length).toBe(5);
    expect(text(h)).toContain('1,738.97');
    expect(text(h)).toContain('14.42');                       // 1.753,39 -> 1.738,97
    expect(text(h)).toContain('−0.82%');
    expect(h).toContain('aria-pressed="true"');
    expect(t.MP.S.date).toBe('2026-10-08');
  });
  it('chi tiết: tham chiếu, mở/cao/thấp, khối lượng so với trung bình 20 phiên, biểu đồ trong ngày có đường và trục giờ', async () => {
    const t = boot();
    await t.MP.refresh(true);
    const h = t.els['mk-detail'].innerHTML;
    expect(text(h)).toContain('1,753.39');                     // tham chiếu
    expect(text(h)).toContain('532.7 tr');                     // khối lượng khớp lệnh
    expect(text(h)).toContain('+2% so với TB 20 phiên');
    expect(text(h)).toContain('GTGD cả sàn HOSE');
    const c = t.els['mk-chart'].innerHTML;
    expect(c).toContain('<path class="mk-line"');
    ['9:00', '11:30', '15:00'].forEach((x) => expect(c).toContain(x));
    expect(c).toContain('TC 1,753.39');                        // đường tham chiếu
  });
  it('độ rộng HOSE khớp số tính độc lập; chuyển sàn đổi số', async () => {
    const t = boot();
    await t.MP.refresh(true);
    let h = text(t.els['mk-breadth'].innerHTML);
    expect(h).toMatch(/\b6\b.*Tăng.*1 trần/);
    expect(h).toMatch(/\b12\b.*Giảm.*1 sàn/);
    expect(h).toContain('19 / 19');                             // mã có giao dịch / tổng cổ phiếu mẫu của HOSE
    t.MP.setExchange('HNX');
    h = text(t.els['mk-breadth'].innerHTML);
    expect(h).toMatch(/\b2\b.*Tăng.*2 trần/);
    expect(h).toContain('7 / 10');
    expect(t.store.get('wh.fin.market.v1')).toContain('"exchange":"HNX"');
  });
  it('khối ngoại hiện mua/bán/ròng; chuyển sang tất cả sàn', async () => {
    const t = boot();
    await t.MP.refresh(true);
    expect(text(t.els['mk-foreign'].innerHTML)).toMatch(/Bán ròng/);
    t.MP.setExchange('ALL');
    const h = text(t.els['mk-foreign'].innerHTML);
    expect(h).toMatch(/Bán ròng 2\d\d tỷ/);                     // -266,5 tỷ (số tính độc lập) làm tròn
    expect(h).toMatch(/Mua 1\.?\d* nghìn tỷ|Mua 1\.0\d nghìn tỷ/);
  });
  it('cổ phiếu nổi bật: tăng mạnh theo thứ tự, có huy hiệu Trần, liên kết sang hồ sơ định giá; đổi loại', async () => {
    const t = boot();
    await t.MP.refresh(true);
    let h = t.els['mk-movers'].innerHTML;
    expect(h.indexOf('>JVC<')).toBeGreaterThan(-1);
    expect(h.indexOf('>JVC<')).toBeLessThan(h.indexOf('>PLX<'));
    expect(h).toContain('/valuation/#stock/JVC');
    expect(h).toContain('mk-badge mk-ceil');
    t.MP.setMover('loss');
    h = t.els['mk-movers'].innerHTML;
    expect(h.indexOf('>SHB<')).toBeGreaterThan(-1);
    expect(h).toContain('mk-badge mk-floor');
    t.MP.setMover('fbuy');
    expect(t.els['mk-movers'].innerHTML).toContain('NN ròng');
    t.MP.setMover('nonsense');
    expect(t.MP.S.mover).toBe('fbuy');                          // giá trị lạ bị bỏ qua
  });
  it('chọn chỉ số đổi sàn đi kèm và lưu lựa chọn; mã chỉ số lạ bị bỏ qua', async () => {
    const t = boot();
    await t.MP.refresh(true);
    t.MP.selectIndex('HNX');
    expect(t.MP.S.index).toBe('HNX');
    expect(t.MP.S.exchange).toBe('HNX');
    expect(text(t.els['mk-detail'].innerHTML)).toContain('HNX-Index');
    t.MP.selectIndex('<script>');
    expect(t.MP.S.index).toBe('HNX');
    expect(JSON.parse(t.store.get('wh.fin.market.v1')).index).toBe('HNX');
    t.MP.setRange('3M');
    expect(t.els['mk-chart'].innerHTML).toContain('<path class="mk-line"');
    t.MP.setRange('99Y');
    expect(t.MP.S.range).toBe('3M');
  });
  it('khôi phục lựa chọn đã lưu khi khởi động và bỏ qua dữ liệu lưu hỏng', () => {
    const t = boot();
    t.store.set('wh.fin.market.v1', JSON.stringify({ index: 'UPCOM', exchange: 'UPCOM', range: '1Y', mover: 'value' }));
    t.MP.start();
    expect(t.MP.S.index).toBe('UPCOM');
    expect(t.MP.S.range).toBe('1Y');
    const b = boot();
    b.store.set('wh.fin.market.v1', '{không phải json');
    b.MP.start();
    expect(b.MP.S.index).toBe('VNINDEX');
    const c = boot();
    c.store.set('wh.fin.market.v1', JSON.stringify({ index: 'ĐỘC', exchange: 'ĐỘC', range: 'ĐỘC', mover: 'ĐỘC' }));
    c.MP.start();
    expect([c.MP.S.index, c.MP.S.exchange, c.MP.S.range, c.MP.S.mover]).toEqual(['VNINDEX', 'HOSE', '1D', 'gain']);
  });
});

describe('trang Thị Trường: nguồn lỗi không làm hỏng trang', () => {
  it('mọi nguồn lỗi: báo lỗi rõ ràng, không ném, không hiện số giả', async () => {
    const t = boot({ failAll: true });
    await t.MP.refresh(true);
    const meta = text(t.els['mk-meta'].innerHTML);
    expect(meta).toContain('Không lấy được chỉ số');
    expect(t.els['mk-indices'].innerHTML).not.toContain('class="mk-ix"');
    expect(text(t.els['mk-breadth'].innerHTML)).not.toMatch(/Tăng/);
    expect(t.MP.S.rows).toBe(null);
    expect(t.els['mk-detail'].innerHTML).toContain('mk-skel');
  });
  it('bảng giá lỗi nhưng chỉ số ổn: chỉ các thẻ bảng giá báo lỗi', async () => {
    const t = boot({ failBoard: true });
    await t.MP.refresh(true);
    expect(text(t.els['mk-indices'].innerHTML)).toContain('1,738.97');
    expect(text(t.els['mk-breadth'].innerHTML)).toContain('Không lấy được bảng giá');
    expect(text(t.els['mk-movers'].innerHTML)).toContain('Không lấy được bảng giá');
    expect(text(t.els['mk-meta'].innerHTML)).toContain('Không lấy được bảng giá');
  });
  it('khối ngoại lỗi: thẻ khối ngoại báo, độ rộng vẫn hiện; tab NN mua ròng báo lý do', async () => {
    const t = boot({ failForeign: true });
    await t.MP.refresh(true);
    expect(text(t.els['mk-breadth'].innerHTML)).toMatch(/Tăng/);
    expect(text(t.els['mk-foreign'].innerHTML)).toContain('Chưa có số liệu khối ngoại');
    t.MP.setMover('fbuy');
    expect(text(t.els['mk-movers'].innerHTML)).toContain('Chưa có số liệu khối ngoại');
  });
  it('nến phút lỗi: biểu đồ trong ngày rơi về 1 tháng kèm ghi chú, chỉ số vẫn đúng', async () => {
    const t = boot({ failIntraday: true });
    await t.MP.refresh(true);
    expect(text(t.els['mk-indices'].innerHTML)).toContain('1,738.97');
    expect(t.els['mk-chart'].innerHTML).toContain('<path class="mk-line"');
    const note = t.els['mk-detail'].children.map((c) => c.textContent).join(' ');
    expect(note).toContain('Chưa có nến trong ngày');
  });
  it('lỗi sau khi đã có dữ liệu: giữ số cũ và nói rõ là số cũ', async () => {
    const o = { failBoard: false };
    const t = boot(o);
    await t.MP.refresh(true);
    expect(t.MP.S.rows.length).toBeGreaterThan(0);
    const before = t.MP.S.rows.length;
    vm.runInContext('fetch = async () => ({ ok: false, json: async () => ({}) });', t.ctx);
    await t.MP.refresh(true);
    expect(t.MP.S.rows.length).toBe(before);
    expect(text(t.els['mk-meta'].innerHTML)).toContain('đang hiển thị số liệu cũ');
    expect(text(t.els['mk-indices'].innerHTML)).toContain('1,738.97');
  });
  it('không gọi chồng: refresh khi đang chạy bị bỏ qua', async () => {
    const t = boot();
    const a = t.MP.refresh(true), b = t.MP.refresh(true);
    await Promise.all([a, b]);
    await t.MP.S.morePromise;
    const dCalls = t.urls.filter((u) => MAIN_D.test(u)).length;
    expect(dCalls).toBe(5);                                    // một lượt duy nhất: 5 chỉ số
  });
});

describe('trang Thị Trường: tự làm mới', () => {
  it('start đặt bộ hẹn 30 giây; chỉ làm mới khi đang trong phiên', async () => {
    const open = boot({ session: 'open' });
    open.MP.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(open.intervals.length).toBe(1);
    expect(open.intervals[0].ms).toBe(30000);
    const n = open.urls.length;
    await new Promise((r) => setTimeout(r, 30));
    open.intervals[0].f();
    await new Promise((r) => setTimeout(r, 50));
    expect(open.urls.length).toBeGreaterThan(n);

    const closed = boot({ session: 'closed' });
    closed.MP.start();
    await new Promise((r) => setTimeout(r, 50));
    const m = closed.urls.length;
    closed.intervals[0].f();
    await new Promise((r) => setTimeout(r, 30));
    expect(closed.urls.length).toBe(m);

    const hidden = boot({ session: 'open', hidden: true });
    hidden.MP.start();
    await new Promise((r) => setTimeout(r, 50));
    const k = hidden.urls.length;
    hidden.intervals[0].f();
    await new Promise((r) => setTimeout(r, 30));
    expect(hidden.urls.length).toBe(k);                        // tab ẩn: không gọi
  });
  it('lần làm mới thường chỉ lấy lại nến phút, không tải lại nến ngày (tiết kiệm)', async () => {
    const t = boot({ session: 'open' });
    await t.MP.refresh(true);
    await t.MP.S.morePromise;
    const d1 = t.urls.filter((u) => /resolution=D/.test(u)).length;
    await t.MP.refresh(false);
    await t.MP.S.morePromise;
    expect(t.urls.filter((u) => /resolution=D/.test(u)).length).toBe(d1);       // chỉ số chính, bổ sung và ngành đều còn mới: không gọi lại
    expect(t.urls.filter((u) => /resolution=1/.test(u)).length).toBe(10);
  });
  it('trạng thái phiên hiện đúng chữ', async () => {
    for (const [s, label] of [['open', 'Đang giao dịch'], ['break', 'Nghỉ trưa'], ['pre', 'Chưa mở cửa'], ['closed', 'Đã đóng cửa'], ['holiday', 'Ngày nghỉ']]) {
      const t = boot({ session: s });
      await t.MP.refresh(true);
      expect(t.els['mk-session'].textContent).toBe(label);
      expect(t.els['mk-session'].className).toContain(s);
    }
  });
});

describe('trang Thị Trường: ngành và định giá (cần đăng nhập)', () => {
  const codes = ['8300', '8600'];
  const snap = FX.prices.data.filter((r) => r.type === 'STOCK' && r.floor === 'HOSE').slice(0, 10).map((r, i) => ({ symbol: r.code, icb2_code: codes[i % 2], metrics: { marketcap: 1e12 * (i + 1) } }));
  const hist = []; for (let m = 0; m < 30; m++) hist.push({ as_of: new Date(Date.UTC(2024, m, 1)).toISOString().slice(0, 10), scope: 'ALL', pe_agg: 10 + (m % 7), pb_agg: 1.5 + (m % 5) / 10 });
  const good = async (a) => (a === 'getMarketUniverse' ? { status: 'success', data: { snapshot: snap, stats: {}, meta: {}, asOf: '2026-10-08' } } : { status: 'success', data: { rows: hist, bond10y: 3.1, bondDate: '2026-10-08' } });

  it('có dữ liệu: ngành sắp theo biến động, định giá có phân vị và phần bù so với trái phiếu', async () => {
    const t = boot({ callGAS: good });
    await t.MP.refresh(true);
    await t.MP.loadOptional();
    const s = text(t.els['mk-sectors'].innerHTML);
    expect(s).toContain('Ngân hàng');
    expect(s).toContain('Bất động sản');
    expect(s).toMatch(/[+−]\d+\.\d\d%/);
    const v = text(t.els['mk-valuation'].innerHTML);
    expect(v).toContain('P/E tổng hợp');
    expect(v).toContain('P/B tổng hợp');
    expect(v).toMatch(/phân vị \d+/);
    expect(v).toContain('3.1%');
    expect(v).toContain('điểm');
  });
  it('chưa đăng nhập hoặc lỗi: hai thẻ báo cần đăng nhập, trang còn lại không ảnh hưởng', async () => {
    const t = boot({ callGAS: async () => ({ status: 'error', message: 'Chưa đăng nhập' }) });
    await t.MP.refresh(true);
    await t.MP.loadOptional();
    await t.MP.S.morePromise;
    expect(text(t.els['mk-contrib'].innerHTML)).toContain('Cần đăng nhập');
    expect(text(t.els['mk-valuation'].innerHTML)).toContain('Cần đăng nhập');
    expect(text(t.els['mk-sectors'].innerHTML)).toContain('Tài chính');          // thẻ ngành tự rơi về chỉ số ngành HOSE (không cần đăng nhập)
    expect(text(t.els['mk-indices'].innerHTML)).toContain('1,738.97');
    const n = boot({});
    await n.MP.refresh(true);
    await n.MP.loadOptional();                                 // callGAS không tồn tại
    expect(text(n.els['mk-contrib'].innerHTML)).toContain('Cần đăng nhập');
  });
  it('ảnh chụp rỗng và lịch sử rỗng: báo chưa có, không ném', async () => {
    const t = boot({ callGAS: async (a) => (a === 'getMarketUniverse' ? { status: 'success', data: { snapshot: [] } } : { status: 'success', data: { rows: [] } }) });
    await t.MP.refresh(true);
    await t.MP.loadOptional();
    await t.MP.S.morePromise;
    expect(text(t.els['mk-contrib'].innerHTML)).toContain('Chưa có ảnh chụp thị trường');
    expect(text(t.els['mk-valuation'].innerHTML)).toContain('Chưa có lịch sử định giá');
  });
  it('lịch sử dưới 12 tháng: nói chưa đủ dữ liệu thay vì kết luận phân vị', async () => {
    const short = hist.slice(0, 5);
    const t = boot({ callGAS: async (a) => (a === 'getMarketUniverse' ? { status: 'success', data: { snapshot: snap, asOf: '2026-10-08' } } : { status: 'success', data: { rows: short, bond10y: null } }) });
    await t.MP.refresh(true);
    await t.MP.loadOptional();
    const v = text(t.els['mk-valuation'].innerHTML);
    expect(v).toContain('Chưa đủ 12 tháng');
    expect(v).not.toMatch(/phân vị \d+/);
  });
});

describe('trang Thị Trường: chỉ số bổ sung (hiệu suất, kỹ thuật, tác động, chỉ số ngành)', () => {
  const caps = { VIC: 1772387135520000, VHM: 558608032544000, VPB: 234000000000000, TCB: 228885565372200, HPG: 171814327982000, BSR: 158981765030500, HDB: 140648264676300, STB: 125932409828800, MSN: 115428321291200, MWG: 113480875213400, FPT: 112577940585600, SSI: 58975884984300, SHB: 52750801303200, PLX: 45995438907000, NVL: 32988400148800, VIX: 30101625836100 };
  const snap = Object.keys(caps).map((k) => ({ symbol: k, icb2_code: '8600', metrics: { marketcap: caps[k] } }));
  const good = async (a) => (a === 'getMarketUniverse' ? { status: 'success', data: { snapshot: snap, asOf: '2026-10-07' } } : { status: 'success', data: { rows: [] } });

  it('bảng hiệu suất: 9 chỉ số, % khớp tính độc lập, kỳ chưa đủ lịch sử là —', async () => {
    const t = boot();
    await t.MP.refresh(true);
    await t.MP.S.morePromise;
    const h = t.els['mk-perf'].innerHTML, x = text(h);
    ['VN-Index', 'VN30', 'HNX-Index', 'HNX30', 'UPCoM-Index', 'VN100', 'VN Small Cap', 'VN Diamond', 'VN Fin Lead'].forEach((n) => expect(x).toContain(n));
    expect(x).toContain('−0.82%');                              // 1 phiên của VN-Index mẫu
    expect(x).toContain('−0.59%');                              // 1 tuần
    expect(x).toContain('−5.00%');                              // 1 tháng (−4,997%)
    expect(x).toContain('—');                                   // 3 tháng trở đi: mẫu chỉ có 26 phiên
    expect(h).toContain('mk-row-on');
  });
  it('xu hướng kỹ thuật: MA20, RSI, vùng giá khớp số tính độc lập', async () => {
    const t = boot();
    await t.MP.refresh(true);
    const x = text(t.els['mk-tech'].innerHTML);
    expect(x).toContain('1,782.01');                            // MA20
    expect(x).toContain('−2.42%');
    expect(x).toContain('35');                                  // RSI 34,98
    expect(x).toContain('Trung tính');
    expect(x).toContain('9%');                                  // vị trí 8,7% trong vùng giá
    expect(x).toContain('chưa đủ 200 phiên');                   // mẫu 26 phiên: không đoán MA200
  });
  it('tác động lên chỉ số: có điểm ước tính và thực tế, mã kéo xuống/lên đúng; chuyển sàn đổi tiêu đề', async () => {
    const t = boot({ callGAS: good });
    await t.MP.refresh(true);
    await t.MP.loadOptional();
    const h = t.els['mk-contrib'].innerHTML, x = text(h);
    expect(x).toContain('Tác động lên VN-Index');
    expect(x).toContain('−19.61');                              // ước tính trên 16 mã mẫu
    expect(x).toContain('−14.42');                              // thực tế
    expect(h.indexOf('>VHM<')).toBeGreaterThan(h.indexOf('Kéo chỉ số xuống'));
    expect(h.indexOf('>PLX<')).toBeGreaterThan(-1);
    expect(h.indexOf('>PLX<')).toBeLessThan(h.indexOf('Kéo chỉ số xuống'));
    t.MP.setExchange('HNX');
    expect(text(t.els['mk-contrib'].innerHTML)).toContain('Tác động lên HNX-Index');
    t.MP.setExchange('ALL');
    expect(text(t.els['mk-contrib'].innerHTML)).toContain('Tác động lên VN-Index');          // Tất cả quy về HOSE
  });
  it('thẻ ngành: có đăng nhập mặc định xem ICB; chuyển qua lại và lưu lựa chọn; không đăng nhập là chỉ số ngành', async () => {
    const t = boot({ callGAS: good });
    await t.MP.refresh(true);
    await t.MP.S.morePromise;
    await t.MP.loadOptional();
    expect(t.els['mk-sectors'].innerHTML).toContain('Bất động sản');                           // ICB 8600 của mẫu
    t.MP.setSecMode('idx');
    expect(text(t.els['mk-sectors'].innerHTML)).toContain('Tài chính');
    expect(text(t.els['mk-sectors'].innerHTML)).toContain('Công nghệ thông tin');
    expect(JSON.parse(t.store.get('wh.fin.market.v1')).secMode).toBe('idx');
    t.MP.setSecMode('rác');
    expect(t.MP.S.secMode).toBe('idx');
    const n = boot({ callGAS: async () => ({ status: 'error' }) });
    await n.MP.refresh(true); await n.MP.S.morePromise; await n.MP.loadOptional();
    expect(text(n.els['mk-sectors'].innerHTML)).toContain('Tài chính');
  });
  it('chỉ số bổ sung lỗi: các thẻ khác vẫn đúng, bảng hiệu suất vẫn có 5 chỉ số chính', async () => {
    const t = boot();
    vm.runInContext("const _f = fetch; fetch = async (u) => (/symbol=(VN100|VNSML|VNDIAMOND|VNFINLEAD|VNFIN|VNREAL|VNIT|VNMAT|VNENE|VNCOND|VNCONS|VNHEAL|VNIND|VNUTI)&/.test(u) ? { ok: false, json: async () => ({}) } : _f(u));", t.ctx);
    await t.MP.refresh(true);
    await t.MP.S.morePromise;
    await t.MP.loadOptional();                                 // callGAS không có: thẻ ngành rơi về chỉ số ngành
    const x = text(t.els['mk-perf'].innerHTML);
    expect(x).toContain('VN-Index'); expect(x).not.toContain('VN100');
    expect(text(t.els['mk-sectors'].innerHTML)).toContain('Không lấy được chỉ số ngành');
    expect(text(t.els['mk-indices'].innerHTML)).toContain('1,738.97');
  });
});

describe('trang Thị Trường: an toàn HTML', () => {
  it('mã và tên từ nguồn ngoài không lọt thẻ script vào HTML', async () => {
    const t = boot();
    const evil = JSON.parse(JSON.stringify(FX));
    evil.prices.data.push({ code: '<img src=x onerror=alert(1)>', type: 'STOCK', floor: 'HOSE', basicPrice: 10, close: 10.7, ceilingPrice: 10.7, nmVolume: 1e6, nmValue: 1e10, ptVolume: 0, ptValue: 0, date: '2026-10-08' });
    vm.runInContext('fetch = async (u) => ({ ok: true, json: async () => (/resolution=D/.test(u) ? EV.daily : /resolution=1/.test(u) ? EV.intraday : /stock_prices/.test(u) ? EV.prices : EV.foreign) });', t.ctx);
    t.ctx.EV = evil;
    await t.MP.refresh(true);
    for (const id of ['mk-indices', 'mk-detail', 'mk-breadth', 'mk-foreign', 'mk-movers']) expect(t.els[id].innerHTML).not.toMatch(/<img|onerror|<script/i);
  });
  it('ngày lấy từ ảnh chụp/lịch sử (dữ liệu của máy chủ) được escape trước khi vào HTML', async () => {
    const snap = FX.prices.data.filter((r) => r.type === 'STOCK' && r.floor === 'HOSE').slice(0, 6).map((r, i) => ({ symbol: r.code, icb2_code: i % 2 ? '8300' : '8600', metrics: { marketcap: 1e12 * (i + 1) } }));
    const hist = []; for (let m = 0; m < 24; m++) hist.push({ as_of: new Date(Date.UTC(2024, m, 1)).toISOString().slice(0, 10), scope: 'ALL', pe_agg: 10 + (m % 5), pb_agg: 1.5 });
    const t = boot({ callGAS: async (a) => (a === 'getMarketUniverse' ? { status: 'success', data: { snapshot: snap, asOf: '<u>1-<u>2-<u>3' } } : { status: 'success', data: { rows: hist, bond10y: 3, bondDate: '<i>1-<i>2-<i>3' } }) });
    await t.MP.refresh(true);
    await t.MP.loadOptional();
    expect(t.els['mk-sectors'].innerHTML).toContain('Ngân hàng');
    expect(t.els['mk-sectors'].innerHTML).not.toContain('<u>');
    expect(t.els['mk-sectors'].innerHTML).toContain('&lt;u&gt;');
    expect(t.els['mk-valuation'].innerHTML).not.toContain('<i>');
    expect(t.els['mk-valuation'].innerHTML).toContain('&lt;i&gt;');
  });
});
