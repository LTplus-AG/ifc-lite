/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { operationArtifactSpecs, operationArtifactTools } from './operation-artifact-tools';
import { boundedString, integer, invalid, keys } from './tool-args';
import type { AgentInputSchema, AgentTool, ToolOutput } from './types';

const executionSchema = { type: 'object', properties: {
  model_id: { type: 'string' }, operation_id: { type: 'string' }, input: { type: 'object' },
  expected_revision: { type: 'integer', minimum: 0 }, idempotency_key: { type: 'string', minLength: 1, maxLength: 200 }, background: { type: 'boolean' },
}, required: ['operation_id'] } satisfies AgentInputSchema;
export const OPERATION_SPECS = {
  ...operationArtifactSpecs,
  viewer_operation_coverage: {
    description: 'Read machine-readable migration coverage for all built-in panels, finite viewport tools and non-panel controls. Lists actual implemented IDs, remaining gaps and specific human-only host boundaries. A control marked grouped lists several operations together; which one serves which part of the control is not recorded. Partial coverage is never reported as complete.',
    inputSchema: { type: 'object', properties: {} } satisfies AgentInputSchema, readOnly: true,
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
    if (Object.keys(args).length) invalid('Coverage accepts no arguments.');
    const { viewerOperationCoverage } = await import('./operations/coverage');
    return output(viewerOperationCoverage());
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
