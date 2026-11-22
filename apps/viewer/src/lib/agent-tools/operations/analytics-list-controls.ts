/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { canonicalJson } from '@ifc-lite/flow';
import type { ListDefinition } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import { entityExists } from '../refs';
import { columnFromDraft, updateColumnInPlace, isEditableColumn, columnDefKey, draftDefKey } from '@/lib/lists/column-edit';
import { presentListRows, activeListRowChannel, releaseListVisibility } from '@/lib/lists/list-visibility';
import { viewerOperation, emptySchema } from './contract';
import { metadata, checkpoint, idSchema } from './analytics-common';
import { internal, invalidInput, parseJsonInput, stale } from './refusals';
const output = { type: 'object', properties: { applied: { type: 'boolean' } }, required: ['applied'], additionalProperties: false };
export const analyticsListControlOperations = [
  viewerOperation<{ id: string; column_id: string; expected_json: string; source: 'property' | 'quantity'; set_name: string; property_name: string }>(metadata('lists.editColumn', 'lists', 'Use the native pencil-editor column-definition transformation, preserving column ID/order and custom labels; reject duplicates and stale complete definitions. This edits query configuration, never IFC values.', ['configuration'], output), {
    type: 'object', properties: { id: idSchema.properties.id, column_id: idSchema.properties.id, expected_json: { type: 'string', minLength: 2, maxLength: 500000 }, source: { type: 'string', enum: ['property', 'quantity'] }, set_name: { type: 'string', maxLength: 10000 }, property_name: { type: 'string', minLength: 1, maxLength: 10000 } }, required: ['id', 'column_id', 'expected_json', 'source', 'set_name', 'property_name'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; column_id: string; expected_json: string; source: 'property' | 'quantity'; set_name: string; property_name: string }>, (i, c) => {
    const s = useViewerStore.getState(); const list = s.listDefinitions.find(row => row.id === i.id);
    if (!list) throw invalidInput('unknown-target', 'Unknown saved list.');
    const expected = parseJsonInput(i.expected_json, 'expected_json') as Partial<ListDefinition> | null;
    const column = list.columns.find(row => row.id === i.column_id);
    const reviewedColumn = !column && expected?.id === list.id && Array.isArray(expected.columns)
      && expected.columns.some(row => row?.id === i.column_id);
    if (!column && !reviewedColumn) throw invalidInput('unknown-target', 'Unknown list column.');
    if (!column || canonicalJson(list) !== canonicalJson(expected)) throw stale('List definition changed since inspection.');
    if (!isEditableColumn(column)) throw invalidInput('invalid-value', 'The native pencil editor supports property/quantity columns only.');
    const draft = { source: i.source, setName: i.set_name, propName: i.property_name };
    if (!draft.propName.trim() || list.columns.some(row => row.id !== column.id && columnDefKey(row) === draftDefKey(draft))) throw invalidInput('invalid-value', 'Empty or duplicate native column definition.');
    const next = { ...list, columns: updateColumnInPlace(list.columns, column.id, columnFromDraft(draft, column.id, column)), updatedAt: Date.now() };
    checkpoint(c); if (!c.commit(() => s.setListDefinitions(s.listDefinitions.map(row => row.id === i.id ? next : row)))) throw internal(useViewerStore.getState().listError ?? 'Native list persistence failed.');
    return { applied: true };
  }),
  viewerOperation<{ key: string; members: { model_id: string; express_id: number }[]; channel: 'isolate' | 'ghost' }>(metadata('lists.presentMembers', 'lists', 'Run the native group/row Isolate or X-ray toggle on explicit model-qualified members from lists.run, including federated groups. Resolves assembly parts and records native channel ownership.', ['selection', 'view'], { type: 'object', properties: { channel: { type: ['string', 'null'], enum: ['isolate', 'ghost', null] } }, required: ['channel'], additionalProperties: false }), {
    type: 'object', properties: { key: { type: 'string', minLength: 1, maxLength: 10000 }, members: { type: 'array', minItems: 1, maxItems: 100000, items: { type: 'object', properties: { model_id: idSchema.properties.id, express_id: { type: 'integer', minimum: 1 } }, required: ['model_id', 'express_id'], additionalProperties: false } }, channel: { type: 'string', enum: ['isolate', 'ghost'] } }, required: ['key', 'members', 'channel'], additionalProperties: false,
  } satisfies JSONSchemaType<{ key: string; members: { model_id: string; express_id: number }[]; channel: 'isolate' | 'ghost' }>, (i, c) => {
    const models = c.host.models();
    for (const member of i.members) { const model = models.find(row => row.id === member.model_id); if (!model?.store || !entityExists({ ...model, store: model.store }, member.express_id)) throw invalidInput('unknown-target', 'Unknown member in the exact target model.'); }
    checkpoint(c); c.commit(() => presentListRows(i.key, i.members.map(row => ({ entityId: row.express_id, modelId: row.model_id, values: [] })), i.channel)); return { channel: activeListRowChannel(i.key) };
  }),
  viewerOperation(metadata('lists.releaseVisibility', 'lists', 'Release only the visibility channel still owned by the native list group action.', ['view'], output), emptySchema, (_, c) => { checkpoint(c); c.commit(releaseListVisibility); return { applied: true }; }),
];
