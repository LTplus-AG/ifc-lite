/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// These are derived fingerprint tokens, NEVER hashes claimed to come from the
// Rust mesher. The descriptor records the source geometry hash and exact affine
// operation. Both revisions use this same token scheme. No IFC bytes are edited.
const token = descriptor => `derived:sha256:${createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')}`;

/** #8042: controlled projections of a real closed solid. Translation preserves
 * volume; axis scaling multiplies it by its determinant. Two copies whose AABB
 * interiors are disjoint have a known union volume (sum), even for a non-box
 * source. Do NOT cut an arbitrary source AABB and invent half its volume. */
export function derivedGeometryCases(rows, fingerprintApi) {
  const source = rows.find(row => row.geometryHash !== undefined && row.volume > 0
    && row.aabb && row.aabb.min.every((min, axis) => row.aabb.max[axis] > min));
  assert.ok(source, 'need a real closed solid with three positive extents (#8042)');
  const extents = source.aabb.max.map((max, axis) => max - source.aabb.min[axis]);
  const axis = extents.indexOf(Math.max(...extents));
  const sourceHash = String(source.geometryHash);
  const opaque = operation => ({ sourceExpressId: source.ref, operation, locate: () => source.ref });
  const revision = (key, name, geometry) => {
    const input = { ifcType: source.ifcType, name };
    return {
      ...source, key,
      dataHash: fingerprintApi.buildDataFingerprint(input),
      components: fingerprintApi.buildComponentFingerprints(input),
      ref: opaque(key), ...geometry,
    };
  };
  const identity = [1, 1, 1];
  const zero = [0, 0, 0];
  const affine = (scale, translate) => ({
    geometryHash: token({ sourceHash, scale, translate }),
    aabb: {
      min: source.aabb.min.map((min, i) => min + translate[i]),
      max: source.aabb.max.map((max, i) => source.aabb.min[i] + (max - source.aabb.min[i]) * scale[i] + translate[i]),
    },
    volume: source.volume * scale.reduce((product, value) => product * value, 1),
  });
  const translation = [...zero];
  translation[axis] = extents[axis];
  const pieces = [
    revision('derived:piece:0', 'derived piece 0', affine(identity, zero)),
    revision('derived:piece:1', 'derived piece 1', affine(identity, translation)),
  ];
  assert.equal(pieces[0].aabb.max[axis], pieces[1].aabb.min[axis], 'AABB interiors are disjoint');
  const unionBox = {
    min: source.aabb.min.map((_, i) => Math.min(...pieces.map(piece => piece.aabb.min[i]))),
    max: source.aabb.max.map((_, i) => Math.max(...pieces.map(piece => piece.aabb.max[i]))),
  };
  // The whole is a DERIVED GROUP of those exact solids, not a producer-proved
  // single-component IFC solid. Its volume is known by disjointness, not by Qto.
  const whole = revision('derived:whole', 'derived union of pieces 0 and 1', {
    geometryHash: token({ union: pieces.map(piece => piece.geometryHash) }),
    aabb: unionBox, volume: pieces.reduce((sum, piece) => sum + piece.volume, 0),
  });
  assert.equal(whole.volume, 2 * source.volume);
  const base = revision('derived:predecessor', 'derived original specification', affine(identity, zero));
  const scale = [...identity];
  scale[axis] = 1.1;
  const head = revision('derived:successor', 'derived edited specification', affine(scale, zero));
  assert.notEqual(base.dataHash, head.dataHash);
  assert.notEqual(base.geometryHash, head.geometryHash);
  const common = { matchUnpairedByContent: true, detectSplitMerge: true, detectSuccessors: true };
  return {
    provenance: {
      kind: 'explicit derived fingerprint revisions; not authored IFC ground truth',
      sourceKey: source.key, sourceExpressId: source.ref, ifcType: source.ifcType,
      sourceHash, sourceAabb: source.aabb, sourceVolume: source.volume,
      axis, translation, successorScale: scale,
      union: 'two translated source solids; disjoint AABB interiors; exact sum of measured volumes',
      hashScheme: 'derived:sha256 of source hash plus affine operation or union members',
    },
    cases: [
      { name: 'derived-split', base: [whole], head: pieces, options: common, kind: 'split' },
      { name: 'derived-merge', base: pieces, head: [whole], options: common, kind: 'merge' },
      { name: 'derived-successor', base: [base], head: [head], options: common, kind: 'successor' },
      // Geometry-scope control: changing both data and geometry must still
      // leave a nonempty successor claim through the public option projection.
      { name: 'derived-successor-geometry-scope', base: [base], head: [head], options: { ...common, scope: 'geometry' }, kind: 'successor' },
    ],
  };
}

/** Deep equality does not prove identity. Check every reference-bearing result
 * path independently, including opaque callback refs that cannot cross WASM. */
export function assertOriginalReferences(actual, base, head) {
  const inSide = (row, side) => {
    // Reference membership implies the original `ref` is carried with it.
    assert.ok(side.includes(row), `${row.key}: result must reuse the original fingerprint`);
  };
  for (const entry of actual.entries) {
    assert.strictEqual(actual.byKey.get(entry.key), entry);
    if (entry.base) inSide(entry.base, base);
    if (entry.head) inSide(entry.head, head);
  }
  for (const match of actual.contentMatches ?? []) {
    match.base.forEach(row => inSide(row, base));
    match.head.forEach(row => inSide(row, head));
  }
  for (const claim of actual.splitMerges ?? []) {
    const [wholes, pieces] = claim.kind === 'split' ? [base, head] : [head, base];
    inSide(claim.whole, wholes);
    claim.pieces.forEach(row => inSide(row, pieces));
    if (claim.excluded) inSide(claim.excluded, pieces);
  }
  for (const claim of actual.successors ?? []) {
    inSide(claim.base, base);
    inSide(claim.head, head);
  }
}

export function assertDerivedClaims(actual, scenario) {
  assert.equal(actual.contentMatches.length, 0, 'derived data revisions must reach the additive stages');
  assert.deepEqual(actual.counts, {
    added: scenario.head.length, deleted: scenario.base.length, modified: 0, unchanged: 0,
  }, 'claims must preserve all add/delete entries');
  if (scenario.kind === 'successor') {
    assert.equal(actual.splitMerges.length, 0);
    assert.equal(actual.successors.length, 1, 'changed data AND geometry must produce a successor');
    const claim = actual.successors[0];
    assert.strictEqual(claim.base, scenario.base[0]);
    assert.strictEqual(claim.head, scenario.head[0]);
    assert.equal(claim.confidence, 'footprint');
    assert.ok(Math.abs(claim.overlap - 1 / 1.1) < 1e-10);
  } else {
    assert.equal(actual.successors.length, 0, 'split/merge participants are bound before successor detection');
    assert.equal(actual.splitMerges.length, 1, 'must exercise a nonempty split/merge result');
    const claim = actual.splitMerges[0];
    assert.equal(claim.kind, scenario.kind);
    assert.equal(claim.confidence, 'verified');
    assert.equal(claim.pieces.length, 2);
    // Check both reported volumes against the derived rows' known volumes, not
    // only against each other: a shared error in both engines must still fail.
    const [whole] = scenario.kind === 'split' ? scenario.base : scenario.head;
    const pieces = scenario.kind === 'split' ? scenario.head : scenario.base;
    assert.equal(claim.wholeVolume, whole.volume, 'whole volume must match the derived whole');
    assert.equal(claim.piecesVolume, pieces.reduce((sum, piece) => sum + piece.volume, 0),
      'pieces volume must match the derived pieces');
    assert.equal(claim.volumeResidual, 0);
  }
}
