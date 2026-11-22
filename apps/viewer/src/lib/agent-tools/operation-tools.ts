/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { operationArtifactSpecs, operationArtifactTools } from './operation-artifact-tools';
import { boundedString, integer, invalid, keys, oneOf } from './tool-args';
import { invalidInput } from './operations/refusals';
import type { AgentInputSchema, AgentTool, ToolOutput } from './types';

const executionSchema = { type: 'object', properties: {
  model_id: { type: 'string' }, operation_id: { type: 'string' }, input: { type: 'object' },
  expected_revision: { type: 'integer', minimum: 0 }, idempotency_key: { type: 'string', minLength: 1, maxLength: 200 }, background: { type: 'boolean' },
}, required: ['operation_id'] } satisfies AgentInputSchema;
const COVERAGE_SECTIONS = ['panels', 'tools', 'exports', 'non_panel', 'human_only'] as const;
const MAX_COVERAGE_PAGE = 5;

export const OPERATION_SPECS = {
  ...operationArtifactSpecs,
  viewer_operation_coverage: {
    description: 'Summarize the built-in viewer coverage audit by row, including completeness and gap IDs. Pass section for a page of detailed control bindings and host boundaries, optionally filtered by row_id. Follow next_offset for additional rows. Grouped controls list several operations without assigning each to a specific part of the control.',
    inputSchema: { type: 'object', properties: {
      section: { type: 'string', enum: COVERAGE_SECTIONS },
      row_id: { type: 'string', minLength: 1, maxLength: 200, description: 'Select one row in the requested section.' },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: MAX_COVERAGE_PAGE, default: 3 },
    } } satisfies AgentInputSchema, readOnly: true,
  },
  viewer_operations: {
    description: 'Search native parameterized viewer operations by natural-language task (query: "measure distance", "color walls", "screenshot"); results are ranked best first. operation_id describes one operation with its exact input/output schema. Workflow: model_list (model ids) → query_entities (express ids) → viewer_operations {query} → viewer_operations {operation_id} → viewer_operation_inspect (read-only) or viewer_operation_execute (needs the commands-and-edits grant the user toggles in the tab). Covers camera, section planes, visibility, selection, appearance, lighting, authoring review, analysis, documents, exports, sources and workflows. Discovery does not execute operations; opening panels is separate (viewer_commands).',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', maxLength: 200 }, operation_id: { type: 'string', maxLength: 200 },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    } } satisfies AgentInputSchema, readOnly: true,
  },
  viewer_operation_inspect: {
    description: 'Execute a read-only operation. Discover needs: model operations require an explicit target; viewer operations omit model_id. background=true returns a job; use viewer_operation_job for its actual completion and results. Does not change viewer state.',
    inputSchema: executionSchema, readOnly: true,
  },
  viewer_operation_execute: {
    description: 'Execute an exact parameterized native operation. Discover needs and its input/output schema first. Requires commands and edits permission at execution. Inputs are validated before any effects. Supply expected_revision from inspection to refuse stale requests. Sensitive effects retain their declared native transaction, export, provider and review policies. This grant does not bypass exact-candidate approval.',
    inputSchema: executionSchema, readOnly: false,
  },
  viewer_operation_job: {
    description: 'Inspect an operation job owned by this viewer host. Returns running or terminal state and structured result. Succeeded results are refused after model replacement or edits.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } satisfies AgentInputSchema, readOnly: true,
  },
  viewer_operation_cancel: {
    description: 'Request cancellation of a read operation job owned by this viewer host. Running means the native service has not settled yet; cancellation does not roll back effects.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } satisfies AgentInputSchema, readOnly: true,
  },
} as const;
const output = (structured: unknown): ToolOutput => ({ text: JSON.stringify(structured), structured });
function jobId(args: Record<string, unknown>) {
  keys(args, ['job_id']);
  return boundedString(args, 'job_id', 200) ?? invalid('Provide job_id.');
}
export const operationTools: Record<keyof typeof OPERATION_SPECS, AgentTool> = {
  ...operationArtifactTools,
  viewer_operation_coverage: { needs: 'none', async run(_host, args) {
    keys(args, ['section', 'row_id', 'offset', 'limit']);
    const section = oneOf(args, 'section', COVERAGE_SECTIONS);
    if (!section && Object.keys(args).length) invalid('Pass a valid section to request coverage details.');
    const row_id = boundedString(args, 'row_id', 200);
    const offset = integer(args, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(args, 'limit', 3, 1, MAX_COVERAGE_PAGE);

    const { viewerOperationCoverage } = await import('./operations/coverage');
    const report = viewerOperationCoverage();
    if (section) {
      const rows = row_id === undefined ? report[section] : report[section].filter(row => row.id === row_id);
      if (row_id !== undefined && !rows.length) {
        throw invalidInput('unknown-target', 'No coverage row has that ID in the requested section.');
      }
      // Coverage is static for this build, so the offset is stable across calls.
      return output({ version: report.version, section, total: rows.length, offset,
        next_offset: offset + limit < rows.length ? offset + limit : null, rows: rows.slice(offset, offset + limit) });
    }

    const { panels, tools, exports, non_panel, human_only, ...overview } = report;
    const summarize = (rows: readonly { id: string; complete: boolean; gaps: readonly { id: string }[] }[]) =>
      rows.map(({ id, complete, gaps }) => ({ id, complete, gap_count: gaps.length, gap_ids: gaps.map(gap => gap.id) }));
    return output({ ...overview, panels: summarize(panels), tools: summarize(tools), exports: summarize(exports),
      non_panel: summarize(non_panel), human_only: human_only.map(({ id }) => ({ id })) });
  } },
  viewer_operations: { needs: 'none', async run(_host, args) {
    keys(args, ['query', 'operation_id', 'offset', 'limit']);
    const query = boundedString(args, 'query', 200, true) ?? '';
    // A blank operation_id means no filter, as before (the schema allows it).
    const operationId = boundedString(args, 'operation_id', 200, true) || undefined;
    const offset = integer(args, 'offset', 0, 0, Number.MAX_SAFE_INTEGER), limit = integer(args, 'limit', 25, 1, 50);
    const { viewerOperations, rankOperations, operationOwners, describeOperation, operationUnavailable, unknownOperationMessage } = await import('./operations/registry');
    // An exact operation_id describes that operation; query only ranks a search.
    const matching = operationId ? viewerOperations().filter(op => op.id === operationId) : rankOperations(query);
    const hint = matching.length ? undefined : operationId
      ? unknownOperationMessage(operationId)
      : `No operation matched. Use task words (hide, colorize, measure, section, screenshot, export) or an owner family: ${operationOwners().join(', ')}. Omit query to list all. Find entities with query_entities.`;
    return output({ total: matching.length, offset, next_offset: offset + limit < matching.length ? offset + limit : null, ...(hint ? { hint } : {}),
      operations: matching.slice(offset, offset + limit).map(op => operationId ? { ...describeOperation(op), unavailable: operationUnavailable(op) }
        : { id: op.id, version: op.version, owner: op.owner, description: op.description, effects: op.effects, capability: op.capability, needs: op.needs, unavailable: operationUnavailable(op) }) });
  } },
  viewer_operation_inspect: { needs: 'none', async run(host, args, ctx) {
    const { executeOperationRequest } = await import('./operations/executor');
    return output(await executeOperationRequest(host, args, ctx, true));
  } },
  viewer_operation_execute: { needs: 'none', async run(host, args, ctx) {
    const { executeOperationRequest } = await import('./operations/executor');
    return output(await executeOperationRequest(host, args, ctx, false));
  } },
  viewer_operation_job: { needs: 'none', async run(host, args, ctx) {
    const id = jobId(args); const { operationJob } = await import('./operations/executor'); return output(operationJob(host, id, false, ctx.claimDelivery));
  } },
  viewer_operation_cancel: { needs: 'none', async run(host, args, ctx) {
    const id = jobId(args); const { operationJob } = await import('./operations/executor'); return output(operationJob(host, id, true, ctx.claimDelivery));
  } },
};
