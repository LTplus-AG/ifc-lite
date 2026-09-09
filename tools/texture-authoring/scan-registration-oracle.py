# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Compare rebuilt registration WASM with NumPy on synthetic rigid cases.

Requires NumPy, Node and `bash scripts/build-wasm.sh`. No network or fixtures.
This checks solver numerics, NOT CRAS correspondence or registration accuracy.
"""
import json
import subprocess
from pathlib import Path
import numpy as np

rng = np.random.default_rng(4381)
requests, expected = [], []
for case in range(40):
    count = [3, 4, 8, 64][case % 4]
    source = rng.normal(size=(count + 4, 3)) * 10
    rotation, _ = np.linalg.qr(rng.normal(size=(3, 3)))
    if np.linalg.det(rotation) < 0:
        rotation[:, 2] *= -1
    target = source @ rotation.T + np.array([12., -53., 27.])
    target += rng.normal(size=target.shape) * (0.005 if case % 2 else 0)
    if case % 3 == 0:
        source += 5e6
        target += 7e6
    source_centre = source[:count].mean(axis=0)
    target_centre = target[:count].mean(axis=0)
    u, _, vt = np.linalg.svd((source[:count] - source_centre).T @ (target[:count] - target_centre))
    correction = np.eye(3)
    correction[2, 2] = np.linalg.det(vt.T @ u.T)
    fitted = vt.T @ correction @ u.T
    expected.append((fitted, target_centre + (source - source_centre) @ fitted.T - target))
    pairs = [dict(id=str(i), sourceObservation=f'row:{i}', targetFeature=f'feature:{i}',
                  source=x.tolist(), target=y.tolist())
             for i, (x, y) in enumerate(zip(source, target))]
    requests.append(dict(
        sourceFrame=dict(assetSha256='a' * 64, frameKey='synthetic-source'),
        targetFrame=dict(assetSha256='b' * 64, frameKey='synthetic-target'),
        fit=pairs[:count], heldOut=pairs[count:]))

javascript = """
import {readFileSync} from 'node:fs';
import {initSync, IfcAPI} from './packages/wasm/pkg/ifc-lite.js';
initSync({module: readFileSync('./packages/wasm/pkg/ifc-lite_bg.wasm')});
const api = new IfcAPI();
try {
    const requests = JSON.parse(readFileSync(0, 'utf8'));
    const reports = requests.map(request => JSON.parse(new TextDecoder().decode(
        api.registerScanCorrespondences(JSON.stringify(request)))));
    process.stdout.write(JSON.stringify(reports));
} finally { api.free(); }
"""
result = subprocess.run(['node', '--input-type=module', '-e', javascript],
                        cwd=Path(__file__).resolve().parents[2],
                        input=json.dumps(requests), text=True, capture_output=True, check=True)
reports = json.loads(result.stdout)
assert len(reports) == len(expected)
worst_rotation, worst_residual = 0., 0.
for case, (report, (rotation, residual)) in enumerate(zip(reports, expected)):
    actual = [p['vectorMetres'] for p in report['fit']['points'] + report['heldOut']['points']]
    rotation_delta = float(np.max(abs(np.array(report['rotation']) - rotation)))
    residual_delta = float(np.max(abs(np.array(actual) - residual)))
    assert rotation_delta < 1e-10, (case, rotation_delta)
    assert residual_delta < 1e-8, (case, residual_delta)
    worst_rotation = max(worst_rotation, rotation_delta)
    worst_residual = max(worst_residual, residual_delta)
print(json.dumps(dict(cases=40, seed=4381, fit_counts=[3, 4, 8, 64], check_count=4,
    oracle='NumPy SVD, synthetic known rigid transformations with optional 5mm noise and million-metre offsets; not CRAS registration',
    max_rotation_component_delta=worst_rotation,
    max_residual_component_delta_metres=worst_residual, numpy=np.__version__), indent=2))
