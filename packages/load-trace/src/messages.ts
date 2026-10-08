/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { perfCounters, type PerfCounterRegistry } from './counters.js';

/**
 * Worker message accounting (#6957): the ONE wrapper every loader worker
 * boundary goes through. It patches the worker's `postMessage` (main -> worker,
 * `out`) and listens for its messages (worker -> main, `in`), adding per label:
 *
 *   msg.<label>.<dir>.count          messages
 *   msg.<label>.<dir>.cloneBytes     estimated structured-clone payload
 *   msg.<label>.out.transferBytes    ArrayBuffers in the transfer list (moved, not copied)
 *   msg.<label>.in.bufferBytes       ArrayBuffers received: the receiver cannot
 *                                    tell a transferred buffer from a cloned one
 *   msg.<label>.<dir>.sharedBytes    SharedArrayBuffers (shared, never copied)
 *
 * With counters off at wrap time it returns the worker untouched, so the
 * production path keeps the native `postMessage`. Load-trace control messages
 * are not counted (they exist only while tracing).
 */

export interface MessageEndpoint {
  postMessage(message: unknown, transfer?: unknown): void;
  /** Absent on a bare port double: then only the outbound side is counted. */
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export interface CloneEstimate { cloneBytes: number; transferBytes: number; sharedBytes: number }

const isTraceControl = (message: unknown) => {
  const type = (message as { type?: unknown } | null)?.type;
  return typeof type === 'string' && type.startsWith('load-trace:');
};

function transferSet(arg: unknown): Set<unknown> {
  const list = Array.isArray(arg) ? arg : (arg as { transfer?: unknown[] } | null | undefined)?.transfer;
  return new Set(list ?? []);
}

/**
 * Estimate what structured clone serialises for `value`. Typed-array views
 * count their WHOLE backing buffer once (clone copies the buffer, not the
 * view's window); strings count one byte per code unit; numbers 8. Iterative,
 * so a deep payload cannot overflow the stack.
 */
export function estimateCloneBytes(
  value: unknown, transferred: (buffer: ArrayBuffer) => boolean = () => false,
): CloneEstimate {
  const out: CloneEstimate = { cloneBytes: 0, transferBytes: 0, sharedBytes: 0 };
  const seen = new Set<unknown>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    switch (typeof v) {
      case 'string': out.cloneBytes += v.length; continue;
      case 'number': case 'bigint': out.cloneBytes += 8; continue;
      case 'boolean': out.cloneBytes += 1; continue;
      case 'object': break;
      default: continue;
    }
    if (v === null || seen.has(v)) continue;
    seen.add(v);
    if (ArrayBuffer.isView(v)) { stack.push(v.buffer); continue; }
    if (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer) { out.sharedBytes += v.byteLength; continue; }
    if (v instanceof ArrayBuffer) {
      if (transferred(v)) out.transferBytes += v.byteLength; else out.cloneBytes += v.byteLength;
      continue;
    }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) stack.push(v[i]); continue; }
    if (v instanceof Map) { for (const [k, e] of v) stack.push(k, e); continue; }
    if (v instanceof Set) { for (const e of v) stack.push(e); continue; }
    if (v instanceof Date) { out.cloneBytes += 8; continue; }
    for (const key of Object.keys(v)) {
      out.cloneBytes += key.length;
      stack.push((v as Record<string, unknown>)[key]);
    }
  }
  return out;
}

export function accountWorkerMessages<W extends MessageEndpoint>(
  worker: W, label: string | (() => string), registry: PerfCounterRegistry = perfCounters,
): W {
  if (!registry.enabled) return worker;
  // A pooled worker (#7036) changes role between loads, so it passes a getter.
  const prefixOf = typeof label === 'function' ? () => `msg.${label()}` : () => `msg.${label}`;
  const nativePost = worker.postMessage.bind(worker);
  const counted: MessageEndpoint['postMessage'] = (message, transfer) => {
    if (!isTraceControl(message)) {
      const list = transferSet(transfer);
      const est = estimateCloneBytes(message, (b) => list.has(b));
      const prefix = prefixOf();
      registry.add(`${prefix}.out.count`);
      registry.add(`${prefix}.out.cloneBytes`, est.cloneBytes);
      registry.add(`${prefix}.out.transferBytes`, est.transferBytes);
      registry.add(`${prefix}.out.sharedBytes`, est.sharedBytes);
    }
    nativePost(message, transfer);
  };
  (worker as MessageEndpoint).postMessage = counted;
  worker.addEventListener?.('message', ({ data }) => {
    if (isTraceControl(data)) return;
    // A received ArrayBuffer may have been transferred or cloned; this side
    // cannot tell, so every buffer lands in bufferBytes, the rest in cloneBytes.
    const est = estimateCloneBytes(data, () => true);
    const prefix = prefixOf();
    registry.add(`${prefix}.in.count`);
    registry.add(`${prefix}.in.cloneBytes`, est.cloneBytes);
    registry.add(`${prefix}.in.bufferBytes`, est.transferBytes);
    registry.add(`${prefix}.in.sharedBytes`, est.sharedBytes);
  });
  return worker;
}
