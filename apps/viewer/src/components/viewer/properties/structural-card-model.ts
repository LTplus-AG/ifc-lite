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

import { getSchemaRegistryForVersion, measureUnit, type SchemaRegistry, type StructuralExtraction } from '@ifc-lite/parser';
import { structuralRecord } from './selectedStructuralMember';

/** A row value. References are model-local express ids; links between rooted records are GlobalIds. */
export type StructuralCardValue =
  | string | number | boolean
  | readonly number[] | readonly (readonly number[])[]
  | { readonly ref: number } | { readonly refs: readonly number[] }
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
};
/** The only `ConnectionConstraint` subtype the read model carries, and it has no `type` field. */
const ECCENTRICITY = 'IfcConnectionPointEccentricity';

interface SchemaAttribute { name: string; type: string }

/** The element type of an aggregate attribute (`IfcLengthMeasure[]` -> `IfcLengthMeasure`). */
const elementType = (type: string) => type.replace(/(\[\])+$/, '');

function registryFor(schema: string | undefined): SchemaRegistry | null {
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

const isRecord = (v: unknown): v is Record<string, unknown> & { expressId: number } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { expressId?: unknown }).expressId === 'number';

/** A resource's attributes as the read model holds them: its name, components and configuration. */
function resourceFields(info: Record<string, unknown>): Record<string, unknown> {
  const { components, configuration, ...rest } = info as { components?: Record<string, unknown>; configuration?: StructuralLoadConfiguration };
  const fields: Record<string, unknown> = { ...rest, ...components };
  if (configuration) {
    fields.Values = { refs: configuration.entries.flatMap((entry) => (entry.value ? [entry.value.expressId] : [])) };
    if (configuration.locations) fields.Locations = configuration.entries.map((entry) => entry.location ?? []);
    configuration.entries.forEach((entry, i) => { if (entry.value) fields[`Values[${i}]`] = entry.value; });
  }
  return fields;
}
type StructuralLoadConfiguration = { entries: { value?: { expressId: number }; location?: number[] }[]; locations?: number[][] };

class SectionWriter {
  readonly sections: StructuralCardSection[] = [];
  constructor(private readonly registry: SchemaRegistry | null) {}

  write(type: string, info: Record<string, unknown> & { expressId: number }, via: string | null, depth: number): void {
    const fields = 'components' in info || 'configuration' in info ? resourceFields(info) : info;
    const attributes = this.registry?.entities[type]?.allAttributes as SchemaAttribute[] | undefined;
    const position = (name: string) => attributes?.findIndex((a) => a.name === name) ?? -1;
    const rows: (StructuralCardRow & { at: number })[] = [];
    const children: [string, Record<string, unknown> & { expressId: number }][] = [];
    for (const [key, raw] of Object.entries(fields)) {
      if (raw === undefined || raw === null || NOT_ATTRIBUTES.has(key)) continue;
      const attribute = RENAMED[key] ?? key[0].toUpperCase() + key.slice(1);
      if (Array.isArray(raw) && raw.length > 0 && raw.every(isRecord)) {
        raw.forEach((child, i) => children.push([`${attribute}[${i}]`, child]));
        continue;
      }
      const at = position(attribute);
      // A held record is a section of its own, and a reference row when the attribute is the record's.
      if (isRecord(raw)) children.push([attribute, raw]);
      if (attributes && at === -1) continue;
      rows.push({ attribute, at, ...(isRecord(raw) ? { value: { ref: raw.expressId } } : this.cell(key, raw, attributes?.[at]?.type)) });
    }
    rows.sort((a, b) => a.at - b.at);
    this.sections.push({ expressId: info.expressId, type, via, depth, rows: rows.map(({ at: _at, ...row }) => row) });
    for (const [childVia, child] of children) {
      const childType = typeof child.type === 'string' ? child.type
        : childVia === 'ConnectionConstraint' ? ECCENTRICITY
          : child.ConnectionConstraint !== undefined ? 'IfcRelConnectsWithEccentricity' : 'IfcRelConnectsStructuralMember';
      this.write(childType, child, childVia, depth + 1);
    }
  }

  private cell(key: string, raw: unknown, declared: string | undefined): Omit<StructuralCardRow, 'attribute'> {
    if (key.endsWith('GlobalIds')) return { value: { globalIds: raw as string[] } };
    if (key.endsWith('GlobalId')) return { value: { globalId: raw as string } };
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { value: raw as StructuralCardValue };
    const type = declared && elementType(declared);
    if (type && this.registry && isReference(this.registry, type)) {
      return { value: Array.isArray(raw) ? { refs: raw as number[] } : { ref: raw as number } };
    }
    const measure = type && this.registry ? measureOf(this.registry, type) : undefined;
    return { value: raw as StructuralCardValue, ...(measure ? { measure } : {}) };
  }
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
  const writer = new SectionWriter(registryFor(schema));
  writer.write(found.type, found.info as unknown as Record<string, unknown> & { expressId: number }, null, 0);
  return writer.sections;
}
