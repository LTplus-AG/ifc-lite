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
 * **Scope of the comparison: every `IfcObjectDefinition` in the file.** IFC's
 * three `IfcRoot` branches are not equally comparable. An `IfcObjectDefinition`
 * (every `IfcObject` — product, task, actor, control, resource, group — plus
 * `IfcTypeObject` and `IfcContext`) is an independently identifiable thing, and
 * is precisely what an identity map can make a claim about. The other two
 * branches are dependent and stay out:
 *
 * - `IfcRelationship`: its identity is its endpoints. Re-GUIDing an
 *   `IfcRelAggregates` while both ends are untouched is not a change anyone
 *   wants reported, and a rename claim about one would be a claim about nothing.
 * - `IfcPropertyDefinition`: a property set's content is already folded into its
 *   owner's `dataHash`, so comparing it again would double-report every edited
 *   property — once on the element, once on the pset.
 *
 * Membership is decided from the schema registry's inheritance chain, not from
 * whether the columnar parser happened to put the entity in its `EntityTable`.
 * That distinction is the whole fix for a class of silent drop-outs: the table
 * only holds the categories the viewer renders, so `IfcTask`, `IfcActor`,
 * `IfcWorkPlan` and every other non-product `IfcObject` reported an empty
 * GlobalId and vanished from the comparison entirely, even though their STEP
 * records carry one. Those are read straight from the source record instead.
 * (The parser's own `--by-entity` path still asks the table and so still misses
 * them; that is pre-existing behaviour of a different flag, untouched here.)
 *
 * The same distinction closes the drop-out's mirror image. The parser fills the
 * table's GlobalId column positionally, and for a resource entity slot 0 is not
 * a GlobalId: an `IfcMaterial`, `IfcSurfaceStyle`, `IfcClassification` or
 * `IfcProjectedCRS` was being compared under its *Name*. On the bundled sample
 * models that put 7-9 colliding keys into every comparison — a material and a
 * surface style of the same name arriving as one entity. None of them is an
 * `IfcRoot`, so the chain check leaves them out and the key set is unique again.
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
  EntityExtractor,
  extractAllEntityAttributes,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractRootAttributesFromEntity,
  getInheritanceChainForEntity,
  type IfcDataStore,
} from '@ifc-lite/parser';

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

/** The IfcRoot-family attributes a fingerprint needs when the columnar
 *  `EntityTable` does not hold the entity. */
type RootAttributes = ReturnType<typeof extractRootAttributesFromEntity>;

/** How an uppercase STEP type participates in the comparison. `name` is the
 *  registry's PascalCase spelling, used instead of the `EntityTable`'s
 *  `'Unknown'` for entities the table never took in. */
interface TypeRole {
  role: 'independent' | 'dependent' | 'unknown';
  name: string;
}

/**
 * Classify one STEP type against the three `IfcRoot` branches.
 *
 * `unknown` is not `dependent`: a vendor extension or a schema leaf outside the
 * codegen pin has no inheritance chain to judge, so it keeps exactly the reach
 * the `EntityTable` already gave it — which for a `…TYPE` class is a genuine
 * GlobalId, since the parser's type-object branch is name-based and takes those
 * in. Guessing that an unrecognised class is an `IfcObject` and reading its
 * source record instead would cost one STEP extraction per row of every
 * unrecognised bucket in the file, on every file, to reach entities almost no
 * file has.
 *
 * The one name the chain is not needed for is `IFCREL…`: that prefix is the
 * parser's own rule for taking an unrecognised relationship into the table, and
 * a relationship is excluded here whether the registry can confirm it or not.
 * Without this, an unrecognised `IfcRelXxx` would be the single class of entity
 * that got in through the relationship branch the comparison deliberately shuts.
 */
function classifyType(typeKey: string): TypeRole {
  const upper = typeKey.toUpperCase();
  const chain = getInheritanceChainForEntity(upper);
  if (chain.length === 0) {
    return { role: upper.startsWith('IFCREL') ? 'dependent' : 'unknown', name: typeKey };
  }
  const name = chain[chain.length - 1];
  if (!chain.includes('IfcRoot')) return { role: 'dependent', name };
  return { role: chain.includes('IfcObjectDefinition') ? 'independent' : 'dependent', name };
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
  const seen = new Set<number>();
  // One extractor for the whole file: it holds a buffer reference, and the
  // source read below only fires for the (small) set of object types the
  // EntityTable declines to hold.
  const extractor = new EntityExtractor(store.source);

  for (const [typeKey, ids] of store.entityIndex.byType) {
    // Classified once per type rather than once per entity — the geometry
    // buckets (IfcCartesianPoint, IfcPolyLoop, …) are the bulk of a real file
    // and are dismissed here without touching a single row.
    const type = classifyType(typeKey);
    if (type.role === 'dependent') continue;

    for (const expressId of ids) {
      if (seen.has(expressId)) continue;
      seen.add(expressId);

      let globalId = store.entities.getGlobalId(expressId);
      let source: RootAttributes | undefined;
      if (!globalId && type.role === 'independent') {
        // In the file but not in the table: a schedule task, an actor, a work
        // plan. Its GlobalId is in the STEP record, so read it there.
        source = readRootAttributes(extractor, store, expressId);
        globalId = source?.globalId ?? '';
      }
      // Still nothing: the entity is not an IfcRoot at all (a placement, a
      // profile, a representation item), so it has no cross-file identity.
      if (!globalId) continue;

      const tableType = store.entities.getTypeName(expressId);
      // `getTypeName` answers 'Unknown' for a row the table never took in. The
      // registry's own spelling is the honest answer, and it has to be a real
      // type name: `ifcType` is hashed into the fingerprint and cross-checked
      // on every content match, so 'Unknown' would pair a task with an actor.
      const ifcType = source && (!tableType || tableType === 'Unknown') ? type.name : tableType;
      const input = buildDataInput(store, expressId, ifcType, source);
      fingerprints.push({
        key: globalId,
        ifcType,
        dataHash: buildDataFingerprint(input),
        components: buildComponentFingerprints(input),
        ref: expressId,
      });
    }
  }

  return fingerprints;
}

/** IfcRoot attributes straight from the entity's STEP record, for the rows the
 *  columnar `EntityTable` never took in. */
function readRootAttributes(
  extractor: EntityExtractor,
  store: IfcDataStore,
  expressId: number,
): RootAttributes | undefined {
  const ref = store.entityIndex.byId.get(expressId);
  if (!ref) return undefined;
  const entity = extractor.extractEntity(ref);
  return entity ? extractRootAttributesFromEntity(entity) : undefined;
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
