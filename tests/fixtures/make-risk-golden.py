"""Tạo tests/fixtures/risk-models-golden.json: dữ liệu mô phỏng cố định (seed) và kết quả TÍNH ĐỘC LẬP bằng numpy/scipy để đối chiếu lib/risk-models.js.
Chạy: python tests/fixtures/make-risk-golden.py   (cần numpy, scipy). Không cần chạy lại trừ khi đổi dữ liệu/công thức."""
import json, os
import numpy as np
from scipy import stats

rng = np.random.default_rng(20261004)
T = 420
# chỉ số: biến động có cụm (GARCH đơn giản) để EWMA / FHS / backtest có ý nghĩa
sig = np.zeros(T); r_m = np.zeros(T); sig[0] = 0.011
for t in range(1, T):
    sig[t] = np.sqrt(0.000004 + 0.08 * r_m[t-1]**2 + 0.9 * sig[t-1]**2)
    r_m[t] = sig[t] * rng.standard_t(6) * np.sqrt(4/6)
# 3 mã: beta khác nhau, mã kém thanh khoản phản ứng trễ một ngày (để Dimson khác hồi quy thường)
def mk(beta, lag_share, idio):
    eps = rng.normal(0, idio, T)
    lagged = np.concatenate([[0], r_m[:-1]])
    return beta * ((1 - lag_share) * r_m + lag_share * lagged) + eps
A = mk(1.1, 0.0, 0.010); B = mk(0.9, 0.5, 0.012); C = mk(0.6, 0.0, 0.015)
R = np.vstack([A, B, C]).T                      # T x 3

out = {'T': T, 'bench': r_m.tolist(), 'A': A.tolist(), 'B': B.tolist(), 'C': C.tolist()}

# EWMA (khởi tạo bằng phương sai mẫu 20 ngày đầu)
lam = 0.94
def ewma(r):
    v = np.var(r[:20], ddof=1); s = []
    for x in r:
        s.append(np.sqrt(v)); v = lam * v + (1 - lam) * x * x
    return np.array(s), np.sqrt(v)
w = np.array([0.4, 0.3, 0.2])                   # 10% tiền mặt
port = R @ w
s, nxt = ewma(port)
out['port'] = port.tolist()
out['ewma'] = {'sigmaNext': nxt, 'series_last5': s[-5:].tolist(), 'series_first3': s[:3].tolist()}

# Dimson: hồi quy r_B,t trên bench t-1, t, t+1
def dimson(y, m):
    yy = y[1:-1]; X = np.column_stack([np.ones(T-2), m[:-2], m[1:-1], m[2:]])
    b = np.linalg.lstsq(X, yy, rcond=None)[0]
    X1 = np.column_stack([np.ones(T-2), m[1:-1]])
    b1 = np.linalg.lstsq(X1, yy, rcond=None)[0]
    return {'beta': float(b[1:].sum()), 'simple': float(b1[1]), 'coefs': b[1:].tolist(), 'obs': T-2}
out['dimson'] = {'A': dimson(A, r_m), 'B': dimson(B, r_m), 'C': dimson(C, r_m)}

# Ledoit-Wolf 2004 (co về mu*I) theo công thức gốc, rồi nhân T/(T-1)
Xc = R - R.mean(axis=0)
S = Xc.T @ Xc / T
p = 3; mu = np.trace(S) / p
d2 = np.sum((S - mu * np.eye(p))**2) / p
b2bar = sum(np.sum((np.outer(x, x) - S)**2) for x in Xc) / (T**2) / p
b2 = min(b2bar, d2); delta = b2 / d2
cov = (delta * mu * np.eye(p) + (1 - delta) * S) * T / (T - 1)
sample = S * T / (T - 1)
out['lw'] = {'delta': delta, 'cov': cov.tolist(), 'sample': sample.tolist()}
def prisk(w, C):
    v = w @ C @ w; vol = np.sqrt(v); contrib = w * (C @ w) / vol
    return {'vol': vol, 'annPct': vol * np.sqrt(252) * 100, 'contrib': contrib.tolist(), 'sharePct': (contrib / vol * 100).tolist()}
out['risk'] = {'sample': prisk(w, sample), 'shrunk': prisk(w, cov)}
# tương quan căng thẳng k = 0,5
sd = np.sqrt(np.diag(cov)); corr = cov / np.outer(sd, sd)
corr_s = corr + 0.5 * (1 - corr); np.fill_diagonal(corr_s, 1)
cov_s = corr_s * np.outer(sd, sd)
out['stress'] = {'k': 0.5, 'annPct': prisk(w, cov_s)['annPct']}

# chi bình phương
out['chi2'] = {'df1': [[x, float(stats.chi2.sf(x, 1))] for x in (0.5, 1.0, 3.841458820694124, 6.6349, 10.0)], 'df2': [[x, float(stats.chi2.sf(x, 2))] for x in (0.5, 2.0, 5.99146, 9.0)]}

# Kiểm định ngược: VaR lịch sử cửa sổ 250, mức 95%
W = 250; level = 0.95; pr = 1 - level
hits = []
for t in range(W, T):
    v = np.percentile(port[t-W:t], pr * 100)
    hits.append(1 if port[t] < v else 0)
hits = np.array(hits); n = len(hits); x = int(hits.sum()); pi = x / n
def xlogy(a, b): return 0.0 if a == 0 else a * np.log(b)
lr_pof = -2 * (xlogy(n - x, 1 - pr) + xlogy(x, pr)) + 2 * (xlogy(n - x, 1 - pi) + xlogy(x, pi))
n00 = n01 = n10 = n11 = 0
for i in range(1, n):
    a, b = hits[i-1], hits[i]
    if a == 0 and b == 0: n00 += 1
    elif a == 0 and b == 1: n01 += 1
    elif a == 1 and b == 0: n10 += 1
    else: n11 += 1
pi01 = n01 / (n00 + n01) if n00 + n01 else 0; pi11 = n11 / (n10 + n11) if n10 + n11 else 0; pia = (n01 + n11) / (n00 + n01 + n10 + n11)
lr_ind = -2 * (xlogy(n00 + n10, 1 - pia) + xlogy(n01 + n11, pia)) + 2 * (xlogy(n00, 1 - pi01) + xlogy(n01, pi01) + xlogy(n10, 1 - pi11) + xlogy(n11, pi11))
lr_ind = max(0.0, lr_ind)
out['backtest'] = {'n': n, 'x': x, 'lr_pof': lr_pof, 'p_pof': float(stats.chi2.sf(lr_pof, 1)), 'lr_ind': lr_ind, 'p_ind': float(stats.chi2.sf(lr_ind, 1)),
                   'lr_cc': lr_pof + lr_ind, 'p_cc': float(stats.chi2.sf(lr_pof + lr_ind, 2)), 'trans': [n00, n01, n10, n11]}

# FHS
e, nxt2 = ewma(port)
z = port / e
q = np.percentile(z, 5)
out['fhs'] = {'varPct': float(-q * nxt2 * 100), 'cvarPct': float(-z[z <= q].mean() * nxt2 * 100), 'q': float(q)}

p = os.path.join(os.path.dirname(__file__), 'risk-models-golden.json')
with open(p, 'w') as f: json.dump(out, f)
print('ok', p, 'exceptions', x, 'of', n, 'delta', round(delta, 4))
