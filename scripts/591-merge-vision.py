#!/usr/bin/env python3
"""合併某批次目錄的 out-*.json 到 591-rent-house/data/vision.json,並檢查完整性。

Usage: python3 -I scripts/591-merge-vision.py 591-rent-house/data/vision-batches/<時間戳>
"""
import glob, json, os, sys, datetime
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '591-rent-house', 'data')
vp = os.path.join(D, 'vision.json')
vis = json.load(open(vp)) if os.path.exists(vp) else {}
if len(sys.argv) < 2: sys.exit(__doc__)
B = sys.argv[1]
LIGHT = {'good', 'fair', 'poor', 'unknown'}; BED = {'yes', 'no', 'unknown'}
expected, got, bad = set(), {}, []
for f in sorted(glob.glob(os.path.join(B, 'in-*.json'))):
    expected |= set(json.load(open(f)))
for f in sorted(glob.glob(os.path.join(B, 'out-*.json'))):
    try:
        got.update(json.load(open(f)))
    except Exception as e:
        bad.append((os.path.basename(f), str(e)))
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
for i, r in got.items():
    if r.get('lighting') not in LIGHT or r.get('double_bed') not in BED:
        bad.append((i, f"invalid values {r.get('lighting')}/{r.get('double_bed')}")); continue
    vis[i] = {**r, 'judged_at': now}
missing = sorted(expected - set(got))
json.dump(vis, open(vp, 'w'), ensure_ascii=False, indent=2)
print(f'expected {len(expected)} got {len(got)} merged_total {len(vis)}')
print('missing', len(missing), missing[:20]); print('bad', bad[:20])
