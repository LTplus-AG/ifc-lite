/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Independent expected-input oracle for the literal audited placeMesh contract.
// It is NEVER applied to retained Scene output. No general normalization.
// Self-contained because the frozen function executes in the browser realm.
export function expectedZeroPlacedMesh(source) {
  const fail = reason => { throw new Error(`REFUSE input identity: zero-placement ${reason}`); };
  const triple = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
  if (!source || source.modelIndex !== 0) fail('primary namespace unavailable');
  if (source.origin !== undefined && !triple(source.origin)) fail('origin schema');
  if (source.localToWorld !== undefined && (!Array.isArray(source.localToWorld)
    || source.localToWorld.length !== 16 || !source.localToWorld.every(Number.isFinite))) fail('localToWorld schema');
  if (source.geometryAabb !== undefined && (!source.geometryAabb
    || Object.getPrototypeOf(source.geometryAabb) !== Object.prototype
    || Object.keys(source.geometryAabb).length !== 2
    || !triple(source.geometryAabb.min) || !triple(source.geometryAabb.max))) fail('geometryAabb schema');
  // Streaming queueMesh may remap topology above these frozen source limits.
  // Such inputs remain unsupported; this oracle does not reproduce that split.
  if (source.indices.length > 180000
    || source.positions.byteLength + source.normals.byteLength > 8 * 1024 * 1024) fail('streaming split unsupported');
  const placed = { ...source, origin: (source.origin ?? [0, 0, 0]).map(value => value + 0) };
  if (source.localToWorld) placed.localToWorld = source.localToWorld.map((value, index) =>
    [3, 7, 11].includes(index) ? value + 0 : value);
  if (source.geometryAabb) placed.geometryAabb = { ...source.geometryAabb,
    min: source.geometryAabb.min.map(value => value + 0), max: source.geometryAabb.max.map(value => value + 0) };
  return placed;
}
