/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Behavioural coverage for `useDrawing2DPersistence.ts` (#4159).
 *
 * The wiring layer where all three shipped bugs lived had zero tests before
 * this file — the PR that added it argued the app's `tsx --test` runner has
 * no DOM/React harness to exercise a hook. That was never true: every other
 * `hooks/*.test.tsx` file in this directory (`useIfcFederation.resetState
 * .test.tsx`, `useClash.stale-run-teardown.test.tsx`, …) mounts a real React
 * tree via `@/test/setup-dom.js` + `react-dom/client` + `act`, and this file
 * follows that exact pattern: a `Probe` component calls the hook, a
 * `createRoot` tree mounts it, and the tests drive `useViewerStore` directly
 * the same way a real load / model-switch would.
 *
 * Each `describe` below is a MUTATION TARGET pinned to one of the three bugs
 * (see the PR discussion): reload must not overwrite the outgoing model's
 * saved entry (Bug 1), switching models must not merge one model's markup
 * into another's (Bug 2), and — covered separately, at the storage layer —
 * a corrupt entry for one model must not destroy another's
 * (`drawing2DSlice.persistence.test.ts`, Bug 3).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store';
import { useDrawing2DPersistence, notifyDrawing2DSectionConfig } from './useDrawing2DPersistence.js';
import { loadDrawing2DEntry, clearAllDrawing2DEntries } from '@/store/slices/drawing2DSlice.persistence.js';
import { computeSourceFingerprintFromBlob } from './sourceFingerprint.js';
import type { Measure2DResult } from '@/store/slices/drawing2DSlice.js';

const DEFAULTS = useViewerStore.getState().drawing2DDisplayOptions;

function sampleMeasure(id: string): Measure2DResult {
  return { id, start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 };
}

/** A minimal `FederatedModel` — only the fields this hook's restore path reads. */
function stubModel(id: string, sourceFile: File): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: sourceFile.size,
    sourceFile,
    idOffset: 0,
    maxExpressId: 0,
  } as FederatedModel;
}

function fileWithBytes(seed: number, name: string): File {
  const bytes = new Uint8Array(256).map((_, i) => (i + seed) % 256);
  return new File([bytes], name, { type: 'application/octet-stream' });
}

// ─── Harness ────────────────────────────────────────────────────────────────

function Probe(): null {
  useDrawing2DPersistence();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
}

/** Flush the microtask queue so an in-flight fingerprint promise settles. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  clearAllDrawing2DEntries();
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  if (container) { container.remove(); container = null; }
  clearAllDrawing2DEntries();
});

// ─── Bug 1: reload must not overwrite the outgoing model's saved entry ─────

describe('reload (session-reset) — MUTATION TARGET: Bug 1', () => {
  it('does not overwrite the outgoing model\'s saved entry with the post-reset wipe', async () => {
    const fileA = fileWithBytes(1, 'a.ifc');
    const hashA = (await computeSourceFingerprintFromBlob(fileA)).hex;
    const modelA = stubModel('model-a', fileA);

    useViewerStore.setState({ models: new Map([['model-a', modelA]]) });
    await mount();

    await act(async () => { useViewerStore.getState().setActiveModel('model-a'); });
    await flush();

    // The user draws something on model A and it saves.
    await act(async () => {
      useViewerStore.setState({ measure2DResults: [sampleMeasure('keep-me')] });
    });
    const savedBefore = loadDrawing2DEntry(hashA, DEFAULTS);
    assert.ok(savedBefore, 'setup sanity: model A\'s measurement must have saved');
    assert.strictEqual(savedBefore!.measure2DResults[0].id, 'keep-me');

    // An ordinary reload: the load path's own sequence (resetViewerState()
    // immediately followed by clearAllModels(), never awaited in between).
    await act(async () => {
      useViewerStore.getState().resetViewerState();
      useViewerStore.getState().clearAllModels();
    });

    const savedAfter = loadDrawing2DEntry(hashA, DEFAULTS);
    assert.ok(savedAfter, 'model A\'s saved entry must survive a reload of the viewer');
    assert.strictEqual(
      savedAfter!.measure2DResults[0]?.id,
      'keep-me',
      'the post-reset wipe (fields -> []) must never be persisted over model A\'s real saved markup',
    );
  });
});

// ─── Bug 2: switching models must not merge one model's markup into another's ─

describe('active-model switch — MUTATION TARGET: Bug 2', () => {
  it('does not leak the outgoing model\'s markup into the newly-active model\'s saved entry', async () => {
    const fileA = fileWithBytes(1, 'a.ifc');
    const fileB = fileWithBytes(99, 'b.ifc');
    const hashA = (await computeSourceFingerprintFromBlob(fileA)).hex;
    const hashB = (await computeSourceFingerprintFromBlob(fileB)).hex;
    const modelA = stubModel('model-a', fileA);
    const modelB = stubModel('model-b', fileB);

    useViewerStore.setState({ models: new Map([['model-a', modelA], ['model-b', modelB]]) });
    await mount();

    await act(async () => { useViewerStore.getState().setActiveModel('model-a'); });
    await flush();
    await act(async () => {
      useViewerStore.setState({ measure2DResults: [sampleMeasure('mA')] });
    });
    assert.strictEqual(loadDrawing2DEntry(hashA, DEFAULTS)!.measure2DResults[0].id, 'mA');

    // Switch to B — an ordinary HierarchyPanel click. Nothing about B has
    // been saved yet.
    await act(async () => { useViewerStore.getState().setActiveModel('model-b'); });

    // The fields must already be clear the instant B becomes active — before
    // the (async) hash lookup below even starts — not merely by the time the
    // restore effect eventually finishes.
    const stateRightAfterSwitch = useViewerStore.getState();
    assert.deepStrictEqual(
      stateRightAfterSwitch.measure2DResults,
      [],
      'model A\'s markup must not still be present the instant B becomes active',
    );

    await flush();

    // A 2D redraw finishing for B — `notifyDrawing2DSectionConfig` fires
    // unconditionally from `useDrawingGeneration.ts` any time a drawing
    // regenerates, with no user action required.
    notifyDrawing2DSectionConfig('model-b', null);

    const savedForB = loadDrawing2DEntry(hashB, DEFAULTS);
    const measureIdsForB = (savedForB?.measure2DResults ?? []).map((m) => m.id);
    assert.ok(
      !measureIdsForB.includes('mA'),
      `model A's measurement must never appear in model B's saved entry (got: ${JSON.stringify(measureIdsForB)})`,
    );

    // And A's own saved entry must be untouched by the switch.
    assert.strictEqual(loadDrawing2DEntry(hashA, DEFAULTS)!.measure2DResults[0].id, 'mA');
  });
});
