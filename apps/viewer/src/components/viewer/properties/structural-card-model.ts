/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the structural properties card shows for one selection, as plain data:
 * the selected structural record and every resource it holds (applied load,
 * load configuration entries, boundary and connection conditions, member-end
 * relationships and their eccentricity), one section each, depth first.
 *
 * Rows come from the read model (`extractStructuralOnDemand`), never from the
 * file: a field the read model does not carry is not shown. Each row is keyed
 * by its EXPRESS attribute name, ordered and filtered by the model's schema, so
 * a read-model bookkeeping field or another schema's spelling of an attribute
 * (`Axis` vs `AxisDirection`) never appears. A read-model field added later is
 * shown without a change here, as long as it follows the read model's naming
 * (the EXPRESS name, or its camelCase).
 *
 * The structural coverage harness calls this module from source
 * (`tests/structural-coverage/probes/card.mjs`), so it must stay free of React
 * and of viewer path aliases.
 */

import { getSchemaRegistryForVersion, measureUnit, type SchemaRegistry, type StructuralExtraction, type StructuralLoadConfigurationInfo } from '@ifc-lite/parser';
import { structuralRecord } from './selectedStructuralMember';

/** A row value. References are model-local express ids; links between rooted records are GlobalIds. */
export type StructuralCardValue =
  | string | number | boolean
  | readonly number[] | readonly (readonly number[])[]
  | { readonly ref: number } | { readonly refs: readonly (number | { readonly dropped: string })[] }
  | { readonly globalId: string } | { readonly globalIds: readonly string[] };

export interface StructuralCardRow {
  /** EXPRESS attribute name. */
  attribute: string;
  value: StructuralCardValue;
  /** The attribute's EXPRESS measure type (`IfcForceMeasure`), for its unit. */
  measure?: string;
}

export interface StructuralCardSection {
  expressId: number;
  /** EXPRESS entity name. */
  type: string;
  /** The parent's attribute that holds this record (`AppliedLoad`, `Values[1]`); null for the selection. */
  via: string | null;
  depth: number;
  rows: StructuralCardRow[];
}

/** Read-model fields that are not attributes of the record: identity, bookkeeping and cross-links. */
const NOT_ATTRIBUTES = new Set([
  'expressId', 'globalId', 'type', 'kind', 'description', 'objectType', 'physicalElementIds',
  'connectionGlobalIds', 'activityGlobalIds', 'memberGlobalIds', 'analysisModelGlobalIds', 'itemGlobalIds',
  'groupGlobalIds', 'appliesToGlobalId',
]);
/** Read-model fields named for what they resolve to rather than for their attribute. */
const RENAMED: Record<string, string> = {
  loadGroupGlobalIds: 'LoadedBy',
  resultGroupGlobalIds: 'HasResults',
  resultForLoadGroupGlobalId: 'ResultForLoadGroup',
  // A member's ends: the inverse IfcStructuralMember.ConnectedBy.
  IfcRelConnectsStructuralMember: 'ConnectedBy',
};
/**
 * The EXPRESS type of a held record the read model gives no `type` field, by the
 * field that holds it: a member end is an `IfcRelConnectsWithEccentricity` when
 * it carries a constraint, and the only constraint read is an eccentricity.
 */
const UNTYPED_CHILD: Record<string, (child: Record<string, unknown>) => string> = {
  ConnectedBy: (child) => (child.ConnectionConstraint !== undefined ? 'IfcRelConnectsWithEccentricity' : 'IfcRelConnectsStructuralMember'),
  ConnectionConstraint: () => 'IfcConnectionPointEccentricity',
};

/** The registry for a store's schema; IFC5 reads with IFC4X3's, as `effectiveMetadataRecord` does. */
function registryFor(schema: string | undefined): SchemaRegistry | null {
  if (schema === 'IFC5') return getSchemaRegistryForVersion('IFC4X3');
  return schema === 'IFC2X3' || schema === 'IFC4' || schema === 'IFC4X3' ? getSchemaRegistryForVersion(schema) : null;
}

/** True when the EXPRESS type is an entity, or a select of entities only. */
function isReference(registry: SchemaRegistry, type: string, seen = new Set<string>()): boolean {
  if (registry.entities[type]) return true;
  const members = registry.selects[type];
  if (!members?.length || seen.has(type)) return false;
  seen.add(type);
  return members.every((member) => isReference(registry, member, seen));
}

/** The measure an attribute's value is in: the type itself, or a select's one measure with a unit. */
function measureOf(registry: SchemaRegistry, type: string): string | undefined {
  const hasUnit = (t: string) => { const unit = measureUnit(t); return !!unit && unit.kind !== 'dimensionless'; };
  const members = registry.selects[type];
  if (!members) return hasUnit(type) ? type : undefined;
  const measures = members.filter(hasUnit);
  return measures.length === 1 ? measures[0] : undefined;
}

type HeldRecord = Record<string, unknown> & { expressId: number };
const isRecord = (v: unknown): v is HeldRecord =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { expressId?: unknown }).expressId === 'number';

/**
 * A record's attribute fields and the records it holds (`[attribute, record]`).
 * A resource (load, condition) keeps its values in `components`; a load
 * configuration's `Values` keep one item per slot and `Locations` is the
 * file's own list, so the two pair by index.
 */
function fieldsOf(info: HeldRecord): { fields: Record<string, unknown>; held: [string, HeldRecord][] } {
  const { components, configuration, ...rest } = info as HeldRecord & { components?: Record<string, unknown>; configuration?: StructuralLoadConfigurationInfo };
  const fields: Record<string, unknown> = { ...rest, ...components };
  const held: [string, HeldRecord][] = [];
  if (configuration) {
    // One Values item per slot, a dropped one included, so Values[i] still pairs with Locations[i].
    fields.Values = { refs: configuration.entries.map((entry) => entry.value?.expressId ?? { dropped: entry.dropped ?? 'unreadable' }) };
    if (configuration.locations) fields.Locations = configuration.locations;
    configuration.entries.forEach((entry, i) => { if (entry.value) held.push([`Values[${i}]`, entry.value as unknown as HeldRecord]); });
  }
  for (const [key, raw] of Object.entries(fields)) {
    if (isRecord(raw)) held.push([attributeOf(key), raw]);
    else if (Array.isArray(raw) && raw.every(isRecord)) raw.forEach((child, i) => held.push([`${attributeOf(key)}[${i}]`, child]));
  }
  return { fields, held };
}

const attributeOf = (key: string) => RENAMED[key] ?? key[0].toUpperCase() + key.slice(1);

/** One row's value and measure, from the declared EXPRESS type of its attribute. */
function cell(registry: SchemaRegistry | null, key: string, raw: unknown, declared: string | undefined): Omit<StructuralCardRow, 'attribute'> {
  if (isRecord(raw)) return { value: { ref: raw.expressId } };
  if (key.endsWith('GlobalIds')) return { value: { globalIds: raw as string[] } };
  if (key.endsWith('GlobalId')) return { value: { globalId: raw as string } };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { value: raw as StructuralCardValue };
  // An aggregate attribute is declared as its element type with `[]` per level.
  const type = declared?.replace(/(\[\])+$/, '');
  if (type && registry && isReference(registry, type)) {
    return { value: Array.isArray(raw) ? { refs: raw as number[] } : { ref: raw as number } };
  }
  const measure = type && registry ? measureOf(registry, type) : undefined;
  return { value: raw as StructuralCardValue, ...(measure ? { measure } : {}) };
}

/**
 * The card's sections for a selection, the selected record first; empty when
 * the selection is no structural record of the read model. `schema` is the
 * store's `schemaVersion`; an unknown schema shows every field unfiltered.
 */
export function structuralCardSections(data: StructuralExtraction, selection: { expressId: number | null; globalId?: string | null },
  schema: string | undefined): StructuralCardSection[] {
  const found = structuralRecord(data, selection.expressId, selection.globalId);
  if (!found) return [];
  const registry = registryFor(schema);
  const sections: StructuralCardSection[] = [];
  const write = (type: string, info: HeldRecord, via: string | null, depth: number) => {
    const { fields, held } = fieldsOf(info);
    const attributes = registry?.entities[type]?.allAttributes;
    const position = (name: string) => attributes?.findIndex((a) => a.name === name) ?? -1;
    const rows: StructuralCardRow[] = [];
    for (const [key, raw] of Object.entries(fields)) {
      // An empty list is an unset optional aggregate (`$`), not a value.
      if (raw === undefined || raw === null || NOT_ATTRIBUTES.has(key) || (Array.isArray(raw) && raw.length === 0)) continue;
      if (Array.isArray(raw) && raw.every(isRecord)) continue;
      // A plain object the card has no form for (only held records and Values refs have one) is not shown.
      if (typeof raw === 'object' && !Array.isArray(raw) && !isRecord(raw) && !('refs' in raw)) continue;
      const attribute = attributeOf(key);
      const at = position(attribute);
      if (attributes && at === -1) continue;
      rows.push({ attribute, ...cell(registry, key, raw, attributes?.[at]?.type) });
    }
    rows.sort((a, b) => position(a.attribute) - position(b.attribute));
    sections.push({ expressId: info.expressId, type, via, depth, rows });
    for (const [childVia, child] of held) {
      const field = childVia.replace(/\[\d+\]$/, '');
      const childType = typeof child.type === 'string' ? child.type : UNTYPED_CHILD[field]?.(child);
      if (childType) write(childType, child, childVia, depth + 1);
    }
  };
  write(found.type, found.info as unknown as HeldRecord, null, 0);
  return sections;
}
