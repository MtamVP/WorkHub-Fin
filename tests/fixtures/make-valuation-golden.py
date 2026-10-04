"""Tạo tests/fixtures/valuation-golden.json: kết quả định giá tính ĐỘC LẬP bằng Python (vòng lặp thẳng, không dùng công thức đóng) để đối chiếu lib/valuation-models.js.
Chạy: python tests/fixtures/make-valuation-golden.py"""
import json, os

def ri(bvps, roe, roe_t, ke, g, payout, N):
    bv = bvps; pv = 0.0
    for t in range(1, N + 1):
        r = roe + (roe_t - roe) * t / N
        pv += (r - ke) * bv / (1 + ke) ** t
        bv = bv * (1 + r * (1 - payout))
    tv = (roe_t - ke) * bv / (ke - g) / (1 + ke) ** N
    return bvps + pv + tv, pv, tv

def fcfe(eps0, roe, roe_t, ke, g1, N1, N2, gT):
    eps = eps0; pv = 0.0; t = 0
    for i in range(N1):
        t += 1; eps *= 1 + g1; cf = eps * (1 - min(1, max(0, g1 / roe))); pv += cf / (1 + ke) ** t
    for i in range(1, N2 + 1):
        w = i / (N2 + 1); g = g1 + (gT - g1) * w; r = roe + (roe_t - roe) * w
        t += 1; eps *= 1 + g; cf = eps * (1 - min(1, max(0, g / r))); pv += cf / (1 + ke) ** t
    cfn = eps * (1 + gT) * (1 - min(1, max(0, gT / roe_t)))
    tv = cfn / (ke - gT) / (1 + ke) ** t
    return pv + tv, pv, tv

cases = []
for p in [dict(bvps=29278.96, roe=0.182, roe_t=0.12, ke=0.105, g=0.05, payout=0.09, N=5),
          dict(bvps=21133.2, roe=0.24, roe_t=0.105, ke=0.105, g=0.05, payout=0.34, N=5),
          dict(bvps=15000, roe=0.08, roe_t=0.08, ke=0.11, g=0.04, payout=0.3, N=7)]:
    v, pv, tv = ri(**p); cases.append({'in': p, 'value': v, 'pv': pv, 'tv': tv})
fc = []
for p in [dict(eps0=5870, roe=0.24, roe_t=0.15, ke=0.105, g1=0.15, N1=5, N2=5, gT=0.05),
          dict(eps0=3000, roe=0.12, roe_t=0.12, ke=0.12, g1=0.08, N1=3, N2=0, gT=0.04),
          dict(eps0=4984, roe=0.182, roe_t=0.182, ke=0.10, g1=0.20, N1=5, N2=5, gT=0.06)]:
    v, pv, tv = fcfe(**p); fc.append({'in': p, 'value': v, 'pv': pv, 'tv': tv})
# định giá ngược: tìm g1 sao cho FCFE = giá (chia đôi độc lập)
rev_in = dict(eps0=5870, roe=0.24, roe_t=0.24, ke=0.105, N1=5, N2=5, gT=0.05)
target = 70000.0
lo, hi = -0.10, 0.60
for _ in range(200):
    mid = (lo + hi) / 2
    v, _, _ = fcfe(g1=mid, **rev_in)
    if v < target: lo = mid
    else: hi = mid
rev = {'in': rev_in, 'price': target, 'g1': (lo + hi) / 2}
out = {'ri': cases, 'fcfe': fc, 'reverse': rev}
p = os.path.join(os.path.dirname(__file__), 'valuation-golden.json')
json.dump(out, open(p, 'w'))
print('ok', [round(c['value'], 2) for c in cases], [round(c['value'], 2) for c in fc], round(rev['g1'], 6))
