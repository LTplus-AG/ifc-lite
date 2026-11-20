/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { useViewerStore } from '@/store';
import { assertToolActive } from '../cancellation';
import type { ReadyModel, ToolCallContext, ToolHost } from '../types';
import { operationArtifacts } from './artifacts';
import { contractFingerprint } from './metadata';
import { MAX_RESULT_BYTES } from './result-limit';
import type { Operation } from './contract';
import { viewerOperation, operationUnavailable } from './registry';

export interface OperationJob {
  id: string;
  operation_id: string;
  model_id: string | null;
  revision: number;
  progress?: { phase: string; done: number; total: number };
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  result?: unknown;
  error?: string;
}
interface LiveJob { snapshot: OperationJob; abort: AbortController; current(): void }
const hosts = new WeakMap<ToolHost, Map<string, LiveJob>>();
const MAX_JOBS = 32;
interface AppliedRequest { signature: string; store: ReadyModel['store'] | undefined; result: Promise<unknown> }
const applied = new WeakMap<ToolHost, Map<string, AppliedRequest>>();
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
  // UTF-8 is at most 3 bytes per UTF-16 unit, so only a long text needs encoding to measure.
  if (text.length * 3 > MAX_RESULT_BYTES && new TextEncoder().encode(text).byteLength > MAX_RESULT_BYTES) throw new Error('Result exceeds the 1 MB operation result limit. Narrow the query.');
  return JSON.parse(text) as unknown;
}

/** Native services perform writes synchronously after this final live grant check. */
export async function executeOperation(
  host: ToolHost, model: ReadyModel | undefined, args: Record<string, unknown>, context: ToolCallContext, readOnly: boolean,
): Promise<unknown> {
  const allowed = ['model_id', 'operation_id', 'input', 'expected_revision', 'background', 'idempotency_key'];
  if (Object.keys(args).some(key => !allowed.includes(key))) invalid('Unknown execution argument.');
  if (typeof args.operation_id !== 'string') invalid('operation_id is required.');
  let entry: Operation;
  try { entry = viewerOperation(args.operation_id); } catch { invalid('Unknown operation_id. Discover an exact registered ID first.'); }
  if (entry.needs === 'model' && !model) invalid('This operation requires a loaded model.');
  const writes = entry.effects.some(effect => effect !== 'read');
  if (readOnly && writes) throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'Inspect only accepts read operations.' });
  const requiredPolicy = { model: 'native-reviewed', artifact: 'native-export', network: 'native-provider', publication: 'native-reviewed' } as const;
  for (const effect of entry.effects) {
    if (['read', 'view', 'selection', 'configuration'].includes(effect)) continue;
    if (!Object.hasOwn(requiredPolicy, effect) || entry.policy?.[effect as keyof typeof requiredPolicy] !== requiredPolicy[effect as keyof typeof requiredPolicy]) {
      throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'This effect requires an explicit native capability contract.' });
    }
  }
  if (!readOnly && !context.canEdit?.()) throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'Commands and edits grant is required for execute.' });
  if (args.expected_revision !== undefined && (typeof args.expected_revision !== 'number' || !Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0)) invalid('expected_revision must be a nonnegative integer.');
  if (args.idempotency_key !== undefined && (typeof args.idempotency_key !== 'string' || !args.idempotency_key || args.idempotency_key.length > 200)) invalid('idempotency_key must contain 1 to 200 characters.');
  let nativeModel = model ? useViewerStore.getState().models.get(model.id) : undefined;
  const revision = useViewerStore.getState().mutationVersion;
  let activeRevision = revision;
  let committed = false;
  const check = () => {
    host.lifetimeSignal?.throwIfAborted();
    assertToolActive(context);
    const unavailable = operationUnavailable(entry);
    if (unavailable) throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: unavailable });
    const now = model ? host.models().find(candidate => candidate.id === model.id) : undefined;
    if (model && (now?.store !== model.store || useViewerStore.getState().mutationVersion !== activeRevision
      || useViewerStore.getState().models.get(model.id) !== nativeModel)) {
      throw new ToolExecutionError({ code: ToolErrorCode.STATE_CHANGED, message: 'Model replaced, closed, or edited during the operation. Discarded result.' });
    }
    if (writes && !context.canEdit?.()) throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'Commands and edits grant was revoked or is absent.' });
  };
  check();
  if (args.background !== undefined && typeof args.background !== 'boolean') invalid('background must be boolean.');
  if (writes && args.background) invalid('View and settings operations execute synchronously; background is only supported for reads.');
  // Before replay: a keyed foreground result must not answer a background request.
  if (args.background && args.idempotency_key !== undefined) invalid('Background reads do not accept idempotency_key.');
  const signature = typeof args.idempotency_key === 'string'
    ? contractFingerprint([model?.id ?? null, entry.id, args.input ?? {}, args.expected_revision ?? null]) : '';
  const previous = typeof args.idempotency_key === 'string' ? applied.get(host)?.get(args.idempotency_key) : undefined;
  if (previous) {
    if (previous.store !== model?.store || previous.signature !== signature) invalid('Idempotency key already belongs to another request or model.');
    return previous.result;
  }
  if (args.expected_revision !== undefined && args.expected_revision !== revision) {
    throw new ToolExecutionError({ code: ToolErrorCode.STATE_CHANGED, message: 'The model revision changed. Inspect it again.' });
  }
  const input = args.input ?? {};
  try { entry.validate(input); } catch (error) { invalid(error instanceof Error ? error.message : 'Invalid operation input.'); }
  let checkpoint = check;
  const markCommitted = () => {
    committed = true;
    if (context.commitState) context.commitState.committed = true;
    activeRevision = useViewerStore.getState().mutationVersion;
    nativeModel = model ? useViewerStore.getState().models.get(model.id) : undefined;
  };
  const commit = <T>(write: () => T): T => {
    if (!writes || readOnly) throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'A read operation cannot commit changes.' });
    checkpoint();
    if (context.commitState) context.commitState.committing = true;
    try {
      const value = write();
      markCommitted();
      return value;
    } finally { if (context.commitState) context.commitState.committing = false; }
  };
  const commitAsync = async <T>(write: () => Promise<T>, didCommit: (result: T) => boolean = value => value !== false): Promise<T> => {
    if (!writes || readOnly) throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'A read operation cannot admit durable writes.' });
    checkpoint();
    if (context.commitState) context.commitState.committing = true;
    try {
      const value = await write();
      if (didCommit(value)) {
        markCommitted();
      }
      return value;
    } finally { if (context.commitState) context.commitState.committing = false; }
  };
  const artifacts = operationArtifacts(host, write => {
    if (!entry.effects.includes('artifact')) throw new Error('The operation did not declare artifact creation.');
    return commit(write);
  });
  const operationContext = { ...context, checkpoint: check, model, host, commit, commitAsync, artifacts };
  check();
  if (!args.background) {
    const run = async (forget = () => {}) => {
      // Nothing native has run yet, so a keyed retry of this failure may run again (#10669).
      try { await entry.load?.(); check(); } catch (error) { forget(); throw error; }
      try {
        const result = await entry.execute(input, operationContext);
        if (!committed) check();
        const value = boundedResult(result);
        entry.validateResult(value);
        return { operation_id: entry.id, model_id: model?.id ?? null, revision: activeRevision, state: entry.completion ?? 'succeeded', committed, result: value };
      } catch (error) {
        if (committed) throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : 'Operation failed after committing changes.',
          details: { committed: true, revision: activeRevision, operation_id: entry.id, model_id: model?.id ?? null } });
        throw error;
      }
    };
    if (typeof args.idempotency_key !== 'string') return run();
    const prior = applied.get(host) ?? new Map<string, AppliedRequest>();
    applied.set(host, prior);
    // Keep failed outcomes once the native handler ran: retrying a partially dispatched UI action must not duplicate it.
    if (prior.size >= 100) invalid('Host idempotency capacity reached (100 requests). Reconnect before creating further keyed requests.');
    const key = args.idempotency_key, request: AppliedRequest = { signature, store: model?.store, result: Promise.resolve() };
    // Registered before run() starts, so even an immediate pre-dispatch failure can remove it.
    prior.set(key, request);
    request.result = run(() => { if (prior.get(key) === request) prior.delete(key); });
    return request.result;
  }
  const owned = jobs(host);
  for (const [id, job] of owned) if (owned.size >= MAX_JOBS && job.snapshot.state !== 'running') owned.delete(id);
  if (owned.size >= MAX_JOBS) invalid('This host already has 32 running operation jobs.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal?.addEventListener('abort', abort, { once: true });
  host.lifetimeSignal?.addEventListener('abort', abort, { once: true });
  if (context.signal?.aborted) controller.abort();
  const snapshot: OperationJob = { id: crypto.randomUUID(), operation_id: entry.id, model_id: model?.id ?? null, revision, state: 'running' };
  const active = () => { controller.signal.throwIfAborted(); check(); };
  checkpoint = active;
  owned.set(snapshot.id, { snapshot, abort: controller, current: check });
  // Retain and settle the actual service promise. Cancellation never claims rollback.
  void Promise.resolve().then(() => { active(); return entry.execute(input, { ...operationContext, signal: controller.signal, checkpoint: active, progress: detail => {
      active(); snapshot.progress = detail;
    } }); })
    .then(result => { active(); snapshot.result = boundedResult(result); entry.validateResult(snapshot.result); snapshot.state = 'succeeded'; })
    .catch((error: unknown) => {
      snapshot.state = controller.signal.aborted ? 'cancelled' : 'failed';
      snapshot.error = error instanceof Error ? error.message : 'Operation failed.';
    }).finally(() => {
      context.signal?.removeEventListener('abort', abort);
      host.lifetimeSignal?.removeEventListener('abort', abort);
    });
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

export async function executeOperationRequest(host: ToolHost, args: Record<string, unknown>, context: ToolCallContext, readOnly: boolean) {
  if (typeof args.operation_id !== 'string') invalid('operation_id is required.');
  let entry: Operation;
  try { entry = viewerOperation(args.operation_id); } catch { invalid('Unknown operation_id.'); }
  let model: ReadyModel | undefined;
  if (entry.needs === 'model') {
    const { resolveModel, usableModel } = await import('../main-viewer-dispatch');
    model = usableModel(resolveModel(host, args), 'store', entry.id);
  } else if (args.model_id !== undefined) {
    invalid('Viewer/session operations do not accept model_id.');
  }
  return executeOperation(host, model, args, context, readOnly);
}
