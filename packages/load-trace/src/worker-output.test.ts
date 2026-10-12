/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  createPerfCounters, createWorkerPhaseTrace, createWorkerTraceHost,
  isTraceSpansMessage, meterTypedArrayArgs, type TraceSpansMessage,
} from './index.js';

describe('sender-side worker accounting (#6993)', () => {
  for (const kind of ['handler', 'phase'] as const) {
    it(`${kind}: preserves exact terminal transfers before detachment and termination`, async () => {
      const counters = createPerfCounters();
      const posted: unknown[] = [];
      let terminated = false;
      const endpoint = {
        postMessage(message: unknown, transfer?: unknown) {
          if (terminated) return; // the host ignores everything after complete
          posted.push(structuredClone(message, { transfer: transfer as Transferable[] | undefined }));
          if ((message as { type?: string }).type === 'complete') terminated = true;
        },
      };
      const options = {
        counters, endpoint: () => endpoint,
        post: (message: TraceSpansMessage) => endpoint.postMessage(message),
      };
      const host = createWorkerTraceHost({ ...options, spanNames: { parse: 'parser.parse' } });
      const phases = createWorkerPhaseTrace(options);
      const enable = { type: 'load-trace:enable', thread: kind };
      if (kind === 'handler') await host(enable, async () => {});
      else phases.accept(enable);

      const moved = new ArrayBuffer(32);
      const extra = new ArrayBuffer(8);
      const cloned = new ArrayBuffer(64);
      const shared = new SharedArrayBuffer(16);
      const run = async () => {
        const scanner = meterTypedArrayArgs({ scan: (source: Uint8Array) => source.length }, 'wasm', counters);
        expect(scanner.scan(new Uint8Array(shared))).toBe(16);
        endpoint.postMessage({ type: 'complete', a: new Uint8Array(moved), b: new Uint8Array(cloned, 0, 8), shared }, [moved, extra]);
      };
      if (kind === 'handler') await host({ type: 'parse' }, run);
      else { await run(); phases.flush(); }

      expect(moved.byteLength).toBe(0); // actual transfer, not a mock's return value
      expect(extra.byteLength).toBe(0); // transfers outside the payload still count
      expect(cloned.byteLength).toBe(64);
      const published = posted.filter(isTraceSpansMessage);
      expect(published).toHaveLength(1);
      expect(published[0].payload.counters).toMatchObject({
        'msg.worker.out.count': 1,
        'msg.worker.out.transferBytes': 40,
        'msg.worker.out.sharedBytes': 16,
        'wasm.bytesIn': 16,
        'wasm.scan.bytes': 16,
      });
      expect(published[0].payload.counters?.['msg.worker.out.cloneBytes']).toBe(84);
      expect((posted[1] as { a: Uint8Array }).a.byteLength).toBe(32);
    });

    it(`${kind}: reused endpoints publish each output once under the current load`, async () => {
      const counters = createPerfCounters();
      const posted: unknown[] = [];
      const endpoint = { postMessage: (message: unknown) => { posted.push(message); } };
      const nativePost = endpoint.postMessage;
      const options = { counters, endpoint: () => endpoint, post: (message: TraceSpansMessage) => endpoint.postMessage(message) };
      const host = createWorkerTraceHost({ ...options, spanNames: {} });
      const phases = createWorkerPhaseTrace(options);
      endpoint.postMessage({ type: 'ready' });
      expect(endpoint.postMessage).toBe(nativePost);
      expect(counters.read()).toEqual({});
      posted.length = 0;
      for (const thread of ['first', 'second']) {
        const enable = { type: 'load-trace:enable', thread };
        if (kind === 'handler') await host(enable, async () => {});
        else phases.accept(enable);
        endpoint.postMessage({ type: 'ready' });
      }
      const published = posted.filter(isTraceSpansMessage);
      expect(published.map((m) => [m.payload.thread, m.payload.counters?.['msg.worker.out.count']])).toEqual([
        ['first', 1], ['second', 1],
      ]);
    });
  }
});
