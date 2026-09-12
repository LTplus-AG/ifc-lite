/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
/** Actual native WASM, preserving a declared affine geometric invariant and
 * the fidelity report contract (#4406): convertible paths keep their calibrated
 * state, omissions carry page-space extents in the same unrotated CropBox frame. */
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
      { ordinal: 8, operation: { kind: 'path', paint: 'stroke', commands: [0,10,20,1,60,20] } },
      { ordinal: 9, operation: { kind: 'restore' } },
    ],
  };
  const prepare = input => JSON.parse(new TextDecoder().decode(api.preparePdfVectorPage(JSON.stringify(input))));
  const scale = 2*0.0254/72;
  // Calibrated model metres back to the oracle's unrotated physical-point frame.
  const toOracle = (x, y) => [(x/scale-10)*2, (220-y/scale)*2];
  try {
    const evidence = new URL('../../docs/architecture/evidence/pdf-vector-state/', import.meta.url);
    const decoded = JSON.parse(readFileSync(new URL('control-request.json', evidence), 'utf8'));
    const oracle = JSON.parse(readFileSync(new URL('conforming-oracle.json', evidence), 'utf8'));
    const actual = prepare(decoded);
    assert.equal(actual.algorithm, 'ifclite-pdf-vector-state-v1');
    assert.equal(actual.fidelity.algorithm, 'ifclite-pdf-fidelity-v1');
    // The control's cubic and dashed strokes are reported, never converted.
    assert.equal(actual.fidelity.exact, false);
    assert.equal(actual.fidelity.rasterOnly, false);
    assert.equal(actual.fidelity.convertiblePaths, actual.paths.length);
    assert.deepEqual(actual.fidelity.summary.map(s => [s.kind, s.count, s.visibleCount]), [['curvedStroke',1,1],['dash',1,1]]);
    const [pdfA, pdfB, pdfC, pdfD, pdfE, pdfF] = oracle.pdfToOracle;
    for (const expected of oracle.paths) {
      const path = actual.paths.find(p => p.operatorOrdinal === expected.operatorOrdinal);
      if (path) {
        const m = path.state.modelMetresFromPath, points = [], commands = path.commands;
        for (let cursor = 0; cursor < commands.length;) {
          const arity = [2,2,6,4,0][commands[cursor++]];
          for (let j = 0; j < arity; j += 2) {
            const x = commands[cursor+j], y = commands[cursor+j+1];
            points.push(toOracle(m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]));
          }
          cursor += arity;
        }
        assert.equal(points.length, expected.oraclePoints.length);
        points.forEach((point, i) => assert.ok(Math.hypot(point[0]-expected.oraclePoints[i][0],
          point[1]-expected.oraclePoints[i][1]) < 1e-4, 'conforming path coordinates agree with independent MuPDF'));
        continue;
      }
      // Omitted paints locate themselves in unrotated PDF user space: their extent
      // maps onto the bounding box of the same MuPDF-measured points.
      const omission = actual.fidelity.omissions.find(o => o.operatorOrdinal === expected.operatorOrdinal);
      assert.ok(omission?.visible, `omission ${expected.operatorOrdinal} is listed and visible`);
      const corners = [[omission.bboxPdf[0], omission.bboxPdf[1]], [omission.bboxPdf[2], omission.bboxPdf[3]]]
        .map(([x, y]) => [pdfA*x+pdfC*y+pdfE, pdfB*x+pdfD*y+pdfF]);
      const xs = expected.oraclePoints.map(p => p[0]), ys = expected.oraclePoints.map(p => p[1]);
      const box = [Math.min(...corners.map(c => c[0])), Math.min(...corners.map(c => c[1])), Math.max(...corners.map(c => c[0])), Math.max(...corners.map(c => c[1]))];
      for (const [got, want] of [[box[0], Math.min(...xs)], [box[1], Math.min(...ys)], [box[2], Math.max(...xs)], [box[3], Math.max(...ys)]])
        assert.ok(Math.abs(got-want) < 1e-4, `omission extent ${got} agrees with independent MuPDF ${want}`);
    }
    const report = prepare(request);
    assert.equal(report.fidelity.exact, true);
    assert.equal(report.fidelity.convertiblePaths, 1);
    assert.deepEqual(report.fidelity.omissions, []);
    assert.deepEqual(report.pageClipPdf, request.viewBox);
    assert.equal(report.paths.length, 1);
    assert.equal(report.paths[0].operatorOrdinal, 8);
    assert.equal(report.paths[0].state.lineWidth, 2);
    assert.deepEqual(report.paths[0].commands, request.operations[3].operation.commands);
    const [a,b,c,d,e,f] = report.paths[0].state.modelMetresFromPath;
    assert.ok(Math.abs(a*10+c*20+e-0.09) < 1e-15);
    assert.ok(Math.abs(b*10+d*20+f-0.172) < 1e-15);
    request.operations.push({ ordinal: 10, operation: { kind: 'unsupported', operator: 'showText' } });
    const blocked = prepare(request);
    assert.equal(blocked.fidelity.exact, false);
    assert.equal(blocked.fidelity.omissions[0].operatorOrdinal, 10);
    assert.equal(blocked.fidelity.omissions[0].kind, 'unsupported:showText');
    assert.equal(blocked.paths.length, 1, 'the earlier convertible path stays convertible');
    assert.notEqual(blocked.requestSha256, report.requestSha256);
    assert.notEqual(blocked.fidelity.sha256, report.fidelity.sha256, 'the verdict digest binds the omissions');
    assert.equal('plan' in blocked, false, 'preparation never supplies an IFC Apply plan');
    assert.throws(() => prepare({ ...request, undocumented: true }), /unknown field/);
    assert.throws(() => prepare({ ...request, decoderVersion: 'different' }), /decoder version/);
    assert.throws(() => api.preparePdfVectorPage(' '.repeat(32*1024*1024+1)), /32 MiB/);
  } finally { api.free(); }
}
