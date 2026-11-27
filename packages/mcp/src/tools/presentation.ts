/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto';
import {
  A2UI_MIME_TYPE, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, QUERY_OPERATORS,
  buildSurface, encodeRef, normalizeQuery, parseFieldPath,
  type ColumnSpec, type RowSpec, type SectionSpec,
} from '@ifc-lite/a2ui';
import { A2UI_APP_URI, DEFAULT_HIGHLIGHT_COLOR, SURFACE_ACTIONS } from '../apps/a2ui/constants.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { CallToolResult, JsonSchema } from '../protocol/index.js';
import { clashCheck } from './clash.js';
import { computePresentationQuery } from './presentation-query.js';
import type { Tool } from './types.js';
import { resolveModel } from './util.js';
import { idsValidate } from './validation.js';

const metadata: Tool['_meta'] = { ui: { resourceUri: A2UI_APP_URI, visibility: ['model', 'app'] } };
const string = { type: 'string', minLength: 1, maxLength: 256 };
const title = { ...string, description: 'Optional display heading.' };

function invalid(message: string): never {
  throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message });
}

async function surfaceResult(summary: string, title: string, sections: SectionSpec[]): Promise<CallToolResult> {
  const surfaceId = randomUUID();
  const messages = buildSurface({ surfaceId, title, sections });
  const { validateIfcMessages } = await import('@ifc-lite/a2ui/agent');
  const errors = validateIfcMessages(messages);
  if (errors.length) throw new Error(errors.join('\n'));
  return { content: [
    { type: 'text', text: summary },
    { type: 'resource', resource: {
      uri: `ifc-lite://a2ui/result/${surfaceId}`,
      mimeType: A2UI_MIME_TYPE,
      text: JSON.stringify(messages),
    } },
  ] };
}

function actions(refs: string[]): SectionSpec {
  return { kind: 'actions', actions: refs.length ? [...SURFACE_ACTIONS] : [], refs: [...new Set(refs)], color: DEFAULT_HIGHLIGHT_COLOR };
}

const querySchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    types: { type: 'array', maxItems: 100, items: string },
    modelId: string,
    storey: string,
    limit: { type: 'integer', minimum: 1, maximum: MAX_QUERY_LIMIT, default: DEFAULT_QUERY_LIMIT },
    where: { type: 'array', maxItems: 32, items: {
      type: 'object', required: ['path', 'op'], additionalProperties: false,
      properties: { path: string, op: { type: 'string', enum: QUERY_OPERATORS }, value: { type: ['string', 'number', 'boolean'] } },
    } },
  },
};

const presentQuery: Tool = {
  name: 'present_query',
  description: 'Query a loaded IFC model and present matching entities as an interactive table, count, and optional grouped chart.',
  scope: 'read', _meta: metadata,
  inputSchema: {
    type: 'object', required: ['query', 'columns'], additionalProperties: false,
    properties: {
      modelId: string, query: querySchema, groupBy: string, title,
      columns: { type: 'array', minItems: 1, maxItems: 20, items: {
        type: 'object', required: ['path'], additionalProperties: false,
        properties: { path: string, label: string },
      } },
    },
  },
  handler(input, ctx) {
    const { spec, problems } = normalizeQuery(input.query);
    if (problems.length) invalid(problems.map(({ path, message }) => `${path}: ${message}`).join('; '));
    if (input.modelId !== undefined && spec.modelId !== undefined && input.modelId !== spec.modelId) invalid('modelId and query.modelId must agree.');
    const model = resolveModel(ctx, input.modelId as string | undefined ?? spec.modelId);
    const columns = input.columns as ColumnSpec[];
    const groupBy = input.groupBy as string | undefined;
    for (const path of [...columns.map((c) => c.path), ...(groupBy ? [groupBy] : [])]) {
      if (!parseFieldPath(path) || ['ref', 'refs', '__proto__', 'constructor', 'prototype'].includes(path)) invalid(`Invalid field path: ${path}`);
    }
    const { rows, groups, total } = computePresentationQuery(model, spec, columns, groupBy, spec.limit ?? DEFAULT_QUERY_LIMIT, ctx.signal);
    const summary = `${total} matching entities.${rows.length < total ? ` Showing ${rows.length}.` : ''}`;
    return surfaceResult(summary, input.title as string ?? 'IFC query results', [
      { kind: 'stats', items: [{ label: 'Matches', value: total }, { label: 'Shown', value: rows.length }] },
      { kind: 'table', columns, rows },
      ...(groupBy ? [{ kind: 'chart', groupBy, data: groups, title: `Shown rows by ${groupBy}` } as const] : []),
      actions(rows.flatMap(({ ref }) => ref ? [ref] : [])),
    ]);
  },
};

function withTitle(tool: Tool): JsonSchema {
  return { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, title } };
}

const presentIds: Tool = {
  name: 'present_ids_results',
  description: 'Run IDS validation on a loaded IFC model and present the failures and specification counts.',
  scope: idsValidate.scope, _meta: metadata, inputSchema: withTitle(idsValidate),
  async handler({ title, ...input }, ctx) {
    const { summary, report } = (await idsValidate.handler(input, ctx)).structuredContent;
    const rows: RowSpec[] = [];
    for (const spec of report.specificationResults) {
      if (spec.status !== 'fail') continue;
      if (spec.error || spec.cardinalityResult?.passed === false) {
        rows.push({ specification: spec.specification.name, finding: spec.error ?? spec.cardinalityResult?.message ?? 'Cardinality requirement failed.' });
      }
      for (const entity of spec.entityResults) {
        if (!entity.passed && rows.length < DEFAULT_QUERY_LIMIT) rows.push({
          ref: encodeRef(entity),
          Name: entity.entityName ?? '',
          type: entity.entityType,
          specification: spec.specification.name,
          finding: entity.requirementResults.filter((r) => r.status === 'fail').map((r) => r.failureReason).filter(Boolean).join('; '),
        });
      }
      if (rows.length >= DEFAULT_QUERY_LIMIT) break;
    }
    return surfaceResult(`IDS: ${summary.passedSpecifications}/${summary.totalSpecifications} specifications passed; ${summary.failedEntities} entity failures.${rows.length >= DEFAULT_QUERY_LIMIT ? ` Showing up to ${DEFAULT_QUERY_LIMIT} findings.` : ''}`, title as string ?? 'IDS validation results', [
      { kind: 'stats', items: [{ label: 'Passed specifications', value: summary.passedSpecifications }, { label: 'Failed specifications', value: summary.failedSpecifications }, { label: 'Entity failures', value: summary.failedEntities }] },
      { kind: 'table', columns: [{ path: 'specification', label: 'Specification' }, { path: 'Name' }, { path: 'type', label: 'IFC class' }, { path: 'finding', label: 'Finding' }], rows },
      actions(rows.flatMap(({ ref }) => ref ? [ref] : [])),
    ]);
  },
};

const presentClash: Tool = {
  name: 'present_clash_results',
  description: 'Run clash checking on a loaded IFC model and present interactive rows for the top clashes.',
  scope: clashCheck.scope, _meta: metadata, inputSchema: withTitle(clashCheck),
  async handler({ title, ...input }, ctx) {
    const modelId = resolveModel(ctx, input.model_id as string | undefined).id;
    const result = await clashCheck.handler({ ...input, model_id: modelId }, ctx);
    const { summary, clashes, truncated } = result.structuredContent;
    const ref = (side: { ref: number }) => encodeRef({ modelId, expressId: side.ref });
    const rows = clashes.map(({ a, b, severity, distance, distanceKind }) => ({
      refs: [ref(a), ref(b)],
      a: a.name || ref(a),
      b: b.name || ref(b),
      severity, distance, distanceKind,
    }));
    const label = truncated ? 'Clashes found before engine limit' : 'Clashes';
    const fallback = result.content.find((c) => c.type === 'text')?.text ?? `${summary.total} clashes.`;
    return surfaceResult(fallback, title as string ?? 'Clash results', [
      { kind: 'stats', items: [{ label, value: summary.total }, { label: 'Shown', value: rows.length }] },
      { kind: 'table', columns: [{ path: 'a', label: 'Entity A' }, { path: 'b', label: 'Entity B' }, { path: 'severity', label: 'Severity' }, { path: 'distance', label: 'Distance (m)' }, { path: 'distanceKind', label: 'Distance kind' }], rows },
      actions(rows.flatMap((row) => row.refs)),
    ]);
  },
};

export const presentationTools = [presentQuery, presentIds, presentClash];
