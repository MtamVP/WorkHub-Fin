# Sinh tests/fixtures/backtest-golden.json: số đối chiếu cho lib/strategy-backtest.js bằng numpy / scipy (cách tính ĐỘC LẬP với bản JavaScript).
# Chạy: python tests/fixtures/make-backtest-golden.py   (cần numpy, scipy)
import json
import math
import os

import numpy as np
from scipy import stats

TD = 252
rng = np.random.default_rng(20261011)
n = 600
# chuỗi chiến lược và chuẩn: lợi suất ngày có tương quan, chiến lược beta 0,8, alpha dương nhẹ, có ngày xấu
bench_r = rng.normal(0.0004, 0.011, n)
strat_r = 0.0003 + 0.8 * bench_r + rng.normal(0, 0.006, n)
strat_r[200] = -0.07
strat_r[201] = 0.04
bench = np.concatenate([[1.0], np.cumprod(1 + bench_r)])
strat = np.concatenate([[1.0], np.cumprod(1 + strat_r)])
rf = 0.03
rfd = (1 + rf) ** (1 / TD) - 1


def drawdown(x):
    peak = np.maximum.accumulate(x)
    dd = x / peak - 1
    i_to = int(np.argmin(dd))
    i_from = int(np.argmax(x[: i_to + 1]))
    return float(dd.min()), i_from, i_to


r = strat[1:] / strat[:-1] - 1
b = bench[1:] / bench[:-1] - 1
years = (len(strat) - 1) / TD
cagr = (strat[-1] / strat[0]) ** (1 / years) - 1
ex = r - rfd
sd = r.std(ddof=1)
down = math.sqrt(np.mean(np.where(ex < 0, ex, 0) ** 2))
mdd, ifrom, ito = drawdown(strat)


def newey_west(y, x, lag):
    # OLS y = a + b x với phương sai Newey-West dạng ma trận (độc lập với bản JS)
    X = np.column_stack([np.ones(len(x)), x])
    beta = np.linalg.solve(X.T @ X, X.T @ y)
    e = y - X @ beta
    u = X * e[:, None]
    S = u.T @ u
    for l in range(1, lag + 1):
        w = 1 - l / (lag + 1)
        G = u[l:].T @ u[:-l]
        S += w * (G + G.T)
    inv = np.linalg.inv(X.T @ X)
    V = inv @ S @ inv
    r2 = 1 - (e @ e) / np.sum((y - y.mean()) ** 2)
    return beta, np.sqrt(np.diag(V)), r2


beta, se, r2 = newey_west(r - rfd, b - rfd, 5)
act = r - b
te = act.std(ddof=1) * math.sqrt(TD)
cagr_b = (bench[-1] / bench[0]) ** (1 / years) - 1

# Sharpe đã trừ may rủi
sr_d = ex.mean() / ex.std(ddof=1)
skew = float(stats.skew(r, bias=True))
kurt = float(stats.kurtosis(r, fisher=False, bias=True))


def psr(sr, sr0, nobs, sk, ku):
    den = math.sqrt(max(1e-12, 1 - sk * sr + (ku - 1) / 4 * sr * sr))
    return float(stats.norm.cdf((sr - sr0) * math.sqrt(nobs - 1) / den))


def emax(trials, var):
    g = 0.5772156649015329
    return math.sqrt(var) * ((1 - g) * stats.norm.ppf(1 - 1 / trials) + g * stats.norm.ppf(1 - 1 / (trials * math.e)))


cases = []
for trials, var in [(2, 0.0004 ** 2), (10, 0.0006 ** 2), (50, 0.0006 ** 2), (200, 0.0008 ** 2)]:
    sr0 = emax(trials, var)
    cases.append({'trials': trials, 'var': var, 'sr0': sr0, 'psr0': psr(sr_d, 0, len(r), skew, kurt), 'dsr': psr(sr_d, sr0, len(r), skew, kurt)})

out = {
    'strat': strat.round(10).tolist(),
    'bench': bench.round(10).tolist(),
    'rf': rf,
    'metrics': {
        'cagr': cagr, 'annVol': sd * math.sqrt(TD), 'sharpe': ex.mean() / sd * math.sqrt(TD), 'sortino': ex.mean() / down * math.sqrt(TD),
        'maxDD': mdd, 'ddFrom': ifrom, 'ddTo': ito, 'calmar': cagr / -mdd, 'skew': skew, 'kurt': kurt,
    },
    'relative': {
        'beta': float(beta[1]), 'alpha': float(beta[0]) * TD, 'tAlpha': float(beta[0] / se[0]), 'tBeta': float(beta[1] / se[1]), 'r2': float(r2),
        'trackingError': te, 'infoRatio': float(act.mean() * TD / te), 'excessCagr': cagr - cagr_b,
    },
    'dsr': {'dailySharpe': float(sr_d), 'nObs': len(r), 'cases': cases},
    'normInv': [[p, float(stats.norm.ppf(p))] for p in [0.001, 0.02, 0.1, 0.5, 0.9, 0.975, 0.999]],
    'normCdf': [[x, float(stats.norm.cdf(x))] for x in [-3, -1.96, -0.5, 0, 0.7, 1.64, 2.5]],
}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backtest-golden.json')
with open(path, 'w', encoding='utf-8') as f:
    json.dump(out, f)
print('ghi', path, 'cagr', round(cagr, 4), 'sharpe', round(out['metrics']['sharpe'], 3), 'tAlpha', round(out['relative']['tAlpha'], 3))


# ---- hồi quy nhiều yếu tố (cho lib/factor-model.js): numpy, sai số Newey-West dạng ma trận, VIF từ ma trận tương quan ----
rng2 = np.random.default_rng(777)
nn = 420
f1 = rng2.normal(0.0004, 0.010, nn)
f2 = 0.4 * f1 + rng2.normal(0, 0.006, nn)
f3 = rng2.normal(0.0002, 0.005, nn)
yy = 0.0001 + 0.9 * f1 + 0.5 * f2 - 0.3 * f3 + rng2.normal(0, 0.004, nn)
Xm = np.column_stack([np.ones(nn), f1, f2, f3])
bet = np.linalg.solve(Xm.T @ Xm, Xm.T @ yy)
ee = yy - Xm @ bet
uu = Xm * ee[:, None]
Ss = uu.T @ uu
for l in range(1, 6):
    w = 1 - l / 6
    Gl = uu[l:].T @ uu[:-l]
    Ss += w * (Gl + Gl.T)
invx = np.linalg.inv(Xm.T @ Xm)
Vv = invx @ Ss @ invx
sees = np.sqrt(np.diag(Vv))
r2m = 1 - (ee @ ee) / np.sum((yy - yy.mean()) ** 2)
corr = np.corrcoef(np.column_stack([f1, f2, f3]), rowvar=False)
vifs = np.diag(np.linalg.inv(corr))
out['regress'] = {
    'y': yy.round(10).tolist(), 'X': [f1.round(10).tolist(), f2.round(10).tolist(), f3.round(10).tolist()], 'lag': 5,
    'alpha': float(bet[0]), 'beta': bet[1:].tolist(), 'tAlpha': float(bet[0] / sees[0]), 't': (bet[1:] / sees[1:]).tolist(), 'r2': float(r2m),
    'adjR2': float(1 - (1 - r2m) * (nn - 1) / (nn - 4)), 'residVol': float(math.sqrt(float(ee @ ee) / (nn - 4)) * math.sqrt(TD)), 'vif': vifs.tolist(),
}
with open(path, 'w', encoding='utf-8') as fh:
    json.dump(out, fh)
print('ghi them hoi quy: beta', [round(b, 3) for b in bet[1:]])
