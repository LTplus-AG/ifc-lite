/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read-side state and helpers for the property-set and quantity-set phases
 * of `StepExporter.export()` (#2475 steps 2b and 2c), split out of
 * `step-property-sets.ts` (#3184): the {@link PropertySetContext} the
 * generation/collection phases run against, the per-entity STEP-text
 * readers those phases share (`entityLineText` and everything parsed from
 * it), and the owner-history resolution the generators call for every
 * record they emit.
 *
 * `isReadableSourceRef` on {@link PropertySetContext} is the exporter's OWN
 * reader rather than the pass's: these readers are also reached from
 * `buildRelDefinesByPropertiesIndex` (`step-property-set-index.ts`) and from
 * `retainSharedAtoms`, neither of which has a pass in hand.
 */

import type { IfcDataStore, IfcAttributeValue, EntityExtractor } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { createSourceRefReader, decodeRange } from './source-ref-bounds.js';
import { findLengthUnitReference, normalizeMapUnitName } from './step-map-unit.js';
import { authoredEntityRefs, type EffectiveEntityIndex } from './effective-index.js';
import { HAS_PROPERTY_SETS_SLOT } from './type-owned-psets.js';
import type { IfcSchemaVersion } from './schema-converter.js';
import type { SourceLineMutations } from './step-exporter.js';

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
  /** `step-attribute-mutations.ts`'s `applySourceLineMutations`: the ONE
   *  pipeline the source-iteration pass and the type-object rewrite share, so
   *  it belongs to neither phase and is injected. */
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

/** `OwnerHistory` is slot 1 on every `IfcRoot` subtype, all schemas. */
const OWNER_HISTORY_SLOT = 1;

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
export function getElementQuantityName(ctx: PropertySetContext, entityId: number): string | null {
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
export function getTypeOwnedHasPropertySetIds(ctx: PropertySetContext, entityId: number, effective: EffectiveEntityIndex): number[] {
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
export function resolveOwnerHistoryRef(ctx: PropertySetContext, hostEntityId: number, willBeEmitted: (id: number) => boolean): string {
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
export function generateGlobalId(random?: RandomSource): string {
  return generateIfcGuid(random);
}

/**
 * Find a unit entity ID by name (simplified - returns null for now)
 */
export function findUnitId(ctx: PropertySetContext, unitName: string, effective: EffectiveEntityIndex): number | null {
  return findLengthUnitReference(normalizeMapUnitName(unitName), effective, { dataStore: ctx.dataStore, entityExtractor: ctx.entityExtractor });
}
