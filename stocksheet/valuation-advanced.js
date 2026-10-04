/* --- FILE: /stocksheet/valuation-advanced.js ---
   Thẻ "Mô hình nâng cao" của trang Định Giá CP: chi phí vốn (CAPM, lãi phi rủi ro theo ngày), P/B hợp lý và thu nhập thặng dư (ngân hàng, tổ chức tài chính), FCFE nhiều giai đoạn và
   ĐỊNH GIÁ NGƯỢC (thị trường đang kỳ vọng tăng trưởng bao nhiêu), bảng nhạy cảm, điểm chất lượng minh bạch, và ĐỐI CHIẾU ĐỘC LẬP số của app với VNDirect.
   compute() là hàm thuần (có kiểm thử) -- html() chỉ dựng chuỗi. Phụ thuộc lib/valuation-models.js (ValuationModels). Mọi chuỗi chèn vào HTML đều qua esc(). */
const ValuationAdvanced = (function () {
  const VMODELS = (typeof require === 'function' && typeof module !== 'undefined') ? require('../lib/valuation-models.js') : ValuationModels;
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = (v) => v !== null && v !== undefined && v !== '' && isFinite(Number(v));
  const dec = (v, d) => (isNum(v) ? Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: d === undefined ? 1 : d }) : '—');
  const pct = (v, d, sign) => (isNum(v) ? (sign && v > 0 ? '+' : '') + dec(v, d === undefined ? 1 : d) + '%' : '—');
  const vnd = (v) => (isNum(v) ? Math.round(Number(v)).toLocaleString('vi-VN') : '—');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const inputVal = (v) => String(Math.round(Number(v) * 10) / 10);           // giá trị cho ô <input type=number>: dấu chấm thập phân (không dùng định dạng vi-VN)

  const DEFAULTS = { erp: 0.08, gT: 0.05, years1: 5, fade: 5, rfFallback: 0.045 };
  const FIN_SECTORS = ['Ngân hàng', 'Chứng khoán', 'Bảo hiểm'];

  // ctx: { symbol, price, sector, metrics (finance_stock_ratios.metrics), rates (finance_rates), a (ValuationCalc.analyze: a.m.eps/bvps/roe/pe/pb/payout), params ({ erp, gT, g1, rf, beta, years1, fade }) }
  function compute(ctx) {
    const VM = VMODELS, m = (ctx.metrics || {}), am = (ctx.a && ctx.a.m) || {}, p = Object.assign({}, DEFAULTS, ctx.params || {});
    const price = Number(ctx.price) > 0 ? Number(ctx.price) : null;
    const financial = FIN_SECTORS.indexOf(ctx.sector) !== -1;
    const out = { ok: true, financial: financial, price: price, hasMetrics: Object.keys(m).length > 0, notes: [] };

    // lãi phi rủi ro: lợi suất trái phiếu chính phủ 10 năm mới nhất (phù hợp thời hạn của cổ phiếu); thiếu thì mức cài tay
    const r10 = (ctx.rates || []).filter((r) => r.tenor === '10Y').sort((a, b) => (a.rate_date < b.rate_date ? -1 : 1));
    const rfLive = r10.length ? Number(r10[r10.length - 1].yield_pct) / 100 : null;
    const rf = isNum(p.rf) ? Number(p.rf) : (rfLive !== null ? rfLive : p.rfFallback);
    const beta = isNum(p.beta) ? Number(p.beta) : (isNum(m.beta) ? Number(m.beta) : 1);
    const coe = VM.costOfEquity({ rf: rf, beta: beta, erp: p.erp });
    out.coe = Object.assign({}, coe, { rfSource: isNum(p.rf) ? 'manual' : (rfLive !== null ? 'bond10y' : 'fallback'), rfDate: r10.length ? r10[r10.length - 1].rate_date : null, betaSource: isNum(p.beta) ? 'manual' : (isNum(m.beta) ? 'vndirect' : 'default') });
    const ke = coe.ke;

    // đầu vào
    const eps0 = isNum(m.epsTtm) && m.epsTtm > 0 ? Number(m.epsTtm) : (isNum(am.eps) ? Number(am.eps) : null);
    const bvps = isNum(m.bvps) && m.bvps > 0 ? Number(m.bvps) : (isNum(am.bvps) ? Number(am.bvps) : null);
    const roe = isNum(m.roae) ? Number(m.roae) : (isNum(am.roe) ? Number(am.roe) / 100 : null);
    const payout = isNum(m.payoutTtm) ? clamp(Number(m.payoutTtm), 0, 1) : (isNum(am.payout) ? clamp(Number(am.payout) / 100, 0, 1) : 0.3);
    const g1Auto = roe !== null ? clamp(roe * (1 - payout), 0.03, 0.25) : 0.08;
    const g1 = isNum(p.g1) ? Number(p.g1) : g1Auto;
    out.inputs = { eps0: eps0, bvps: bvps, roe: roe, payout: payout, g1: g1, g1Auto: g1Auto, g1Manual: isNum(p.g1), gT: p.gT, years1: p.years1, fade: p.fade, erp: p.erp };

    const rows = [];
    if (roe !== null && bvps !== null) {
      const jp = VM.justifiedPB({ roe: roe, g: p.gT, ke: ke, bvps: bvps });
      if (jp && jp.ok && jp.fair > 0) rows.push({ key: 'jpb', label: 'P/B hợp lý = (ROE − g) / (Ke − g)', value: jp.fair, note: `P/B hợp lý ${dec(jp.pb, 2)}x · ROE ${pct(roe * 100)}, g ${pct(p.gT * 100)}` });
      const ri = VM.residualIncome({ bvps: bvps, roe: roe, roeTerminal: Math.max(ke, roe * 0.75 + ke * 0.25), ke: ke, g: p.gT, payout: payout, years: p.years1 });
      if (ri && ri.ok && ri.value > 0) rows.push({ key: 'ri', label: 'Thu nhập thặng dư', value: ri.value, note: `sổ sách ${vnd(ri.book)} + thặng dư ${vnd(ri.pvRi)} + cuối kỳ ${vnd(ri.tvPv)}`, detail: ri });
    }
    if (eps0 !== null && roe !== null && roe > 0) {
      const f = VM.fcfe({ eps0: eps0, roe: roe, ke: ke, g1: g1, years1: p.years1, fadeYears: p.fade, gT: p.gT, roeTerminal: Math.max(ke, roe * 0.75 + ke * 0.25) });
      if (f && f.ok && f.value > 0) { rows.push({ key: 'fcfe', label: 'FCFE nhiều giai đoạn', value: f.value, note: `tăng trưởng ${pct(g1 * 100)} ${p.years1} năm → ${pct(p.gT * 100)} · giá trị cuối kỳ ${dec(f.terminalSharePct, 0)}%`, detail: f }); out.fcfe = f; }
      else if (f && f.ok === false) out.notes.push('Ke ≤ tăng trưởng cuối kỳ: mô hình không xác định, hãy giảm g cuối kỳ hoặc tăng phần bù rủi ro.');
      // định giá ngược
      if (price) {
        const rv = VM.reverseFcfe(price, { eps0: eps0, roe: roe, ke: ke, years1: p.years1, fadeYears: p.fade, gT: p.gT, roeTerminal: Math.max(ke, roe * 0.75 + ke * 0.25) });
        if (rv) out.reverse = rv;
      }
    }
    // giá hợp lý theo mô hình: ngân hàng -> trung bình P/B hợp lý và thặng dư; còn lại -> FCFE
    const pick = financial ? rows.filter((r) => r.key === 'jpb' || r.key === 'ri') : rows.filter((r) => r.key === 'fcfe');
    out.rows = rows.map((r) => Object.assign({}, r, { upsidePct: price ? (r.value / price - 1) * 100 : null, primary: pick.indexOf(r) !== -1 }));
    out.fair = pick.length ? pick.reduce((s, r) => s + r.value, 0) / pick.length : null;
    out.fairUpsidePct = out.fair && price ? (out.fair / price - 1) * 100 : null;

    // bảng nhạy cảm theo (Ke, g cuối kỳ) cho mô hình chính
    const primary = financial ? 'jpb' : 'fcfe';
    const model = (k, g) => {
      if (primary === 'jpb') { const r = VM.justifiedPB({ roe: roe, g: g, ke: k, bvps: bvps }); return r && r.ok ? r.fair : null; }
      const r = VM.fcfe({ eps0: eps0, roe: roe, ke: k, g1: g1, years1: p.years1, fadeYears: p.fade, gT: g, roeTerminal: Math.max(k, roe * 0.75 + k * 0.25) });
      return r && r.ok ? r.value : null;
    };
    if ((financial ? (roe !== null && bvps !== null) : (eps0 !== null && roe !== null && roe > 0))) {
      const kes = [-0.02, -0.01, 0, 0.01, 0.02].map((d) => ke + d), gs = [p.gT - 0.02, p.gT - 0.01, p.gT, p.gT + 0.01];
      out.sens = Object.assign(VM.sensitivity(model, kes, gs), { primary: primary, ke: ke, gT: p.gT });
    }

    out.quality = VM.qualityScore(m, { financial: financial });

    // đối chiếu độc lập app <-> VNDirect
    const pairs = [];
    if (isNum(m.pe) && isNum(am.pe)) pairs.push({ key: 'pe', label: 'P/E', app: am.pe, ref: m.pe, tol: 0.2, fmt: 'x' });
    if (isNum(m.pb) && isNum(am.pb)) pairs.push({ key: 'pb', label: 'P/B', app: am.pb, ref: m.pb, tol: 0.2, fmt: 'x' });
    if (isNum(m.roae) && isNum(am.roe)) pairs.push({ key: 'roe', label: 'ROE', app: am.roe / 100, ref: m.roae, absTol: 0.04, fmt: '%' });
    if (isNum(m.epsTtm) && isNum(am.eps)) pairs.push({ key: 'eps', label: 'EPS (hồ sơ so với 4 quý gần nhất)', app: am.eps, ref: m.epsTtm, tol: 0.25, fmt: 'vnd' });
    if (isNum(m.bvps) && isNum(am.bvps)) pairs.push({ key: 'bvps', label: 'BVPS', app: am.bvps, ref: m.bvps, tol: 0.15, fmt: 'vnd' });
    if (isNum(ctx.ownBeta) && isNum(m.beta)) pairs.push({ key: 'beta', label: 'Beta (app so với VNDirect)', app: ctx.ownBeta, ref: m.beta, absTol: 0.2, fmt: 'n' });
    out.cross = VM.crossCheck(pairs).map((c, i) => Object.assign(c, { fmt: pairs[i].fmt }));

    // so với lịch sử của chính mã
    out.history = isNum(m.pe) ? { pe: VM.versusHistory(m.pe, { y1: m.pe1y, y3: m.pe3y, y5: m.pe5y }), pb: isNum(m.pb) ? VM.versusHistory(m.pb, { y1: m.pb1y, y3: m.pb3y, y5: m.pb5y }) : null } : null;
    return out;
  }

  const FMT = { x: (v) => dec(v, 2) + 'x', '%': (v) => pct(v * 100, 1), vnd: (v) => vnd(v), n: (v) => dec(v, 2) };

  // r: kết quả compute(); st: { loading, error, erpPct, gTPct, g1Pct } trạng thái nhập; trả HTML (đã escape)
  function html(r, st) {
    const s = st || {};
    if (s.loading) return '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-microscope"></i> Mô hình nâng cao</h3><div class="vl-empty"><i class="fa-solid fa-spinner fa-spin"></i> Đang lấy chỉ số cơ bản từ VNDirect…</div></div>';
    if (!r) return '';
    const c = r.coe, inp = r.inputs;
    const inputs = `<div class="vl-adv-inputs">
        <label>Phần bù rủi ro cổ phiếu (%)<input type="number" class="input-val" id="va-erp" min="3" max="15" step="0.5" value="${esc(inputVal(inp.erp * 100))}" onchange="vaChange()"></label>
        <label>Tăng trưởng cuối kỳ g (%)<input type="number" class="input-val" id="va-gt" min="0" max="8" step="0.5" value="${esc(inputVal(inp.gT * 100))}" onchange="vaChange()"></label>
        <label>Tăng trưởng giai đoạn 1 (%/năm)<input type="number" class="input-val" id="va-g1" min="-10" max="40" step="0.5" value="${esc(inputVal(inp.g1 * 100))}" onchange="vaChange()"><small>${inp.g1Manual ? 'bạn đặt' : 'tự tính = ROE × (1 − tỷ lệ chi trả)'}</small></label>
    </div>`;
    const coe = `<div class="vl-metric-row"><span>Chi phí vốn chủ Ke = <b>${pct(c.ke * 100, 2)}</b></span> = lãi phi rủi ro <b>${pct(c.rf * 100, 2)}</b> (${c.rfSource === 'bond10y' ? 'trái phiếu CP 10 năm, ' + esc(c.rfDate || '') : (c.rfSource === 'manual' ? 'bạn đặt' : 'mức cài tay, chưa có dữ liệu trái phiếu')}) + beta <b>${dec(c.betaUsed, 2)}</b> (${c.betaSource === 'vndirect' ? 'VNDirect ' + dec(c.beta, 2) + ', điều chỉnh Blume' : (c.betaSource === 'manual' ? 'bạn đặt' : 'mặc định 1')}) × phần bù <b>${pct(c.erp * 100, 1)}</b></div>`;
    let body = '';
    if (!r.rows.length) body += `<div class="vl-note"><i class="fa-solid fa-circle-info"></i><span>${r.hasMetrics ? 'Chưa đủ số liệu (EPS, BVPS, ROE) để chạy mô hình.' : 'Chưa có chỉ số cơ bản của mã này từ VNDirect.'}</span></div>`;
    else {
      body += `<div class="vl-table-wrap"><table class="vl-scen"><thead><tr><th>Mô hình</th><th class="num">Giá trị / cổ phiếu</th><th class="num">So với giá hiện tại</th></tr></thead><tbody>
        ${r.rows.map((x) => `<tr><td><span class="vl-m-name">${esc(x.label)}</span>${x.primary ? ' <span class="vl-m-weight">chính</span>' : ''}<small>${esc(x.note)}</small></td><td class="num vl-strong">${vnd(x.value)}</td><td class="num"><span class="${x.upsidePct > 0 ? 'pnl-up-text' : 'pnl-down-text'}">${pct(x.upsidePct, 0, true)}</span></td></tr>`).join('')}
        </tbody>${r.fair ? `<tfoot><tr><td>Giá trị theo mô hình chính</td><td class="num vl-strong">${vnd(r.fair)}</td><td class="num">${pct(r.fairUpsidePct, 0, true)}</td></tr></tfoot>` : ''}</table></div>`;
      if (r.reverse) {
        const rv = r.reverse, years = inp.years1;
        body += `<div class="vl-note"><i class="fa-solid fa-circle-question"></i><span><b>Định giá ngược:</b> ${rv.ok ? `giá hiện tại ${vnd(r.price)} ngụ ý lợi nhuận tăng khoảng <b>${pct(rv.g1 * 100, 1)}/năm trong ${years} năm</b> rồi giảm dần về ${pct(inp.gT * 100, 1)}. ${inp.g1 !== undefined && rv.g1 < inp.g1 - 0.02 ? 'Thấp hơn mức tăng trưởng bạn giả định (' + pct(inp.g1 * 100, 1) + ') — thị trường đang kỳ vọng ít hơn bạn.' : (rv.g1 > inp.g1 + 0.02 ? 'Cao hơn mức tăng trưởng bạn giả định (' + pct(inp.g1 * 100, 1) + ') — thị trường đang kỳ vọng nhiều hơn bạn.' : 'Gần với giả định của bạn.')}` : (rv.reason === 'below' ? 'giá thấp hơn cả kịch bản suy giảm mạnh nhất mô hình mô tả (tăng trưởng −10%/năm).' : 'giá cao hơn cả kịch bản tăng trưởng 60%/năm: mô hình này không giải thích được mức giá.')}</span></div>`;
      }
    }
    let sens = '';
    if (r.sens) {
      const S = r.sens;
      sens = `<h4 class="vl-sub">Độ nhạy: giá trị theo Ke và g cuối kỳ <small>(${S.primary === 'jpb' ? 'P/B hợp lý' : 'FCFE'})</small></h4><div class="vl-table-wrap"><table class="vl-scen"><thead><tr><th>g \\ Ke</th>${S.kes.map((k) => `<th class="num">${pct(k * 100, 1)}</th>`).join('')}</tr></thead><tbody>
        ${S.gs.map((g, i) => `<tr><td>${pct(g * 100, 1)}</td>${S.grid[i].map((v, j) => { const base = Math.abs(S.kes[j] - S.ke) < 1e-9 && Math.abs(g - S.gT) < 1e-9; return `<td class="num${base ? ' vl-strong' : ''}">${v === null ? '—' : vnd(v)}${v !== null && r.price ? `<small class="${v > r.price ? 'pnl-up-text' : 'pnl-down-text'}">${pct((v / r.price - 1) * 100, 0, true)}</small>` : ''}</td>`; }).join('')}</tr>`).join('')}
        </tbody></table></div><p class="vl-hint">Chênh 1 điểm % trong Ke hoặc g làm giá trị đổi rất nhiều: hãy coi khoảng giá trong bảng, không phải một con số.</p>`;
    }
    let quality = '';
    if (r.quality && r.quality.scored) {
      const q = r.quality;
      quality = `<h4 class="vl-sub">Điểm chất lượng ${q.financial ? '(bộ tiêu chí tổ chức tài chính)' : ''} <small>${q.score === null ? 'chưa đủ tiêu chí để chấm' : dec(q.score, 0) + '/100 · ' + q.passed + '/' + q.scored + ' tiêu chí đạt'}</small></h4><div class="vl-quality">
        ${q.items.map((i) => `<div class="vl-q ${i.available ? (i.pass ? 'ok' : 'bad') : 'na'}"><i class="fa-solid ${i.available ? (i.pass ? 'fa-circle-check' : 'fa-circle-xmark') : 'fa-circle-minus'}"></i><span>${esc(i.label)}</span><b>${esc(i.value || 'chưa có số liệu')}</b></div>`).join('')}</div>
        <p class="vl-hint">Các tiêu chí đơn giản, công khai, tính từ chỉ số VNDirect; không phải mô hình chấm điểm chuẩn (Piotroski, Altman) vì thiếu một số số liệu gốc. Dùng để soát nhanh, không thay cho đọc báo cáo.</p>`;
    }
    let cross = '';
    if (r.cross && r.cross.length) cross = `<h4 class="vl-sub">Đối chiếu độc lập: số trong hồ sơ so với VNDirect</h4><div class="vl-table-wrap"><table class="vl-scen"><thead><tr><th>Chỉ số</th><th class="num">Hồ sơ / app</th><th class="num">VNDirect</th><th>Kết quả</th></tr></thead><tbody>
        ${r.cross.map((x) => { const f = FMT[x.fmt] || FMT.n; return `<tr><td>${esc(x.label)}</td><td class="num">${x.app === null ? '—' : f(x.app)}</td><td class="num">${x.ref === null ? '—' : f(x.ref)}</td><td>${x.status === 'ok' ? '<span class="pnl-up-text"><i class="fa-solid fa-check"></i> khớp</span>' : (x.status === 'differs' ? `<span class="pnl-down-text"><i class="fa-solid fa-triangle-exclamation"></i> lệch${x.relPct !== null ? ' ' + dec(x.relPct, 0) + '%' : ''}</span>` : '—')}</td></tr>`; }).join('')}
        </tbody></table></div><p class="vl-hint">Lệch lớn thường do hồ sơ nhập tay cũ, số cổ phiếu khác (phát hành thêm, cổ phiếu quỹ) hoặc khác kỳ số liệu. Không nhất thiết app sai — nhưng nên biết trước khi tin vào kết quả.</p>`;
    let hist = '';
    if (r.history && r.history.pe) {
      const h = r.history.pe;
      const line = (k, l) => (h[k] ? `${l}: ${dec(h[k] * 100, 0)}% mức bình quân` : '');
      hist = `<p class="vl-hint" style="margin-top:10px">P/E hiện tại so với bình quân của chính mã — ${[line('y1', '1 năm'), line('y3', '3 năm'), line('y5', '5 năm')].filter(Boolean).join(' · ')} (dưới 100% = đang rẻ hơn lịch sử, nhưng lịch sử có thể đã khác về tăng trưởng).</p>`;
    }
    return `<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-microscope"></i> Mô hình nâng cao<span class="vl-muted">${r.financial ? 'định giá theo vốn chủ (tổ chức tài chính)' : 'dòng tiền cho cổ đông'}</span></h3>${inputs}${coe}${body}${sens}${quality}${cross}${hist}${r.notes.map((t) => `<div class="vl-note"><i class="fa-solid fa-circle-info"></i><span>${esc(t)}</span></div>`).join('')}</div>`;
  }

  return { compute, html, DEFAULTS, FIN_SECTORS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ValuationAdvanced;
