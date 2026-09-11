/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Actual Rust/WASM calls: no mocked planner or synthetic returned report. */
export function checkScanRegistrationContract(IfcAPI) {
  const api = new IfcAPI();
  const solve = request => JSON.parse(new TextDecoder().decode(api.registerScanCorrespondences(JSON.stringify(request))));
  const points = [[0, 0, 0], [2, 0, 0], [0, 3, 0], [0, 0, 4], [2, 3, 4], [-2, 1, 3], [3, -1, 2], [1, 4, -2]];
  const pairs = points.map((source, i) => ({ id: `p${i}`, sourceObservation: `row:${i}`, targetFeature: `guid:corner:${i}`,
    source, target: [-source[1] + 10, source[0] - 5, source[2] + 2] }));
  const request = {
    sourceFrame: { assetSha256: 'a'.repeat(64), frameKey: 'source-native-metres' },
    targetFrame: { assetSha256: 'b'.repeat(64), frameKey: 'ifc-world-z-up-revision-1' },
    fit: pairs.slice(0, 4), heldOut: pairs.slice(4),
  };
  try {
    for (const fixture of ['registration_thin_fixture.json', 'registration_anisotropic_fixture.json']) {
      const thin = JSON.parse(readFileSync(new URL(`../../rust/processing/src/appearance/${fixture}`, import.meta.url), 'utf8'));
      const thinReport = solve(thin.request);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        assert.ok(Math.abs(thinReport.rotation[i][j] - thin.expectedRotation[i][j]) < 1e-6);
      }
      assert.ok(thinReport.heldOut.maxMetres < 1e-8, 'thin accepted sets retain accurate rotation through WASM');
    }
    const report = solve(request);
    assert.ok(report.fit.maxMetres < 1e-12);
    assert.ok(report.heldOut.maxMetres < 1e-12);
    assert.deepEqual(report.sourceFrame, request.sourceFrame);
    assert.deepEqual(report.targetFrame, request.targetFrame);
    // Rust serializes f64 coordinates with .0 for integer-valued numbers; digest
    // must be checked using the documented typed serialization, not JS stringify.
    const typedJson = JSON.stringify(request).replace(/\[(?:-?\d+(?:,|\])){3}/g,
      vector => vector.replace(/-?\d+/g, number => `${number}.0`));
    const digest = createHash('sha256').update(report.algorithm).update(Buffer.from([0])).update(typedJson).digest('hex');
    assert.equal(report.requestSha256, digest);
    request.heldOut[0].target[0] += 100;
    const changed = solve(request);
    assert.deepEqual(changed.rotation, report.rotation);
    assert.deepEqual(changed.sourceAnchor, report.sourceAnchor);
    assert.deepEqual(changed.targetAnchor, report.targetAnchor);
    assert.ok(Math.abs(changed.heldOut.maxMetres - 100) < 1e-10);
    assert.notEqual(changed.requestSha256, report.requestSha256);
    request.heldOut[0].sourceObservation = request.fit[0].sourceObservation;
    assert.throws(() => solve(request), /distinct/);
    assert.throws(() => api.registerScanCorrespondences(' '.repeat(512 * 1024 + 1)), /512 KiB/);
    assert.throws(() => solve({ ...request, undocumented: true }), /unknown field/);
  } finally { api.free(); }
}
