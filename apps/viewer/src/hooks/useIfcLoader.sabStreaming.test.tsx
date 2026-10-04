/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IFC/STEP load path acquires its bytes by streaming into a
 * `SharedArrayBuffer` — asserted by driving `useIfcLoader`, not by reading its
 * source (#2434).
 *
 * `loadFile` streams a file at or above `STREAM_SAB_THRESHOLD` (256 MiB)
 * straight into a pre-sized SAB instead of `await file.arrayBuffer()`, so peak
 * memory is ~`fileSize` rather than `2 × fileSize` when the geometry pipeline
 * copies into its own SAB (#600). Losing that call site does not break any
 * output — the load still succeeds — it just doubles peak memory on exactly
 * the files where that is fatal. So it needs a test of its own.
 *
 * This was previously pinned by scanning `useIfcLoader.ts` for
 * `await acquireFileBuffer(`. That scan reads the WHOLE module, so any other
 * helper or format path that happens to contain the same call satisfies it
 * while the IFC/STEP call site is replaced by `file.arrayBuffer()` — the
 * regression it names. It also could not distinguish a call from a mention
 * until it was hardened, which is the shape of assertion #2434 exists to
 * remove. Nothing below reads source text.
 *
 * **How a 256 MiB contract is driven in a unit test.** `file.size` is the only
 * input the streaming branch consults before it calls `file.stream()`, and it
 * is `defineProperty`-able on a real `File`; the bytes stay tiny. The
 * `SharedArrayBuffer` constructor is replaced by one that RECORDS the
 * requested size and hands back a SAB sized to the fixture's real length, so
 * the read completes (`acquireFileBuffer` rejects a short read) without any
 * run paying a quarter-gigabyte allocation.
 *
 * **The load then fails, after acquisition, and that is expected.** Node has no
 * fetchable WASM engine, so the run prints a `[Geometry] init` failure and the
 * store ends with a load error. Every assertion here is about how the bytes
 * were READ, which happens before format handling and before the engine is
 * touched; a failure that arrives EARLIER than the read cannot hide, because
 * it leaves the read counters at zero and fails the test.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { useIfcLoader } from './useIfcLoader.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';

/**
 * `STREAM_SAB_THRESHOLD` (apps/viewer/src/utils/ifcConfig.ts) is 256 MiB.
 * `acquireFileBuffer` streams at or above it and takes `file.arrayBuffer()`
 * below it, so a reported size past the threshold is what makes the streaming
 * branch — and any regression out of it — observable.
 */
const ABOVE_SAB_THRESHOLD = 256 * 1024 * 1024 + 1;

/**
 * A STEP header is all `detectFormat` needs to route this down the IFC/STEP
 * branch (`packages/ifcx/src/index.ts` matches `ISO-10303-21` in the first 100
 * bytes), and the branch is entered after the bytes are read. Using real STEP
 * content rather than a stand-in is what scopes this test to the IFC/STEP load
 * path: the file the loader is handed is the one whose reads are counted.
 */
const STEP_BYTES = new TextEncoder().encode(
  "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n"
  + "FILE_NAME('sab-streaming.ifc','2026-01-01T00:00:00',(''),(''),'','','');\n"
  + "FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
);

interface FileProbe {
  /** Whole-file reads through `file.arrayBuffer()` — the doubled-peak path. */
  arrayBuffer: number;
  /** Reads through `file.stream()` — how SAB streaming acquires bytes. */
  stream: number;
}

/**
 * A real `File` whose two read entry points are counted and whose reported
 * size sits above the SAB streaming threshold. `file.slice(...)` is untouched
 * on purpose: the loader's 4 KiB head slice for point-cloud detection is a
 * separate `Blob`, so it never lands in these counters.
 */
function probedStepFile(probe: FileProbe): File {
  const file = new File([STEP_BYTES], 'sab-streaming.ifc');
  Object.defineProperty(file, 'size', { value: ABOVE_SAB_THRESHOLD });

  const realArrayBuffer = file.arrayBuffer.bind(file);
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: (): Promise<ArrayBuffer> => {
      probe.arrayBuffer++;
      return realArrayBuffer();
    },
  });

  const realStream = file.stream.bind(file);
  Object.defineProperty(file, 'stream', {
    configurable: true,
    value: (): ReadableStream<Uint8Array> => {
      probe.stream++;
      return realStream() as ReadableStream<Uint8Array>;
    },
  });

  return file;
}

/**
 * Records every `new SharedArrayBuffer(n)` and returns one sized to the real
 * fixture bytes. `acquireFileBuffer` throws on a short read, so the substitute
 * has to be big enough to hold what the stream actually yields — and small
 * enough that the run stays free.
 */
function withRecordedSharedArrayBuffer<T>(sizes: number[], body: () => Promise<T>): Promise<T> {
  const holder = globalThis as { SharedArrayBuffer?: unknown };
  const real = holder.SharedArrayBuffer as SharedArrayBufferConstructor;
  const recording = function RecordingSharedArrayBuffer(byteLength: number): SharedArrayBuffer {
    sizes.push(byteLength);
    return new real(Math.min(byteLength, STEP_BYTES.byteLength));
  } as unknown as SharedArrayBufferConstructor;
  // Preserve the native brand checks used by the real loader and observer.
  Object.defineProperty(recording, 'prototype', { value: real.prototype });
  holder.SharedArrayBuffer = recording;
  return body().finally(() => {
    holder.SharedArrayBuffer = real;
  });
}

/**
 * Only a FILE-SIZED allocation is the one under test. The pipeline takes a
 * handful of small bookkeeping SABs (an 8-byte Atomics handshake); asserting
 * "exactly one SAB" would fail on those and tempt the next maintainer to
 * loosen the assertion rather than read it.
 */
function fileSized(sizes: number[]): number[] {
  return sizes.filter((n) => n >= 1024 * 1024);
}

let hookApi: ReturnType<typeof useIfcLoader> | null = null;

function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  hookApi = null;
  useViewerStore.getState().resetViewerState();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  if (container) container.remove();
  container = null;
});

describe('useIfcLoader - the IFC/STEP path keeps SAB streaming (#600)', () => {
  it('reads a file above the threshold through file.stream() into a file-sized SharedArrayBuffer', async () => {
    const probe: FileProbe = { arrayBuffer: 0, stream: 0 };
    const sabSizes: number[] = [];
    const file = probedStepFile(probe);

    await withRecordedSharedArrayBuffer(sabSizes, async () => {
      await act(async () => {
        await hookApi!.loadFile(file);
      });
    });

    // Reachability: an assertion about how a load read its bytes is worthless
    // if `loadFile` returned before it got that far.
    assert.equal(
      useViewerStore.getState().models.size,
      1,
      'loadFile must have registered the model - otherwise it never reached byte acquisition and the counters below are vacuous',
    );

    assert.equal(
      probe.stream,
      1,
      'a file at or above STREAM_SAB_THRESHOLD must be pulled through file.stream() - that is what streams it into a SharedArrayBuffer instead of paying a doubled peak (#600)',
    );
    assert.equal(
      probe.arrayBuffer,
      0,
      'the IFC/STEP path must not take a whole-file file.arrayBuffer() above the threshold - that is the doubled peak this streaming exists to avoid',
    );
    assert.deepEqual(
      fileSized(sabSizes),
      [ABOVE_SAB_THRESHOLD],
      'exactly one SharedArrayBuffer must be allocated at the file size, i.e. the destination the file streamed into',
    );
  });
});

/** Count real whole-source slice operations, not code text. Bounded UTF-8
 * prefix copies remain permitted; this fixture exceeds that prefix. */
async function observeSourceCopies(body: () => Promise<void>): Promise<number> {
  let copies = 0;
  const original = Uint8Array.prototype.slice;
  Uint8Array.prototype.slice = function(start?: number, end?: number) {
    if (this.buffer instanceof SharedArrayBuffer && this.byteLength === STEP_BYTES.byteLength) copies++;
    return original.call(this, start, end);
  };
  try {
    await body();
    return copies;
  } finally {
    Uint8Array.prototype.slice = original;
  }
}

it('ordinary large IFC reaches engine admission without a second full source allocation (#6537)', async () => {
  const reads = { arrayBuffer: 0, stream: 0 };
  const requested: number[] = [];
  const copies = await observeSourceCopies(() => withRecordedSharedArrayBuffer(requested, async () => {
    await act(async () => { await hookApi!.loadFile(probedStepFile(reads)); });
  }));
  assert.equal(reads.stream, 1, 'the real canonical loader reached source acquisition');
  assert.equal(useViewerStore.getState().models.size, 1);
  assert.equal(copies, 0, 'ordinary STEP must not materialize a second source before its owned consumers');
});

for (const residents of [1, 2]) {
  it(`federated admission with ${residents} resident model(s) keeps shared source and existing owners (#6537)`, async () => {
    const existing = Array.from({ length: residents }, (_, i) => fixtureModel(`resident-${i}`));
    useViewerStore.setState(fixtureModels(...existing));
    const reads = { arrayBuffer: 0, stream: 0 };
    const requested: number[] = [];
    const copies = await observeSourceCopies(() => withRecordedSharedArrayBuffer(requested, async () => {
      await act(async () => { await hookApi!.loadFile(probedStepFile(reads), { kind: 'federated', modelId: 'incoming' }); });
    }));
    assert.equal(reads.stream, 1, 'federated load reached the same canonical source acquisition');
    assert.equal(copies, 0);
    assert.equal(useViewerStore.getState().models.size, residents, 'engine refusal must preserve loaded owners');
    for (const model of existing) assert.equal(useViewerStore.getState().models.get(model.id), model);
  });
}

it('cancel during shared acquisition never materializes the superseded source (#6537)', async () => {
  const reads = { arrayBuffer: 0, stream: 0 };
  const file = probedStepFile(reads);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  Object.defineProperty(file, 'stream', { value: () => {
    reads.stream++;
    return new ReadableStream<Uint8Array>({ async start(controller) {
      entered();
      await gate;
      controller.enqueue(STEP_BYTES);
      controller.close();
    } });
  } });
  const requested: number[] = [];
  const copies = await observeSourceCopies(() => withRecordedSharedArrayBuffer(requested, async () => {
    const load = hookApi!.loadFile(file);
    try {
      await reading;
      const cancel = useViewerStore.getState().activeLoadCanceller;
      assert.ok(cancel, 'a real in-flight acquisition owns the cancel action');
      cancel();
    } finally {
      release();
      await load;
    }
  }));
  assert.equal(reads.stream, 1);
  assert.equal(copies, 0);
  assert.equal(useViewerStore.getState().ifcDataStore, null, 'cancelled source cannot publish parser output');
});
