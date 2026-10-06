/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { room } from './wasm-scan-segmentation-contract.mjs';

const PROPOSAL_FIELDS = ['basis', 'confidence', 'fit', 'geometry', 'id', 'ifcClass', 'sources'];

/** Actual Rust/WASM calls: the #6870 seeded room (5 x 4 x 2.6 m, column r 0.25) proposed into a moved model frame. */
export function checkScanProposalContract(IfcAPI) {
  const api = new IfcAPI();
  const decode = bytes => JSON.parse(new TextDecoder().decode(bytes));
  try {
    const { positions } = room();
    const report = new TextDecoder().decode(api.segmentScanPoints(positions, JSON.stringify({ scannerPosition: [2.5, 2, 1.5] })));
    // Model frame = scan frame + (100, 200, 10).
    const scanToModel = [1, 0, 0, 100, 0, 1, 0, 200, 0, 0, 1, 10, 0, 0, 0, 1];
    const out = decode(api.proposeScanElements(report, JSON.stringify({ scanToModel })));
    assert.equal(out.algorithm, 'ifclite-scan-proposals-v1');
    assert.deepEqual(Object.keys(out.proposals[0]).sort(), PROPOSAL_FIELDS);
    const of = cls => out.proposals.filter(p => p.ifcClass === cls);
    assert.equal(of('IfcWall').length, 4, 'four single-face walls');
    assert.ok(of('IfcWall').every(p => p.basis === 'singleFace' && p.geometry.thicknessMetres === 0.2));
    // The west face (x = 0) puts its wall outside the room: axis x = -0.1.
    const west = of('IfcWall').find(p => Math.abs(p.geometry.start[0] - p.geometry.end[0]) < 0.05 && p.geometry.start[0] < 102.5);
    assert.ok(west && Math.abs(west.geometry.start[0] - 99.9) < 0.03, `west wall axis ${west?.geometry.start}`);
    assert.ok(Math.abs(west.geometry.start[2] - 10) < 0.03 && Math.abs(west.geometry.heightMetres - 2.6) < 0.03, 'snapped to floor and ceiling');
    assert.deepEqual(of('IfcSlab').map(p => p.basis).sort(), ['ceiling', 'floor']);
    const [column] = of('IfcColumn');
    assert.ok(Math.hypot(column.geometry.base[0] - 103.5, column.geometry.base[1] - 202) < 0.015, `column ${column.geometry.base}`);
    assert.ok(Math.abs(column.geometry.radiusMetres - 0.25) < 0.01);
    assert.deepEqual(column.sources, [{ kind: 'cylinder', index: 0 }]);
    assert.throws(() => api.proposeScanElements(report, '{"surprise":1}'), /unknown field/);
    assert.throws(() => api.proposeScanElements('{}', '{}'), /Invalid scan segmentation report/);
    assert.throws(() => api.proposeScanElements(report, JSON.stringify({ scanToModel: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })), /uniform scale/);
  } finally { api.free(); }
}
