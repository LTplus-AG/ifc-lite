/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A per-TYPE preview of what a schema conversion will do to the entities a
 * store actually contains, computed WITHOUT running the export.
 *
 * `schema-converter.ts`'s `convertStepLine` already makes every one of these
 * decisions per RECORD, but only as a side effect of producing bytes (or, for
 * a non-rooted type with no target representation, throwing —
 * `resolveUnrepresentedEntity`'s documented, intentional behaviour for e.g.
 * `IFCTRIANGULATEDFACESET` into IFC2X3: there is no valid IFC2X3 substitute
 * for a representation item, so guessing one would ship a differently-broken
 * file). Before this module, a caller's only way to learn what a conversion
 * would do — or that it cannot complete at all — was to attempt the full
 * export and either inspect `stats.warnings` after the fact or catch the
 * exception with no indication of what ELSE in the file has the same
 * problem, since the export aborts on the FIRST record it cannot represent.
 *
 * `IfcDataStore.entityIndex.byType` already gives every distinct type
 * present with its express ids, and `classifyEntityTypeConversion`'s
 * decision depends only on the TYPE (the generated attribute tables are
 * positional-name lists, not per-instance data) — so a complete, honest loss
 * report is one pass over the distinct types, not the whole file (#4206: the
 * "the loss report ... names each attribute it could not carry" bar).
 */

import { isStructuralBoundaryCondition, isStructuralAssignmentConversion } from './schema-converter-structural.js';
import { NO_ROUND_TRIP, structuralRoundTrip } from './schema-converter-structural-diagnostics.js';
import { varyingTarget } from './schema-converter-structural-varying.js';
import { DocumentLinks } from './schema-converter-document-links.js';
import { SourceRecords } from './schema-converter-structural-source.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  convertEntityType,
  attrNameTable,
  shouldSkipEntity,
  type IfcSchemaVersion,
} from './schema-converter.js';
import { BY_NAME_ATTR_REMAP_TYPES } from './schema-converter-attr-remap.js';
import { isStrictAttrPrefix, replacedSlot } from './schema-converter-renames.js';
import { attrMapFor, attrsDroppedByMap, dropsSetMembers } from './schema-converter-attr-maps.js';
import { isRootedEntityType } from './schema-untranslatable.js';

/** How one entity TYPE's data survives a schema conversion. */
export type EntityConversionKind =
  /** Same type name, nothing lost: the attribute list is unchanged, padded,
   *  or reconciled by an attribute map (#10763). */
  | 'identity'
  /** Different type name, every source attribute has a same-named or
   *  explicitly mapped semantic home in the target. */
  | 'renamed'
  /** Reconciled with SOME loss. Usually at least one source attribute has no
   *  home in the target schema's shape for this type (see
   *  `droppedAttributes`) — but a same-named type whose attribute lists are
   *  reordered rather than appended/removed, with no attribute map
   *  (`schema-converter-attr-maps.ts`, #10763), is also `lossy` with an EMPTY
   *  `droppedAttributes`: every name still exists in the target, but
   *  `convertRecord` leaves the positional values untouched under the new
   *  shape, so they land in the wrong slots rather than disappearing. */
  | 'lossy'
  /** No representation at all in the target schema. The type IS an IfcRoot
   *  subtype, so every instance becomes a generic IFCPROXY: its own semantic
   *  type, GlobalId and every attribute are gone. */
  | 'proxied'
  /** No representation at all, and NOT an IfcRoot subtype (a resource type or
   *  representation item referenced positionally by other entities). Cannot
   *  become a proxy (an IfcProduct is not a valid substitute) and cannot be
   *  dropped (referencing entities would dangle) — converting a record of
   *  this type throws. */
  | 'blocked';

export interface EntityConversionInfo {
  targetType: string;
  kind: EntityConversionKind;
  /** Source-schema attribute names with no same-named slot in the target
   *  type. Populated for `lossy`, `proxied` (every attribute, or for an alignment
   *  product only its GlobalId and the attributes past IfcProduct's) and `blocked`
   *  (every attribute — the record cannot be written at all). */
  droppedAttributes: readonly string[];
}

/**
 * Classify what converting entities of `entityType` from `fromSchema` to
 * `toSchema` will do, mirroring `schema-converter.ts`'s `convertRecord`
 * decision tree exactly (same helpers, same order) without needing a STEP
 * line to run it on.
 */
export function classifyEntityTypeConversion(
  entityType: string,
  fromSchema: IfcSchemaVersion,
  toSchema: IfcSchemaVersion,
): EntityConversionInfo {
  const upper = entityType.toUpperCase();
  if (fromSchema === toSchema) return { targetType: upper, kind: 'identity', droppedAttributes: [] };

  const newType = convertEntityType(upper, fromSchema, toSchema);
  const srcAttrs = attrNameTable(fromSchema)?.get(upper);
  // #9668: stiffness fields survive by semantic position and unit, despite
  // renamed Linear/Translational attributes and SELECT wrappers.
  if (isStructuralBoundaryCondition(upper) && ((fromSchema === 'IFC2X3' && toSchema === 'IFC4') || (fromSchema === 'IFC4' && toSchema === 'IFC2X3')))
    // IFC2X3 cannot retain the IFC4 SELECT member: boolean false and a zero
    // measure both become 0, preserving stiffness but losing that distinction.
    return { targetType: upper, kind: fromSchema === 'IFC4' ? 'lossy' : 'renamed', droppedAttributes: [] };
  // #9668: the two linked objects survive in IFC4's analytical assignment,
  // under differently named roles, but their original relationship kind is lost.
  if (isStructuralAssignmentConversion(upper, fromSchema, toSchema))
    return { targetType: newType, kind: 'lossy', droppedAttributes: [] };
  if (shouldSkipEntity(newType, toSchema)) {
    // `productProxy` keeps attributes 1 to 6 (IfcProduct's, OwnerHistory
    // through Representation, #7683) and mints the GlobalId, so what is lost
    // is the source GlobalId and everything past the seventh attribute.
    // `srcAttrs` is undefined only for a source schema with no generated
    // table (IFC5); there is nothing to name in that case.
    return {
      targetType: 'IFCPROXY',
      kind: 'proxied',
      droppedAttributes: (srcAttrs ?? []).filter((_, i) => i === 0 || i >= 7),
    };
  }

  const targetTable = attrNameTable(toSchema);
  const tgtAttrs = targetTable?.get(newType);

  // Same condition as `convertRecord` (an IFC2X3 target refuses a type its
  // table lacks even when the source table does not know it either, #7683).
  if (targetTable && !tgtAttrs && (toSchema === 'IFC2X3' || (toSchema === 'IFC4' && fromSchema === 'IFC4X3' && srcAttrs))) {
    const dropped = srcAttrs ?? [];
    return isRootedEntityType(upper)
      ? { targetType: 'IFCPROXY', kind: 'proxied', droppedAttributes: dropped }
      : { targetType: newType, kind: 'blocked', droppedAttributes: dropped };
  }

  if (!srcAttrs || !tgtAttrs) {
    // Unknown to one of the tables (IFC5 has none) — the per-line converter
    // passes such lines through unexamined; nothing to report either way.
    return { targetType: newType, kind: upper === newType ? 'identity' : 'renamed', droppedAttributes: [] };
  }

  if (srcAttrs.length === tgtAttrs.length && srcAttrs.every((name, i) => name === tgtAttrs[i])) {
    // Neither list is a STRICT prefix of the other when they are equal
    // (`isStrictAttrPrefix` requires shorter.length < longer.length) — the
    // same case `convertRecord` leaves untouched because `finalAttrs` never
    // gets reassigned there. Matches, not a rename or a loss.
    return { targetType: newType, kind: upper === newType ? 'identity' : 'renamed', droppedAttributes: [] };
  }

  const mapped = attrMapFor(upper, newType, fromSchema, toSchema);
  if (mapped) {
    // #10763: what the reviewed map carries survives; every other source attribute is dropped.
    const dropped = attrsDroppedByMap(mapped.map, mapped.up, srcAttrs, tgtAttrs);
    return { targetType: newType, kind: dropped.length > 0 ? 'lossy' : upper === newType ? 'identity' : 'renamed', droppedAttributes: dropped };
  }
  // #10758: the converter writes `$` where a schema replaced an attribute in place.
  const replaced = replacedSlot(upper, srcAttrs, tgtAttrs);
  const replacedName = replaced === undefined ? [] : [srcAttrs[replaced]];
  // A pad drops nothing past the source's own length, so one branch serves both.
  if (isStrictAttrPrefix(tgtAttrs, srcAttrs, upper) || isStrictAttrPrefix(srcAttrs, tgtAttrs, upper)) {
    const dropped = [...replacedName, ...srcAttrs.slice(tgtAttrs.length)];
    return {
      targetType: newType,
      kind: dropped.length > 0 ? 'lossy' : upper === newType ? 'identity' : 'renamed',
      droppedAttributes: dropped,
    };
  }
  if (upper !== newType && BY_NAME_ATTR_REMAP_TYPES.has(upper)) {
    const dropped = srcAttrs.filter((name) => !tgtAttrs.includes(name));
    return { targetType: newType, kind: dropped.length > 0 ? 'lossy' : 'renamed', droppedAttributes: dropped };
  }
  // Neither prefix-related nor in the by-name allowlist: `convertRecord`
  // leaves the attribute list untouched under the new type name — a record
  // whose slots no longer match its own declared type's shape at all.
  return {
    targetType: newType,
    kind: 'lossy',
    droppedAttributes: srcAttrs.filter((name) => !tgtAttrs.includes(name)),
  };
}

/** One distinct type's outcome, with the express ids of every instance the
 *  store holds — the caller supplies these for the report to name. */
export interface ConversionLossEntry extends EntityConversionInfo {
  sourceType: string;
  count: number;
  expressIds: readonly number[];
  /** Record-level losses when instances of this type lose different attributes or are written as different types. */
  recordGroups?: readonly (Pick<ConversionLossEntry, 'expressIds' | 'droppedAttributes' | 'count'> & Partial<Pick<ConversionLossEntry, 'targetType'>>)[];
}

export interface ConversionLossReport {
  fromSchema: IfcSchemaVersion;
  toSchema: IfcSchemaVersion;
  /** Every non-identity, non-plain-`renamed` entry: `lossy`, `proxied` and
   *  `blocked` types the store actually contains at least one instance of.
   *  A type whose records lose different attributes, because an IFC2X3 <-> IFC4
   *  structural carrier brings some of them back for some records, has one
   *  entry with record groups and the union of their lost attributes (#9668). */
  entries: readonly ConversionLossEntry[];
  /** True when a full-fidelity export exists (no `blocked` entries) but at
   *  least one type is `lossy` or `proxied`. */
  hasLoss: boolean;
  /** True when the store contains a type `exportToStep(store, {schema:
   *  toSchema})` cannot write at all — the export will throw. */
  hasBlocking: boolean;
  /** Human-readable lines, one per entry, naming the type, how many
   *  instances, their express ids and which attributes do not survive. */
  describe(): string[];
}

const MAX_IDS_NAMED = 8;

function describeEntry(entry: ConversionLossEntry): string {
  const ids = entry.expressIds.slice(0, MAX_IDS_NAMED).map((id) => `#${id}`).join(', ');
  const more = entry.expressIds.length > MAX_IDS_NAMED ? `, +${entry.expressIds.length - MAX_IDS_NAMED} more` : '';
  const attrs = entry.droppedAttributes.length > 0 ? ` — loses ${entry.droppedAttributes.join(', ')}` : '';
  switch (entry.kind) {
    case 'blocked':
      return (
        `${entry.count} × ${entry.sourceType} (${ids}${more}) has no representation in this schema and is ` +
        `not an IfcRoot subtype: conversion cannot write these records at all${attrs}.`
      );
    case 'proxied':
      return (
        `${entry.count} × ${entry.sourceType} (${ids}${more}) has no representation in this schema: these ` +
        `become generic IFCPROXY placeholders, losing their own type${attrs}.`
      );
    case 'lossy':
    default:
      return `${entry.count} × ${entry.sourceType} → ${entry.targetType} (${ids}${more})${attrs}.`;
  }
}

/**
 * The entry for a type with dropped attributes: its records grouped by those no carrier
 * restores for them. A `lossy` record that loses nothing then has no entry.
 */
function entryAfterRestoration(
  sourceType: string,
  expressIds: readonly number[],
  info: EntityConversionInfo,
  isRetained: (id: number, attribute: string) => boolean,
): ConversionLossEntry | undefined {
  const groups = new Map<string, { dropped: string[]; ids: number[] }>();
  for (const id of expressIds) {
    const dropped = info.droppedAttributes.filter((attribute) => !isRetained(id, attribute));
    if (info.kind === 'lossy' && !dropped.length) continue;
    const key = dropped.join(',');
    const group = groups.get(key) ?? { dropped, ids: [] };
    group.ids.push(id);
    groups.set(key, group);
  }
  if (!groups.size) return undefined;
  const recordGroups = [...groups.values()].map(({ dropped, ids }) => ({
    droppedAttributes: dropped,
    count: ids.length,
    expressIds: ids,
  }));
  const lost = new Set(recordGroups.flatMap((group) => group.droppedAttributes));
  const omitted = new Set(recordGroups.flatMap((group) => group.expressIds));
  const reportedIds = expressIds.filter((id) => omitted.has(id));
  return {
    ...info,
    droppedAttributes: info.droppedAttributes.filter((attribute) => lost.has(attribute)),
    sourceType,
    count: reportedIds.length,
    expressIds: reportedIds,
    ...(recordGroups.length > 1 ? { recordGroups } : {}),
  };
}

/**
 * A complete, per-type loss report for converting every entity `store`
 * contains from `fromSchema` to `toSchema` — no export attempted, so this
 * does not throw for a record the export cannot write and always covers the
 * whole file, not just the first record a full export would have aborted on.
 * With source bytes, the report checks whether a narrowed SET actually loses
 * members and excludes values preserved by IFC2X3 ↔ IFC4 structural carriers
 * (#9668). Those carriers describe the default, unedited full export.
 */
export function analyzeConversionLoss(
  store: Pick<IfcDataStore, 'entityIndex'> & Partial<Pick<IfcDataStore, 'source' | 'deferredEntityIndex'>>,
  fromSchema: IfcSchemaVersion,
  toSchema: IfcSchemaVersion,
): ConversionLossReport {
  const entries: ConversionLossEntry[] = [];
  if (fromSchema !== toSchema) {
    const typed: [string, readonly number[], EntityConversionInfo][] = [];
    // An IFC2X3 varying action classifies as identity, but the upgrade can report its CausedBy (`strandedAs`).
    const varying: [string, readonly number[]][] = [];
    // @raw-entity-enumeration-ok this report accepts only a source entityIndex and describes the parsed file's schema-conversion losses
    for (const [sourceType, expressIds] of store.entityIndex.byType) {
      if (expressIds.length === 0) continue;
      const info = classifyEntityTypeConversion(sourceType, fromSchema, toSchema);
      if (info.kind !== 'identity' && info.kind !== 'renamed') typed.push([sourceType.toUpperCase(), expressIds, info]);
      else if (fromSchema === 'IFC2X3' && varyingTarget(sourceType.toUpperCase())) varying.push([sourceType.toUpperCase(), expressIds]);
    }
    // #9668: what an IFC2X3 <-> IFC4 structural carrier writes back on the round trip is not lost.
    // Only IfcStructural* records carry anything, and reading them needs the source bytes.
    // #10846: nor is a document link the export moves to the other record.
    const carrying = (type: string, info: EntityConversionInfo) => /^IFC(STRUCTURAL|DOCUMENT(INFORMATION|REFERENCE)$)/.test(type) && info.droppedAttributes.length > 0;
    const { entityIndex, deferredEntityIndex, source } = store;
    const round = source
      ? structuralRoundTrip({ entityIndex, deferredEntityIndex, source }, fromSchema, toSchema,
        [...typed.flatMap(([type, ids, info]) => (carrying(type, info) ? ids : [])), ...varying.flatMap(([, ids]) => ids)])
      : NO_ROUND_TRIP;
    const records = source ? new SourceRecords({ entityIndex, deferredEntityIndex, source }) : undefined;
    const links = new DocumentLinks();
    try {
      if (records) links.fromSource(records, fromSchema, toSchema);
    } catch (error) {
      // As for the carriers: the schema-only preview stands if the prepass fails.
      console.warn('[analyzeConversionLoss] Could not evaluate document links', error);
    }
    const { stranded } = round;
    const restored = new Map([...round.restored, ...links.restored]);
    for (const [sourceType, expressIds, info] of typed) {
      const mapped = records && toSchema === 'IFC2X3' ? attrMapFor(sourceType, info.targetType, fromSchema, toSchema) : undefined;
      // A SET declared for an upgrade can still be dropped entirely on downgrade.
      const setAttribute = mapped?.map.setOfOne?.[1];
      const narrowedSet = setAttribute && !mapped?.map.upOnly.includes(setAttribute) ? setAttribute : undefined;
      const slot = narrowedSet ? attrNameTable(fromSchema)?.get(sourceType)?.indexOf(narrowedSet) ?? -1 : -1;
      const isRetained = (id: number, attribute: string) => {
        if (restored.get(id)?.has(attribute)) return true;
        if (attribute !== narrowedSet) return false;
        const value = records?.slots(id)?.[slot];
        return value !== undefined && !dropsSetMembers(value);
      };
      const entry = carrying(sourceType, info) || slot >= 0
        ? entryAfterRestoration(sourceType, expressIds, info, isRetained)
        : { ...info, sourceType, count: expressIds.length, expressIds };
      if (entry) entries.push(entry);
    }
    // #10846: the classifier sees no IfcDocumentReference loss on an upgrade, but linking one drops its Name for WR1.
    if (links.unnamed.size > 0) {
      const expressIds = [...links.unnamed].sort((a, b) => a - b);
      entries.push({ targetType: 'IFCDOCUMENTREFERENCE', kind: 'lossy', droppedAttributes: ['Name'], sourceType: 'IFCDOCUMENTREFERENCE', count: expressIds.length, expressIds });
    }
    for (const [sourceType, ids] of varying) {
      const byTarget = new Map<string, number[]>();
      for (const id of ids) {
        const targetType = stranded.get(id);
        if (!targetType) continue;
        const list = byTarget.get(targetType) ?? [];
        list.push(id);
        byTarget.set(targetType, list);
      }
      const groups = [...byTarget].map(([targetType, expressIds]) => ({ targetType, droppedAttributes: ['CausedBy'], count: expressIds.length, expressIds }));
      if (!groups.length) continue;
      const expressIds = groups.flatMap((group) => group.expressIds);
      // Several groups: each names its own target, and the entry keeps the classifier's (the source type).
      const targetType = groups.length > 1 ? sourceType : groups[0].targetType;
      entries.push({ targetType, kind: 'lossy', droppedAttributes: ['CausedBy'], sourceType, count: expressIds.length, expressIds, ...(groups.length > 1 ? { recordGroups: groups } : {}) });
    }
    entries.sort((a, b) => a.sourceType.localeCompare(b.sourceType));
  }
  const hasBlocking = entries.some((e) => e.kind === 'blocked');
  return {
    fromSchema,
    toSchema,
    entries,
    hasLoss: entries.length > 0,
    hasBlocking,
    describe: () => entries.flatMap((entry) => entry.recordGroups
      ?.map((group) => describeEntry({ ...entry, ...group })) ?? [describeEntry(entry)]),
  };
}
