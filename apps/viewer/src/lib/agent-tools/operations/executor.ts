/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { isAbortError } from '@/lib/runs/abort';
import { useViewerStore } from '@/store';
import { ResultDelivery } from '../delivery';
import { assertToolActive, cancelledDispatch } from '../cancellation';
import type { ReadyModel, ToolCallContext, ToolCommitState, ToolHost } from '../types';
import { operationArtifacts } from './artifacts';
import { contractFingerprint } from './metadata';
import { MAX_RESULT_BYTES, utf8Bytes } from './result-limit';
import type { Operation } from './contract';
import { viewerOperation, operationUnavailable, unknownOperationMessage } from './registry';
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
interface LiveJob { snapshot: OperationJob; abort: AbortController; current(): void; discard(): void; delivery: ResultDelivery; delivered?: boolean }
const hosts = new WeakMap<ToolHost, Map<string, LiveJob>>();
const MAX_JOBS = 32;
interface AppliedRequest {
  signature: string;
  store: ReadyModel['store'] | undefined;
  result: Promise<unknown>;
  delivery: ResultDelivery;
  executionSignal?: AbortSignal;
  commitState: ToolCommitState;
}
const applied = new WeakMap<ToolHost, Map<string, AppliedRequest>>();
function jobs(host: ToolHost) {
  let owned = hosts.get(host);
  if (!owned) { owned = new Map(); hosts.set(host, owned); }
  return owned;
}
function collect(result: Promise<unknown>, delivery: ResultDelivery, context: ToolCallContext, commitState: ToolCommitState): Promise<unknown> {
  const claim = delivery.claim(context.signal);
  if (context.claimDelivery) {
    context.claimDelivery(claim, commitState);
    return result;
  }
  const { signal } = context;
  return new Promise((resolve, reject) => {
    const cancel = () => { claim.drop(); reject(cancelledDispatch()); };
    const abort = () => { if (!commitState.committed && !commitState.committing) cancel(); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const detach = () => signal?.removeEventListener('abort', abort);
    void result.then(value => {
      detach();
      if (signal?.aborted && !commitState.committed) { cancel(); return; }
      claim.deliver();
      resolve(value);
    }, error => {
      detach();
      claim.drop();
      reject(error);
    });
  });
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
  try { entry = viewerOperation(args.operation_id); } catch { invalid(unknownOperationMessage(args.operation_id), 'unknown-target'); }
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
  const commitState = context.commitState ?? { committed: false, committing: false };
  let executionContext = context;
  let demand: ResultDelivery | undefined;
  const check = () => {
    host.lifetimeSignal?.throwIfAborted();
    assertToolActive(executionContext);
    if (demand && !commitState.committing && !commitState.committed && !demand.hasActiveCaller) throw cancelledDispatch();
    const reason = operationUnavailable(entry);
    if (reason) throw disabled(reason);
    const now = model ? host.models().find(candidate => candidate.id === model.id) : undefined;
    if (model && (now?.store !== model.store || useViewerStore.getState().mutationVersion !== activeRevision
      || useViewerStore.getState().models.get(model.id) !== nativeModel)) {
      throw stale('Model replaced, closed, or edited during the operation. Discarded result.');
    }
    if (writes && !executionContext.canEdit?.()) throw new ToolExecutionError({ code: ToolErrorCode.READ_ONLY, message: 'Commands and edits grant was revoked or is absent.', details: { reason: 'read-only' } });
  };
  check();
  if (args.background !== undefined && typeof args.background !== 'boolean') invalid('background must be boolean.');
  if (writes && args.background) invalid('View and settings operations execute synchronously; background is only supported for reads.');
  // Before replay: a keyed foreground result must not answer a background request.
  if (args.background && args.idempotency_key !== undefined) invalid('Background reads do not accept idempotency_key.');
  const signature = typeof args.idempotency_key === 'string'
    ? contractFingerprint([model?.id ?? null, entry.id, args.input ?? {}, args.expected_revision ?? null]) : '';
  const key = typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined;
  const requests = applied.get(host);
  const previous = key === undefined ? undefined : requests?.get(key);
  if (previous) {
    if (previous.store !== model?.store || previous.signature !== signature) invalid('Idempotency key already belongs to another request or model.', 'conflict');
    if (previous.executionSignal?.aborted) {
      // The last caller cancelled this execution. Wait for it to release native state before starting the same key.
      // A native effect may already have run. Only retry if settlement released the key.
      const retry = () => key !== undefined && requests?.get(key) === previous
        ? previous.result
        : executeOperation(host, model, args, context, readOnly);
      return previous.result.then(retry, retry);
    }
    return collect(previous.result, previous.delivery, context, previous.commitState);
  }
  if (args.expected_revision !== undefined && args.expected_revision !== revision) {
    throw stale('The model revision changed. Inspect it again.');
  }
  const input = args.input ?? {};
  try { entry.validate(input); } catch (error) { invalid(error instanceof Error ? error.message : 'Invalid operation input.'); }
  let checkpoint = check;
  const markCommitted = () => {
    commitState.committed = true;
    activeRevision = useViewerStore.getState().mutationVersion;
    nativeModel = model ? useViewerStore.getState().models.get(model.id) : undefined;
  };
  const commit = <T>(write: () => T): T => {
    if (!writes || readOnly) throw internal('A read operation cannot commit changes.');
    checkpoint();
    commitState.committing = true;
    try {
      const value = write();
      markCommitted();
      return value;
    } finally { commitState.committing = false; }
  };
  const commitAsync = async <T>(write: () => Promise<T>, didCommit: (result: T) => boolean = value => value !== false): Promise<T> => {
    if (!writes || readOnly) throw internal('A read operation cannot admit durable writes.');
    checkpoint();
    commitState.committing = true;
    try {
      const value = await write();
      if (didCommit(value)) {
        markCommitted();
      }
      return value;
    } finally { commitState.committing = false; }
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
  const retained: Array<{ undo: () => void; deliver?: () => void | false }> = [];
  const retain = (undo: () => void, deliver?: () => void | false) => { retained.push({ undo, deliver }); };
  const operationContext = { checkpoint: check, model, host, commit, commitAsync, ownGeometry, retain, artifacts };
  const settleResult = (delivered: boolean) => {
    let replayable = true;
    for (const record of retained.splice(0)) {
      try {
        if (delivered) {
          if (record.deliver?.() === false) replayable = false;
        } else {
          record.undo();
        }
      } catch (error) { console.warn('[viewer operation] settling a retained result failed', error); }
    }
    return replayable;
  };
  const discardResult = () => settleResult(false);
  const accepted = (result: unknown, finalCheck: () => void): unknown => {
    finalCheck();
    const bounded = boundedResult(result);
    entry.validateResult(bounded);
    return bounded;
  };
  check();
  if (!args.background) {
    const reversible = !writes || entry.candidateOnly === true;
    // Keyed work belongs to all its callers, regardless of the operation's effects.
    const executionAbort = key === undefined ? undefined : new AbortController();
    if (executionAbort) {
      const signals = host.lifetimeSignal ? [executionAbort.signal, host.lifetimeSignal] : [executionAbort.signal];
      executionContext = { ...context, signal: AbortSignal.any(signals) };
    }
    let finished = false;
    let acceptedForDelivery = false;
    let forget = () => {};
    const release = () => {
      if (!finished) {
        if (!commitState.committing && !commitState.committed) executionAbort?.abort();
        return;
      }
      if (commitState.committed) return;
      if (reversible && acceptedForDelivery) forget();
      discardResult();
    };
    const delivery = new ResultDelivery(() => { if (!settleResult(true)) forget(); }, release);
    if (executionAbort) demand = delivery;
    const run = async () => {
      // Nothing native has run yet, so a keyed retry of this failure may run again (#10669).
      try { await entry.load?.(); check(); if (!delivery.hasActiveCaller) throw cancelledDispatch(); } catch (error) { forget(); throw operationFailure(error, entry.id); }
      try {
        const result = await entry.execute(input, { ...executionContext, ...operationContext });
        const value = accepted(result, () => { if (!commitState.committed) check(); });
        acceptedForDelivery = true;
        return { operation_id: entry.id, model_id: model?.id ?? null, revision: activeRevision, state: entry.completion ?? 'succeeded', committed: commitState.committed, result: value };
      } catch (error) {
        if (commitState.committed) throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : 'Operation failed after committing changes.',
          details: { reason: 'internal', ...(error instanceof ToolExecutionError ? { cause_code: error.code, cause_reason: error.details?.reason, cause_details: withoutReason(error.details) } : {}),
            committed: true, revision: activeRevision, operation_id: entry.id, model_id: model?.id ?? null } });
        // Reads and candidate-only handlers have no durable effects to deduplicate.
        if (reversible) forget();
        discardResult();
        throw operationFailure(error, entry.id);
      } finally {
        finished = true;
        if (commitState.committed) retained.length = 0;
        if (!delivery.pending) release();
      }
    };
    // Defer native work until the initiating caller has registered its claim.
    const start = () => Promise.resolve().then(run);
    if (key === undefined) return collect(start(), delivery, context, commitState);
    const prior = requests ?? new Map<string, AppliedRequest>();
    applied.set(host, prior);
    // Keep failed outcomes for irreversible native actions to avoid replaying partial effects.
    if (prior.size >= 100) throw unavailable('Host idempotency capacity reached (100 requests). Reconnect before creating further keyed requests.');
    const request: AppliedRequest = { signature, store: model?.store, result: start(), delivery, executionSignal: executionAbort?.signal, commitState };
    // Registered before run() starts, so even an immediate pre-dispatch failure can remove it.
    prior.set(key, request);
    forget = () => { if (prior.get(key) === request) prior.delete(key); };
    return collect(request.result, delivery, context, commitState);
  }
  const owned = jobs(host);
  // Finished jobs make room, delivered or failed ones first; an uncollected result goes only when nothing else can.
  const uncollected = (job: LiveJob) => job.snapshot.state === 'succeeded' && !job.delivered;
  for (const evictUncollected of [false, true]) {
    for (const [id, job] of owned) {
      if (owned.size < MAX_JOBS) break;
      if (job.snapshot.state === 'running' || job.delivery.pending || uncollected(job) !== evictUncollected) continue;
      owned.delete(id);
      if (evictUncollected) job.discard(); // its result will never be collected
    }
  }
  if (owned.size >= MAX_JOBS) throw unavailable('This host already has 32 running operation jobs.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal?.addEventListener('abort', abort, { once: true });
  host.lifetimeSignal?.addEventListener('abort', abort, { once: true });
  if (context.signal?.aborted) controller.abort();
  const snapshot: OperationJob = { id: crypto.randomUUID(), operation_id: entry.id, model_id: model?.id ?? null, revision, state: 'running' };
  const active = () => { controller.signal.throwIfAborted(); check(); };
  checkpoint = active;
  const job: LiveJob = { snapshot, abort: controller, current: check, discard: discardResult,
    delivery: new ResultDelivery(() => { job.delivered = true; settleResult(true); }, () => {
      // A still-collectible job can be polled again. A terminal refusal leaves only the existing claims.
      if (snapshot.state === 'failed' || snapshot.state === 'cancelled') discardResult();
    }) };
  owned.set(snapshot.id, job);
  // Retain and settle the actual service promise. Cancellation never claims rollback.
  void Promise.resolve().then(() => { active(); return entry.execute(input, { ...context, ...operationContext, signal: controller.signal, checkpoint: active, progress: detail => {
      active(); snapshot.progress = detail;
    } }); })
    .then(result => { snapshot.result = accepted(result, active); snapshot.state = 'succeeded'; })
    .catch((error: unknown) => {
      if (!commitState.committed) discardResult();
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

export function operationJob(host: ToolHost, id: string, cancel = false, claimDelivery?: ToolCallContext['claimDelivery']): OperationJob {
  const job = jobs(host).get(id);
  if (!job) invalid('Unknown job for this viewer host.', 'unknown-target');
  if (cancel && job.snapshot.state === 'running') job.abort.abort();
  if (job.snapshot.state === 'succeeded') {
    try { job.current(); } catch (error) {
      // A permanent refusal prevents new claims. Pending polls already hold the result; let one deliver it
      // or discard it when they all drop. A temporary refusal leaves the job available for another poll.
      const aborted = host.lifetimeSignal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')
        || (error instanceof ToolExecutionError && error.code === ToolErrorCode.CANCELLED);
      if (!job.delivered && (aborted || (error instanceof ToolExecutionError && error.code === ToolErrorCode.STATE_CHANGED))) {
        const refusal = aborted ? cancelledDispatch() : operationFailure(error, job.snapshot.operation_id);
        Object.assign(job.snapshot, { state: aborted ? 'cancelled' : 'failed', error: refusal.message, error_code: refusal.code,
          error_details: refusal.details, result: undefined });
        if (!job.delivery.pending) job.discard();
      }
      throw error;
    }
    if (!job.delivered) {
      const claim = job.delivery.claim();
      if (claimDelivery) claimDelivery(claim);
      else claim.deliver();
    }
  }
  // A cancellation request is observable, but terminal cancellation awaits runner settlement.
  return { ...job.snapshot, ...(cancel && job.snapshot.state === 'running' ? { cancellationRequested: true } : {}) };
}

export async function executeOperationRequest(host: ToolHost, args: Record<string, unknown>, context: ToolCallContext, readOnly: boolean) {
  if (typeof args.operation_id !== 'string') invalid('operation_id is required.');
  let entry: Operation;
  try { entry = viewerOperation(args.operation_id); } catch { invalid(unknownOperationMessage(args.operation_id), 'unknown-target'); }
  let model: ReadyModel | undefined;
  if (entry.needs === 'model') {
    const { resolveModel, usableModel } = await import('../main-viewer-dispatch');
    model = usableModel(resolveModel(host, args), 'store', entry.id);
  } else if (args.model_id !== undefined) {
    invalid('Viewer/session operations do not accept model_id.');
  }
  return executeOperation(host, model, args, context, readOnly);
}
