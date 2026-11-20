/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { boundedPage, pageInput, pageOutputProperties, type PageInput } from './result-limit';
import { stateRevision } from './state-revision';
import { executeNativeList } from '@/lib/lists/execute-native-list';
import { parseListDefinitionFile } from '@/lib/lists/persistence';
import { decodeSavedList } from '@/lib/lists/saved-list-codec';
import { prepareListProviders } from '@/lib/lists/prepare-providers';
import { resolveRenderFrame } from '@/hooks/useRenderFrameOffsets';
import { buildExportModel, createListArtifact } from '@/lib/lists/export';
import { detectNumericColumns } from '@/components/viewer/lists/list-table-utils';
import { operation, viewerOperation, emptySchema } from './contract';
import { matchesJsonSnapshot, metadata, idSchema, jsonSchema, artifactSchema, removedSchema, checkpoint } from './analytics-common';

function savedDefinition(id: string) {
  const value = useViewerStore.getState().listDefinitions.find(row => row.id === id);
  if (!value) throw new Error('Unknown saved list.');
  return value;
}
function definition(id: string) { return structuredClone(savedDefinition(id)); }
const resultSchema = { type: 'object', properties: { columns: { type: 'array' }, rows: { type: 'array' }, totalCount: { type: 'integer' }, executionTime: { type: 'number' }, ...pageOutputProperties, groups: { type: 'array', nullable: true }, summary: { type: 'object', nullable: true } }, required: ['columns', 'rows', 'totalCount', 'executionTime', 'next_offset', 'page_revision'] };
export const analyticsListOperations = [
  viewerOperation(metadata('lists.library', 'lists', 'Read persisted definitions, active result state and native save errors.', ['read'], {
    type: 'object', properties: { definitions: { type: 'array' }, activeId: { type: ['string', 'null'] }, executing: { type: 'boolean' }, error: { type: ['string', 'null'] } }, required: ['definitions', 'activeId', 'executing', 'error'], additionalProperties: false,
  }), emptySchema, () => { const s = useViewerStore.getState(); return { definitions: s.listDefinitions, activeId: s.activeListId, executing: s.listExecuting, error: s.listError }; }),
  viewerOperation<{ content_json: string }>(metadata('lists.import', 'lists', 'Import a full native saved-list JSON definition, including columns, grouping and Rules filters. Uses the native decoder and persistence failure reporting.', ['configuration'], {
    type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false,
  }), jsonSchema, (i, c) => {
    const value = parseListDefinitionFile(i.content_json); checkpoint(c);
    const s = useViewerStore.getState();
    const rows = s.listDefinitions.filter(row => row.id !== value.id);
    const saved = c.commit(() => s.setListDefinitions([...rows, value]));
    if (!saved) throw new Error(useViewerStore.getState().listError ?? 'List persistence failed.');
    return { id: value.id };
  }),
  viewerOperation<{ id: string; expected_json: string; content_json: string }>(metadata('lists.replace', 'lists', 'Edit all native query/column/grouping/filter settings with an expected complete definition conflict check. The native saved-list codec and persistence remain authoritative.', ['configuration'], {
    type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false,
  }), {
    type: 'object', properties: { id: idSchema.properties.id, expected_json: jsonSchema.properties.content_json, content_json: jsonSchema.properties.content_json }, required: ['id', 'expected_json', 'content_json'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_json: string; content_json: string }>, (i, c) => {
    const current = definition(i.id); if (!matchesJsonSnapshot(current, i.expected_json)) throw new Error('List definition changed since inspection.');
    const value = decodeSavedList(JSON.parse(i.content_json)); if (value.id !== i.id) throw new Error('Changing the list ID is not allowed.');
    checkpoint(c); const s = useViewerStore.getState();
    if (!c.commit(() => s.setListDefinitions(s.listDefinitions.map(row => row.id === i.id ? value : row)))) throw new Error(useViewerStore.getState().listError ?? 'Native list persistence failed.');
    return { id: i.id };
  }),
  viewerOperation<{ id: string }>(metadata('lists.delete', 'lists', 'Delete one saved definition through the native persistence path.', ['configuration'], removedSchema), idSchema, (i, c) => {
    definition(i.id); const s = useViewerStore.getState(); checkpoint(c);
    if (!c.commit(() => s.setListDefinitions(s.listDefinitions.filter(row => row.id !== i.id)))) throw new Error(useViewerStore.getState().listError ?? 'List persistence failed.');
    return { removed: i.id };
  }),
  operation<PageInput & { id: string; offset: number; limit: number }>(metadata('lists.run', 'lists', 'Await a saved native federated list query with provenance; publish completed rows to the panel and return a bounded page. Cancels before publishing. Pass next_offset and page_revision to continue.', ['read', 'configuration'], resultSchema), {
    type: 'object', properties: { id: idSchema.properties.id, ...pageInput.properties, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['id', 'offset', 'limit'], additionalProperties: false,
  } satisfies JSONSchemaType<PageInput & { id: string; offset: number; limit: number }>, async (i, c) => {
    const original = savedDefinition(i.id);
    const value = structuredClone(original);
    const result = await executeNativeList(value, c); checkpoint(c);
    const { columns, totalCount, executionTime, groups, summary } = result;
    const header = { columns, totalCount, executionTime, groups: groups?.slice(0, i.limit), group_count: groups?.length ?? 0, summary };
    const { items: rows, total: _total, offset: _offset, ...page } = boundedPage(result.rows, i, header,
      stateRevision([columns, result.rows, groups, summary]));
    c.commit(() => {
      const s = useViewerStore.getState();
      if (s.listDefinitions.find(row => row.id === value.id) !== original) throw new Error('List definition changed during evaluation.');
      s.setActiveListId(value.id);
      s.setListResult(result);
      s.setListError(null);
    });
    return { ...header, ...page, rows };
  }),
  operation<{ id: string; format: 'csv' | 'xlsx' | 'pdf' }>(metadata('lists.export', 'lists', 'Await a fresh native list run and real CSV/Excel/PDF writer. Return an artifact handle; never fabricate rows or report a dispatched download as complete.', ['read', 'artifact'], artifactSchema), {
    type: 'object', properties: { id: idSchema.properties.id, format: { type: 'string', enum: ['csv', 'xlsx', 'pdf'] } }, required: ['id', 'format'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; format: 'csv' | 'xlsx' | 'pdf' }>, async (i, c) => {
    const value = definition(i.id); const result = await executeNativeList(value, c); checkpoint(c);
    const s = useViewerStore.getState(); const { modelUnits } = prepareListProviders(s, resolveRenderFrame(s.models, s.geometryResult));
    const model = buildExportModel({ title: value.name, columns: result.columns, rows: result.rows, grouping: value.grouping,
      numericCols: detectNumericColumns(result.columns, result.rows), columnWidths: [], generatedAt: new Date().toLocaleString(), modelUnits, unitDisplayOverrides: s.unitDisplayOverrides });
    const artifact = await createListArtifact(i.format, model); checkpoint(c);
    return c.artifacts.create({ filename: artifact.filename, mimeType: artifact.blob.type, data: artifact.blob });
  }),
];
