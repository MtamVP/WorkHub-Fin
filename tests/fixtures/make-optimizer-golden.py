# Tạo tests/fixtures/optimizer-golden.json: lời giải ĐỘC LẬP bằng scipy.optimize (SLSQP) cho lib/portfolio-optimizer.js.
# Chạy: python tests/fixtures/make-optimizer-golden.py  (numpy, scipy)
import json, os
import numpy as np
from scipy.optimize import minimize

rng = np.random.default_rng(20261009)
cases = []

def solve(fun, n, lo, hi, x0=None):
    cons = [{'type': 'eq', 'fun': lambda w: np.sum(w) - 1.0}]
    x0 = np.full(n, 1.0 / n) if x0 is None else x0
    best = None
    for start in [x0] + [rng.dirichlet(np.ones(n)) for _ in range(6)]:
        start = np.clip(start, lo, hi); start = start / start.sum()
        r = minimize(fun, start, method='SLSQP', bounds=[(lo, hi)] * n, constraints=cons, options={'ftol': 1e-15, 'maxiter': 2000})
        if r.success and (best is None or r.fun < best.fun):
            best = r
    return best.x

for (n, lo, hi, seed) in [(4, 0.0, 1.0, 1), (5, 0.0, 0.35, 2), (6, 0.05, 0.30, 3), (8, 0.0, 0.25, 4)]:
    r = np.random.default_rng(seed)
    A = r.normal(0, 0.15, (n, n))
    C = A @ A.T / n + np.diag(r.uniform(0.01, 0.06, n))      # hiệp phương sai năm hợp lý (biến động 15%-45%)
    mu = r.uniform(0.02, 0.25, n)
    rf = 0.03
    var = lambda w: w @ C @ w
    wmv = solve(var, n, lo, hi)
    neg_sharpe = lambda w: -((w @ mu - rf) / np.sqrt(w @ C @ w))
    wms = solve(neg_sharpe, n, lo, hi)
    def erc_obj(w):
        s = np.sqrt(w @ C @ w); rc = w * (C @ w) / s
        return np.sum((rc - s / n) ** 2) * 1e4
    werc = solve(erc_obj, n, 1e-6, 1.0)                     # ERC không chặn (để so với thuật toán hạ toạ độ)
    cases.append({'n': n, 'lo': lo, 'hi': hi, 'C': C.tolist(), 'mu': mu.tolist(), 'rf': rf,
                  'minvar': {'w': wmv.tolist(), 'vol': float(np.sqrt(var(wmv)))},
                  'maxsharpe': {'w': wms.tolist(), 'sharpe': float(-neg_sharpe(wms))},
                  'erc': {'w': werc.tolist()}})

out = os.path.join(os.path.dirname(__file__), 'optimizer-golden.json')
json.dump({'generated': 'scipy ' + __import__('scipy').__version__ + ' SLSQP', 'cases': cases}, open(out, 'w'), indent=1)
print('ok', out, [ (c['n'], round(c['minvar']['vol'], 4), round(c['maxsharpe']['sharpe'], 4)) for c in cases ])
