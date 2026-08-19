/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The property-set and quantity-set phases of `StepExporter.export()` (#2475
 * steps 2b and 2c), and the type-object `HasPropertySets` rewrite that sits
 * between them.
 *
 * ## Why one module, and why the rewrite is not its own function
 *
 *  - `generatedTypeOwnedPsetIds` is written by the property-set generation loop
 *    and read by the rewrite loop. `ExportPass` documents it as the binding
 *    that "is read in one phase only", and it stays that way here precisely
 *    because both loops live inside
 *    {@link generatePropertyAndQuantitySetEntities}: it is a plain local, not a
 *    field on the pass and not an argument threaded between two functions.
 *  - {@link getTypeOwnedHasPropertySetIds} is the rewrite's own helper, but its
 *    only call site is the property-set COLLECTION loop, which fills
 *    `pass.typeOwnedPsetIdsByEntity` from its result.
 *  - `getPropertySetName` is called from the collection loop twice and from the
 *    rewrite once.
 *  - The three generation loops run pset → rewrite → qset, and `export()`
 *    flushes `pass.rewrittenEntityLines` (the rewrite's output) only after the
 *    qset loop. That order is load-bearing and is kept exactly as it was.
 *
 * ## What stayed behind, and why these two exports exist
 *
 * `retainSharedAtoms` belongs to neither phase and runs between them, so it
 * stays on the exporter — which is why {@link getPropertyIdsInSet} is exported
 * rather than module-private, the same shape step 2a used for
 * `findLengthUnitReference`. {@link buildRelDefinesByPropertiesIndex} is
 * exported for the mirror-image reason: the collection loops consume its
 * `byEntity` half, but `export()` reads `relatedByRel` for the deleted-host
 * relationship sweep, which is neither phase's work.
 * `StepExporter.applySourceLineMutations` is shared with the source-iteration
 * pass, so it is injected on the context rather than moved.
 *
 * ## The state these phases cannot read off the pass
 *
 * {@link PropertySetContext}, following `step-georeferencing.ts:GeorefContext`.
 * `allocateExpressId` is the exporter's own `nextExpressId++`: all six
 * allocation sites in an export live in the two generators below, and the
 * counter is shared with the georeferencing phase, so it is injected as a
 * callback rather than hoisted onto the pass. The owner-history memos are
 * injected BY REFERENCE and stay owned by the exporter, because their reset is
 * an `export()`-level statement whose comment explains why they are per-export;
 * storing them here would move that reset out of the method that documents it.
 *
 * Every helper below takes `ctx` FIRST; the two phase entry points take it
 * LAST, as `applyGeoreferencingMutations` does. The split is not aesthetic —
 * the two generators end in optional parameters, which a trailing `ctx` cannot
 * follow.
 */

import type { IfcDataStore, IfcAttributeValue } from '@ifc-lite/parser';
import { EntityExtractor, extractQuantitiesOnDemand, serializeValue, ref } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { recordSourceLineDelivery } from './delta-modification-ledger.js';
import { nominateDeliveredInPlaceEdits } from './in-place-nomination.js';
import { createSourceRefReader, decodeRange } from './source-ref-bounds.js';
import { findLengthUnitReference, normalizeMapUnitName } from './step-georeferencing.js';
import { authoredEntityRefs, type EffectiveEntityIndex } from './effective-index.js';
import {
  HAS_PROPERTY_SETS_SLOT,
  isTypeClass,
  resolveTypeOwnedPsetIds,
  rewriteTypeOwnedPsetLine,
  typeOwnedPsetRewriteWarning,
} from './type-owned-psets.js';
import { escapeStepString, toStepReal, quantityTypeToIfcType } from './step-serialization.js';
import { serializeNominalValue } from './declared-property-type.js';
import type { IfcSchemaVersion } from './schema-converter.js';
import type { ExportPass, SourceLineMutations, StepExportOptions } from './step-exporter.js';

/** `OwnerHistory` is slot 1 on every `IfcRoot` subtype, all schemas. */
const OWNER_HISTORY_SLOT = 1;

/**
 * The store the extractor THIS class installed on a view currently reads
 * (#2487). The extractor is installed once per view and closes over this box
 * rather than over a store directly, so a later export of the same view against
 * a different store re-points it instead of answering from the first file.
 *
 * A box, and not a `WeakSet` of views, because ownership has to reflect the
 * CURRENT state and not the historical fact that an export once installed
 * something. `setQuantityExtractor` is public: a caller may install its own
 * afterwards, and a marker saying "the exporter owns this view" would then keep
 * overwriting a caller-supplied base forever. With a box, the second export
 * writes to a box nothing reads any more and never calls the setter again, so
 * the caller's extractor stands. Weak, so it never keeps a session alive.
 */
const exporterQuantityBase = new WeakMap<MutablePropertyView, { store: IfcDataStore }>();

/**
 * The two owner-history memos the generators share, in one object so the
 * exporter can hand them over by reference. Both are per-EXPORT rather than
 * per-exporter; `StepExporter.export()` owns the reset and explains why.
 */
export interface OwnerHistoryCache {
  /** Lazily-resolved fallback `#id` of an IfcOwnerHistory that survives the
   *  current export closure (or `$` when the file has none). */
  fallbackRef: string | undefined;
  /** Per-host cache of an element's own OwnerHistory ref (`#id` or null). */
  readonly byEntity: Map<number, string | null>;
}

/**
 * The exporter state these phases cannot read off the {@link ExportPass}.
 *
 * `isReadableSourceRef` is the exporter's OWN reader rather than the pass's:
 * the byte readers below are also reached from
 * {@link buildRelDefinesByPropertiesIndex} and from `retainSharedAtoms`,
 * neither of which has a pass in hand. Both readers are built by
 * `createSourceRefReader` over the same `dataStore.source`.
 */
export interface PropertySetContext {
  readonly dataStore: IfcDataStore;
  readonly entityExtractor: EntityExtractor | null;
  readonly mutationView: MutablePropertyView | null;
  readonly isReadableSourceRef: ReturnType<typeof createSourceRefReader>;
  /** `() => this.nextExpressId++` on the exporter. */
  readonly allocateExpressId: () => number;
  readonly ownerHistory: OwnerHistoryCache;
  /** `StepExporter.applySourceLineMutations`: the ONE pipeline the
   *  source-iteration pass and the type-object rewrite share, so it belongs to
   *  neither phase and is injected instead of moved. */
  readonly applySourceLineMutations: (
    expressId: number,
    entityText: string,
    recordType: string,
    attributeMutations: Map<string, string> | undefined,
    sourceSchema: IfcSchemaVersion,
    overlayActive: boolean,
    onRejected?: (attrName: string, value: string) => void,
  ) => SourceLineMutations;
}

/** The mutation groupings `export()` builds before the collection phase runs. */
export interface PropertyMutationGroups {
  readonly entityPropMutations: Map<number, Set<string>>;
  readonly entityQuantMutations: Map<number, Set<string>>;
  readonly relDefinesByEntity: Map<number, Array<{ relId: number; psetId: number }>>;
}

/**
 * Build a one-shot reverse index of every IfcRelDefinesByProperties in
 * the source: for each related entity, list the rels and property/quantity
 * sets that reference it. Used by the export pre-pass so the per-entity
 * "find owning rels" step is O(K) rather than O(N) per modified entity.
 *
 * `relatedByRel` is the same walk read the other way round, so the deleted-host
 * sweep costs nothing extra.
 */
export function buildRelDefinesByPropertiesIndex(ctx: PropertySetContext): {
  byEntity: Map<number, Array<{ relId: number; psetId: number }>>;
  relatedByRel: Map<number, number[]>;
} {
  const byEntity = new Map<number, Array<{ relId: number; psetId: number }>>();
  const relatedByRel = new Map<number, number[]>();
  for (const [relId, relRef] of ctx.dataStore.entityIndex.byId) {
    if (relRef.type.toUpperCase() !== 'IFCRELDEFINESBYPROPERTIES') continue;
    const psetId = getRelatedPropertySet(ctx, relId);
    if (!psetId) continue;
    const related = getRelatedEntities(ctx, relId);
    relatedByRel.set(relId, related);
    for (const entityId of related) {
      let bucket = byEntity.get(entityId);
      if (!bucket) {
        bucket = [];
        byEntity.set(entityId, bucket);
      }
      bucket.push({ relId, psetId });
    }
  }
  return { byEntity, relatedByRel };
}

/**
 * The source STEP text of an entity's line, or `null` when there are no bytes
 * to read.
 *
 * The byte check is on the RANGE, not on `dataStore.source`. `source` is a
 * MANDATORY accessor — `EMPTY_SOURCE_BYTES` is how "this model kept no bytes"
 * is spelled (server-parsed, synthetic, GLB and point-cloud stores all have
 * one) — so the `!ctx.dataStore.source` guard the five readers below used to
 * carry never fired. It was also redundant: a zero-length range decodes to
 * `''`, which fails every regex those readers run, so they already answered
 * "nothing" for a sourceless store. Scoping the check to the range is what
 * makes the guard live without changing a single answer, the same shape and
 * for the same reason as `reference-collector.ts` (#2339).
 *
 * An OVERLAY-created entity never reaches here: every caller resolves its id
 * through `dataStore.entityIndex.byId`, which holds source records only
 * (`effective-index.ts` synthesises the overlay refs on its own side and
 * writes nothing back), so an overlay id is already `undefined` at the
 * lookup and is served by the callers' documented "not a source record"
 * path. That is why an early return is safe HERE and is NOT safe at the
 * visible-only closure in `export` — see the comment there.
 *
 * ## Why `isReadableSourceRef` and not `byteLength === 0`
 *
 * An out-of-range ref does NOT degrade to "no match" here. `decodeUtf8`
 * clamps the range it cannot address, and the clamped window is still a
 * window over real file bytes — so these readers answer from somebody
 * ELSE's record. `source-ref-bounds.ts` (#2491) carries the measured
 * account of both shapes and of why "a clamped, empty decode already yields
 * no match" is false; it is not restated here, because an argument kept in
 * two files is an argument that has to stay true in two files.
 *
 * The consequence specific to THIS site is that the wrong answer is acted
 * on. `retainSharedAtoms` un-skips every id `getPropertyIdsInSet` returns,
 * so a member list read out of the wrong record un-skips the wrong atoms;
 * and the source-iteration pass already refuses to emit a record whose ref
 * fails `isReadableSourceRef` (see the `continue` in `export`), so before
 * this gate these readers were making decisions on behalf of a container
 * that the same export had decided not to write. Gating them on the same
 * predicate is what makes the two passes agree.
 *
 * The degradation is the one the exporter already handles: a record with no
 * emittable bytes, generating nothing and named by nothing. It costs one
 * answer that used to be right by luck — an overrunning ref on the file's
 * LAST record clamps back to exactly that record's text — but that record
 * is one the emission pass drops anyway, so keeping the answer only kept
 * the disagreement.
 */
/*
 * Exported for `entity-line-text-bounds.test.ts`, which is the only pin on
 * where this range STARTS: every pattern the readers below run is unanchored
 * or `$`-anchored, so no public export path can see the first byte move
 * (#2497). That test used to reach the method by casting a `StepExporter` to
 * an interface of its privates; an export is the same access, stated.
 */
export function entityLineText(ctx: PropertySetContext, entityId: number): string | null {
  const entityRef = ctx.dataStore.entityIndex.byId.get(entityId);
  if (!entityRef || !ctx.isReadableSourceRef(entityRef)) return null;
  return decodeRange(
    ctx.dataStore.source,
    entityRef.byteOffset,
    entityRef.byteOffset + entityRef.byteLength
  );
}

/**
 * Get entity IDs related by IfcRelDefinesByProperties (the related objects)
 */
function getRelatedEntities(ctx: PropertySetContext, relId: number): number[] {
  const entityText = entityLineText(ctx, relId);
  if (entityText === null) return [];

  // Parse IfcRelDefinesByProperties: #ID=IFCRELDEFINESBYPROPERTIES('guid',$,$,$,(#objects),#pset);
  // The 5th argument (index 4) is the list of related objects
  const match = entityText.match(/\(([^)]+)\)\s*,\s*#(\d+)\s*\)\s*;/);
  if (!match) return [];

  const objectsList = match[1];
  const refs: number[] = [];
  const refMatches = objectsList.matchAll(/#(\d+)/g);
  for (const m of refMatches) {
    refs.push(parseInt(m[1], 10));
  }
  return refs;
}

/**
 * Get the property set ID from IfcRelDefinesByProperties
 */
function getRelatedPropertySet(ctx: PropertySetContext, relId: number): number | null {
  const entityText = entityLineText(ctx, relId);
  if (entityText === null) return null;

  // Last #ID before the closing );
  const match = entityText.match(/,\s*#(\d+)\s*\)\s*;$/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Get the name of a property set by parsing the entity
 */
export function getPropertySetName(ctx: PropertySetContext, psetId: number): string | null {
  const entityText = entityLineText(ctx, psetId);
  if (entityText === null) return null;

  // Parse: IFCPROPERTYSET('guid',$,'Name',$,...) - Name is 3rd argument
  const match = entityText.match(/IFCPROPERTYSET\s*\([^,]*,[^,]*,'([^']*)'/i);
  if (!match) return null;
  return match[1];
}

/**
 * Get the name of an element quantity set by parsing the entity
 */
function getElementQuantityName(ctx: PropertySetContext, entityId: number): string | null {
  const entityText = entityLineText(ctx, entityId);
  if (entityText === null) return null;

  // Parse: IFCELEMENTQUANTITY('guid',$,'Name',...) - Name is 3rd argument
  const match = entityText.match(/IFCELEMENTQUANTITY\s*\([^,]*,[^,]*,'([^']*)'/i);
  if (!match) return null;
  return match[1];
}

/**
 * Get IDs of properties in a property set
 */
export function getPropertyIdsInSet(ctx: PropertySetContext, psetId: number): number[] {
  const entityText = entityLineText(ctx, psetId);
  if (entityText === null) return [];

  // Parse: IFCPROPERTYSET(...,(#prop1,#prop2,...)); - Last argument is properties list
  const match = entityText.match(/\(\s*(#[^)]+)\s*\)\s*\)\s*;$/);
  if (!match) return [];

  const propsList = match[1];
  const ids: number[] = [];
  const refMatches = propsList.matchAll(/#(\d+)/g);
  for (const m of refMatches) {
    ids.push(parseInt(m[1], 10));
  }
  return ids;
}

/**
 * The full HasPropertySets id list of a type object, from whichever authority
 * owns the record.
 *
 * Slot 5 is `HasPropertySets` on every `IfcTypeObject` subtype. For a source
 * record the list is parsed out of the file; for an overlay-created type it is
 * read off the authored payload, where a reference is the documented `'#42'`
 * string form. Reading only the source made every pset on a created
 * `IfcWallType` look unowned, which is how it ended up on an occurrence
 * relation instead (#2012).
 */
function getTypeOwnedHasPropertySetIds(ctx: PropertySetContext, entityId: number, effective: EffectiveEntityIndex): number[] {
  if (effective.isOverlayCreated(entityId)) {
    const authored = ctx.mutationView?.getNewEntity(entityId)?.attributes?.[HAS_PROPERTY_SETS_SLOT];
    return authoredEntityRefs(overlaySlotValue(ctx, entityId, HAS_PROPERTY_SETS_SLOT, authored));
  }
  if (!ctx.entityExtractor) return [];
  const entityRef = ctx.dataStore.entityIndex.byId.get(entityId);
  if (!entityRef) return [];

  const entity = ctx.entityExtractor.extractEntity(entityRef);
  const hasPropertySets = entity?.attributes?.[HAS_PROPERTY_SETS_SLOT];
  if (!Array.isArray(hasPropertySets)) return [];

  return hasPropertySets.filter((value): value is number => typeof value === 'number');
}

/**
 * The overlay's answer for one positional slot of an overlay-created entity,
 * falling back to the creation payload only when the overlay has NOTHING to
 * say about that slot.
 *
 * **Ask `Map.has`, never `??`.** `setPositionalAttribute(id, slot, null)` is
 * an explicit "clear this slot", and its value is `null`, so `??` reads the
 * overlay's answer as an absence and reinstates the authored one. That is the
 * same overlay-versus-buffer confusion this whole change is about, one
 * attribute wide: an explicit null IS the overlay's answer, and the overlay is
 * the authority. Cleared OwnerHistory came back as the authored reference, and
 * a cleared `HasPropertySets` resurrected the list the user had removed.
 */
function overlaySlotValue(
  ctx: PropertySetContext,
  entityId: number,
  slot: number,
  authored: IfcAttributeValue | undefined,
): IfcAttributeValue | undefined {
  const overrides = ctx.mutationView?.getPositionalMutationsForEntity(entityId);
  if (!overrides?.has(slot)) return authored;
  const value = overrides.get(slot);
  // `Map.get` widens to `| undefined`, which `has` has already ruled out. A
  // slot explicitly set to nothing serializes as `$`, i.e. null.
  return value === undefined ? null : value;
}

/**
 * Read an element's own OwnerHistory reference (`#id`), or null when the
 * element omits one (`$`) or cannot be parsed. OwnerHistory is the second
 * attribute of every IfcRoot subtype, immediately after the GlobalId string.
 */
function getOwnerHistoryRefOfEntity(ctx: PropertySetContext, entityId: number): string | null {
  const cached = ctx.ownerHistory.byEntity.get(entityId);
  if (cached !== undefined) return cached;
  let result: string | null = null;
  // An overlay-created host has no source line to read, but it does have an
  // authored OwnerHistory in slot 1 — reading only the buffer sent every
  // generated pset on a created entity to the file's first owner history
  // instead of the one the caller named (#2012).
  const overlay = ctx.mutationView?.getNewEntity(entityId);
  if (overlay) {
    const refs = authoredEntityRefs(
      overlaySlotValue(ctx, entityId, OWNER_HISTORY_SLOT, overlay.attributes[OWNER_HISTORY_SLOT]),
    );
    result = refs.length > 0 ? `#${refs[0]}` : null;
    ctx.ownerHistory.byEntity.set(entityId, result);
    return result;
  }
  const entityRef = ctx.dataStore.entityIndex.byId.get(entityId);
  // Readability rather than presence, as everywhere else (#2491). A clamped
  // decode would match nothing here, so this is tidiness rather than a bug —
  // but the gates in this file agree on one predicate now.
  if (entityRef && ctx.isReadableSourceRef(entityRef)) {
    const entityText = decodeRange(
      ctx.dataStore.source,
      entityRef.byteOffset,
      entityRef.byteOffset + entityRef.byteLength
    );
    // #ID=IFCWALL('GlobalId',#owner,...): GlobalId is a quoted STEP string
    // (doubled '' escapes); OwnerHistory is the ref/`$` right after it.
    const match = entityText.match(/=\s*IFC\w+\s*\(\s*'(?:[^']|'')*'\s*,\s*#(\d+)/i);
    if (match) result = `#${match[1]}`;
  }
  ctx.ownerHistory.byEntity.set(entityId, result);
  return result;
}

/**
 * Resolve a STEP reference to an existing IfcOwnerHistory for the
 * IfcPropertySet / IfcRelDefinesByProperties / IfcElementQuantity entities we
 * generate for `hostEntityId`'s mutations. OwnerHistory is optional in IFC4 but
 * MANDATORY in IFC2X3 (IfcRoot.OwnerHistory), so emitting `$` yields an invalid
 * IFC2X3 file that strict readers (e.g. BIM Vision) reject.
 *
 * Prefer the host element's OWN owner history, then any owner history that
 * survives this export, then `$` only when none does.
 *
 * "Survives" is `willBeEmitted`, the same predicate that decides whether the
 * host itself may have psets generated for it. A reference is a reference: it
 * is no more acceptable to point an emitted `IfcPropertySet` at an owner
 * history the session deleted than at a host it deleted. This used to consult
 * only the `visibleOnly` closure, so an overlay-created OwnerHistory that was
 * later deleted still got referenced — a dangling `#N`, reached through the
 * one attribute the generators fill in for themselves.
 */
function resolveOwnerHistoryRef(ctx: PropertySetContext, hostEntityId: number, willBeEmitted: (id: number) => boolean): string {
  const own = getOwnerHistoryRefOfEntity(ctx, hostEntityId);
  if (own !== null) {
    const ownId = parseInt(own.slice(1), 10);
    if (willBeEmitted(ownId)) return own;
  }
  if (ctx.ownerHistory.fallbackRef === undefined) {
    // Source-only: the fallback is a best-effort "some owner history the file
    // still has", and the host's OWN history above is the path that resolves
    // an overlay-created one.
    const ids = ctx.dataStore.entityIndex.byType.get('IFCOWNERHISTORY') ?? [];
    const surviving = ids.find((id: number) => willBeEmitted(id));
    ctx.ownerHistory.fallbackRef = surviving !== undefined ? `#${surviving}` : '$';
  }
  return ctx.ownerHistory.fallbackRef;
}

/**
 * Generate a new IFC GlobalId (22 character base64). `random` is the
 * export's optional seeded source (`StepExportOptions.guidRandom`);
 * undefined keeps the default random path.
 */
function generateGlobalId(random?: RandomSource): string {
  return generateIfcGuid(random);
}

/**
 * Find a unit entity ID by name (simplified - returns null for now)
 */
function findUnitId(ctx: PropertySetContext, unitName: string, effective: EffectiveEntityIndex): number | null {
  return findLengthUnitReference(normalizeMapUnitName(unitName), effective, { dataStore: ctx.dataStore, entityExtractor: ctx.entityExtractor });
}

/**
 * Generate STEP entities for property sets
 */
function generatePropertySetEntities(
  ctx: PropertySetContext,
  entityId: number,
  psets: PropertySet[],
  willBeEmitted: (id: number) => boolean,
  effective: EffectiveEntityIndex,
  typeOwnedPsetNames?: Set<string>,
  random?: RandomSource
): { lines: string[]; count: number; generatedTypeOwnedPsetIds: Map<string, number> } {
  const lines: string[] = [];
  let count = 0;
  const generatedTypeOwnedPsetIds = new Map<string, number>();

  for (const pset of psets) {
    const propertyIds: number[] = [];

    // Create IfcPropertySingleValue for each property
    for (const prop of pset.properties) {
      const propId = ctx.allocateExpressId();
      count++;

      // `prop.dataType`, not `prop.type` alone: regenerating the set rewrites
      // every property in it, and the shape-derived primitive would re-declare
      // the ones nobody edited (`IFCTEXT` → `IFCLABEL`, `IFCLENGTHMEASURE` →
      // `IFCREAL`). See `declared-property-type.ts` for when the source token
      // is trusted (#2482).
      const valueStr = serializeNominalValue(prop.value, prop.type, prop.dataType);
      const unitId = prop.unit ? findUnitId(ctx, prop.unit, effective) : null;
      const unitStr = unitId !== null ? ref(unitId) : null;

      // #ID=IFCPROPERTYSINGLEVALUE('Name',$,Value,Unit);
      const line = `#${propId}=IFCPROPERTYSINGLEVALUE('${escapeStepString(prop.name)}',$,${valueStr},${unitStr ? serializeValue(unitStr) : '$'});`;
      lines.push(line);
      propertyIds.push(propId);
    }

    // Create IfcPropertySet
    const psetId = ctx.allocateExpressId();
    count++;

    const propRefs = propertyIds.map(id => `#${id}`).join(',');
    const globalId = generateGlobalId(random);

    // #ID=IFCPROPERTYSET('GlobalId',#ownerHistory,'Name',$,(#props));
    const psetLine = `#${psetId}=IFCPROPERTYSET('${globalId}',${resolveOwnerHistoryRef(ctx, entityId, willBeEmitted)},'${escapeStepString(pset.name)}',$,(${propRefs}));`;
    lines.push(psetLine);

    if (typeOwnedPsetNames?.has(pset.name)) {
      generatedTypeOwnedPsetIds.set(pset.name, psetId);
    } else {
      // Create IfcRelDefinesByProperties to link pset to entity
      const relId = ctx.allocateExpressId();
      count++;

      const relGlobalId = generateGlobalId(random);
      // #ID=IFCRELDEFINESBYPROPERTIES('GlobalId',#ownerHistory,$,$,(#entity),#pset);
      const relLine = `#${relId}=IFCRELDEFINESBYPROPERTIES('${relGlobalId}',${resolveOwnerHistoryRef(ctx, entityId, willBeEmitted)},$,$,(#${entityId}),#${psetId});`;
      lines.push(relLine);
    }
  }

  return { lines, count, generatedTypeOwnedPsetIds };
}

/**
 * Generate STEP entities for quantity sets (IfcElementQuantity)
 */
function generateQuantitySetEntities(
  ctx: PropertySetContext,
  entityId: number,
  qsets: QuantitySet[],
  willBeEmitted: (id: number) => boolean,
  random?: RandomSource
): { lines: string[]; count: number } {
  const lines: string[] = [];
  let count = 0;

  for (const qset of qsets) {
    const quantityIds: number[] = [];

    for (const q of qset.quantities) {
      const qId = ctx.allocateExpressId();
      count++;

      const ifcType = quantityTypeToIfcType(q.type);
      // #ID=IFCQUANTITYLENGTH('Name',$,$,Value,$);
      const val = toStepReal(q.value);
      const line = `#${qId}=${ifcType}('${escapeStepString(q.name)}',$,$,${val},$);`;
      lines.push(line);
      quantityIds.push(qId);
    }

    // Create IfcElementQuantity
    const qsetId = ctx.allocateExpressId();
    count++;

    const quantRefs = quantityIds.map(id => `#${id}`).join(',');
    const globalId = generateGlobalId(random);

    // #ID=IFCELEMENTQUANTITY('GlobalId',#ownerHistory,'Name',$,$,(#quants));
    const qsetLine = `#${qsetId}=IFCELEMENTQUANTITY('${globalId}',${resolveOwnerHistoryRef(ctx, entityId, willBeEmitted)},'${escapeStepString(qset.name)}',$,$,(${quantRefs}));`;
    lines.push(qsetLine);

    // Create IfcRelDefinesByProperties to link qset to entity
    const relId = ctx.allocateExpressId();
    count++;

    const relGlobalId = generateGlobalId(random);
    const relLine = `#${relId}=IFCRELDEFINESBYPROPERTIES('${relGlobalId}',${resolveOwnerHistoryRef(ctx, entityId, willBeEmitted)},$,$,(#${entityId}),#${qsetId});`;
    lines.push(relLine);
  }

  return { lines, count };
}

/**
 * Collect what the overlay's property-set and quantity-set edits mean for this
 * export: which sets to regenerate (`pass.newPropertySets` /
 * `pass.newQuantitySets`), which source records to withhold
 * (`pass.skipPropertySetIds` / `pass.skipRelationshipIds`), and which type
 * objects need their `HasPropertySets` resolved later
 * (`pass.typeOwnedPsetNamesByEntity`, `…IdsByEntity`, `pass.rewrittenEntityIds`).
 *
 * The caller owns the `mutationView && options.applyMutations !== false` gate;
 * reaching here means overlay edits were both present and enabled.
 */
export function collectPropertyAndQuantitySetMutations(
  pass: ExportPass,
  options: StepExportOptions,
  groups: PropertyMutationGroups,
  ctx: PropertySetContext,
): void {
  const { entityPropMutations, entityQuantMutations, relDefinesByEntity } = groups;
  // `export()` narrowed this through the enclosing `if`, and the caller still
  // owns that gate: reaching here means the view exists and mutations are
  // enabled. Named once here rather than asserted at each of the six reads.
  const mutationView = ctx.mutationView as MutablePropertyView;
  // Collect modified property sets and find original psets to skip
  for (const [entityId, psetNames] of entityPropMutations) {
    // A deleted entity must not cause the exporter to REMOVE anything.
    //
    // This is the other half of the dangling-reference class, and the half
    // `willBeEmitted` cannot reach: that predicate guards what gets ADDED,
    // and this loop's real work is deciding what gets SKIPPED. An edited
    // pset is replaced wholesale, so its original id goes into
    // `skipPropertySetIds` — but IFC exporters share one IfcPropertySet
    // between entities, and once the host is deleted there is no
    // replacement to take its place. The surviving entity's relation then
    // points at a container nobody wrote. Verified against main at
    // e6516991 (#2030's own merge): edit `Pset_WallCommon` on one of two
    // walls sharing it, delete that wall, and the export drops #11 while
    // #12 still names it. `retainSharedAtoms` rescues a shared ATOM one
    // level down; nothing rescues the shared container.
    //
    // Leaving the pset alone makes it an orphan when nothing else
    // references it, which is valid IFC. Its relation is dropped by the
    // sweep above, which handles a plain delete too — no pset edit needed.
    if (pass.effective.isDeleted(entityId)) continue;
    pass.modifiedEntities.add(entityId);
    // Same rule as the attribute loop below: an overlay-CREATED entity is
    // emitted once, by the new-entities pass, and already counted in
    // `newEntityCount` — as are the pset entities this loop goes on to
    // generate. Only the COUNT is guarded; the entity still records its
    // pset edits and still emits them.
    //
    // A NOMINATION, in both modes, never a count on its own: this site sees
    // a pset NAME the session touched, not whether that name resolves to
    // anything. `deletePropertySet(id, 'AName')` on a host that owns no such
    // set reaches here and changes nothing at all, and used to put "1
    // modification" in the header of a byte-identical file (#2474). What
    // settles it is the generator's `recordEmitted` and the skip branches'
    // `recordWithheld` below.
    if (!pass.isOverlayCreated(entityId) && pass.hasEmittableHostBytes(entityId)) {
      pass.modifications.nominate(entityId, 'property-set');
    }

    // Get the FULL mutated property sets for this entity (merged base + mutations)
    const allPsets = mutationView.getForEntity(entityId);
    const relevantPsets = allPsets.filter((pset: PropertySet) => psetNames.has(pset.name));
    const relDefinedPsetNames = new Set<string>();

    if (relevantPsets.length > 0) {
      pass.newPropertySets.push({ entityId, psets: relevantPsets });
    }

    // Find original property set IDs and relationship IDs to skip — look
    // up only the IfcRelDefinesByProperties rels that reference this entity.
    const rels = relDefinesByEntity.get(entityId);
    if (rels) {
      for (const { relId, psetId: relatedPsetId } of rels) {
        // Check if this pset is one we're modifying
        const psetName = getPropertySetName(ctx, relatedPsetId);
        if (psetName) {
          relDefinedPsetNames.add(psetName);
        }
        if (psetName && psetNames.has(psetName)) {
          pass.skipRelationshipIds.add(relId);
          pass.skipPropertySetIds.add(relatedPsetId);
          // Also skip the individual properties in this pset
          const propIds = getPropertyIdsInSet(ctx, relatedPsetId);
          for (const propId of propIds) {
            pass.skipPropertySetIds.add(propId);
          }
          // The other half of "did this edit change the file": a full export
          // applies a set DELETION by leaving these lines out, and produces
          // no replacement content to record an emission for. Without this
          // the count would settle from the generator alone and a real
          // deletion would stop counting along with the no-op one (#2474).
          pass.modifications.recordWithheld(entityId, 'property-set');
        }
      }
    }

    if (isTypeClass(pass.effective.typeOf(entityId))) {
      const typeOwnedPsetIds = getTypeOwnedHasPropertySetIds(ctx, entityId, pass.effective);
      const typeOwnedAffected = new Set<string>();

      for (const psetId of typeOwnedPsetIds) {
        const psetName = getPropertySetName(ctx, psetId);
        if (!psetName || !psetNames.has(psetName)) continue;
        typeOwnedAffected.add(psetName);
        pass.skipPropertySetIds.add(psetId);
        const propIds = getPropertyIdsInSet(ctx, psetId);
        for (const propId of propIds) {
          pass.skipPropertySetIds.add(propId);
        }
        // No `recordWithheld` twin of the rel-defined branch above, and
        // deliberately: a name that matches an OWNED pset is either dropped
        // from the resolved list or swapped for the replacement this export
        // generated, so slot 5 always comes back different and the repoint
        // below records the emission for it. A second record here would be
        // one no mutation can kill.
      }

      for (const psetName of psetNames) {
        if (!relDefinedPsetNames.has(psetName)) {
          typeOwnedAffected.add(psetName);
        }
      }

      if (typeOwnedAffected.size > 0) {
        pass.typeOwnedPsetNamesByEntity.set(entityId, typeOwnedAffected);
        pass.typeOwnedPsetIdsByEntity.set(entityId, typeOwnedPsetIds);
        pass.rewrittenEntityIds.add(entityId);
      }
    }
  }

  // Collect modified quantity sets (only if quantities are included)
  if (options.includeQuantities === false) entityQuantMutations.clear();
  // A quantity overlay with nothing under it regenerates a source quantity
  // set from the edited quantity ALONE, and the skip loop below then
  // withholds the source lines that held its siblings (#2487). Unlike
  // properties — whose base falls back to the `baseTable` the view was
  // constructed with — quantities have only the opt-in
  // `setQuantityExtractor`, so the default really is an empty base, and
  // four in-tree callers plus every external embedder never set it.
  //
  // The exporter is the one place that always holds the missing half: it
  // was handed the very store the view is an overlay ON. Supplying it here
  // makes the loss impossible for every caller rather than for the callers
  // we happened to find, and a view that resolves its own quantities (the
  // viewer, MCP, the CLI headless backend) is never overwritten.
  //
  // The extractor closes over ONE store, and the view outlives this export.
  // So it closes over a BOX this class owns instead: a second export of the
  // same view against a DIFFERENT store re-points that box rather than
  // reading the first store's quantities, which is the one way "install only
  // when absent" could have answered from the wrong file. The setter is
  // called at most once per view, so a caller that installs its own
  // extractor at any point — before the first export or after it — keeps it.
  //
  // `hasQuantityBase` and `setQuantityExtractor` are probed, like every other
  // optional view capability this class reaches for (`peekNextExpressId`,
  // `getNewEntities`, `getEntityTypeMutation`): `MutablePropertyView` is
  // published API arriving from a separately versioned package, and callers
  // pass partial and duck-typed views. `hasQuantityBase` is newer than
  // `setQuantityExtractor`, and without it there is no way to tell an empty
  // base from a caller-supplied one — so an older view falls back to the
  // pre-#2487 behaviour (no base supplied) rather than risk overwriting one.
  const quantityView = mutationView;
  if (
    entityQuantMutations.size > 0 &&
    typeof quantityView.setQuantityExtractor === 'function' &&
    typeof quantityView.hasQuantityBase === 'function'
  ) {
    const installed = exporterQuantityBase.get(quantityView);
    if (installed) {
      // Ours, or a caller's that replaced ours: re-pointing the box is a
      // no-op in the second case, and calling the setter again is what
      // would not be.
      installed.store = ctx.dataStore;
    } else if (!quantityView.hasQuantityBase()) {
      const box = { store: ctx.dataStore };
      exporterQuantityBase.set(quantityView, box);
      quantityView.setQuantityExtractor((id: number) => extractQuantitiesOnDemand(box.store, id));
    }
  }
  for (const [entityId, qsetNames] of entityQuantMutations) {
    // Same rule as the property loop above: a deleted entity removes nothing.
    if (pass.effective.isDeleted(entityId)) continue;
    pass.modifiedEntities.add(entityId);
    // See the property loop above — an overlay-created entity is counted as
    // new, not modified. The pset loop's own nomination no longer has to be
    // excluded to avoid a double count: the ledger settles per ENTITY, so a
    // host with both a pset and a qset edit counts once whatever is
    // nominated. Nominating both buys the opposite — an accurate warning
    // when the qset half is the half a delta cannot carry.
    //
    // Settled from effect like its property-set twin (#2474). The reachable
    // no-op here is an UNDONE quantity-set creation whose name matches NO
    // source set: `getMutations()` is append-only, so the `CREATE_QUANTITY`
    // record still names the qset after `removeQuantityMutation` has taken
    // it out of the overlay, and the generator below then finds nothing to
    // write. The same undo against a COLLIDING name is not a no-op — it
    // withholds the source set's lines — which is what the skip loop's
    // `recordWithheld` below settles.
    if (!pass.isOverlayCreated(entityId) && pass.hasEmittableHostBytes(entityId)) {
      pass.modifications.nominate(entityId, 'quantity-set');
    }

    const allQsets = mutationView.getQuantitiesForEntity(entityId);
    const relevantQsets = allQsets.filter((qset: QuantitySet) => qsetNames.has(qset.name));

    if (relevantQsets.length > 0) {
      pass.newQuantitySets.push({ entityId, qsets: relevantQsets });
    }

    // The names this export is actually WRITING a replacement for. The
    // affected-name set is not the same thing: it comes from the session's
    // append-only mutation history, which keeps naming a quantity set after
    // an undo has taken it back out of the overlay, so a Ctrl+Z used to
    // withhold a source `IfcElementQuantity` that nothing regenerated.
    //
    // A quantity-set REMOVAL is the one case where withholding WITHOUT a
    // replacement is the intent rather than the bug. It had no public
    // populator when #2487 wrote that rule, so the rule read "always the
    // bug"; `MutablePropertyView.deleteQuantitySet` (#2508) gives it one,
    // and the deleted set is now asked for by name below. Without that, the
    // panel hid a base quantity set the exported file still carried.
    const regeneratedQsetNames = new Set(relevantQsets.map((qset: QuantitySet) => qset.name));

    // Skip original quantity set entities (IfcElementQuantity).
    // Same per-entity index lookup as the property branch above.
    const rels = relDefinesByEntity.get(entityId);
    if (rels) {
      for (const { relId, psetId: relatedPsetId } of rels) {
        const qsetName = getElementQuantityName(ctx, relatedPsetId);
        const deleted = qsetName !== null
          && mutationView.isQuantitySetDeleted?.(entityId, qsetName) === true;
        if (qsetName && (regeneratedQsetNames.has(qsetName) || deleted)) {
          pass.skipRelationshipIds.add(relId);
          pass.skipPropertySetIds.add(relatedPsetId);
          const quantIds = getPropertyIdsInSet(ctx, relatedPsetId);
          for (const quantId of quantIds) {
            pass.skipPropertySetIds.add(quantId);
          }
          // The withheld half, exactly as the rel-defined property branch
          // above. This loop has just decided that #`relatedPsetId`, its
          // quantity atoms and the relationship that attached them do NOT
          // go into the file; whether anything is generated to take their
          // place is decided elsewhere, and is not this branch's to assume.
          //
          // It IS assumable for the pset side and not here, and the
          // difference is where the two read their base from.
          // `getForEntity` merges the overlay over the base pset walk, so a
          // name the session touched but did not change still resolves to
          // source content and is regenerated.
          // `getQuantitiesForEntity` merges the overlay over
          // `quantityExtractor`, which is OPT-IN: it defaults to null, and
          // several in-tree callers wire the property extractor beside it
          // and not it (`cli/commands/mutate.ts`, `gym.ts`,
          // `generate-spaces.ts`, `export/demesh-session.ts`), as does any
          // external embedder of these two published packages. With no
          // extractor the base is empty and the overlay is the only source,
          // so a qset the overlay no longer holds resolves to nothing.
          //
          // Which makes this reachable through an UNDONE quantity-set
          // creation whose name COLLIDES with a source set:
          // `setQuantity(id, 'Qto_WallBaseQuantities', ...)` followed by the
          // `removeQuantityMutation` that mutationSlice runs on Ctrl+Z. The
          // append-only history still names the qset, so this branch
          // withholds the source lines; the overlay is empty again, so
          // nothing is regenerated. The export drops the source quantity set
          // — a real change to the file, and a data-loss bug of its own
          // (#2487) — and this call is what stops the count from calling it
          // nothing.
          pass.modifications.recordWithheld(entityId, 'quantity-set');
        }
      }
    }
  }
}

/**
 * Write the generated property-set and quantity-set records into
 * `pass.entities`, and point every affected type object's `HasPropertySets` at
 * the property sets this export just generated.
 *
 * Three loops, in the order `export()` ran them, and the order is load-bearing:
 * the rewrite reads `generatedTypeOwnedPsetIds` from the property-set loop, and
 * the caller flushes `pass.rewrittenEntityLines` — this function's output —
 * only after the quantity-set loop has run.
 */
export function generatePropertyAndQuantitySetEntities(
  pass: ExportPass,
  options: StepExportOptions,
  ctx: PropertySetContext,
): void {
  // Generate new property entities for mutations (these REPLACE the skipped ones)
  const generatedTypeOwnedPsetIds = new Map<number, Map<string, number>>();
  for (const { entityId, psets } of pass.newPropertySets) {
    // Nothing may be emitted FOR an entity that gets no defining line —
    // see `willBeEmitted` (#1978, #2030, #2012).
    if (!pass.willBeEmitted(entityId)) continue;
    const newEntities = generatePropertySetEntities(
      ctx,
      entityId,
      psets,
      pass.willBeEmitted,
      pass.effective,
      pass.typeOwnedPsetNamesByEntity.get(entityId),
      options.guidRandom
    );
    pass.entities.push(...newEntities.lines);
    pass.newEntityCount += newEntities.count;
    // Replacement content for this host actually landed, so a delta really
    // does carry its PROPERTY-SET modification — and only that one (#2462).
    if (newEntities.lines.length > 0) pass.modifications.recordEmitted(entityId, 'property-set');
    generatedTypeOwnedPsetIds.set(entityId, newEntities.generatedTypeOwnedPsetIds);
  }

  // Point every affected type object's HasPropertySets at the psets this
  // export generated. One loop, because a type whose affected psets produced
  // no replacement content (a deletion) needs exactly the same resolution
  // with an empty replacement map.
  for (const [entityId, typeOwnedPsetNames] of pass.typeOwnedPsetNamesByEntity) {
    // `entityId` here is a TYPE object rather than an element; `willBeEmitted`
    // resolves either the same way (#2030).
    if (!pass.willBeEmitted(entityId)) continue;
    const resolved = resolveTypeOwnedPsetIds(
      pass.typeOwnedPsetIdsByEntity.get(entityId) ?? [],
      typeOwnedPsetNames,
      generatedTypeOwnedPsetIds.get(entityId) ?? new Map(),
      (psetId) => getPropertySetName(ctx, psetId),
    );
    if (pass.effective.isOverlayCreated(entityId)) {
      // No source line to rewrite: the new-entities pass writes this record
      // from its authored payload, so the list rides in as a slot override.
      pass.overlayTypeOwnedPsets.set(
        entityId,
        resolved.length > 0 ? resolved.map((id) => `#${id}`) : null,
      );
      continue;
    }
    // This line REPLACES the one the source-iteration pass would have
    // written — `rewrittenEntityIds` makes that pass skip the entity — so it
    // has to carry the entity's other edits too, and it has to apply them
    // the way that pass does. It used to replace slot 5 and nothing else,
    // which dropped the rename in `setAttribute(id,'Name',…)` +
    // `addPropertySet(id,…)`, and then, once renames were special-cased
    // here, still dropped retypes and positional edits — same line, same
    // silence. So run the ONE pipeline both passes share and replace
    // `HasPropertySets` on its output. Order matters: see
    // {@link applySourceLineMutations}.
    const record = pass.effective.get(entityId);
    let sourceLine: string | null = null;
    let mutated: SourceLineMutations | null = null;
    // One narrowed block for both calls: `record` is in scope for the decode
    // AND for the record type below, with no non-null assertion to keep true
    // by hand. `byteOffset >= 0` is the same "are there real source bytes"
    // test the source-iteration pass makes — an overlay-authored record
    // carries `-1` there, and decoding from it would read another entity's
    // bytes rather than fall through to the no-source-bytes branch.
    // `isReadableSourceRef` folds in the `byteOffset >= 0 && byteLength > 0`
    // test this used to make by hand, and adds the bound the invariant used
    // to supply (#2491).
    if (record && pass.isReadableSourceRef(record)) {
      sourceLine = decodeRange(
        ctx.dataStore.source,
        record.byteOffset,
        record.byteOffset + record.byteLength,
      );
      // The RECORD's class is the from-type: the bytes are still the source
      // class, whatever `typeOf` now says the entity effectively is.
      mutated = ctx.applySourceLineMutations(
        entityId,
        sourceLine,
        record.type,
        pass.modifiedAttributes.get(entityId),
        pass.sourceSchema,
        pass.overlayActive,
        (attr, value) =>
          pass.warnings.push(
            `entity #${entityId}: attribute ${attr} not written - ` +
              `${JSON.stringify(value)} is not a number and the slot is REAL-typed`,
          ),
      );
    }
    if (mutated === null) {
      // `willBeEmitted` already required real source bytes for a non-overlay
      // record, so this is only reachable with no source buffer at all —
      // in which case the source-iteration pass never ran either and there is
      // nothing to lose. Say it anyway; the pset edit is still going nowhere.
      pass.warnings.push(typeOwnedPsetRewriteWarning(entityId, 'no-source-bytes'));
      // The line above IS the report, so the ledger must not add a second,
      // vaguer one blaming the delta format for a drop the format did not
      // cause.
      pass.modifications.acknowledgeUndelivered(entityId, 'property-set');
      continue;
    }
    const { line, repointed } = rewriteTypeOwnedPsetLine(mutated.text, resolved);
    if (repointed) {
      // A repoint that resolves to the list the line ALREADY names changes
      // nothing, and it is reachable: deleting a pset name the type object
      // does not own leaves every original id in place (it is "affected" but
      // matches none of them) and generates no replacement, so slot 5 comes
      // back byte-identical. Same rule as the fallback branch below — an
      // unchanged line has no place in a delta, and claiming it delivered the
      // edit would put a modification in the header over a line that carries
      // none. A FULL export still emits it: `rewrittenEntityIds` made the
      // source-iteration pass skip this entity, so withholding the line there
      // would delete the record from the file (#2469).
      const changed = line !== sourceLine;
      if (options.deltaOnly !== true || changed) {
        pass.rewrittenEntityLines.set(entityId, line);
      }
      // A rewritten source line IS in the delta — the one in-place change a
      // delta does carry today (#2462). The repoint itself delivers the
      // property-set edit that put this host in the loop; the rest of the
      // line delivers whichever in-place edits the pipeline applied to it.
      if (changed) {
        pass.modifications.recordEmitted(entityId, 'property-set');
        recordSourceLineDelivery(pass.modifications, entityId, mutated);
        // `rewrittenEntityIds` made the source-iteration pass skip this
        // host, so this line is the ONLY place a full export can see its
        // named-attribute edits land — per site, not per feature (#2483).
        nominateDeliveredInPlaceEdits(pass.modifications, entityId, mutated, pass.inPlaceNominees);
      }
      continue;
    }
    // A malformed source line — too few arguments to have a slot 5, or not
    // parseable as a STEP record at all. The entity must still come out:
    // `rewrittenEntityIds` made the source-iteration pass skip it, so
    // dropping the line here deletes the whole record from the file (#2469).
    pass.warnings.push(typeOwnedPsetRewriteWarning(entityId, 'unparseable-line'));
    // Same as the `no-source-bytes` branch: the property-set edit is
    // genuinely undelivered — the repoint is what would have delivered it and
    // it did not happen — but this warning already says so, precisely, so the
    // ledger stays quiet about that pair rather than duplicating it. (When
    // the affected psets produced replacement content, the property-set pass
    // above has already recorded the emission, and an emission outranks an
    // acknowledgement.)
    pass.modifications.acknowledgeUndelivered(entityId, 'property-set');
    // `line` is byte-for-byte what the source-iteration pass would have
    // written, so emit it wherever that pass would have run. Under
    // `deltaOnly` it does not run, and a line the mutation pipeline left
    // identical to its source is not a change — it has no place in a delta.
    const changed = line !== sourceLine;
    if (options.deltaOnly !== true || changed) {
      pass.rewrittenEntityLines.set(entityId, line);
    }
    // The ledger stays honest about WHICH modification landed: the
    // property-set edit that nominated this host is the thing that just
    // failed, so only the entity's OTHER edits are in this line. Under the
    // per-kind keying that comes out as `attribute/retype/positional:
    // delivered, property-set: undelivered` — the host still counts once,
    // because a real change of its did land.
    if (changed) {
      recordSourceLineDelivery(pass.modifications, entityId, mutated);
      // Same site rule as the repoint branch above: the failed repoint is
      // what did not land, and the line still carries the host's OTHER edits.
      nominateDeliveredInPlaceEdits(pass.modifications, entityId, mutated, pass.inPlaceNominees);
    }
  }

  // Generate new quantity entities for mutations
  for (const { entityId, qsets } of pass.newQuantitySets) {
    if (!pass.willBeEmitted(entityId)) continue;
    const newEntities = generateQuantitySetEntities(ctx, entityId, qsets, pass.willBeEmitted, options.guidRandom);
    pass.entities.push(...newEntities.lines);
    pass.newEntityCount += newEntities.count;
    if (newEntities.lines.length > 0) pass.modifications.recordEmitted(entityId, 'quantity-set');
  }
}
