/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Decoded-value checks for `scripts/cache-native-conformance.mjs` (#9584).
 *
 * Byte equality with the TS writer proves the native encoders; it cannot
 * catch a value both writers would encode the same way but that is wrong.
 * These check the native cache's decoded values against the TS libraries'
 * own tables and against the source bytes, so the Rust copies of those
 * tables (`rust/cache/src/type_enum.rs`, the relationship kind map, the
 * PascalCase class names) fail here when they drift.
 */

import assert from 'node:assert/strict';

export function compareDecodedModel(label, { decoded, sourceBytes, data }) {
  const index = decoded.entityIndex;
  const typeOf = new Map();
  for (let i = 0; i < index.ids.length; i++) typeOf.set(index.ids[i], index.typeNames[index.typeIndices[i]]);

  // EntityIndex spans address `#id=TYPE(` in the source.
  for (let i = 0; i < index.ids.length; i++) {
    const record = sourceBytes.toString('latin1', index.byteOffsets[i], index.byteOffsets[i] + index.byteLengths[i]);
    const match = /^#(\d+)\s*=\s*([A-Za-z0-9_]+)/.exec(record);
    assert.ok(match, `${label}: entity-index row ${i} does not span a STEP record`);
    assert.equal(Number(match[1]), index.ids[i], `${label}: entity-index id at row ${i}`);
    assert.equal(match[2].toUpperCase(), typeOf.get(index.ids[i]), `${label}: entity-index type at row ${i}`);
  }

  // Entity rows: the enum ordinal and the display name the TS tables give.
  const { entities, strings } = decoded.dataStore;
  assert.ok(entities.count > 0, `${label}: entity rows`);
  for (let i = 0; i < entities.count; i++) {
    const id = entities.expressId[i];
    const upper = typeOf.get(id);
    assert.ok(upper, `${label}: entity row #${id} has an entity-index row`);
    assert.equal(entities.typeEnum[i], data.IfcTypeEnumFromString(upper), `${label}: typeEnum of #${id} (${upper})`);
    assert.equal(strings.get(entities.rawTypeName[i]), data.IFC_ENTITY_NAMES[upper] ?? upper, `${label}: rawTypeName of #${id}`);
  }

  // Every edge's kind is the one the TS parser gives its IfcRel* class.
  const folded = new Map([
    ['IFCRELNESTS', data.RelationshipType.Aggregates],
    ['IFCRELASSIGNSTOGROUPBYFACTOR', data.RelationshipType.AssignsToGroup],
  ]);
  const { forward, inverse } = decoded.dataStore.relationships;
  assert.equal(forward.edgeTargets.length, inverse.edgeTargets.length, `${label}: both directions hold every edge`);
  for (let k = 0; k < forward.edgeTypes.length; k++) {
    const relClass = typeOf.get(forward.edgeRelIds[k]);
    const kind = forward.edgeTypes[k];
    const exact = data.relationshipTypeName(kind).toUpperCase() === relClass;
    assert.ok(exact || folded.get(relClass) === kind, `${label}: edge ${k} kind ${kind} for ${relClass}`);
  }
  for (const [source] of forward.offsets) assert.ok(typeOf.has(source), `${label}: edge source #${source} exists`);

  for (const mesh of decoded.geometry.meshes) {
    assert.ok(typeOf.has(mesh.expressId), `${label}: mesh for #${mesh.expressId} has an entity`);
  }
}
