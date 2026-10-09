/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `list.proposal`: a Lists `ListDefinition` (classes, Rules groups, columns,
 * optional grouping and sums) without the identity and timestamps the library
 * assigns on save. Columns use the Lists column contract verbatim; unit kinds
 * (`quantityType` / `dataType`) are execution-time annotations the engine
 * derives, so a proposal never states them.
 */

import { IfcTypeEnum, IfcTypeEnumFromString } from '@ifc-lite/data';
import { ENTITY_ATTRIBUTES, type ColumnDefinition, type ListDefinition, type ListGrouping } from '@ifc-lite/lists';
import { onlyKeys, parseEnvelope, parseNativeArtifactScope, record, requiredText, text, type ArtifactEnvelope } from './artifact-json';
import { canonicalClasses, knownClassRefusal, parseProposalGroups } from './artifact-rules';
import type { JsonResponseSchema } from '@ifc-lite/ai';
import { profileLiteral, profileObject, profileTitle } from './response-profile-schema';

export type ListDraft = Pick<ListDefinition, 'name' | 'description' | 'entityTypes' | 'groups' | 'columns' | 'sortBy' | 'grouping'>;

export interface ListProposal extends ArtifactEnvelope {
  scope?: import('./artifact-json').NativeArtifactScope;
  kind: 'list.proposal';
  /** The classes as proposed, before subclass expansion; for review text. */
  classes: string[];
  list: ListDraft;
}

export const COLUMN_LIMIT = 30;
const COLUMN_SOURCES = ['attribute', 'property', 'quantity', 'material', 'classification', 'spatial', 'model'] as const;
const SPATIAL_LEVELS = ['Container', 'Storey', 'Building', 'Site', 'Project'];

/** #7234 concrete wall-measurement preset, owned beside its native parser. */
export function wallListResponseProfile(area: { set: string; name: string }, rating: { set: string; name: string }): JsonResponseSchema {
  const column = (id: string, source: 'quantity' | 'property', field: typeof area) => profileObject({
    id: profileLiteral(id), source: profileLiteral(source), psetName: profileLiteral(field.set), propertyName: profileLiteral(field.name),
  });
  return { name: 'assistant_wall_measurement_list', schema: profileObject({
    version: profileLiteral(1), kind: profileLiteral('list.proposal'), title: profileTitle,
    list: profileObject({ name: profileTitle,
      entityTypes: { type: 'array', items: profileLiteral('IfcWall'), minItems: 1, maxItems: 1 },
      columns: { type: 'array', items: { anyOf: [column('area', 'quantity', area), column('fire-rating', 'property', rating)] }, minItems: 2, maxItems: 2 },
    }),
  }) };
}

function parseColumn(value: unknown, index: number, ids: Set<string>): ColumnDefinition {
  const at = `Column ${index + 1}`;
  if (!record(value)) throw new Error(`${at} is not an object`);
  onlyKeys(value, ['id', 'source', 'psetName', 'propertyName', 'label'], at);
  const id = requiredText(value.id, `${at} "id"`, 40);
  if (ids.has(id)) throw new Error(`${at} repeats the column id "${id}"`);
  ids.add(id);
  const source = value.source;
  if (!COLUMN_SOURCES.includes(source as typeof COLUMN_SOURCES[number])) throw new Error(`${at} "source" must be one of ${COLUMN_SOURCES.join(', ')}`);
  if (value.label !== undefined && !text(value.label)) throw new Error(`${at} "label" must be short text`);
  const label = typeof value.label === 'string' ? { label: value.label.trim() } : {};
  switch (source) {
    case 'attribute':
      if (!ENTITY_ATTRIBUTES.includes(value.propertyName as typeof ENTITY_ATTRIBUTES[number])) throw new Error(`${at} attribute must be one of ${ENTITY_ATTRIBUTES.join(', ')}`);
      return { id, source, propertyName: value.propertyName as string, ...label };
    case 'property': case 'quantity':
      return { id, source, psetName: requiredText(value.psetName, `${at} "psetName"`), propertyName: requiredText(value.propertyName, `${at} "propertyName"`), ...label };
    case 'spatial':
      if (!SPATIAL_LEVELS.includes(value.propertyName as string)) throw new Error(`${at} spatial level must be one of ${SPATIAL_LEVELS.join(', ')}`);
      return { id, source, propertyName: value.propertyName as string, ...label };
    default:
      if (value.psetName !== undefined) throw new Error(`${at}: a ${String(source)} column takes no psetName`);
      return { id, source: source as 'material' | 'classification' | 'model', propertyName: '', ...label };
  }
}

function columnRefs(value: unknown, at: string, ids: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error(`${at} must list at most 4 column ids`);
  return value.map((id) => {
    if (typeof id !== 'string' || !ids.has(id)) throw new Error(`${at} refers to ${JSON.stringify(id)}, which is not a column id`);
    return id;
  });
}

function parseGrouping(value: unknown, ids: ReadonlySet<string>): ListGrouping | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error('"grouping" is not an object');
  onlyKeys(value, ['columnIds', 'sumColumnIds', 'view'], 'The grouping');
  const columnIds = columnRefs(value.columnIds, 'The grouping "columnIds"', ids);
  if (columnIds.length === 0) throw new Error('The grouping needs at least one column id');
  const sumColumnIds = value.sumColumnIds === undefined ? [] : columnRefs(value.sumColumnIds, 'The grouping "sumColumnIds"', ids);
  if (value.view !== undefined && value.view !== 'nested' && value.view !== 'schedule') throw new Error('The grouping "view" must be nested or schedule');
  return { columnId: columnIds[0], columnIds, sumColumnIds, ...(value.view ? { view: value.view as 'nested' | 'schedule' } : {}) };
}

export function parseListProposal(answer: string): ListProposal {
  const { value, envelope } = parseEnvelope(answer, 'list.proposal', ['list', 'scope']);
  if (!record(value.list)) throw new Error('A list.proposal needs a "list" object');
  const list = value.list;
  onlyKeys(list, ['name', 'description', 'entityTypes', 'groups', 'columns', 'sortBy', 'grouping'], 'The list');
  const name = requiredText(list.name, 'The list "name"');
  if (list.description !== undefined && !text(list.description, 500)) throw new Error('The list "description" must be text');
  const classes = list.entityTypes === undefined ? [] : list.entityTypes;
  if (!Array.isArray(classes) || classes.length > 20 || classes.some((c) => typeof c !== 'string')) throw new Error('The list "entityTypes" must list at most 20 IFC class names');
  for (const name of classes as string[]) {
    const refusal = knownClassRefusal(name);
    if (refusal) throw new Error(`The list "entityTypes": ${refusal}`);
  }
  // Lists target exact classes; expanding first keeps `IfcWall` reaching `IfcWallStandardCase`.
  const entityTypes = [...new Set(canonicalClasses(classes as string[]).map(IfcTypeEnumFromString).filter((type) => type !== IfcTypeEnum.Unknown))];
  if (classes.length > 0 && entityTypes.length === 0) throw new Error(`Lists cannot target ${(classes as string[]).join(', ')}; use an element class such as IfcWall`);
  if (!Array.isArray(list.columns) || list.columns.length === 0 || list.columns.length > COLUMN_LIMIT) throw new Error(`The list needs 1 to ${COLUMN_LIMIT} columns`);
  const ids = new Set<string>();
  const columns = list.columns.map((column, index) => parseColumn(column, index, ids));
  let sortBy: ListDefinition['sortBy'];
  if (list.sortBy !== undefined) {
    if (!record(list.sortBy) || !ids.has(list.sortBy.columnId as string) || (list.sortBy.direction !== 'asc' && list.sortBy.direction !== 'desc')) {
      throw new Error('The list "sortBy" must be { "columnId": <a column id>, "direction": "asc" | "desc" }');
    }
    sortBy = { columnId: list.sortBy.columnId as string, direction: list.sortBy.direction };
  }
  const grouping = parseGrouping(list.grouping, ids);
  return { ...envelope, scope: parseNativeArtifactScope(value.scope), kind: 'list.proposal', classes: classes as string[], list: {
    name, ...(typeof list.description === 'string' ? { description: list.description } : {}), entityTypes,
    groups: parseProposalGroups(list.groups, 'The list', { allowEmpty: true }), columns,
    ...(sortBy ? { sortBy } : {}), ...(grouping ? { grouping } : {}),
  } };
}

/** The library entry a reviewed draft becomes. */
export function toListDefinition(draft: ListDraft, id: string, now: number): ListDefinition {
  return { ...draft, id, createdAt: now, updatedAt: now };
}
