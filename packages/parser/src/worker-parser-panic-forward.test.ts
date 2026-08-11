/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2527 follow-up: `parser.worker.ts` also loads the wasm engine
 * (`IfcParser.parseColumnar` calls into `IfcAPI`), so a Rust panic there
 * stashes its location on the PARSER worker's own global — invisible to the
 * main thread's `attachWasmPanicLocation` gate for the same reason a
 * geometry-worker trap was (see `geometry-parallel-panic-forward.test.ts`).
 *
 * This pins that `WorkerParser.parseColumnar` reads the
 * `wasmPanicLocation`/`wasmPanicAt` fields the worker forwards on its
 * `{type:'error'}` message and re-plants them on `globalThis` under
 * `__ifclite_wasm_panic` before rejecting, so the existing #2527 gate picks
 * a parser-worker trap up unmodified.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerParser } from './worker-parser.js';
import { WASM_PANIC_STASH_KEY } from './wasm-panic-forward.js';

class FakeWorker {
  postMessage: (msg: unknown) => void;
  terminate = vi.fn();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor(onPost: (self: FakeWorker, msg: unknown) => void) {
    this.postMessage = vi.fn((msg: unknown) => onPost(this, msg));
  }
}

let originalWorker: unknown;

function globalStash(): unknown {
  return (globalThis as Record<string, unknown>)[WASM_PANIC_STASH_KEY];
}

beforeEach(() => {
  originalWorker = (globalThis as Record<string, unknown>).Worker;
  delete (globalThis as Record<string, unknown>)[WASM_PANIC_STASH_KEY];
});

afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = originalWorker;
  delete (globalThis as Record<string, unknown>)[WASM_PANIC_STASH_KEY];
  vi.restoreAllMocks();
});

function installFakeWorker(
  panicLocation: string | undefined,
  panicAt: number | undefined,
  message = 'unreachable',
): void {
  (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (this: unknown) {
    return new FakeWorker((self, msg) => {
      const m = msg as { type?: string; id?: string };
      if (m.type === 'parse') {
        queueMicrotask(() => {
          self.onmessage?.({
            data: {
              type: 'error',
              id: m.id,
              message,
              ...(panicLocation !== undefined ? { wasmPanicLocation: panicLocation } : {}),
              ...(panicAt !== undefined ? { wasmPanicAt: panicAt } : {}),
            },
          });
        });
      }
    });
  }) as unknown as typeof Worker;
}

describe('WorkerParser forwards a parser worker realm panic location', () => {
  it('re-plants the worker-forwarded location on globalThis before rejecting', async () => {
    const at = Date.now();
    installFakeWorker('parser/src/tokenizer.rs:88:5', at);
    const parser = new WorkerParser();
    const source = new SharedArrayBuffer(8);
    await expect(parser.parseColumnar(source)).rejects.toThrow('unreachable');
    expect(globalStash()).toEqual({ location: 'parser/src/tokenizer.rs:88:5', at });
  });

  it('leaves globalThis untouched when the worker error carries no panic location', async () => {
    installFakeWorker(undefined, undefined);
    const parser = new WorkerParser();
    const source = new SharedArrayBuffer(8);
    await expect(parser.parseColumnar(source)).rejects.toThrow('unreachable');
    expect(globalStash()).toBeUndefined();
  });

  // Mirrors geometry-parallel-panic-forward.test.ts: a worker forwards its
  // panic fields on ANY {type:'error'} message, so a stash left from an
  // earlier, suppressed panic can ride out on an ordinary, non-trap parser
  // error. The trap-shape gate on restashWasmPanicLocation must block the
  // re-plant through the real WorkerParser path.
  it('does not re-plant a location forwarded alongside a non-trap worker error', async () => {
    installFakeWorker('parser/src/tokenizer.rs:88:5', Date.now(), 'malformed STEP header');
    const parser = new WorkerParser();
    const source = new SharedArrayBuffer(8);
    await expect(parser.parseColumnar(source)).rejects.toThrow('malformed STEP header');
    expect(globalStash()).toBeUndefined();
  });
});
