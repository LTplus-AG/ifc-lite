/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Serving one paired session's calls (#9523): admission (see
 * `call-admission.ts`), one AbortController and a tab-side time limit per
 * call, results bounded by the bridge's validator, and one activity row per
 * call with no arguments or results. A cancelled call's late result is not
 * sent: the bridge has already settled it and would drop it.
 */

import type { BridgeCallMessage } from '@ifc-lite/mcp/bridge-protocol';
import type { AgentBridgeActivity } from './state';
import { buildResultFrame, toCallToolResult, type ToolOutcome } from './result-frame';
import { CallAdmission, type CallLimits } from './call-admission';

const encoder = new TextEncoder();
const utf8Bytes = (text: string): number => encoder.encode(text).byteLength;

function warn(message: string, err?: unknown): void {
  console.warn(`[agent-bridge] ${message}`, ...(err === undefined ? [] : [err]));
}

interface InFlight {
  controller: AbortController;
  tool: string;
  modelId: string | null;
  startedAt: number;
}

export interface CallRunnerOptions {
  sessionId: string;
  limits: CallLimits;
  maxResultBytes: number;
  now: () => number;
  dispatch(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome>;
  modelIdFor?(args: Record<string, unknown>): string | null;
  onActivity?(entry: AgentBridgeActivity): void;
  /** Send one frame on the session's socket. */
  send(json: string): void;
  /** False once the session has ended: nothing more is started or sent. */
  isLive(): boolean;
  /** The peer sent more calls than allowed: end the session. */
  onFlood(): void;
}

export class CallRunner {
  private readonly inFlight = new Map<string, InFlight>();
  private readonly queued = new Set<string>();
  private readonly admission: CallAdmission<BridgeCallMessage>;
  private readonly limits: CallLimits;
  private seq = 0;

  constructor(private readonly opts: CallRunnerOptions) {
    this.limits = opts.limits;
    this.admission = new CallAdmission(opts.limits, opts.now);
  }

  private now(): number { return this.opts.now(); }
  private live(): boolean { return this.opts.isLive(); }

  /** True when `id` is running or queued (a duplicate `call` is ignored). */
  has(id: string): boolean { return this.inFlight.has(id) || this.queued.has(id); }

  /** The bridge cancelled `id`: drop it from the queue, or abort it. */
  cancel(id: string): void {
    if (this.admission.drop(id)) {
      this.queued.delete(id);
      return;
    }
    this.inFlight.get(id)?.controller.abort();
  }

  /** The session ended: abort every running call and forget the queue. */
  abortAll(): void {
    for (const call of this.inFlight.values()) call.controller.abort();
    this.inFlight.clear();
    this.admission.clear();
    this.queued.clear();
  }

  /** A `call` frame for this session arrived. */
  admit(call: BridgeCallMessage): void {
    let argumentBytes: number;
    try {
      argumentBytes = utf8Bytes(JSON.stringify(call.arguments));
    } catch (err) {
      warn('could not measure call arguments', err);
      argumentBytes = Number.POSITIVE_INFINITY;
    }
    switch (this.admission.admit(call.id, call, argumentBytes)) {
      case 'run':
        void this.serve(call);
        return;
      case 'queue':
        this.queued.add(call.id);
        return;
      case 'flood':
        this.opts.onFlood();
        return;
      case 'too-large':
        this.refuse(call, 'INVALID_INPUT',
          `The arguments of ${call.name} are larger than the viewer accepts (${this.limits.maxArgumentBytes} bytes).`);
        return;
      case 'busy':
        this.refuse(call, 'RATE_LIMITED',
          `The viewer is busy with ${this.limits.maxRunning + this.limits.maxQueued} calls. Retry ${call.name} when they finish.`);
        return;
    }
  }

  /** Answer a call at once without dispatching it. */
  private refuse(call: BridgeCallMessage, errorCode: string, text: string): void {
    const entry: InFlight = { controller: new AbortController(), tool: call.name, modelId: null, startedAt: this.now() };
    this.record(entry, { outcome: 'error', errorCode });
    this.reply(call, { text, structured: null, isError: true, errorCode });
  }

  private async serve(call: BridgeCallMessage): Promise<void> {
    const entry: InFlight = {
      controller: new AbortController(),
      tool: call.name,
      modelId: this.modelIdFor(call.arguments),
      startedAt: this.now(),
    };
    this.inFlight.set(call.id, entry);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      entry.controller.abort();
    }, this.limits.callTimeoutMs);
    let outcome: ToolOutcome;
    try {
      outcome = await this.opts.dispatch(call.name, call.arguments, entry.controller.signal);
    } catch (err) {
      outcome = { text: err instanceof Error ? err.message : String(err), structured: null, isError: true, errorCode: 'INTERNAL_ERROR' };
    } finally {
      clearTimeout(timer);
    }
    const stillPending = this.inFlight.get(call.id) === entry;
    if (stillPending) this.inFlight.delete(call.id);
    if (timedOut) {
      outcome = {
        text: `The viewer stopped ${call.name} after ${Math.round(this.limits.callTimeoutMs / 1000)} s.`,
        structured: null, isError: true, errorCode: 'TIMEOUT',
      };
    }
    const cancelled = entry.controller.signal.aborted && !timedOut;
    this.record(entry, cancelled ? { outcome: 'cancelled', errorCode: 'CANCELLED' }
      : outcome.isError ? { outcome: 'error', errorCode: outcome.errorCode ?? 'INTERNAL_ERROR' } : { outcome: 'ok' });
    // A cancelled call is already settled on the bridge, and a closed socket has no one to answer.
    if (!cancelled && stillPending) this.reply(call, outcome);
    this.startNext();
  }

  /** Hand the freed slot to the next queued call, after yielding so input (Disconnect) is processed first. */
  private startNext(): void {
    if (!this.live()) return;
    const next = this.admission.release();
    if (!next) return;
    setTimeout(() => {
      this.queued.delete(next.id);
      if (!this.live()) return;
      void this.serve(next);
    }, 0);
  }

  private reply(call: BridgeCallMessage, outcome: ToolOutcome): void {
    if (!this.live()) return;
    try {
      const frame = buildResultFrame(this.opts.sessionId, call.id, toCallToolResult(outcome), this.opts.maxResultBytes);
      if (frame.truncated) warn(`the result of ${call.name} was more than the bridge accepts and was truncated`);
      this.opts.send(frame.json);
    } catch (err) {
      warn(`could not send the result of ${call.name}`, err);
    }
  }

  private modelIdFor(args: Record<string, unknown>): string | null {
    try {
      return this.opts.modelIdFor?.(args) ?? null;
    } catch (err) {
      warn('could not tell which model a call is about', err);
      return null;
    }
  }

  private record(entry: InFlight, result: Pick<AgentBridgeActivity, 'outcome' | 'errorCode'>): void {
    const row: AgentBridgeActivity = {
      seq: ++this.seq,
      tool: entry.tool,
      modelId: entry.modelId,
      startedAt: entry.startedAt,
      durationMs: Math.max(0, this.now() - entry.startedAt),
      ...result,
    };
    try {
      this.opts.onActivity?.(row);
    } catch (err) {
      warn('the activity listener failed', err);
    }
  }
}
