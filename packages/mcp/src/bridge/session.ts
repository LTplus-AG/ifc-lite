/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One paired tab's session for `--bridge` (#9523): its socket, what it offers,
 * and the calls waiting on it.
 *
 * Call ids are unique for the process lifetime (a shared counter), and a reply
 * only settles a call pending in THIS session's map, so a reply from an
 * earlier tab, an unknown id or a second reply to the same call is ignored.
 */

import type { WebSocket, RawData } from 'ws';
import { describeThrown } from '../errors.js';
import { BRIDGE_LIMITS } from './protocol.js';
import type {
  BridgeCallResult,
  BridgePermission,
  BridgeServerMessage,
  BridgeToolDescriptor,
  BridgeErrorCode,
} from './protocol.js';

export type BridgeCallFailure =
  | 'no-viewer'
  | 'disconnected'
  | 'replaced'
  | 'timeout'
  | 'cancelled'
  | 'read-only'
  | 'unknown-tool'
  | 'shutting-down'
  | 'malformed-result'
  | 'invalid-arguments'
  | 'backpressure';

export class BridgeCallError extends Error {
  constructor(readonly reason: BridgeCallFailure, message: string) {
    super(message);
    this.name = 'BridgeCallError';
  }
}

interface Pending {
  name: string;
  resolve(result: BridgeCallResult): void;
  reject(err: BridgeCallError): void;
}

let callCounter = 0;

export class BridgeSession {
  readonly connectedAt = new Date();
  private readonly pending = new Map<string, Pending>();

  constructor(
    readonly ws: WebSocket,
    readonly id: string,
    public tabPermission: BridgePermission,
    public tools: BridgeToolDescriptor[],
    readonly client: { name: string; version?: string } | undefined,
    private readonly log: (line: string) => void,
  ) {}

  send(msg: BridgeServerMessage): void {
    this.sendText(JSON.stringify(msg));
  }

  /** Send a `call` and wait for its `result`, a timeout, a cancel or the session's end. */
  call(name: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<BridgeCallResult> {
    const fail = (reason: BridgeCallFailure, message: string) => Promise.reject(new BridgeCallError(reason, message));
    if (signal?.aborted) return fail('cancelled', `Call to '${name}' was cancelled.`);
    // Outbound bounds: a stalled or slow tab must not let calls or queued bytes pile up.
    if (this.pending.size >= BRIDGE_LIMITS.maxPendingCalls) {
      return fail('backpressure', `The viewer already has ${BRIDGE_LIMITS.maxPendingCalls} calls waiting; retry when some have answered.`);
    }
    const id = `c${++callCounter}`;
    let frame: string;
    try {
      // 1e999 parses to Infinity and would silently go out as null: refuse it.
      frame = JSON.stringify({ type: 'call', sessionId: this.id, id, name, arguments: args }, (_key, v: unknown) => {
        if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('arguments contain a non-finite number');
        return v;
      });
    } catch (err) {
      return fail('invalid-arguments', `The arguments for '${name}' cannot be sent: ${describeThrown(err)}`);
    }
    const bytes = Buffer.byteLength(frame, 'utf8');
    if (bytes > BRIDGE_LIMITS.maxCallBytes) {
      return fail('invalid-arguments', `The arguments for '${name}' are ${bytes} bytes; the limit is ${BRIDGE_LIMITS.maxCallBytes}.`);
    }
    // Counted with this frame, so the queue never exceeds the bound.
    if (this.ws.bufferedAmount + bytes > BRIDGE_LIMITS.maxBufferedBytes) {
      return fail('backpressure', 'The viewer is not reading its socket fast enough; retry later.');
    }
    const settled = new Promise<BridgeCallResult>((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        finish();
        this.send({ type: 'cancel', sessionId: this.id, id, reason: 'timeout' });
        reject(new BridgeCallError('timeout', `The viewer did not answer '${name}' within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      const onAbort = (): void => {
        finish();
        this.send({ type: 'cancel', sessionId: this.id, id, reason: 'cancelled' });
        reject(new BridgeCallError('cancelled', `Call to '${name}' was cancelled.`));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        name,
        resolve: (r) => { finish(); resolve(r); },
        reject: (e) => { finish(); reject(e); },
      });
    });
    this.sendText(frame);
    return settled;
  }

  private sendText(text: string): void {
    if (this.ws.readyState === this.ws.OPEN) sendText(this.ws, text, this.log);
  }

  /** Settle a pending call with the tab's result. False when `id` is not pending here. */
  settle(id: string, result: BridgeCallResult): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.resolve(result);
    return true;
  }

  /** Fail one pending call (malformed reply). False when `id` is not pending here. */
  failOne(id: string, reason: BridgeCallFailure, message: (name: string) => string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.reject(new BridgeCallError(reason, message(p.name)));
    return true;
  }

  /** Fail every pending call at once. */
  failAll(reason: BridgeCallFailure, message: string): void {
    // A copy: reject() deletes from `pending` while this loop runs.
    for (const p of Array.from(this.pending.values())) p.reject(new BridgeCallError(reason, `${message} (call: '${p.name}')`));
    this.pending.clear();
  }
}

function sendText(ws: WebSocket, text: string, log: (line: string) => void): void {
  ws.send(text, (err) => {
    if (err) log(`send failed: ${describeThrown(err)}`);
  });
}

function sendFrame(ws: WebSocket, msg: BridgeServerMessage, log: (line: string) => void): void {
  sendText(ws, JSON.stringify(msg), log);
}

/** Send an `error` frame, then close with `closeCode`. */
export function failSocket(ws: WebSocket, code: BridgeErrorCode, message: string, closeCode: number, log: (line: string) => void): void {
  if (ws.readyState === ws.OPEN) sendFrame(ws, { type: 'error', code, message }, log);
  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(closeCode, code);
}

export function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/** Best-effort call `id` from a frame that failed validation, if it names `sessionId`. */
export function looseId(text: string, sessionId: string): string | null {
  try {
    const raw = JSON.parse(text) as { id?: unknown; sessionId?: unknown } | null;
    // Ids the bridge issues are short; a long one cannot name a pending call.
    return raw?.sessionId === sessionId && typeof raw.id === 'string' && raw.id.length <= 64 ? raw.id : null;
  } catch {
    // Not JSON at all: there is no id to recover.
    return null;
  }
}
