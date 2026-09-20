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

import type { IfcDataStore } from '@ifc-lite/parser';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3, type IfcEntityInfo } from '@ifc-lite/data';
import {
  convertEntityType,
  attrNameTable,
  isStrictAttrPrefix,
  shouldSkipEntity,
  type IfcSchemaVersion,
} from './schema-converter.js';
import { BY_NAME_ATTR_REMAP_TYPES } from './schema-converter-attr-remap.js';
import { isRootedEntityType } from './schema-untranslatable.js';

/** How one entity TYPE's data survives a schema conversion. */
export type EntityConversionKind =
  /** Same type, same attribute list: nothing lost. */
  | 'identity'
  /** Different type name (or the same name, source-schema attrs trimmed/padded),
   *  every source attribute has a same-named home in the target. */
  | 'renamed'
  /** Renamed or reconciled, but at least one source attribute has no home in
   *  the target schema's shape for this type — see `droppedAttributes`. */
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
   *  type. Populated for `lossy`, `proxied` (every attribute) and `blocked`
   *  (every attribute — the record cannot be written at all). */
  droppedAttributes: readonly string[];
}

const ENTITY_TABLES: Record<Exclude<IfcSchemaVersion, 'IFC5'>, readonly IfcEntityInfo[]> = {
  IFC2X3: ENTITIES_IFC2X3,
  IFC4: ENTITIES_IFC4,
  IFC4X3: ENTITIES_IFC4X3,
};

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
  if (shouldSkipEntity(newType, toSchema)) {
    return { targetType: 'IFCPROXY', kind: 'proxied', droppedAttributes: [] };
  }

  const targetTable = attrNameTable(toSchema);
  const srcAttrs = attrNameTable(fromSchema)?.get(upper);
  const tgtAttrs = targetTable?.get(newType);

  if (srcAttrs && targetTable && !tgtAttrs) {
    return isRootedEntityType(upper)
      ? { targetType: 'IFCPROXY', kind: 'proxied', droppedAttributes: srcAttrs }
      : { targetType: newType, kind: 'blocked', droppedAttributes: srcAttrs };
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

  if (isStrictAttrPrefix(tgtAttrs, srcAttrs)) {
    const dropped = srcAttrs.slice(tgtAttrs.length);
    return {
      targetType: newType,
      kind: dropped.length > 0 ? 'lossy' : upper === newType ? 'identity' : 'renamed',
      droppedAttributes: dropped,
    };
  }
  if (isStrictAttrPrefix(srcAttrs, tgtAttrs)) {
    return { targetType: newType, kind: upper === newType ? 'identity' : 'renamed', droppedAttributes: [] };
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
}

export interface ConversionLossReport {
  fromSchema: IfcSchemaVersion;
  toSchema: IfcSchemaVersion;
  /** Every non-identity, non-plain-`renamed` entry: `lossy`, `proxied` and
   *  `blocked` types the store actually contains at least one instance of. */
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
        `become generic IFCPROXY placeholders, losing their own type and every attribute${attrs}.`
      );
    case 'lossy':
    default:
      return `${entry.count} × ${entry.sourceType} → ${entry.targetType} (${ids}${more})${attrs}.`;
  }
}

/**
 * A complete, per-type loss report for converting every entity `store`
 * contains from `fromSchema` to `toSchema` — no export attempted, so this
 * never throws and always covers the whole file, not just the first record a
 * full export would have aborted on.
 */
export function analyzeConversionLoss(
  store: Pick<IfcDataStore, 'entityIndex'>,
  fromSchema: IfcSchemaVersion,
  toSchema: IfcSchemaVersion,
): ConversionLossReport {
  const entries: ConversionLossEntry[] = [];
  if (fromSchema !== toSchema && ENTITY_TABLES[fromSchema as Exclude<IfcSchemaVersion, 'IFC5'>]) {
    for (const [sourceType, expressIds] of store.entityIndex.byType) {
      if (expressIds.length === 0) continue;
      const info = classifyEntityTypeConversion(sourceType, fromSchema, toSchema);
      if (info.kind === 'identity' || info.kind === 'renamed') continue;
      entries.push({ ...info, sourceType: sourceType.toUpperCase(), count: expressIds.length, expressIds });
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
    describe: () => entries.map(describeEntry),
  };
}
