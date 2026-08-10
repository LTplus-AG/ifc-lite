/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How `useIfcFederation` acquires bytes — asserted by driving the hook, not by
 * reading its source (#2434).
 *
 * Two contracts live here:
 *
 * 1. **IFCX never SAB-streams** (memory guard for #647). IFCX is JSON, so the
 *    bytes are handed to `safeUtf8Decode` → `JSON.parse`. Cross-thread string
 *    decoding cannot read a `SharedArrayBuffer` directly, so a SAB-backed read
 *    forces a full-file scratch copy on top of the JSON string: peak becomes
 *    SAB + scratch + string, strictly worse than the plain `ArrayBuffer` path.
 *    Both IFCX entry points must therefore stay on `file.arrayBuffer()`.
 *
 * 2. **`addModel` delegates the read to the canonical `loadFile`** rather than
 *    acquiring bytes itself, so IFC/STEP keeps exactly one load pipeline (and
 *    with it the SAB streaming that `acquireFileBuffer` provides above
 *    `STREAM_SAB_THRESHOLD`).
 *
 * These were previously pinned by scanning `useIfcFederation.ts` for the
 * strings `file.arrayBuffer()` / `acquireFileBuffer` / `loadFile(` inside the
 * relevant function bodies. That scan could not fail for the regression it
 * named: a read routed through a module-scope SAB helper, or a `loadFile`
 * mentioned only in a comment, both leave the searched text intact. The
 * instrumentation below observes what the hook actually *does* with the File.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { useIfcFederation } from './useIfcFederation.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BASE_PATH = resolve(REPO_ROOT, 'tests/models/ifc5/Hello_Wall_hello-wall.ifcx');
const OVERLAY_PATH = resolve(REPO_ROOT, 'tests/models/ifc5/Hello_Wall_hello-wall-add-fire-rating-60.ifcx');
// Per AGENTS.md fixtures are fetched on demand; skip cleanly on a fresh
// checkout rather than crashing the suite.
const FIXTURES_AVAILABLE = existsSync(BASE_PATH) && existsSync(OVERLAY_PATH);

/**
 * `STREAM_SAB_THRESHOLD` (apps/viewer/src/utils/ifcConfig.ts) is 256 MiB, and
 * `acquireFileBuffer` only SAB-streams at or above it. Reporting a size past
 * that threshold is what makes a regression *observable*: a real 256 MiB
 * fixture is not affordable in a unit test, but `size` is the only thing the
 * SAB branch consults before it calls `file.stream()`. The bytes stay small.
 */
const ABOVE_SAB_THRESHOLD = 256 * 1024 * 1024 + 1;

interface FileProbe {
  /** Reads that went through `file.arrayBuffer()` — the required IFCX path. */
  arrayBuffer: number;
  /** Reads that went through `file.stream()` — how SAB streaming acquires bytes. */
  stream: number;
}

/**
 * A real `File` whose two read entry points are counted and whose reported
 * size sits above the SAB streaming threshold.
 */
function probedFile(path: string, name: string, probe: FileProbe): File {
  const file = new File([readFileSync(path)], name, { type: 'application/json' });
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
 * Counts `new SharedArrayBuffer(n)` without allocating: a caller that reaches
 * this stub has already lost the contract, and a truthful 256 MiB allocation
 * would just make the failing run expensive. The stub hands back a real
 * zero-length SAB so the caller's `new Uint8Array(sab)` still works and the
 * failure surfaces as this counter rather than a TypeError from the harness.
 */
function withCountedSharedArrayBuffer<T>(sizes: number[], body: () => Promise<T>): Promise<T> {
  // Only FILE-SIZED allocations are the defect. The IFCX pipeline legitimately
  // takes an 8-byte SAB for an Atomics handshake on its first run; asserting
  // "zero SABs" would fail on that and tempt the next maintainer to loosen the
  // assertion rather than read it.
  const holder = globalThis as { SharedArrayBuffer?: unknown };
  const real = holder.SharedArrayBuffer as SharedArrayBufferConstructor;
  holder.SharedArrayBuffer = function CountingSharedArrayBuffer(byteLength: number): SharedArrayBuffer {
    sizes.push(byteLength);
    return new real(0);
  } as unknown as SharedArrayBufferConstructor;
  return body().finally(() => {
    holder.SharedArrayBuffer = real;
  });
}

/**
 * The SAB-streaming regression allocates `new SharedArrayBuffer(file.size)`.
 * Anything at or beyond a mebibyte is that allocation and nothing else; the
 * pipeline's own bookkeeping SABs are a handful of bytes.
 */
function fileSized(sizes: number[]): number[] {
  return sizes.filter((n) => n >= 1024 * 1024);
}

let hookApi: ReturnType<typeof useIfcFederation> | null = null;
let loadFileCalls: Array<{ file: File; target: unknown }> = [];
const loadFile = async (file: File, target?: unknown): Promise<void> => {
  loadFileCalls.push({ file, target });
};

function Probe(): null {
  hookApi = useIfcFederation(loadFile);
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  hookApi = null;
  loadFileCalls = [];
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

describe(
  'useIfcFederation - IFCX byte acquisition never uses SAB streaming (#647)',
  { skip: !FIXTURES_AVAILABLE && 'tests/models/ifc5 fixtures missing - run `pnpm fixtures`' },
  () => {
    it('loadFederatedIfcx reads each file via arrayBuffer(), never via a SAB stream', async () => {
      const probe: FileProbe = { arrayBuffer: 0, stream: 0 };
      const sabSizes: number[] = [];

      await withCountedSharedArrayBuffer(sabSizes, async () => {
        await act(async () => {
          await hookApi!.loadFederatedIfcx([probedFile(BASE_PATH, 'base.ifcx', probe)]);
        });
      });

      // Reachability first: an assertion about how a load read its bytes is
      // worthless if the load never happened.
      assert.equal(useViewerStore.getState().error, null, 'federated load must succeed');
      assert.ok(useViewerStore.getState().models.size > 0, 'federated load must register a model');

      assert.equal(probe.arrayBuffer, 1, 'the IFCX file must be read via file.arrayBuffer()');
      assert.equal(
        probe.stream,
        0,
        'file.stream() is how bytes are pulled into a SharedArrayBuffer; the IFCX path must never do that',
      );
      assert.deepEqual(
        fileSized(sabSizes),
        [],
        'no file-sized SharedArrayBuffer may be allocated for an IFCX load - SAB forces a full-file scratch copy in safeUtf8Decode on top of the JSON string (#647)',
      );
    });

    it('addIfcxOverlays reads the overlay via arrayBuffer(), never via a SAB stream', async () => {
      const baseProbe: FileProbe = { arrayBuffer: 0, stream: 0 };
      await act(async () => {
        await hookApi!.loadFederatedIfcx([probedFile(BASE_PATH, 'base.ifcx', baseProbe)]);
      });
      assert.equal(useViewerStore.getState().error, null, 'base load must succeed');

      const overlayProbe: FileProbe = { arrayBuffer: 0, stream: 0 };
      const sabSizes: number[] = [];
      await withCountedSharedArrayBuffer(sabSizes, async () => {
        await act(async () => {
          await hookApi!.addIfcxOverlays([probedFile(OVERLAY_PATH, 'fire-rating.ifcx', overlayProbe)]);
        });
      });

      assert.equal(useViewerStore.getState().error, null, 'overlay add must succeed');

      assert.equal(overlayProbe.arrayBuffer, 1, 'the overlay must be read via file.arrayBuffer()');
      assert.equal(overlayProbe.stream, 0, 'the overlay must not be pulled through a SAB stream');
      assert.deepEqual(
        fileSized(sabSizes),
        [],
        'no file-sized SharedArrayBuffer may be allocated when adding an IFCX overlay',
      );
    });
  },
);

describe('useIfcFederation - addModel delegates byte acquisition to the canonical loadFile', () => {
  it('hands the File to loadFile with a federated target and reads no bytes itself', async () => {
    const probe: FileProbe = { arrayBuffer: 0, stream: 0 };
    // Not an IFCX fixture: addModel is format-agnostic because it never looks
    // at the bytes. A one-byte blob is enough, and keeps this case runnable
    // without the downloaded fixtures.
    const file = new File([new Uint8Array([0x49])], 'model.ifc');
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

    await act(async () => {
      await hookApi!.addModel(file);
    });

    assert.equal(loadFileCalls.length, 1, 'addModel must route through the injected loadFile');
    assert.equal(loadFileCalls[0]!.file, file, 'loadFile must receive the File itself, not bytes');
    assert.equal(
      (loadFileCalls[0]!.target as { kind?: string } | undefined)?.kind,
      'federated',
      'the canonical loader must be told this is a federated add',
    );
    assert.equal(
      probe.arrayBuffer + probe.stream,
      0,
      'addModel must not acquire bytes itself - a second read path is exactly the duplication the single-loadFile rule exists to prevent',
    );
  });
});
