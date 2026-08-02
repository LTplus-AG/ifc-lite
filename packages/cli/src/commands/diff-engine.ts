/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CLI's adapter onto the real `@ifc-lite/diff` engine (issue #1891).
 *
 * `ifc-lite diff` on its own answers "what changed at the type and identity
 * level" — counts per type, GlobalIds added and removed. That is useless the
 * moment the two files came from a from-scratch re-export, because every
 * GlobalId is new and the whole model reads as deleted-and-added. `--by-content`
 * routes the same two files through the engine's content-keyed matching pass
 * instead, and lets the accepted matches be written to (and replayed from) an
 * identity-map sidecar.
 *
 * **Data scope only, on purpose.** The Node CLI has no geometry pipeline: no
 * meshes, so no world geometry hash and no bounding box. Rather than pretend
 * otherwise, it passes `scope: 'data'`, which is the honest description of what
 * it can see — the engine then classifies every unambiguous 1:1 content match as
 * `renamed` and reports every genuinely ambiguous group as a group, exactly as
 * it does for a viewer session whose geometry hashing was unavailable.
 *
 * **Scope of the comparison: every `IfcObjectDefinition` in the file**, decided
 * from the schema registry's inheritance chain rather than from what the
 * columnar parser put in its `EntityTable`. That walk is `diff-scope.ts`, which
 * documents the rule and the two silent defects it fixes; `--by-entity` runs on
 * the same walk, so both modes of the command answer about the same entities.
 */

import { createHash } from 'node:crypto';
import {
  buildComponentFingerprints,
  buildDataFingerprint,
  type DataFingerprintInput,
  type EntityFingerprint,
  type ModelIdentity,
} from '@ifc-lite/diff';
import { RelationshipType } from '@ifc-lite/data';
import {
  extractAllEntityAttributes,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { comparableEntities, type RootAttributes } from './diff-scope.js';

/** Adapter handle threaded through the diff: the entity's express id. */
export type DiffRef = number;

/**
 * Content digest of a model's bytes, as written into the sidecar.
 *
 * The digest is over the file **as it sits on disk**, before any `.ifcZIP`
 * unwrapping — that is the thing a user can reproduce with `shasum`, and the
 * thing that changes when someone re-exports.
 */
export function modelIdentityOf(path: string, bytes: Uint8Array): ModelIdentity {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { hash: `sha256:${digest}`, path };
}

/**
 * Build one {@link EntityFingerprint} per `IfcObjectDefinition` in a store.
 *
 * `components` is populated as well as `dataHash`: the content pass's only
 * defence against a `dataHash` collision retiring an unrelated add/delete pair
 * is agreement on `ifcType` and on every component sub-hash, and the second
 * check is inert unless both sides supply them (see the "Hash collisions"
 * section of `docs/guide/model-diff.md`).
 */
export function buildFileFingerprints(store: IfcDataStore): EntityFingerprint<DiffRef>[] {
  const fingerprints: EntityFingerprint<DiffRef>[] = [];
  for (const { expressId, globalId, ifcType, source } of comparableEntities(store)) {
    const input = buildDataInput(store, expressId, ifcType, source);
    fingerprints.push({
      key: globalId,
      ifcType,
      dataHash: buildDataFingerprint(input),
      components: buildComponentFingerprints(input),
      ref: expressId,
    });
  }
  return fingerprints;
}

/**
 * Assemble the canonical {@link DataFingerprintInput} for one entity.
 *
 * Mirrors the viewer adapter (`apps/viewer/src/lib/compare/buildFingerprints.ts`)
 * minus its geometry-data filtering: that filter exists to keep placement data
 * out of the *data* hash so a pure move reads as a geometry-only change, and
 * this path has no geometry hash for such a change to land in. Dropping the
 * filter here would make a moved element look unchanged.
 */
function buildDataInput(
  store: IfcDataStore,
  expressId: number,
  ifcType: string,
  /** Set only when the entity is absent from the columnar `EntityTable`, whose
   *  accessors then answer '' for every display attribute. */
  source: RootAttributes | undefined,
): DataFingerprintInput {
  const predefinedType = extractAllEntityAttributes(store, expressId).find(
    (attribute) => attribute.name === 'PredefinedType',
  )?.value;

  const propertySets = extractPropertiesOnDemand(store, expressId).map((set) => ({
    name: set.name,
    properties: set.properties.map((property) => ({ name: property.name, value: property.value })),
  }));

  const quantitySets = extractQuantitiesOnDemand(store, expressId).map((set) => ({
    name: set.name,
    quantities: set.quantities.map((quantity) => ({
      name: quantity.name,
      // Rounded to 4 dp, matching the viewer: re-exporting a model with
      // sub-tolerance float jitter must not flip the data hash on an otherwise
      // identical element, which on this path would cost the pair its match.
      value: roundQuantity(quantity.value),
    })),
  }));

  const typeAssignments = store.relationships
    .getRelated(expressId, RelationshipType.DefinesByType, 'inverse')
    .map((typeId: number) => ({
      globalId: store.entities.getGlobalId(typeId) || undefined,
      name: store.entities.getName(typeId) || undefined,
      type: store.entities.getTypeName(typeId) || undefined,
    }));

  return {
    ifcType,
    name: store.entities.getName(expressId) || source?.name || undefined,
    description: store.entities.getDescription(expressId) || source?.description || undefined,
    objectType: store.entities.getObjectType(expressId) || source?.objectType || undefined,
    predefinedType: predefinedType != null ? String(predefinedType) : undefined,
    propertySets,
    quantitySets,
    typeAssignments,
  };
}

function roundQuantity(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : value;
}
