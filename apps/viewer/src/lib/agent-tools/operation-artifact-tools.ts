/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { assertDispatchActive } from './cancellation';
import type { AgentInputSchema, AgentTool, ToolCallContext, ToolHost, ToolOutput } from './types';

const id = { type: 'string', minLength: 1, maxLength: 200 };
const idSchema: AgentInputSchema = { type: 'object' as const, properties: { artifact_id: id }, required: ['artifact_id'] };
const readSchema: AgentInputSchema = { type: 'object', properties: { artifact_id: id, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 65536 } }, required: ['artifact_id'] };
export const operationArtifactSpecs = {
  viewer_artifacts: { description: 'List bounded artifacts owned by this agent connection. Handles cannot be used by another host and expire on disconnect.', inputSchema: { type: 'object' as const, properties: {} }, readOnly: true },
  viewer_artifact_read: { description: 'Read up to 65536 bytes of a connection-owned artifact as base64 with a byte offset. Continue using next_offset; null means EOF.', inputSchema: readSchema, readOnly: true },
  viewer_artifact_download: { description: 'Dispatch the native browser download for a connection-owned artifact. Requires the live commands-and-edits grant; dispatch is not confirmation of a saved file.', inputSchema: idSchema, readOnly: false },
  viewer_artifact_delete: { description: 'Delete an artifact owned by this connection and release its quota. Requires the live commands-and-edits grant.', inputSchema: idSchema, readOnly: false },
} as const;
const output = (structured: unknown): ToolOutput => ({ structured, text: JSON.stringify(structured) });
function input(args: Record<string, unknown>, allowed: readonly string[]): string {
  if (Object.keys(args).some(key => !allowed.includes(key)) || typeof args.artifact_id !== 'string' || !args.artifact_id || args.artifact_id.length > 200) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Provide an exact artifact_id and only the documented fields.' });
  }
  return args.artifact_id;
}
function permitted(host: ToolHost, ctx: ToolCallContext) {
  assertDispatchActive(ctx.signal); host.lifetimeSignal?.throwIfAborted();
  if (!ctx.canEdit?.()) throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'A live commands-and-edits grant is required.' });
}
function commit<T>(host: ToolHost, ctx: ToolCallContext, effect: () => T): T {
  permitted(host, ctx);
  if (ctx.commitState) ctx.commitState.committing = true;
  try {
    const result = effect();
    if (ctx.commitState) ctx.commitState.committed = true;
    return result;
  } finally { if (ctx.commitState) ctx.commitState.committing = false; }
}
export const operationArtifactTools: Record<keyof typeof operationArtifactSpecs, AgentTool> = {
  viewer_artifacts: { needs: 'none', async run(host, args) {
    if (Object.keys(args).length) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Artifact listing accepts no arguments.' });
    const { listArtifacts } = await import('./operations/artifacts'); return output({ artifacts: listArtifacts(host) });
  } },
  viewer_artifact_read: { needs: 'none', async run(host, args, ctx) {
    const artifact = input(args, ['artifact_id', 'offset', 'length']);
    const { readArtifact } = await import('./operations/artifacts');
    const offset = args.offset === undefined ? 0 : args.offset, length = args.length === undefined ? 65536 : args.length;
    if (typeof offset !== 'number' || typeof length !== 'number') throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'offset and length must be integers.' });
    const result = await readArtifact(host, artifact, offset, length); assertDispatchActive(ctx.signal); return output(result);
  } },
  viewer_artifact_download: { needs: 'none', async run(host, args, ctx) {
    const artifact = input(args, ['artifact_id']); permitted(host, ctx);
    const { downloadArtifact } = await import('./operations/artifacts'); permitted(host, ctx);
    return output(commit(host, ctx, () => downloadArtifact(host, artifact)));
  } },
  viewer_artifact_delete: { needs: 'none', async run(host, args, ctx) {
    const artifact = input(args, ['artifact_id']); permitted(host, ctx);
    const { removeArtifact } = await import('./operations/artifacts'); permitted(host, ctx);
    return output(commit(host, ctx, () => removeArtifact(host, artifact)));
  } },
};
