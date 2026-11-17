/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { operationArtifactSpecs, operationArtifactTools } from './operation-artifact-tools';
import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import type { AgentInputSchema, AgentTool, ToolOutput } from './types';

const executionSchema = { type: 'object', properties: {
  model_id: { type: 'string' }, operation_id: { type: 'string' }, input: { type: 'object' },
  expected_revision: { type: 'integer', minimum: 0 }, idempotency_key: { type: 'string', minLength: 1, maxLength: 200 }, background: { type: 'boolean' },
}, required: ['operation_id'] } satisfies AgentInputSchema;
export const OPERATION_SPECS = {
  ...operationArtifactSpecs,
  viewer_operations: {
    description: 'Search native parameterized viewer operations. Bounded discovery, with exact runtime schemas on describe. Opening panels is separate. Operations currently cover native camera, section planes, visibility, selection, appearance, lighting, native authoring review, analysis, documents, exports, sources and workflow execution. Discovery does not execute operations.',
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
function invalid(message: string): never { throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message }); }
function jobId(args: Record<string, unknown>) {
  if (Object.keys(args).some(key => key !== 'job_id') || typeof args.job_id !== 'string' || args.job_id.length > 200) invalid('Provide only job_id.');
  return args.job_id;
}
export const operationTools: Record<keyof typeof OPERATION_SPECS, AgentTool> = {
  ...operationArtifactTools,
  viewer_operations: { needs: 'none', async run(_host, args) {
    if (Object.keys(args).some(key => !['query', 'operation_id', 'offset', 'limit'].includes(key))) invalid('Unknown discovery argument.');
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200)) invalid('Invalid query.');
    if (args.operation_id !== undefined && (typeof args.operation_id !== 'string' || args.operation_id.length > 200)) invalid('Invalid operation_id.');
    const offset = args.offset ?? 0, limit = args.limit ?? 25;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) invalid('Invalid offset.');
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) invalid('Invalid limit.');
    const { viewerOperations, describeOperation, operationUnavailable } = await import('./operations/registry');
    const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
    const matching = viewerOperations().filter(op => (!args.operation_id || op.id === args.operation_id)
      && `${op.id} ${op.owner} ${op.description}`.toLowerCase().includes(query));
    return output({ total: matching.length, offset, next_offset: offset + limit < matching.length ? offset + limit : null,
      operations: matching.slice(offset, offset + limit).map(op => args.operation_id ? { ...describeOperation(op), unavailable: operationUnavailable(op) }
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
  viewer_operation_job: { needs: 'none', async run(host, args) {
    const id = jobId(args); const { operationJob } = await import('./operations/executor'); return output(operationJob(host, id));
  } },
  viewer_operation_cancel: { needs: 'none', async run(host, args) {
    const id = jobId(args); const { operationJob } = await import('./operations/executor'); return output(operationJob(host, id, true));
  } },
};
