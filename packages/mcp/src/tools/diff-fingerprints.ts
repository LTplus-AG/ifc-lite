/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The MCP server's adapter onto the real `@ifc-lite/diff` engine (issue #1891).
 *
 * `model_diff` on its own answers "what changed at the type and identity
 * level" — counts per type, GlobalIds added and removed. That answer is wrong
 * in the most damaging way the moment the two models came from a from-scratch
 * re-export: every GlobalId is new, so the whole model reads as
 * deleted-and-added. `by_content: true` routes the same two loaded models
 * through the engine's content-keyed matching pass instead.
 *
 * **Data scope only, on purpose.** Node has no geometry pipeline here: no
 * meshes, so no world geometry hash and no bounding box. Rather than pretend
 * otherwise the handler passes `scope: 'data'`, which is the honest description
 * of what it can see — the engine then classifies every unambiguous 1:1 content
 * match as `renamed` and reports every genuinely ambiguous group as a group,
 * exactly as it does for a viewer session whose geometry hashing was
 * unavailable.
 *
 * **Scope of the comparison: every `IfcObjectDefinition` in the model.** IFC's
 * three `IfcRoot` branches are not equally comparable. An `IfcObjectDefinition`
 * (every `IfcObject` — product, task, actor, control, resource, group — plus
 * `IfcTypeObject` and `IfcContext`) is an independently identifiable thing. The
 * other two branches are dependent and stay out:
 *
 * - `IfcRelationship`: its identity is its endpoints. Re-GUIDing an
 *   `IfcRelAggregates` while both ends are untouched is not a change anyone
 *   wants reported.
 * - `IfcPropertyDefinition`: a property set's content is already folded into
 *   its owner's `dataHash`, so comparing it again would double-report every
 *   edited property — once on the element, once on the pset.
 *
 * Membership is decided from the inheritance chain of every bundled schema
 * (IFC2X3 + IFC4 + IFC4X3), not from whether the columnar parser happened to
 * put the entity in its `EntityTable`, and not from the IFC4 codegen pin alone.
 * That distinction is the whole fix for a class of silent drop-outs: the table
 * only holds the categories the viewer renders, so `IfcTask`, `IfcActor`,
 * `IfcWorkPlan` and every other non-product `IfcObject` reported an empty
 * GlobalId and vanished from the comparison entirely, even though their STEP
 * records carry one. Those are read straight from the source record instead.
 * (`by_entity` on the same tool still asks the store and so still misses them;
 * that is pre-existing behaviour of a different flag, untouched here.)
 *
 * The same distinction closes the drop-out's mirror image. The parser fills
 * the table's GlobalId column positionally, and for a resource entity slot 0
 * is not a GlobalId: an `IfcMaterial`, `IfcSurfaceStyle`, `IfcClassification`
 * or `IfcProjectedCRS` was compared under its *Name*, colliding keys into the
 * comparison — a material and a surface style of the same name arriving as
 * one entity. None is an `IfcRoot`, so the chain check leaves them out.
 *
 * ## Why this is a second copy, and what stops it drifting
 *
 * `packages/cli/src/commands/diff-engine.ts` and its `diff-scope.ts` are the
 * same adapter, and the two must stay behaviourally identical — a fingerprint
 * means nothing unless both producers compute it the same way. It is duplicated
 * rather than shared because there is no honest home for it yet:
 *
 * - `@ifc-lite/cli` already depends on `@ifc-lite/mcp`, so this package cannot
 *   import from there without a cycle.
 * - `@ifc-lite/diff` is deliberately store-agnostic and dependency-free; giving
 *   it a runtime dependency on `@ifc-lite/parser` to host an adapter would undo
 *   the property that lets the viewer, the CLI and this server each supply
 *   their own.
 * - `@ifc-lite/parser` must not learn about diffing. The *scope* walk is close
 *   to parser-domain — it exists to compensate for the columnar parser's own
 *   `EntityTable` gaps — but which `IfcRoot` branches a comparison may speak
 *   for is diff policy, and exporting that from the most-depended-on package
 *   under a neutral name would only rename the problem. (A fourth package both
 *   could depend on is a published artefact and a release decision, not this.)
 *
 * Until then the agreement is **asserted, not assumed**. The copies previously
 * relied on parallel suites (`diff.test.ts` here, `diff-content.test.ts` in the
 * CLI) checking the same behaviour separately, which cannot detect a drift:
 * fixing one copy and not the other passes both. It took hours to find out —
 * #2001 moved the CLI's membership check to the cross-schema inheritance lookup
 * and this copy stayed on the IFC4 codegen pin, silently dropping every IFC2X3
 * and IFC4X3 object class outside it. `diff-fingerprints.test.ts` now runs
 * *both* copies over the CLI's own fixtures, so the next divergence fails a
 * build instead of shipping.
 *
 * The one thing this copy has and the CLI's does not is the optional `overlay`
 * argument: a `model_id` here may carry queued mutations the CLI's two files
 * cannot. Called without it, the two copies compute byte-identical
 * fingerprints, which the paired tests check.
 */

import {
  buildComponentFingerprints,
  buildDataFingerprint,
  type DataFingerprintInput,
  type EntityFingerprint,
} from '@ifc-lite/diff';
import { iterateEffectiveEntities, RelationshipType, resolvedTypeName, type EffectiveEntity } from '@ifc-lite/data';
import {
  EntityExtractor,
  extractAllEntityAttributes,
  extractClassificationsOnDemand,
  extractProjectUnits,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractRootAttributesFromEntity,
  spatialContainerPath,
  getInheritanceChainAcrossSchemas,
  getAttributeNamesAcrossSchemas,
  quantitySiScale,
  roundToScale,
  scaledPropertyValue,
  type IfcDataStore, type ProjectUnits,
} from '@ifc-lite/parser';
import { attributeAcrossSchemas, authoredKeyResolver, override, type FingerprintAdapterOptions } from './diff-authored-keys.js';
import { classificationLabel } from './diff-classification-label.js';
export { AUTHORED_KEY_PREFIX, type FingerprintAdapterOptions } from './diff-authored-keys.js';
import { stepText, type CreatedEntity, type PendingOverlay } from '../overlay.js';

/** Adapter handle threaded through the diff: the entity's express id. */
export type DiffRef = number;

/** The IfcRoot-family attributes a fingerprint needs when the columnar
 *  `EntityTable` does not hold the entity. */
type RootAttributes = ReturnType<typeof extractRootAttributesFromEntity>;

/** How an uppercase STEP type participates in the comparison. `name` is the
 *  registry's PascalCase spelling, used instead of the `EntityTable`'s
 *  `'Unknown'` for entities the table never took in. */
interface TypeRole {
  role: 'independent' | 'dependent' | 'unknown';
  name: string;
  /** Whether the class is an `IfcTypeObject` — the gate on hashing `Tag`
   *  (issue #2021). A class no bundled schema declares is `false` rather than
   *  guessed; the fingerprint then carries no `Tag`, which is the same answer
   *  as a type object that has none. */
  typeObject: boolean;
}

/**
 * Classify one STEP type against the three `IfcRoot` branches.
 *
 * The chain has to come from **every bundled schema**, not from the parser's
 * IFC4 codegen pin. `getInheritanceChainForEntity` answers an empty chain for
 * any class the pin does not carry, and that is not a rare corner: IFC2X3 alone
 * puts 23 `IfcObjectDefinition` classes there (`IfcMove`, `IfcOrderAction`,
 * `IfcScheduleTimeControl`, `IfcSpaceProgram`, `IfcServiceLife`, …) and IFC4X3
 * another 77. Judging those as `unknown` dropped the ones the `EntityTable`
 * does not hold — real objects with real GlobalIds — and let through the
 * IFC2X3-only *resource* classes it does hold under a `…STYLE` name, keyed on
 * the Name in slot 0. Both are wrong answers about an IFC2X3 file, which is
 * still most of what is in the wild.
 *
 * `unknown` is still not `dependent`: a vendor extension no schema declares has
 * no chain to judge, so it keeps exactly the reach the `EntityTable` already
 * gave it — which for a `…TYPE` class is a genuine GlobalId, since the parser's
 * type-object branch is name-based and takes those in. Guessing that an
 * unrecognised class is an `IfcObject` and reading its source record instead
 * would cost one STEP extraction per row of every unrecognised bucket in the
 * model, on every call, to reach entities almost no file has. The price of that
 * choice is that a vendor `IfcRoot` subtype whose name does not end in `TYPE`
 * stays uncompared.
 *
 * The one name the chain is not needed for is `IFCREL…`: that prefix is the
 * parser's own rule for taking an unrecognised relationship into the table, and
 * a relationship is excluded here whether any schema can confirm it or not.
 * Without this, an unrecognised `IfcRelXxx` would be the single class of entity
 * that got in through the relationship branch the comparison deliberately shuts.
 */
function classifyType(typeKey: string): TypeRole {
  const upper = typeKey.toUpperCase();
  const chain = getInheritanceChainAcrossSchemas(upper);
  if (chain.length === 0) {
    return {
      role: upper.startsWith('IFCREL') ? 'dependent' : 'unknown',
      name: typeKey,
      typeObject: false,
    };
  }
  // The chain holds the class itself plus its supertypes; which end the leaf
  // sits at is the schema source's business — the union walk answers leaf→root
  // and the IFC4 pin it falls back to answers root→leaf — so find it by name.
  const name = chain.find((ancestor) => ancestor.toUpperCase() === upper) ?? typeKey;
  const typeObject = chain.includes('IfcTypeObject');
  if (!chain.includes('IfcRoot')) return { role: 'dependent', name, typeObject };
  return {
    role: chain.includes('IfcObjectDefinition') ? 'independent' : 'dependent',
    name,
    typeObject,
  };
}

/**
 * Build one {@link EntityFingerprint} per `IfcObjectDefinition` in a store.
 *
 * `components` is populated as well as `dataHash`: the content pass's only
 * defence against a `dataHash` collision retiring an unrelated add/delete pair
 * is agreement on `ifcType` and on every component sub-hash, and the second
 * check is inert unless both sides supply them (see the "Hash collisions"
 * section of `docs/guide/model-diff.md`).
 *
 * Pass `overlay` to fingerprint the model *as the session has it* rather than
 * as the file was parsed — tombstoned entities drop out, created ones join, and
 * edited names, descriptions and property values are hashed at their new
 * values. Omitting it (the CLI twin has no session to overlay) is the original
 * store-only behaviour exactly.
 */
export function buildModelFingerprints(
  store: IfcDataStore,
  overlay?: PendingOverlay | null,
  options: FingerprintAdapterOptions = {},
): EntityFingerprint<DiffRef>[] {
  const fingerprints: EntityFingerprint<DiffRef>[] = [];
  const seen = new Set<number>();
  // One extractor for the whole model: the source read below only fires for
  // the (small) set of object types the EntityTable declines to hold.
  const extractor = new EntityExtractor(store.source);
  const units = extractProjectUnits(store.source, store.entityIndex); // for quantitySiScale/scaledPropertyValue
  const entities = comparableEntities(store, overlay);
  const keyOf = authoredKeyResolver(store, overlay, options, extractor, entities);
  for (const { expressId, type: typeKey, overlayCreated } of entities) {
    if (overlayCreated) {
      const created = overlay?.createdEntity(expressId);
      if (created && overlay) {
        const fingerprint = createdFingerprint(created, overlay, units, keyOf(expressId, created.globalId));
        if (fingerprint) fingerprints.push(fingerprint);
      }
      continue;
    }
    const type = classifyType(typeKey);
    if (seen.has(expressId)) continue;
    seen.add(expressId);

    const named = overlay?.attributes(expressId);
    const positional = overlay?.positionalAttributes?.(expressId);
    const editedGlobalId = named?.has('GlobalId') ? named.get('GlobalId')
      : positional?.has(0) ? stepText(positional.get(0)) ?? '' : undefined;
    let globalId = editedGlobalId ?? store.entities.getGlobalId(expressId);
    let source: RootAttributes | undefined;
    if (!globalId && editedGlobalId === undefined && type.role === 'independent') {
      // In the model but not in the table: a schedule task, an actor, a work
      // plan. Its GlobalId is in the STEP record, so read it there.
      source = readRootAttributes(extractor, store, expressId);
      globalId = source?.globalId ?? '';
    }
    // Still nothing: the entity is not an IfcRoot at all (a placement, a
    // profile, a representation item), so it has no cross-model identity.
    if (!globalId) continue;

    // The effective class wins over the immutable table's source class.
    const ifcType = type.name;
    const input = buildDataInput(store, expressId, ifcType, source, type.typeObject, overlay, units);
    const fingerprint: EntityFingerprint<DiffRef> = {
      key: keyOf(expressId, globalId),
      ifcType,
      dataHash: buildDataFingerprint(input),
      components: buildComponentFingerprints(input),
      ref: expressId,
    };
    const container = spatialContainerPath(store, expressId);
    if (container !== undefined) fingerprint.container = container;
    fingerprints.push(fingerprint);
  }

  return fingerprints;
}

/** Limit the canonical walk to potentially comparable classes before it visits
 * geometry buckets. Sparse retype destinations and authored classes are added
 * even when absent from the parsed source index. */
function comparableEntities(store: IfcDataStore, overlay?: PendingOverlay | null): EffectiveEntity[] {
  const types = new Set<string>();
  // @raw-entity-enumeration-ok the diff chooses candidate source CLASS keys only; iterateEffectiveEntities handles membership below
  for (const type of store.entityIndex.byType.keys()) {
    if (classifyType(type).role !== 'dependent') types.add(type);
  }
  const retypes = overlay?.typeMutations?.();
  for (const change of retypes?.values() ?? []) {
    if (classifyType(change.newType).role !== 'dependent') types.add(change.newType);
  }
  const created = overlay?.created ?? [];
  for (const entity of created) {
    if (classifyType(entity.ifcType).role !== 'dependent') types.add(entity.ifcType);
  }
  if (types.size === 0) return [];
  const createdById = new Map(created.map(entity => [entity.expressId, entity]));
  const membership = overlay ? {
    isDeleted: (id: number) => overlay.deleted.has(id),
    getNewEntities: () => created.map(entity => ({ expressId: entity.expressId, type: entity.ifcType })),
    getNewEntity: (id: number) => {
      const entity = createdById.get(id);
      return entity ? { type: entity.ifcType } : null;
    },
    getTypeMutations: () => retypes ?? new Map<number, { newType: string }>(),
  } : null;
  return [...iterateEffectiveEntities(store, membership, [...types])];
}

/**
 * Fingerprint one overlay-created entity (`entity_create`).
 *
 * It goes through the same `classifyType` gate as a stored entity — a created
 * `IfcRelAggregates` stays out of the comparison exactly as a parsed one does,
 * and an unrecognised class keeps the same reach the store path gives it — and
 * its `ifcType` is the registry's spelling. The caller may have authored the
 * STEP-uppercase form, and `ifcType` is hashed and cross-checked on every
 * content match, so `IFCWALL` would never pair with `IfcWall`.
 *
 * Its attributes come from the same place a stored entity's do: the creation
 * payload is only the *base*, which `entity_set_attribute` overrides exactly as
 * it overrides a parsed record (see {@link buildDataInput}). Create-then-rename
 * is an ordinary two-step, and reading the frozen payload made this the one
 * fingerprint in the model describing a value the session no longer holds — a
 * rename went unseen, a clear was hashed as the name it cleared. All four
 * hashed IfcRoot attributes: `Name` and `Description` have a payload behind them
 * (STEP slots 0/2/3 are fixed across `IfcRoot` subtypes), `ObjectType` has none
 * (slot 4 is `ApplicableOccurrence` on an `IfcTypeObject`) and so exists only as
 * an override. `Tag` is read from its class-specific authored slot or override,
 * and hashed only for `IfcTypeObject` (issue #2021). Property sets and
 * quantities are read through the overlay.
 *
 * An authored key is resolved from its effective attributes or property sets,
 * alongside source entities, so a duplicate is treated as a collision.
 *
 * `predefinedType` and `typeAssignments` are necessarily absent: both are read
 * through the store, which has no row for an entity that exists only in the
 * overlay, and neither is reachable through `entity_set_attribute`. A created
 * entity that would have matched on those alone therefore reports as added
 * rather than matched, which is the safe direction.
 */
function createdFingerprint(
  entity: CreatedEntity,
  overlay: PendingOverlay,
  units: ProjectUnits, // scales Qto_ quantities and measure-typed Pset properties to base SI
  key: string,
): EntityFingerprint<DiffRef> | null {
  const type = classifyType(entity.ifcType);
  if (type.role === 'dependent') return null;
  const edited = overlay.attributes(entity.expressId);
  const tagIndex = getAttributeNamesAcrossSchemas(entity.ifcType).indexOf('Tag');
  const input: DataFingerprintInput = {
    ifcType: type.name,
    name: override(edited.get('Name'), entity.name),
    description: override(edited.get('Description'), entity.description),
    objectType: override(edited.get('ObjectType'), undefined),
    tag: type.typeObject ? override(edited.get('Tag'), tagIndex < 0 ? undefined : stepText(entity.attributes[tagIndex])) : undefined,
    propertySets: overlay.propertySets(entity.expressId).map((set) => ({
      name: set.name,
      properties: set.properties.map((property) => ({ name: property.name, value: scaledPropertyValue(property.value, property.dataType, units) })),
    })),
    quantitySets: overlay.quantitySets(entity.expressId).map((set) => ({
      name: set.name,
      quantities: set.quantities.map((quantity) => ({
        name: quantity.name,
        value: roundToScale(quantity.value * quantitySiScale(quantity, units)),
      })),
    })),
    typeAssignments: [],
  };
  return {
    key,
    ifcType: type.name,
    dataHash: buildDataFingerprint(input),
    components: buildComponentFingerprints(input),
    ref: entity.expressId,
  };
}

/** IfcRoot attributes straight from the entity's STEP record, for the rows the
 *  columnar `EntityTable` never took in. */
function readRootAttributes(
  extractor: EntityExtractor,
  store: IfcDataStore,
  expressId: number,
): RootAttributes | undefined {
  // @raw-entity-enumeration-ok one source record supplies missing table GlobalId; caller applies overlay identity and membership
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
  /** `IfcTypeObject` subtype? Gates `Tag` into the fingerprint (issue #2021). */
  isTypeObject: boolean,
  /** Set when the session has queued edits; its reads are base-merged, so it
   *  replaces the store read rather than being layered on top of it. */
  overlay: PendingOverlay | null | undefined,
  units: ProjectUnits, // scales Qto_ quantities and measure-typed Pset properties to base SI
): DataFingerprintInput {
  const predefinedType = extractAllEntityAttributes(store, expressId).find(
    (attribute) => attribute.name === 'PredefinedType',
  )?.value;
  // `Tag` for a TYPE OBJECT only. On an occurrence it is the authoring tool's
  // element id, which changes across producers while the design does not, and
  // `dataHash` is the content bucket key — hashing it there would stop the
  // re-export matching this whole path exists for. On a type object it is the
  // only thing separating same-named types with no geometry hash to fall back
  // on (issue #2021, and `DataFingerprintInput.tag` for the full argument).
  const storedTag = isTypeObject
    ? attributeAcrossSchemas(store, expressId, ifcType, 'Tag')
    : undefined;
  const edited = overlay?.attributes(expressId);
  const tagIndex = isTypeObject ? getAttributeNamesAcrossSchemas(ifcType).indexOf('Tag') : -1;
  const positional = tagIndex >= 0 ? overlay?.positionalAttributes?.(expressId) : undefined;
  const effectiveTag = tagIndex >= 0 && positional?.has(tagIndex)
    ? stepText(positional.get(tagIndex))
    : override(edited?.get('Tag'), storedTag != null ? String(storedTag) : undefined);

  const propertySets = (overlay
    ? overlay.propertySets(expressId)
    : extractPropertiesOnDemand(store, expressId)
  ).map((set) => ({
    name: set.name,
    properties: set.properties.map((property) => ({ name: property.name, value: scaledPropertyValue(property.value, property.dataType, units) })),
  }));

  const quantitySets = (overlay
    ? overlay.quantitySets(expressId)
    : extractQuantitiesOnDemand(store, expressId)
  ).map((set) => ({
    name: set.name,
    // Scaled to base SI, then rounded — both stored and overlaid values, a
    // queued edit being authored in the project unit same as a parsed one.
    quantities: set.quantities.map((quantity) => ({ name: quantity.name, value: roundToScale(quantity.value * quantitySiScale(quantity, units)) })),
  }));

  const typeAssignments = store.relationships
    .getRelated(expressId, RelationshipType.DefinesByType, 'inverse')
    .map((typeId: number) => ({
      globalId: store.entities.getGlobalId(typeId) || undefined,
      name: store.entities.getName(typeId) || undefined,
      type: resolvedTypeName(store.entities, typeId),
    }));

  const classifications = extractClassificationsOnDemand(store, expressId).map(classificationLabel);
  return {
    ifcType,
    classifications,
    // The hash sees all four attributes `entity_set_attribute` accepts, but
    // `Tag` only on a type object (issue #2021) — on an occurrence it stays out
    // of the hash, so an edit to it is deliberately invisible here. The overlay
    // carries all four, so the selection happens at this consumer, which has a
    // reason for it, rather than in the projection where it silently starved
    // the readback (#2014).
    name: override(edited?.get('Name'), store.entities.getName(expressId) || source?.name),
    description: override(edited?.get('Description'), store.entities.getDescription(expressId) || source?.description),
    objectType: override(edited?.get('ObjectType'), store.entities.getObjectType(expressId) || source?.objectType),
    predefinedType: predefinedType != null ? String(predefinedType) : undefined,
    tag: isTypeObject ? effectiveTag : undefined,
    propertySets,
    quantitySets,
    typeAssignments,
  };
}
