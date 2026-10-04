"""Tạo tests/fixtures/perf-golden.json: lịch sử NAV mô phỏng (có nạp/rút vốn và cổ tức), chuẩn so sánh, chuỗi lãi phi rủi ro, và kết quả TÍNH ĐỘC LẬP bằng numpy/scipy
để đối chiếu lib/perf-calc.js (lợi suất kỳ Modified Dietz, lợi suất giá, XIRR, Sharpe/Sortino/alpha theo lãi phi rủi ro từng kỳ, t-stat và khoảng tin cậy của alpha).
Chạy: python tests/fixtures/make-perf-golden.py   (cần numpy, scipy)."""
import json, os, datetime as dt
import numpy as np
from scipy import optimize

rng = np.random.default_rng(20261004)
start = dt.date(2025, 1, 6)
days = []
d = start
while len(days) < 300:
    if d.weekday() < 5: days.append(d)
    d += dt.timedelta(days=1)
n = len(days)
bench_r = rng.normal(0.0003, 0.011, n)
bench = 1200 * np.cumprod(1 + bench_r)
port_r = 0.8 * bench_r + rng.normal(0.0002, 0.006, n)

nav = np.zeros(n); contrib = np.zeros(n)
nav[0] = 500e6; contrib[0] = 500e6
divs = []      # cổ tức tiền mặt: cộng thẳng vào NAV
flows = {60: 100e6, 140: -80e6, 220: 150e6}           # chỉ số ngày: nạp (+) / rút (-)
div_days = {45: 6e6, 130: 4e6, 250: 9e6}
for t in range(1, n):
    f = flows.get(t, 0.0); dv = div_days.get(t, 0.0)
    nav[t] = nav[t-1] * (1 + port_r[t]) + f + dv
    contrib[t] = contrib[t-1] + f
    if dv: divs.append({'date': days[t].isoformat(), 'amount': dv})
rows = [{'snapshot_date': days[i].isoformat(), 'nav': float(nav[i]), 'net_contributed': float(contrib[i])} for i in range(n)]
benchrows = [[days[i].isoformat(), float(bench[i])] for i in range(n)]

# chuỗi lãi phi rủi ro (lợi suất TPCP 1 năm) đổi dần; chỉ có từ ngày thứ 100 (ngày trước dùng rf cố định)
rf_fixed = 0.045
rates = []
for i in range(100, n, 5): rates.append({'rate_date': days[i].isoformat(), 'tenor': '1Y', 'yield_pct': 3.2 + 0.4 * np.sin(i / 40.0)})
rf_series = [(r['rate_date'], r['yield_pct'] / 100) for r in rates]
def rf_at(d):
    v = None
    for dd, y in rf_series:
        if dd <= d: v = y
        else: break
    return v

# --- Modified Dietz theo từng kỳ giữa hai lần chụp liên tiếp ---
P = []
for i in range(1, n):
    flow = contrib[i] - contrib[i-1]
    denom = nav[i-1] + 0.5 * flow
    r = (nav[i] - nav[i-1] - flow) / denom
    div = sum(x['amount'] for x in divs if days[i-1].isoformat() < x['date'] <= days[i].isoformat())
    rp = (nav[i] - nav[i-1] - flow - div) / denom
    rb = bench[i] / bench[i-1] - 1
    P.append({'from': days[i-1].isoformat(), 'to': days[i].isoformat(), 'r': r, 'rp': rp, 'rb': rb, 'flow': flow, 'div': div, 'navStart': nav[i-1], 'nav': nav[i]})
r = np.array([p['r'] for p in P]); rp_ = np.array([p['rp'] for p in P]); rb = np.array([p['rb'] for p in P])
span = (days[-1] - days[0]).days
years = span / 365.25
ppy = len(P) / years
cum = np.prod(1 + r) - 1; cum_price = np.prod(1 + rp_) - 1; bench_cum = np.prod(1 + rb) - 1

# rf theo kỳ
rfp_fixed = (1 + rf_fixed) ** (1 / ppy) - 1
rfp = []
for p in P:
    a = rf_at(p['from'])
    if a is None: rfp.append(rfp_fixed)
    else:
        nd = max(1, (dt.date.fromisoformat(p['to']) - dt.date.fromisoformat(p['from'])).days)
        rfp.append((1 + a) ** (nd / 365.25) - 1)
rfp = np.array(rfp)
ex = r - rfp
sharpe = ex.mean() / ex.std(ddof=1) * np.sqrt(ppy)
down = np.sqrt(np.mean(np.minimum(0, ex) ** 2)); sortino = ex.mean() / down * np.sqrt(ppy)
exB = rb - rfp
beta = np.cov(r, rb, ddof=1)[0, 1] / np.var(rb, ddof=1)
alpha_per = ex.mean() - beta * exB.mean()
resid = ex - beta * exB - alpha_per
sd = resid.std(ddof=1); se = sd / np.sqrt(len(r))
alpha = alpha_per * ppy * 100; t = alpha_per / se
ci = [(alpha_per - 1.96 * se) * ppy * 100, (alpha_per + 1.96 * se) * ppy * 100]
years_needed = (2 * sd / abs(alpha_per)) ** 2 / ppy
# alpha giá
bp = np.cov(rp_, rb, ddof=1)[0, 1] / np.var(rb, ddof=1)
price_alpha = (np.mean(rp_ - rfp) - bp * exB.mean()) * ppy * 100

# XIRR
cf = [(days[0], -nav[0])]
for p in P:
    if abs(p['flow']) > 0:
        a = dt.date.fromisoformat(p['from']); b = dt.date.fromisoformat(p['to'])
        mid = dt.date.fromordinal((a.toordinal() + b.toordinal()) // 2)      # giữa kỳ, làm tròn xuống ngày (khớp new Date((t1+t2)/2).toISOString().slice(0,10))
        cf.append((mid, -p['flow']))
cf.append((days[-1], nav[-1]))
t0 = min(c[0] for c in cf)
def npv(rate): return sum(a / (1 + rate) ** ((d_ - t0).days / 365) for d_, a in cf)
irr = optimize.brentq(npv, -0.9999, 10, xtol=1e-14)

out = {'rows': rows, 'bench': benchrows, 'dividends': divs, 'rates': rates, 'rf_fixed': rf_fixed, 'cf': [[c[0].isoformat(), c[1]] for c in cf],
       'expected': {'periods': len(P), 'ppy': ppy, 'cumulativePct': cum * 100, 'priceCumulativePct': cum_price * 100, 'benchCumulativePct': bench_cum * 100,
                    'dividendsTotal': sum(x['amount'] for x in divs), 'sharpe': sharpe, 'sortino': sortino, 'beta': beta, 'alphaPct': alpha, 'alphaTStat': t,
                    'alphaCIPct': ci, 'alphaYearsNeeded': years_needed, 'priceAlphaPct': price_alpha, 'irrPct': irr * 100,
                    'rfEffective': float(np.mean(rfp) * ppy)}}
p = os.path.join(os.path.dirname(__file__), 'perf-golden.json')
with open(p, 'w') as f: json.dump(out, f)
print('ok', 'cum', round(cum * 100, 3), 'price', round(cum_price * 100, 3), 'irr', round(irr * 100, 3), 'alpha', round(alpha, 3), 't', round(t, 3))
