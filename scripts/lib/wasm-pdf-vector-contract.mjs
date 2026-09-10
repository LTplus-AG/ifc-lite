/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
/** Actual native WASM, preserving a declared affine geometric invariant. */
export function checkPdfVectorContract(IfcAPI) {
  const api = new IfcAPI();
  const request = {
    pdfSha256: 'a'.repeat(64), decoderVersion: '6.3.289', pageNumber: 1,
    viewBox: [10,20,110,92], userUnit: 2, intrinsicRotation: 90,
    modelMetresFromPdf: [0,-0.002,0.002,0,-0.04,0.22],
    calibrationKey: 'wall-calibration-v1', toleranceMetres: 0.0001,
    operations: [
      { ordinal: 3, operation: { kind: 'save' } },
      { ordinal: 4, operation: { kind: 'transform', matrix: [2,0,0,3,4,5] } },
      { ordinal: 5, operation: { kind: 'lineWidth', width: 2 } },
      { ordinal: 8, operation: { kind: 'path', paint: 'stroke', commands: [0,10,20,2,20,30,40,50,60,20] } },
      { ordinal: 9, operation: { kind: 'restore' } },
    ],
  };
  const prepare = input => JSON.parse(new TextDecoder().decode(api.preparePdfVectorPage(JSON.stringify(input))));
  try {
    const evidence = new URL('../../docs/architecture/evidence/pdf-vector-state/', import.meta.url);
    const decoded = JSON.parse(readFileSync(new URL('control-request.json', evidence), 'utf8'));
    const oracle = JSON.parse(readFileSync(new URL('conforming-oracle.json', evidence), 'utf8'));
    const actual = prepare(decoded);
    assert.equal(actual.stateQualified, true);
    assert.equal(actual.geometryReady, false);
    for (const expected of oracle.paths) {
      const path = actual.paths[expected.pathIndex], m = path.state.modelMetresFromPath;
      const points = [], commands = path.commands, scale = 2*0.0254/72;
      for (let cursor = 0; cursor < commands.length;) {
        const arity = [2,2,6,4,0][commands[cursor++]];
        for (let j = 0; j < arity; j += 2) {
          const x = commands[cursor+j], y = commands[cursor+j+1];
          points.push([((m[0]*x+m[2]*y+m[4])/scale-10)*2,
            (220-(m[1]*x+m[3]*y+m[5])/scale)*2]);
        }
        cursor += arity;
      }
      assert.equal(points.length, expected.oraclePoints.length);
      points.forEach((point, i) => assert.ok(Math.hypot(point[0]-expected.oraclePoints[i][0],
        point[1]-expected.oraclePoints[i][1]) < 1e-4, 'conforming path coordinates agree with independent MuPDF'));
    }
    const report = prepare(request);
    assert.equal(report.stateQualified, true);
    assert.equal(report.geometryReady, false);
    assert.deepEqual(report.pageClipPdf, request.viewBox);
    assert.ok(report.pendingGeometry.includes('pageClip'));
    assert.equal(report.paths.length, 1);
    assert.equal(report.paths[0].operatorOrdinal, 8);
    assert.equal(report.paths[0].state.lineWidth, 2);
    assert.deepEqual(report.paths[0].commands, request.operations[3].operation.commands);
    const [a,b,c,d,e,f] = report.paths[0].state.modelMetresFromPath;
    assert.ok(Math.abs(a*10+c*20+e-0.09) < 1e-15);
    assert.ok(Math.abs(b*10+d*20+f-0.172) < 1e-15);
    request.operations.push({ ordinal: 10, operation: { kind: 'unsupported', operator: 'showText' } });
    const blocked = prepare(request);
    assert.equal(blocked.stateQualified, false);
    assert.equal(blocked.diagnostics[0].operatorOrdinal, 10);
    assert.notEqual(blocked.requestSha256, report.requestSha256);
    assert.equal('plan' in blocked, false, 'preparation never supplies an IFC Apply plan');
    assert.throws(() => prepare({ ...request, undocumented: true }), /unknown field/);
    assert.throws(() => prepare({ ...request, decoderVersion: 'different' }), /decoder version/);
    assert.throws(() => api.preparePdfVectorPage(' '.repeat(32*1024*1024+1)), /32 MiB/);
  } finally { api.free(); }
}
