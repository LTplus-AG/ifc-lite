/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3790, third hop: `parser.worker.ts` itself must carry the
 * malformed-record stop off the `set-entity-index` message and into the
 * `preScannedEntityIndex` it hands `parseColumnar`.
 *
 * `set-entity-index-oversized-count.test.ts` pins the two hops on the
 * `WorkerParser` side, but it drives a fully synthetic `Worker` and never runs
 * a line of this file, so the stash-and-forward here is invisible to it: this
 * worker could drop the field between `pendingEntityIndex` and
 * `preScannedEntityIndex` and every one of those tests would stay green.
 *
 * Asserted through the `diagnostic` message the worker posts back, not through
 * an internal, because that is what a host actually observes.
 *
 * `parser.worker.ts` assigns `self.onmessage = ...` at module scope, which
 * needs a `self` global -- absent under vitest's default Node environment. The
 * `self`/`postMessage` polyfill and the cache-busted dynamic import mirror
 * `parser-worker-panic-forward.test.ts`; see its header for why the import is
 * per-test and why the hook timeout is generous.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fromTransport, type DataStoreTransport } from './data-store-transport.js';
import { extractGeoreferencingOnDemand } from './on-demand-georeferencing.js';
import { contiguousSourceBytes } from './source-bytes.js';

const postedMessages: unknown[] = [];
let originalSelf: unknown;
let originalPostMessage: unknown;

let importCounter = 0;

/** Same one-time transform cost as the panic-forward sibling; same budget. */
const WORKER_IMPORT_HOOK_TIMEOUT_MS = 30_000;

const IFC = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t','',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);",
  "#2=IFCWALL('0000000000000000000002',$,'Wall2',$,$,$,$,$,$);",
  "#3=IFCSITE('0000000000000000000003',$,'Site',$,$,$,$,$,.ELEMENT.,(47,0,0),(8,0,0),0.,$,$);",
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

const RECORD_1 = "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);";

/** The SAB the host shares with the worker, holding the bytes above. */
function sharedSource(): SharedArrayBuffer {
  const bytes = new TextEncoder().encode(IFC);
  const sab = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(sab).set(bytes);
  return sab;
}

/**
 * The columns a pre-pass that stopped at `#2` produces: `#1` and nothing else.
 * Real byte offsets, so the refs rebuilt from them are real records.
 */
function columnsForFirstRecordOnly() {
  const start = IFC.indexOf(RECORD_1);
  return {
    ids: Uint32Array.from([1]),
    starts: Uint32Array.from([start]),
    lengths: Uint32Array.from([RECORD_1.length]),
  };
}

/** One cast, not four. */
const typeOf = (m: unknown): string | undefined => (m as { type?: string }).type;

/**
 * WAIT FOR THE WORKER TO SETTLE, NOT FOR A FIXED NUMBER OF TURNS.
 *
 * This used to drain 200 microtasks, one macrotask, then 200 more, and it made
 * one test out of 1,181 redden the whole Node-tests job: measured over 39
 * pushes to main, `Test` was red 15 times and 12 of those were this assertion.
 *
 * THE BUDGET WAS NEVER 400 TURNS. The parse yields through
 * `yield-to-event-loop.ts`, a MessageChannel round-trip in Node, which no
 * amount of microtask draining satisfies -- so the old helper's real budget was
 * exactly ONE event-loop turn, and this fixture needs exactly one. Zero
 * headroom. One extra crossing of `YIELD_INTERVAL_MS` (columnar-parser.ts) or
 * one hit of entity-scanner's `setTimeout(0)` on a loaded runner makes it two,
 * and the old code loses. Reproduced by deferring the worker's delivery a few
 * macrotasks: old 3 failed, new 4 passed.
 *
 * `vi.waitFor` polls the condition instead, and its timeout message NAMES the
 * wait and lists what did arrive. That matters more than it looks: a bare
 * deadline here would fail with `expected [ … ] to include 'complete'` -- the
 * exact text this change exists to stop producing -- and send the next reader
 * to re-diagnose a fixed bug.
 */
async function settle(): Promise<void> {
  await vi.waitFor(
    () => {
      const types = postedMessages.map(typeOf);
      if (!types.includes('complete') && !types.includes('error')) {
        throw new Error(`worker has not settled: saw [${types.join(', ')}]`);
      }
    },
    { timeout: 20_000, interval: 1 },
  );
}

function post(data: unknown): void {
  (self as unknown as Worker).onmessage!({ data } as unknown as MessageEvent);
}

/**
 * Start the parse the way the viewer does on this path. `waitForEntityIndex`
 * is load-bearing, not decoration: without it the worker eagerly compiles the
 * wasm scanner it will never use, that fetch fails under vitest, and the parse
 * dies before the scan ever runs.
 */
function startParse(): void {
  post({ type: 'parse', id: 'req-1', source: sharedSource(), waitForEntityIndex: true });
}

/**
 * The parse must actually have RUN. Without this, "no `stopped early`
 * diagnostic" is satisfied by a parse that died before the scan -- which is
 * exactly what happened while writing these controls: with
 * `waitForEntityIndex` unset the worker eagerly compiles the wasm scanner,
 * that fetch fails under vitest, and the only message posted back is
 * `{type:'error'}`. Both controls passed, proving nothing.
 */
function assertParsed(): void {
  const types = postedMessages.map(typeOf);
  const error = postedMessages.find((m) => typeOf(m) === 'error');
  if (error) throw new Error(`worker errored: ${(error as { message?: string }).message}`);
  expect(types).toContain('complete');
}

function diagnostics(): string[] {
  return postedMessages
    .filter((m) => typeOf(m) === 'diagnostic')
    .map((m) => (m as { message: string }).message);
}

beforeEach(async () => {
  postedMessages.length = 0;
  const g = globalThis as Record<string, unknown>;
  originalSelf = g.self;
  originalPostMessage = g.postMessage;
  g.self = globalThis;
  g.postMessage = (msg: unknown) => postedMessages.push(msg);
  importCounter += 1;
  await import('./parser.worker.js?t=' + importCounter);
}, WORKER_IMPORT_HOOK_TIMEOUT_MS);

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  if (originalSelf === undefined) delete g.self; else g.self = originalSelf;
  if (originalPostMessage === undefined) delete g.postMessage;
  else g.postMessage = originalPostMessage;
});

describe('parser.worker.ts and the #3790 set-entity-index handoff', () => {
  it('reports the stop the host handed it, through the diagnostic channel', async () => {
    post({
      type: 'set-entity-index',
      ...columnsForFirstRecordOnly(),
      oversizedIdCount: 0,
      malformedRecordCount: 1,
    });
    startParse();
    await settle();

    assertParsed();
    expect(diagnostics().some((m) => m.includes('stopped early'))).toBe(true);
  }, 30_000);

  it('stays silent when the host reported no stop', async () => {
    // The control. A worker that hard-coded the diagnostic, or that read a
    // stale flag from a previous handoff, would fire here too.
    post({
      type: 'set-entity-index',
      ...columnsForFirstRecordOnly(),
      oversizedIdCount: 0,
      malformedRecordCount: 0,
    });
    startParse();
    await settle();

    assertParsed();
    expect(diagnostics().some((m) => m.includes('stopped early'))).toBe(false);
  }, 30_000);

  it('stays silent when the host sent no such field at all', async () => {
    // Today's every-load case (#3699 unlanded): nothing reported must not be
    // turned into a warning any more than into a clean bill of health.
    post({
      type: 'set-entity-index',
      ...columnsForFirstRecordOnly(),
      oversizedIdCount: 0,
    });
    startParse();
    await settle();

    assertParsed();
    expect(diagnostics().some((m) => m.includes('stopped early'))).toBe(false);
  }, 30_000);
});

// #3983: execute the real worker handler; verify the receiver needs no entity
// lookups for its first georeference read (including the early spatial store).
it('prepares render metadata before publishing partial and complete stores (#3983)', async () => {
  const records = [...IFC.matchAll(/#(\d+)=[^;]+;/g)];
  post({ type: 'set-entity-index',
    ids: Uint32Array.from(records, r => Number(r[1])),
    starts: Uint32Array.from(records, r => r.index!),
    lengths: Uint32Array.from(records, r => r[0].length),
  });
  startParse();
  await settle();
  assertParsed();
  const messages = postedMessages.filter((m): m is { type: string; payload: DataStoreTransport } =>
    ['partial-store', 'complete'].includes((m as { type: string }).type));
  expect(messages).toHaveLength(2);
  for (const { payload } of messages) {
    const source = contiguousSourceBytes(new Uint8Array(sharedSource()), payload.sourceContentKey ?? undefined);
    // Full-fixture FNV-1a, independently calculated with Python integer arithmetic.
    expect(payload.sourceContentKey).toBe('16b-6d79a917');
    // toTransferable does not compute a key: this proves it arrived pre-seeded.
    expect(source.toTransferable().contentKey).toBe(payload.sourceContentKey);
    const store = fromTransport(structuredClone(payload), source);
    const lookups = vi.spyOn(store.entityIndex.byId, 'get');
    const georef = extractGeoreferencingOnDemand(store);
    expect(georef?.source).toBe('siteLocation');
    expect(georef?.projectedCRS?.name).toBe('EPSG:4326');
    expect(lookups).not.toHaveBeenCalled();
    lookups.mockRestore();
  }
}, 30_000);
