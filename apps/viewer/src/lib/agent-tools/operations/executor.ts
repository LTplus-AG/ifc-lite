/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { useViewerStore } from '@/store';
import { assertToolActive, cancelledDispatch } from '../cancellation';
import { isAbortError } from '@/lib/runs/abort';
import type { ReadyModel, ToolCallContext, ToolHost } from '../types';
import { operationArtifacts } from './artifacts';
import { contractFingerprint } from './metadata';
import { MAX_RESULT_BYTES, utf8Bytes } from './result-limit';
import type { Operation } from './contract';
import { viewerOperation, operationUnavailable } from './registry';
import { disabled, internal, invalidInput, stale, unavailable, type InputReason } from './refusals';

export interface OperationJob {
  id: string;
  operation_id: string;
  model_id: string | null;
  revision: number;
  progress?: { phase: string; done: number; total: number };
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  result?: unknown;
  error?: string;
  /** The failed operation's error code and details, exactly as a foreground call reports them (#10871). */
  error_code?: string;
  error_details?: Record<string, unknown>;
}
interface LiveJob { snapshot: OperationJob; abort: AbortController; current(): void; discard(): void; delivered?: boolean }
const hosts = new WeakMap<ToolHost, Map<string, LiveJob>>();
const MAX_JOBS = 32;
interface AppliedRequest { signature: string; store: ReadyModel['store'] | undefined; result: Promise<unknown> }
const applied = new WeakMap<ToolHost, Map<string, AppliedRequest>>();
function jobs(host: ToolHost) {
  let owned = hosts.get(host);
  if (!owned) { owned = new Map(); hosts.set(host, owned); }
  return owned;
}
/** A cause's details without its own `reason`, which a committed failure must not carry as a retry hint. */
function withoutReason(details: Record<string, unknown> | undefined) {
  if (!details) return undefined;
  const { reason: _reason, ...rest } = details; return rest;
}
function operationFailure(error: unknown, operationId: string): ToolExecutionError {
  if (isAbortError(error)) return cancelledDispatch();
  if (error instanceof ToolExecutionError) {
    if (error.code === ToolErrorCode.ENTITY_NOT_FOUND) return invalidInput('unknown-target', error.message, error.details);
    return error;
  }
  return internal(error instanceof Error ? error.message : 'Operation failed.', { operation_id: operationId });
}

function invalid(message: string, reason: InputReason = 'invalid-value'): never {
  throw invalidInput(reason, message);
}
function boundedResult(result: unknown): unknown {
  // JSON's NaN/Infinity coercion would silently fabricate success data.
  const text = JSON.stringify(result ?? null, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw internal('Operation returned a non-finite number.');
    return value;
  });
  // UTF-8 is at most 3 bytes per UTF-16 unit, so only a long text needs encoding to measure.
  if (text.length * 3 > MAX_RESULT_BYTES && utf8Bytes(text) > MAX_RESULT_BYTES) throw invalidInput('limit', 'Result exceeds the 1 MB operation result limit. Narrow the query.');
  return JSON.parse(text) as unknown;
}

/** A model entry a remesh replaced: the same entry apart from its geometry and the pre-alignment tail it carries. */
const GEOMETRY_FIELDS = new Set(['geometryResult', 'preAlignment']);
function geometryOnly<T extends object>(before: T, after: T): boolean {
  for (const key in before) if (!GEOMETRY_FIELDS.has(key) && before[key] !== after[key]) return false;
  for (const key in after) if (!GEOMETRY_FIELDS.has(key) && !(key in before)) return false;
  return true;
}

/** Native services perform writes synchronously after this final live grant check. */
export async function executeOperation(
  host: ToolHost, model: ReadyModel | undefined, args: Record<string, unknown>, context: ToolCallContext, readOnly: boolean,
): Promise<unknown> {
  const allowed = ['model_id', 'operation_id', 'input', 'expected_revision', 'background', 'idempotency_key'];
  if (Object.keys(args).some(key => !allowed.includes(key))) invalid('Unknown execution argument.');
  if (typeof args.operation_id !== 'string') invalid('operation_id is required.');
  let entry: Operation;
  try { entry = viewerOperation(args.operation_id); } catch { invalid('Unknown operation_id. Discover an exact registered ID first.', 'unknown-target'); }
  if (entry.needs === 'model' && !model) invalid('This operation requires a loaded model.');
  const writes = entry.effects.some(effect => effect !== 'read');
  if (readOnly && writes) throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'Inspect only accepts read operations.', details: { reason: 'read-only' } });
  const requiredPolicy = { model: 'native-reviewed', artifact: 'native-export', network: 'native-provider', publication: 'native-reviewed' } as const;
  for (const effect of entry.effects) {
    if (['read', 'view', 'selection', 'configuration'].includes(effect)) continue;
    if (!Object.hasOwn(requiredPolicy, effect) || entry.policy?.[effect as keyof typeof requiredPolicy] !== requiredPolicy[effect as keyof typeof requiredPolicy]) {
      throw internal('This effect requires an explicit native capability contract.');
    }
  }
  if (!readOnly && !context.canEdit?.()) throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'Commands and edits grant is required for execute.', details: { reason: 'read-only' } });
  if (args.expected_revision !== undefined && (typeof args.expected_revision !== 'number' || !Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0)) invalid('expected_revision must be a nonnegative integer.');
  if (args.idempotency_key !== undefined && (typeof args.idempotency_key !== 'string' || !args.idempotency_key || args.idempotency_key.length > 200)) invalid('idempotency_key must contain 1 to 200 characters.');
  let nativeModel = model ? useViewerStore.getState().models.get(model.id) : undefined;
  const revision = useViewerStore.getState().mutationVersion;
  let activeRevision = revision;
  let committed = false;
  const check = () => {
    host.lifetimeSignal?.throwIfAborted();
    assertToolActive(context);
    const reason = operationUnavailable(entry);
    if (reason) throw disabled(reason);
    const now = model ? host.models().find(candidate => candidate.id === model.id) : undefined;
    if (model && (now?.store !== model.store || useViewerStore.getState().mutationVersion !== activeRevision
      || useViewerStore.getState().models.get(model.id) !== nativeModel)) {
      throw stale('Model replaced, closed, or edited during the operation. Discarded result.');
    }
    if (writes && !context.canEdit?.()) throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'Commands and edits grant was revoked or is absent.', details: { reason: 'read-only' } });
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
    if (previous.store !== model?.store || previous.signature !== signature) invalid('Idempotency key already belongs to another request or model.', 'conflict');
    return previous.result;
  }
  if (args.expected_revision !== undefined && args.expected_revision !== revision) {
    throw stale('The model revision changed. Inspect it again.');
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
    if (!writes || readOnly) throw internal('A read operation cannot commit changes.');
    checkpoint();
    if (context.commitState) context.commitState.committing = true;
    try {
      const value = write();
      markCommitted();
      return value;
    } finally { if (context.commitState) context.commitState.committing = false; }
  };
  const commitAsync = async <T>(write: () => Promise<T>, didCommit: (result: T) => boolean = value => value !== false): Promise<T> => {
    if (!writes || readOnly) throw internal('A read operation cannot admit durable writes.');
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
    if (!entry.effects.includes('artifact')) throw internal('The operation did not declare artifact creation.');
    return commit(write);
  });
  const ownGeometry = async <T>(work: () => Promise<T>, release: (value: T) => void): Promise<T> => {
    checkpoint();
    const value = await work();
    const state = useViewerStore.getState(), now = model ? state.models.get(model.id) : undefined;
    if (nativeModel && now && state.mutationVersion === activeRevision && geometryOnly(nativeModel, now)) nativeModel = now;
    try { checkpoint(); } catch (error) {
      try { release(value); } catch (releaseError) { console.warn('[viewer operation] releasing a refused result failed', releaseError); }
      throw error;
    }
    return value;
  };
  const operationContext = { ...context, checkpoint: check, model, host, commit, commitAsync, ownGeometry, artifacts };
  const discardResult = (result: unknown) => {
    try { entry.discard?.(result, operationContext); } catch (error) { console.warn('[viewer operation] discarding a refused result failed', error); }
  };
  /** The result after the final check, bounded and validated. A result refused here is never delivered, so what the
   * handler stored for it is discarded; a committed write is not, since it already happened. */
  const accepted = (result: unknown, finalCheck: () => void): unknown => {
    try { finalCheck(); const bounded = boundedResult(result); entry.validateResult(bounded); return bounded; } catch (error) {
      if (!committed) discardResult(result);
      throw error;
    }
  };
  check();
  if (!args.background) {
    const run = async (forget = () => {}) => {
      // Nothing native has run yet, so a keyed retry of this failure may run again (#10669).
      try { await entry.load?.(); check(); } catch (error) { forget(); throw operationFailure(error, entry.id); }
      try {
        const result = await entry.execute(input, operationContext);
        const value = accepted(result, () => { if (!committed) check(); });
        return { operation_id: entry.id, model_id: model?.id ?? null, revision: activeRevision, state: entry.completion ?? 'succeeded', committed, result: value };
      } catch (error) {
        if (committed) throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : 'Operation failed after committing changes.',
                  // reason stays 'internal': the write committed, so no retry reason may survive. The cause is kept beside it.
          details: { reason: 'internal', ...(error instanceof ToolExecutionError ? { cause_code: error.code, cause_reason: error.details?.reason, cause_details: withoutReason(error.details) } : {}),
            committed: true, revision: activeRevision, operation_id: entry.id, model_id: model?.id ?? null } });
        throw operationFailure(error, entry.id);
      }
    };
    if (typeof args.idempotency_key !== 'string') return run();
    const prior = applied.get(host) ?? new Map<string, AppliedRequest>();
    applied.set(host, prior);
    // Keep failed outcomes once the native handler ran: retrying a partially dispatched UI action must not duplicate it.
    if (prior.size >= 100) throw unavailable('Host idempotency capacity reached (100 requests). Reconnect before creating further keyed requests.');
    const key = args.idempotency_key, request: AppliedRequest = { signature, store: model?.store, result: Promise.resolve() };
    // Registered before run() starts, so even an immediate pre-dispatch failure can remove it.
    prior.set(key, request);
    request.result = run(() => { if (prior.get(key) === request) prior.delete(key); });
    return request.result;
  }
  const owned = jobs(host);
  for (const [id, job] of owned) if (owned.size >= MAX_JOBS && job.snapshot.state !== 'running') owned.delete(id);
  if (owned.size >= MAX_JOBS) throw unavailable('This host already has 32 running operation jobs.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal?.addEventListener('abort', abort, { once: true });
  host.lifetimeSignal?.addEventListener('abort', abort, { once: true });
  if (context.signal?.aborted) controller.abort();
  const snapshot: OperationJob = { id: crypto.randomUUID(), operation_id: entry.id, model_id: model?.id ?? null, revision, state: 'running' };
  const active = () => { controller.signal.throwIfAborted(); check(); };
  checkpoint = active;
  owned.set(snapshot.id, { snapshot, abort: controller, current: check, discard: () => discardResult(snapshot.result) });
  // Retain and settle the actual service promise. Cancellation never claims rollback.
  void Promise.resolve().then(() => { active(); return entry.execute(input, { ...operationContext, signal: controller.signal, checkpoint: active, progress: detail => {
      active(); snapshot.progress = detail;
    } }); })
    .then(result => { snapshot.result = accepted(result, active); snapshot.state = 'succeeded'; })
    .catch((error: unknown) => {
      snapshot.state = controller.signal.aborted ? 'cancelled' : 'failed';
      const refusal = controller.signal.aborted ? cancelledDispatch() : operationFailure(error, entry.id);
      snapshot.error = refusal.message;
      snapshot.error_code = refusal.code;
      if (refusal.details) snapshot.error_details = refusal.details;
    }).finally(() => {
      context.signal?.removeEventListener('abort', abort);
      host.lifetimeSignal?.removeEventListener('abort', abort);
    });
  return { job: { ...snapshot } };
}

export function operationJob(host: ToolHost, id: string, cancel = false): OperationJob {
  const job = jobs(host).get(id);
  if (!job) invalid('Unknown job for this viewer host.', 'unknown-target');
  if (cancel && job.snapshot.state === 'running') job.abort.abort();
  if (job.snapshot.state === 'succeeded') {
    try { job.current(); } catch (error) {
      // A result never delivered and refused for good (the model changed, the host closed) never will be: discard
      // what its handler stored, once. A delivered result is the caller's; a passing refusal (a disabled feature)
      // keeps the job as it is, holding its candidate until the job is evicted or the host closes.
      const aborted = host.lifetimeSignal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')
        || (error instanceof ToolExecutionError && error.code === ToolErrorCode.CANCELLED);
      if (!job.delivered && (aborted || (error instanceof ToolExecutionError && error.code === ToolErrorCode.STATE_CHANGED))) {
        job.discard();
        Object.assign(job.snapshot, { state: aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : 'Operation failed.', result: undefined });
      }
      throw error;
    }
    job.delivered = true;
  }
  // A cancellation request is observable, but terminal cancellation awaits runner settlement.
  return { ...job.snapshot, ...(cancel && job.snapshot.state === 'running' ? { cancellationRequested: true } : {}) };
}

export async function executeOperationRequest(host: ToolHost, args: Record<string, unknown>, context: ToolCallContext, readOnly: boolean) {
  if (typeof args.operation_id !== 'string') invalid('operation_id is required.');
  let entry: Operation;
  try { entry = viewerOperation(args.operation_id); } catch { invalid('Unknown operation_id.', 'unknown-target'); }
  let model: ReadyModel | undefined;
  if (entry.needs === 'model') {
    const { resolveModel, usableModel } = await import('../main-viewer-dispatch');
    model = usableModel(resolveModel(host, args), 'store', entry.id);
  } else if (args.model_id !== undefined) {
    invalid('Viewer/session operations do not accept model_id.');
  }
  return executeOperation(host, model, args, context, readOnly);
}
