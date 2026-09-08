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
 * Each `describe` below is a MUTATION TARGET pinned to one of the bugs (see
 * the PR discussion): reload must not overwrite the outgoing model's saved
 * entry (Bug 1), switching models must not merge one model's markup into
 * another's (Bug 2), a corrupt entry for one model must not destroy
 * another's (`drawing2DSlice.persistence.test.ts`, Bug 3), and — the newest,
 * below — A → B → A with both hashes already cached must not destroy A's
 * saved entry with the accompanying clear from the B → A leg (Bug 4).
 *
 * Bug 4's test deliberately does NOT wrap the critical `setActiveModel` call
 * in `await act(async () => …)`. `act` flushes React effects synchronously
 * as part of awaiting it, which pulls the restore effect forward in time —
 * production has no such flush; the store's raw `subscribe` listeners run
 * inside `set()`, strictly before React's (scheduled, asynchronous) effect
 * pass. A test that awaits `act` around the switch cannot tell "the listener
 * skipped the accompanying clear" apart from "the listener persisted empty
 * data and the restore effect silently overwrote it back to correct" — both
 * end in the same passing assertion. This test instead calls
 * `setActiveModel` bare and asserts against `localStorage` in the very next
 * line, before yielding to any scheduler.
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

// ─── Bug 2, independently pinned: the atomic clear itself, not act's flush ─

describe('setActiveModel atomic clear — MUTATION TARGET: Bug 2 (independently pinned)', () => {
  it('clears the flat markup fields the INSTANT the active model changes, not merely by the time effects flush', async () => {
    const fileA = fileWithBytes(1, 'a.ifc');
    const fileB = fileWithBytes(99, 'b.ifc');
    const modelA = stubModel('model-a', fileA);
    const modelB = stubModel('model-b', fileB);

    useViewerStore.setState({ models: new Map([['model-a', modelA], ['model-b', modelB]]) });
    await mount();

    await act(async () => { useViewerStore.getState().setActiveModel('model-a'); });
    await flush();
    await act(async () => {
      useViewerStore.setState({ measure2DResults: [sampleMeasure('mA')] });
    });

    // The critical call is bare — NOT wrapped in `act` — so React's effect
    // pass (including this hook's own redundant defensive clear) cannot run
    // before the assertion below. If `setActiveModel`'s own atomic patch
    // stopped clearing the fields, this assertion is the only thing left to
    // catch it: the effect's clear would still (eventually) paper over it,
    // but that happens after this line, not before.
    useViewerStore.getState().setActiveModel('model-b');

    assert.deepStrictEqual(
      useViewerStore.getState().measure2DResults,
      [],
      'the atomic patch itself must clear markup the instant activeModelId changes, with no effect having run yet',
    );

    // Let the hook's effects settle so unmount doesn't warn.
    await flush();
  });
});

// ─── Bug 4: A → B → A with both hashes cached must not destroy A's entry ──

describe('A → B → A round trip — MUTATION TARGET: Bug 4', () => {
  it('does not overwrite A\'s saved entry with the B → A leg\'s accompanying clear', async () => {
    const fileA = fileWithBytes(1, 'a.ifc');
    const fileB = fileWithBytes(99, 'b.ifc');
    const hashA = (await computeSourceFingerprintFromBlob(fileA)).hex;
    const modelA = stubModel('model-a', fileA);
    const modelB = stubModel('model-b', fileB);

    useViewerStore.setState({ models: new Map([['model-a', modelA], ['model-b', modelB]]) });
    await mount();

    // Visit A, draw, and let it save — hash(A) is now cached.
    await act(async () => { useViewerStore.getState().setActiveModel('model-a'); });
    await flush();
    await act(async () => {
      useViewerStore.setState({ measure2DResults: [sampleMeasure('mA')] });
    });
    assert.strictEqual(loadDrawing2DEntry(hashA, DEFAULTS)!.measure2DResults[0].id, 'mA');

    // Visit B — hash(B) becomes cached too, matching the bug report's
    // precondition ("both content-hashes are already cached").
    await act(async () => { useViewerStore.getState().setActiveModel('model-b'); });
    await flush();

    // The B -> A leg: bare, not wrapped in `act`. This is the exact
    // production ordering the bug report describes — the raw save
    // subscriber fires synchronously inside `setActiveModel`'s `set()`
    // call, strictly before the restore effect (a scheduled React effect)
    // has any chance to run. Asserting inside `act(async () => …)` would
    // let that restore effect flush BEFORE this line reads storage, which
    // is exactly the shielding the PR review flagged: the effect restoring
    // real data back would mask a listener that had just destroyed it.
    useViewerStore.getState().setActiveModel('model-a');

    const savedRightAfterSwitch = loadDrawing2DEntry(hashA, DEFAULTS);
    assert.ok(
      savedRightAfterSwitch,
      'model A\'s saved entry must not be deleted by the accompanying clear on the B -> A leg',
    );
    assert.strictEqual(
      savedRightAfterSwitch!.measure2DResults[0]?.id,
      'mA',
      'model A\'s saved entry must survive an A -> B -> A round trip once both hashes are cached',
    );

    // Let the restore effect settle so unmount doesn't warn, and confirm the
    // data is still intact afterwards too (the restore effect's own save,
    // if any, must persist the SAME real data, not overwrite it again).
    await flush();
    assert.strictEqual(
      loadDrawing2DEntry(hashA, DEFAULTS)!.measure2DResults[0]?.id,
      'mA',
      'model A\'s saved entry must still be intact once the restore effect has settled',
    );
  });
});
