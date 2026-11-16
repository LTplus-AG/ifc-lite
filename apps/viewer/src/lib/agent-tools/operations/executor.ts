/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { useViewerStore } from '@/store';
import { assertToolActive } from '../cancellation';
import type { ReadyModel, ToolCallContext, ToolHost } from '../types';
import type { Operation } from './contract';
import { viewerOperation, operationUnavailable } from './registry';

export interface OperationJob {
  id: string;
  operation_id: string;
  model_id: string;
  revision: number;
  progress?: { phase: string; done: number; total: number };
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  result?: unknown;
  error?: string;
}
interface LiveJob { snapshot: OperationJob; abort: AbortController; current(): void }
const hosts = new WeakMap<ToolHost, Map<string, LiveJob>>();
const MAX_JOBS = 32;
interface AppliedRequest { signature: string; store: ReadyModel['store']; result: Promise<unknown> }
const applied = new WeakMap<ToolHost, Map<string, AppliedRequest>>();
const MAX_RESULT_BYTES = 1_000_000;
function jobs(host: ToolHost) {
  let owned = hosts.get(host);
  if (!owned) { owned = new Map(); hosts.set(host, owned); }
  return owned;
}
function invalid(message: string): never {
  throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message });
}
function boundedResult(result: unknown): unknown {
  // JSON's NaN/Infinity coercion would silently fabricate success data.
  const text = JSON.stringify(result ?? null, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Operation returned a non-finite number.');
    return value;
  });
  if (text.length > MAX_RESULT_BYTES) throw new Error('Result exceeds the 1 MB operation result limit. Narrow the query.');
  return JSON.parse(text) as unknown;
}

/** Native services perform writes synchronously after this final live grant check. */
export async function executeOperation(
  host: ToolHost, model: ReadyModel, args: Record<string, unknown>, context: ToolCallContext, readOnly: boolean,
): Promise<unknown> {
  const allowed = ['model_id', 'operation_id', 'input', 'expected_revision', 'background', 'idempotency_key'];
  if (Object.keys(args).some(key => !allowed.includes(key))) invalid('Unknown execution argument.');
  if (typeof args.operation_id !== 'string') invalid('operation_id is required.');
  let entry: Operation;
  try { entry = viewerOperation(args.operation_id); } catch { invalid('Unknown operation_id. Discover an exact registered ID first.'); }
  const writes = entry.effects.some(effect => effect !== 'read');
  if (readOnly && writes) throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'Inspect only accepts read operations.' });
  // A future mixed export/network/model contract must deliberately extend this gate.
  if (entry.effects.some(effect => !['read', 'view', 'selection', 'configuration'].includes(effect))) {
    throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'This effect requires a separate host capability contract.' });
  }
  if (!readOnly && !context.canEdit?.()) throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'Commands and edits grant is required for execute.' });
  if (args.expected_revision !== undefined && (typeof args.expected_revision !== 'number' || !Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0)) invalid('expected_revision must be a nonnegative integer.');
  if (args.idempotency_key !== undefined && (typeof args.idempotency_key !== 'string' || !args.idempotency_key || args.idempotency_key.length > 200)) invalid('idempotency_key must contain 1 to 200 characters.');
  const nativeModel = useViewerStore.getState().models.get(model.id);
  const revision = useViewerStore.getState().mutationVersion;
  if (args.expected_revision !== undefined && args.expected_revision !== revision) {
    throw new ToolExecutionError({ code: ToolErrorCode.STATE_CHANGED, message: 'The model revision changed. Inspect it again.' });
  }
  if (args.background !== undefined && typeof args.background !== 'boolean') invalid('background must be boolean.');
  if (writes && args.background) invalid('View and settings operations execute synchronously; background is only supported for reads.');
  const input = args.input ?? {};
  try { entry.validate(input); } catch (error) { invalid(error instanceof Error ? error.message : 'Invalid operation input.'); }
  const check = () => {
    assertToolActive(context);
    const unavailable = operationUnavailable(entry);
    if (unavailable) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: unavailable });
    const now = host.models().find(candidate => candidate.id === model.id);
    if (now?.store !== model.store || useViewerStore.getState().mutationVersion !== revision
      || useViewerStore.getState().models.get(model.id) !== nativeModel) {
      throw new ToolExecutionError({ code: ToolErrorCode.STATE_CHANGED, message: 'Model replaced, closed, or edited during the operation. Discarded result.' });
    }
    if (writes && !context.canEdit?.()) throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'Commands and edits grant was revoked or is absent.' });
  };
  check();
  if (!args.background) {
    const run = async () => {
      check();
      const result = await entry.execute(input, { ...context, checkpoint: check, model });
      check();
      return { operation_id: entry.id, model_id: model.id, revision, state: entry.completion ?? 'succeeded', result: boundedResult(result) };
    };
    if (typeof args.idempotency_key !== 'string') return run();
    let prior = applied.get(host);
    if (!prior) { prior = new Map(); applied.set(host, prior); }
    const signature = JSON.stringify([model.id, revision, entry.id, input]);
    const existing = prior.get(args.idempotency_key);
    if (existing) {
      if (existing.store !== model.store || existing.signature !== signature) invalid('Idempotency key already belongs to another request or model revision.');
      return existing.result;
    }
    // Keep failed outcomes too: retrying a partially dispatched UI action must not duplicate it.
    if (prior.size >= 100) invalid('Host idempotency capacity reached (100 requests). Reconnect before creating further keyed requests.');
    const result = run();
    prior.set(args.idempotency_key, { signature, store: model.store, result });
    return result;
  }
  if (args.idempotency_key !== undefined) invalid('Background reads do not accept idempotency_key.');
  const owned = jobs(host);
  for (const [id, job] of owned) if (owned.size >= MAX_JOBS && job.snapshot.state !== 'running') owned.delete(id);
  if (owned.size >= MAX_JOBS) invalid('This host already has 32 running operation jobs.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal?.addEventListener('abort', abort, { once: true });
  if (context.signal?.aborted) controller.abort();
  const snapshot: OperationJob = { id: crypto.randomUUID(), operation_id: entry.id, model_id: model.id, revision, state: 'running' };
  const active = () => { controller.signal.throwIfAborted(); check(); };
  owned.set(snapshot.id, { snapshot, abort: controller, current: check });
  // Retain and settle the actual service promise. Cancellation never claims rollback.
  void Promise.resolve().then(() => { active(); return entry.execute(input, { ...context, signal: controller.signal, checkpoint: active, model, progress: detail => {
      active(); snapshot.progress = detail;
    } }); })
    .then(result => { active(); snapshot.result = boundedResult(result); snapshot.state = 'succeeded'; })
    .catch((error: unknown) => {
      snapshot.state = controller.signal.aborted ? 'cancelled' : 'failed';
      snapshot.error = error instanceof Error ? error.message : 'Operation failed.';
    }).finally(() => context.signal?.removeEventListener('abort', abort));
  return { job: { ...snapshot } };
}

export function operationJob(host: ToolHost, id: string, cancel = false): OperationJob {
  const job = jobs(host).get(id);
  if (!job) invalid('Unknown job for this viewer host.');
  if (cancel && job.snapshot.state === 'running') job.abort.abort();
  if (job.snapshot.state === 'succeeded') job.current();
  // A cancellation request is observable, but terminal cancellation awaits runner settlement.
  return { ...job.snapshot, ...(cancel && job.snapshot.state === 'running' ? { cancellationRequested: true } : {}) };
}
