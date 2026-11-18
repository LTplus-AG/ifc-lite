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
import { click, waitFor } from '@/test/render.js';
import { loadDialogs } from '@/test/dialog-host.js';
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
function probedStepFile(probe: FileProbe, size = ABOVE_SAB_THRESHOLD, name = 'sab-streaming.ifc'): File {
  const file = new File([STEP_BYTES], name);
  Object.defineProperty(file, 'size', { value: size });

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
  holder.SharedArrayBuffer = function RecordingSharedArrayBuffer(byteLength: number): SharedArrayBuffer {
    sizes.push(byteLength);
    return new real(Math.min(byteLength, STEP_BYTES.byteLength));
  } as unknown as SharedArrayBufferConstructor;
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
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const { ConfirmDialogHost } = await loadDialogs();
  await act(async () => {
    root!.render(<><Probe /><ConfirmDialogHost /></>);
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

// #10264: exercise the real loader, including header detection for renamed IFC
// files and the federation entry. No giant fixture is allocated by this test.
for (const name of ['large.ifc', 'renamed.bin']) {
  for (const kind of ['primary', 'federated'] as const) {
    it(`#10264 refuses a 1 GB+ ${kind} IFC (${name}) before reading or allocating its source`, async () => {
      const memory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
      const cores = Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency');
      Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 4 });
      Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 32 });
      const probe: FileProbe = { arrayBuffer: 0, stream: 0 };
      const sizes: number[] = [];
      const errors: string[] = [];
      if (kind === 'federated') useViewerStore.setState(fixtureModels(fixtureModel('already-loaded')));
      const existingModels = new Map(useViewerStore.getState().models);
      try {
        await withRecordedSharedArrayBuffer(sizes, async () => {
          await act(async () => {
            await hookApi!.loadFile(probedStepFile(probe, 1.26e9, name),
              { kind, modelId: 'memory-refusal' }, { onLoadError: (message) => errors.push(message) });
          });
        });
        assert.equal(errors.length, 1, 'the caller receives the refusal, not an engine/network failure');
        assert.match(errors[0], /local processing memory budget/);
        assert.match(errors[0], /smaller model|native CLI\/server/);
        assert.deepEqual(probe, { arrayBuffer: 0, stream: 0 }, 'no whole-source read started');
        assert.deepEqual(fileSized(sizes), [], 'no file-sized shared source was allocated');
        assert.equal(useViewerStore.getState().loading, false, 'the refusal settles the load UI');
        if (kind === 'federated') {
          const models = useViewerStore.getState().models;
          assert.deepEqual([...models.keys()], [...existingModels.keys()], 'no new model is registered');
          for (const [id, model] of existingModels) assert.equal(models.get(id), model, 'existing models are untouched');
        }
      } finally {
        if (memory) Object.defineProperty(navigator, 'deviceMemory', memory);
        else Reflect.deleteProperty(navigator, 'deviceMemory');
        if (cores) Object.defineProperty(navigator, 'hardwareConcurrency', cores);
        else Reflect.deleteProperty(navigator, 'hardwareConcurrency');
      }
    });
  }
}

for (const kind of ['primary', 'federated'] as const) {
  for (const proceed of [false, true]) it(`#10264 ${kind}: 8 GB warning ${proceed ? 'Continue permits' : 'Cancel prevents'} source acquisition`, async () => {
    const memory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
    const probe: FileProbe = { arrayBuffer: 0, stream: 0 }, sizes: number[] = [];
    useViewerStore.setState(fixtureModels(fixtureModel('existing')));
    const before = new Map(useViewerStore.getState().models);
    try {
      await withRecordedSharedArrayBuffer(sizes, async () => {
        let pending: Promise<void> | undefined;
        await act(async () => { pending = hookApi!.loadFile(probedStepFile(probe, 1.26e9), { kind, modelId: 'memory-consent' }); });
        await waitFor(() => !!document.querySelector('[role="alertdialog"]'), 'memory consent opens before any source allocation');
        assert.deepEqual(probe, { arrayBuffer: 0, stream: 0 });
        assert.deepEqual(fileSized(sizes), []);
        const dialog = document.querySelector('[role="alertdialog"]')!;
        assert.match(dialog.textContent ?? '', /about 9.9 GiB/);
        const buttons = dialog.querySelectorAll('button');
        click(buttons[proceed ? 1 : 0]);
        await act(async () => { await pending; });
        assert.equal(probe.stream, proceed ? 1 : 0);
        assert.equal(fileSized(sizes).length, proceed ? 1 : 0);
        if (!proceed) {
          assert.deepEqual([...useViewerStore.getState().models], [...before], 'Cancel preserves the loaded scene');
          assert.equal(useViewerStore.getState().error, null, 'Cancel is not a load failure');
        }
      });
    } finally {
      if (memory) Object.defineProperty(navigator, 'deviceMemory', memory);
      else Reflect.deleteProperty(navigator, 'deviceMemory');
    }
  });
}
