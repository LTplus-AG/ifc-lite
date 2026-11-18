/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Data-model oracle for `scripts/cache-native-conformance.mjs` (#9584).
 *
 * The TS writer round trip proves the encoders agree; it cannot see a source
 * value the native data model dropped before encoding. Here the SAME IFC is
 * parsed by the existing TS parser (`IfcParser.parseColumnar`, the store the
 * browser builds; no wasm on this path) and its raw attribute extractor
 * (`EntityExtractor`), and the native cache, decoded by the TS reader, is
 * compared with them keyed by express id and decoded string value, never by
 * row order or string-pool index.
 *
 * What each side can express, and so what is compared:
 *
 * - GlobalId, Description, ObjectType: the format's entity columns hold a
 *   string; `EntityTableBuilder.add` takes `string` and every reader accessor
 *   folds an absent value to `''`. The source can say `$` or `''`. Rule: the
 *   cached value is the source string, `''` for `$` or an undeclared slot.
 * - Name: the column keeps `$` (null index, `getNameOrUndefined() ===
 *   undefined`) apart from `''` (#4930). Rule: exactly the source's.
 *   The source value is the raw STEP attribute (`EntityExtractor`) at the slot
 *   the FILE's schema names (an undeclared type reads the IfcRoot layout).
 *   The TS store's own Description/ObjectType columns are `''` for every
 *   non-group row, so they are no oracle for those; its GlobalId and Name
 *   columns are, with one stated rule (relationship rows, below).
 * - Flags: HAS_GEOMETRY is the row's own `Representation` (attribute 6 named
 *   so, value not `$`; `EntityFlags` docs, #4666) for every native row, and
 *   the whole flags byte equals the TS store's on every common row.
 * - Type: the STEP keyword (entity index) and the display name.
 * - Relationships: every edge, both directions, as (source, target, kind,
 *   relationship id) plus its shadowed relationship ids, as sets.
 * - Schema, entity count and length unit.
 *
 * Row sets differ by design, and the difference is asserted as a rule, not
 * tolerated: see `compareRowSets`.
 */

import assert from 'node:assert/strict';

/**
 * The rooted STEP classes the TS parser indexes without an entity row: its
 * byte-scanned property and association passes (`PROPERTY_REL_TYPES`,
 * `PROPERTY_CONTAINER_TYPES`, `ASSOCIATION_REL_TYPES` in
 * `packages/parser/src/columnar-parser-indexes.ts`). Every other IfcRoot
 * class, `IfcDoorLiningProperties` included, gets a row.
 */
const ROWLESS_TS_CLASSES = new Set([
  'IFCRELDEFINESBYPROPERTIES',
  'IFCPROPERTYSET', 'IFCELEMENTQUANTITY',
  'IFCRELASSOCIATESCLASSIFICATION', 'IFCRELASSOCIATESMATERIAL', 'IFCRELASSOCIATESDOCUMENT',
]);
const ASSOCIATES_MATERIAL = 20;
/** `EntityFlags.HAS_GEOMETRY` (`packages/data/src/types.ts`). */
const HAS_GEOMETRY = 1;

function histogram(ids, typeOf) {
  const out = {};
  for (const id of ids) out[typeOf(id)] = (out[typeOf(id)] ?? 0) + 1;
  return out;
}

/** Every edge of a decoded `RelationshipGraph`, both directions, with its shadow list. */
function edgeSet(graph) {
  const out = new Set();
  for (const [direction, edges] of [['forward', graph.forward], ['inverse', graph.inverse]]) {
    const shadows = new Map();
    if (edges.shadowedEdgeIndex) {
      for (let g = 0; g < edges.shadowedEdgeIndex.length; g++) {
        const ids = Array.from(edges.shadowedRelIds.subarray(edges.shadowedGroupOffsets[g], edges.shadowedGroupOffsets[g + 1]));
        shadows.set(edges.shadowedEdgeIndex[g], ids.sort((a, b) => a - b).join(','));
      }
    }
    for (const [source, offset] of edges.offsets) {
      const count = edges.counts.get(source);
      for (let k = offset; k < offset + count; k++) {
        out.add(`${direction} ${source} ${edges.edgeTargets[k]} ${edges.edgeTypes[k]} #${edges.edgeRelIds[k]} [${shadows.get(k) ?? ''}]`);
      }
    }
  }
  return out;
}

/**
 * Row-set rule. With ROOT = every IfcRoot instance in the file (TS schema
 * inheritance) and REF = every endpoint of a TS relationship edge plus every
 * IfcMaterial leaf of a TS IfcRelAssociatesMaterial definition:
 *
 *   native rows == ROOT ∪ REF                       (rooted + referenced, #6034)
 *   native \ TS == (ROOT ∩ ROWLESS_TS_CLASSES) ∪ (REF \ ROOT \ TS)
 *   TS \ native == TS \ (ROOT ∪ REF)                (unreferenced resource rows)
 */
function compareRowSets(label, { nativeIds, tsIds, store, parser, typeOf }) {
  const chainCache = new Map();
  const chain = (type) => {
    let c = chainCache.get(type);
    if (!c) {
      c = parser.getInheritanceChainAcrossSchemas(type).map((t) => t.toUpperCase());
      chainCache.set(type, c);
    }
    return c;
  };
  const isRoot = (id) => chain(typeOf(id)).includes('IFCROOT');
  const rowless = (id) => ROWLESS_TS_CLASSES.has(typeOf(id));

  const root = new Set();
  for (const [id] of store.entityIndex.byId) if (isRoot(id)) root.add(id);
  const ref = new Set();
  const forward = store.relationships.forward;
  for (const [source, offset] of forward.offsets) {
    ref.add(source);
    for (let k = offset; k < offset + forward.counts.get(source); k++) {
      ref.add(forward.edgeTargets[k]);
      if (forward.edgeTypes[k] === ASSOCIATES_MATERIAL) {
        for (const leaf of parser.collectMaterialLeaves(store, source)) ref.add(leaf.id);
      }
    }
  }
  const expectedNative = new Set([...root, ...ref]);
  const missing = [...expectedNative].filter((id) => !nativeIds.has(id));
  const extra = [...nativeIds].filter((id) => !expectedNative.has(id));
  assert.deepEqual({ missing: histogram(missing, typeOf), extra: histogram(extra, typeOf) }, { missing: {}, extra: {} },
    `${label}: native rows are exactly the rooted instances plus every relationship endpoint and associated material leaf`);

  const nativeOnly = [...nativeIds].filter((id) => !tsIds.has(id));
  const expectedNativeOnly = new Set([...root].filter(rowless));
  for (const id of ref) if (!root.has(id) && !tsIds.has(id)) expectedNativeOnly.add(id);
  const nativeOnlySet = new Set(nativeOnly);
  assert.deepEqual(
    {
      unexplained: histogram(nativeOnly.filter((id) => !expectedNativeOnly.has(id)), typeOf),
      keptByTs: histogram([...expectedNativeOnly].filter((id) => !nativeOnlySet.has(id)), typeOf),
    },
    { unexplained: {}, keptByTs: {} },
    `${label}: native-only rows are the IfcRoot classes the TS parser indexes without a row, plus referenced resources it has no bucket for`);
  const tsOnly = [...tsIds].filter((id) => !nativeIds.has(id));
  for (const id of tsOnly) assert.ok(!root.has(id) && !ref.has(id), `${label}: TS-only row #${id} (${typeOf(id)}) is an unreferenced resource`);
  return {
    nativeOnly: histogram(nativeOnly, typeOf),
    tsOnly: tsOnly.length,
    isRelationship: (id) => chain(typeOf(id)).includes('IFCRELATIONSHIP'),
  };
}

/** The raw STEP value of `attribute` on `id`: a string, `null` for `$`, or `undefined` when undeclared. */
function rawAttribute(extractor, parser, store, id, attribute) {
  const ref = store.entityIndex.byId.get(id);
  const names = parser.getAttributeNamesForSchema(ref.type, store.schemaVersion);
  const slot = names.length > 0 ? names.indexOf(attribute) : ['GlobalId', null, 'Name', 'Description', 'ObjectType'].indexOf(attribute);
  if (slot < 0) return undefined;
  const value = extractor.extractEntity(ref).attributes[slot];
  if (value === null || value === undefined) return null;
  assert.equal(typeof value, 'string', `#${id} ${attribute} is a string attribute`);
  return value;
}

/**
 * Compare the decoded native cache with a TS parse of the same IFC. Returns
 * a one-line summary of the row-set difference.
 */
export async function compareModelOracle(label, { sourceBytes, decoded, parser, cache }) {
  const buffer = sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength);
  const store = await new parser.IfcParser().parseColumnar(buffer, { onDiagnostic: () => {} });
  const native = decoded.dataStore.entities;
  const ts = store.entities;
  const typeOf = (id) => store.entityIndex.byId.get(id)?.type;

  assert.equal(cache.SchemaVersion[decoded.dataStore.schema], store.schemaVersion, `${label}: schema`);
  assert.equal(decoded.dataStore.entityCount, store.entityCount, `${label}: entity count`);
  const unit = decoded.geometry?.coordinateInfo.lengthUnitScale;
  if (decoded.geometry) assert.equal(unit, store.lengthUnitScale, `${label}: length unit scale`);

  const nativeIds = new Set(native.expressId);
  const tsIds = new Set(ts.expressId.subarray(0, ts.count));
  assert.equal(nativeIds.size, native.count, `${label}: one native row per express id`);
  const rows = compareRowSets(label, { nativeIds, tsIds, store, parser, typeOf });

  // Every native row against the source.
  const rowOf = new Map();
  for (let i = 0; i < native.count; i++) rowOf.set(native.expressId[i], i);
  const tsRowOf = new Map();
  for (let i = 0; i < ts.count; i++) tsRowOf.set(ts.expressId[i], i);
  const extractor = new parser.EntityExtractor(new Uint8Array(buffer));
  const accessor = { GlobalId: 'getGlobalId', Description: 'getDescription', ObjectType: 'getObjectType' };
  for (const id of nativeIds) {
    const where = `${label}: #${id} (${typeOf(id)})`;
    assert.equal(native.getTypeName(id).toUpperCase(), typeOf(id), `${where} type`);
    for (const [attribute, get] of Object.entries(accessor)) {
      assert.equal(native[get](id), rawAttribute(extractor, parser, store, id, attribute) ?? '', `${where} ${attribute}`);
    }
    const name = rawAttribute(extractor, parser, store, id, 'Name');
    assert.equal(native.getNameOrUndefined(id), name ?? undefined, `${where} Name (absent vs empty)`);
    // HAS_GEOMETRY: the row's own Representation (#4666), not its class.
    const ref = store.entityIndex.byId.get(id);
    const ownBody = parser.getAttributeNamesAcrossSchemas(ref.type)[6] === 'Representation'
      && (extractor.extractEntity(ref).attributes[6] ?? null) !== null;
    assert.equal(Boolean(native.flags[rowOf.get(id)] & HAS_GEOMETRY), ownBody, `${where} HAS_GEOMETRY`);
  }

  // The common rows against the TS store's own columns. Rule: the TS parser
  // byte-scans IfcRelationship rows for their endpoints only, so it stores
  // them with GlobalId '' and no Name; every other common row agrees exactly.
  for (const id of tsIds) {
    if (!nativeIds.has(id)) continue;
    const where = `${label}: #${id} (${typeOf(id)}) against the TS store`;
    assert.equal(native.getTypeName(id), ts.getTypeName(id), `${where} type name`);
    assert.equal(native.flags[rowOf.get(id)], ts.flags[tsRowOf.get(id)], `${where} flags`);
    if (rows.isRelationship(id)) {
      assert.deepEqual([ts.getGlobalId(id), ts.getNameOrUndefined(id)], ['', undefined], `${where}: relationship rows carry no attributes`);
      continue;
    }
    assert.equal(native.getGlobalId(id), ts.getGlobalId(id), `${where} GlobalId`);
    assert.equal(native.getNameOrUndefined(id), ts.getNameOrUndefined(id), `${where} Name`);
  }

  // Relationships, as sets.
  const nativeEdges = edgeSet(decoded.dataStore.relationships);
  const tsEdges = edgeSet(store.relationships);
  const onlyNative = [...nativeEdges].filter((e) => !tsEdges.has(e));
  const onlyTs = [...tsEdges].filter((e) => !nativeEdges.has(e));
  assert.deepEqual({ onlyNative: onlyNative.slice(0, 5), onlyTs: onlyTs.slice(0, 5) }, { onlyNative: [], onlyTs: [] },
    `${label}: relationship edges (${onlyNative.length} native-only, ${onlyTs.length} TS-only)`);

  return `${native.count} native / ${ts.count} TS rows, ${nativeEdges.size} edges equal; native-only ${JSON.stringify(rows.nativeOnly)}, ${rows.tsOnly} TS-only resource rows`;
}
