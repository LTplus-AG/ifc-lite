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
import { computeFullSourceHashFromBlob } from '@/utils/sourceContentHash.js';
import { computeSourceFingerprint } from './sourceFingerprint.js';
import type { Measure2DResult } from '@/store/slices/drawing2DSlice.js';
import type { SectionConfig } from '@ifc-lite/drawing-2d';

const STALE_CONFIG: SectionConfig = {
  plane: { axis: 'z', position: 999, flipped: false },
  projectionDepth: 10,
  includeHiddenLines: true,
  creaseAngle: 30,
  scale: 100,
};

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

/**
 * A 4MB deterministic (xorshift32) fill — same construction
 * `sourceFingerprint.test.ts` uses to demonstrate the sampler's gap blind
 * spot at this exact length (see its 'FALSE-HITS a byte-length-preserving
 * edit in a sampler GAP' test).
 */
function fillLarge(len: number, seed: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(len));
  let x = seed >>> 0;
  for (let i = 0; i < len; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
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

/**
 * Like {@link flush}, but for the two large-buffer (4-5MB) tests below that
 * hash real content via `computeFullSourceHashFromBlob` (SHA-256 over the
 * whole buffer, plus a `Blob.arrayBuffer()` read) rather than the ~256-byte
 * fixtures every other test in this file uses. `flush`'s fixed two ticks are
 * plenty for that near-instant case but proved NOT enough for a real
 * multi-MB hash under CI's slower/noisier CPU (observed CI failure:
 * `loadDrawing2DEntry` returned `null` right after a save that fired before
 * `hashCache` had resolved) — this ticks far more generously (bounded, not
 * unbounded) rather than weakening any assertion to tolerate that.
 */
async function flushDeep(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
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
    const hashA = (await computeFullSourceHashFromBlob(fileA))!;
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
    const hashA = (await computeFullSourceHashFromBlob(fileA))!;
    const hashB = (await computeFullSourceHashFromBlob(fileB))!;
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
    const hashA = (await computeFullSourceHashFromBlob(fileA))!;
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

// ─── Fingerprint-collision regression (PR #4159 review thread) ────────────
//
// `hooks/sourceFingerprint.ts`'s window-sampled fingerprint FALSE-HITS a
// byte-length-preserving edit that lands entirely in its sampler gap (proven
// by `sourceFingerprint.test.ts`'s 'FALSE-HITS …' test, same construction
// reused here). Before this fix, this module used THAT fingerprint as the
// markup-persistence key, so two distinct 4MB models differing only inside
// the gap would collide on `hashCache`/`localStorage` key and model B would
// silently restore model A's saved measurements. The fix switches the key to
// `computeFullSourceHashFromBlob` (true SHA-256 over the whole file), which
// cannot share this blind spot. MUTATION TARGET: revert the hook's import
// back to `computeSourceFingerprintFromBlob` and this test must fail.
describe('fingerprint gap collision — MUTATION TARGET: sampled-key data leak', () => {
  it('two 4MB models that collide on the sampled fingerprint do NOT collide on the persistence key', async () => {
    const len = 4_000_000;
    const bytesA = fillLarge(len, 202);
    const bytesB = bytesA.slice();
    // Same offset `sourceFingerprint.test.ts` uses: between interior windows
    // 1 and 2, outside the 64KB head/tail — a genuine sampler gap.
    bytesB[700_000] ^= 0xff;

    // Sanity: this pair really does collide on the OLD (sampled) key — the
    // exact defect the review thread flagged.
    assert.equal(
      computeSourceFingerprint(bytesA).hex,
      computeSourceFingerprint(bytesB).hex,
      'setup sanity: the two buffers must collide on the sampled fingerprint',
    );

    const fileA = new File([bytesA], 'a.ifc', { type: 'application/octet-stream' });
    const fileB = new File([bytesB], 'b.ifc', { type: 'application/octet-stream' });
    const hashA = (await computeFullSourceHashFromBlob(fileA))!;
    const hashB = (await computeFullSourceHashFromBlob(fileB))!;
    assert.notEqual(hashA, hashB, 'the full-content hash must distinguish the two buffers');

    // Distinct model ids from every other `describe` in this file: the
    // hook's `hashCache` is module-level and keyed by modelId, not content —
    // reusing 'model-a'/'model-b' here would read back an earlier test's
    // STALE cached hash for those ids instead of exercising this test's
    // actual (colliding) file content.
    const modelA = stubModel('gap-model-a', fileA);
    const modelB = stubModel('gap-model-b', fileB);
    useViewerStore.setState({ models: new Map([['gap-model-a', modelA], ['gap-model-b', modelB]]) });
    await mount();

    await act(async () => { useViewerStore.getState().setActiveModel('gap-model-a'); });
    // flushDeep, not flush: this activation hashes a real 4MB buffer
    // (computeFullSourceHashFromBlob), which can take longer than flush's
    // fixed two ticks under a loaded CI runner.
    await flushDeep();
    await act(async () => {
      useViewerStore.setState({ measure2DResults: [sampleMeasure('mA')] });
    });
    // Assert on the ENTRY first, with a message, rather than dereferencing
    // it straight through a non-null assertion: if the persistence key ever
    // reverts to the sampled fingerprint, this lookup (keyed by the TEST's
    // own independently-computed full hash) legitimately finds nothing —
    // and a bare `!.measure2DResults` would crash with an opaque TypeError
    // instead of failing with a message that says what actually happened.
    const entryA = loadDrawing2DEntry(hashA, DEFAULTS);
    assert.ok(
      entryA,
      `expected model A's save to be readable back under its full-content hash key (${hashA}); ` +
      'got nothing — either persistFor never resolved hashCache for this model in time, or the ' +
      'persistence key is no longer computeFullSourceHashFromBlob',
    );
    assert.strictEqual(entryA.measure2DResults[0].id, 'mA');

    await act(async () => { useViewerStore.getState().setActiveModel('gap-model-b'); });
    await flushDeep();

    const stateForB = useViewerStore.getState();
    assert.deepStrictEqual(
      stateForB.measure2DResults,
      [],
      'model B must not inherit model A\'s markup despite sharing the sampled fingerprint',
    );
    assert.equal(
      loadDrawing2DEntry(hashB, DEFAULTS),
      null,
      'nothing has been saved for model B yet — it must not read back model A\'s entry',
    );
  });
});

// ─── Restoration-ordering race (PR #4159 review thread) ────────────────────
//
// The review comment describes a stray `notifyDrawing2DSectionConfig` call
// landing in the window between `setActiveModel`'s atomic clear and this
// hook's own (React-scheduled, passive-effect) restore. Tracing the ACTUAL
// current code (`drawing2DSlice.markupTransition.ts`'s in-session
// `liveMarkupCache`, added after the comment's `applyHash`/`resetViewerState`
// framing) shows the five flat markup ARRAYS can no longer be wiped that way
// for a model revisited this session: `setActiveModel` restores them
// SYNCHRONOUSLY from `liveMarkupCache` in the same `set()` that moves
// `activeModelId`, so there is no "cleared to defaults" instant a stray
// notify could observe for those fields. Attempted repros of the literal
// "writes the defaults" claim (see git history of this describe block) do
// NOT reproduce against current `main` for that reason.
//
// `liveMarkupCache` does NOT cover `sectionConfig` (`Drawing2DMarkupPatch`
// has no such field — see `markupTransitionPatch`'s own doc: "this cache
// does not carry [sectionConfig]"). `lastSectionConfig`/
// `lastSectionConfigModelId` are plain module-level variables outside the
// store, reset only inside THIS hook's own effect — which still runs on a
// LATER, separate scheduled task from `setActiveModel`'s synchronous patch.
// A stray notify landing in that (still-real) gap sets
// `lastSectionConfigModelId = <new model>` while `lastSectionConfig` holds
// whatever config the notify's CALLER computed — which, for an in-flight
// generation that started before the switch, is the OUTGOING model's plane,
// not the new model's. `persistFor` then writes that mismatched config
// straight into the new model's saved entry (`activeModelId === modelId`
// is the only check `notifyDrawing2DSectionConfig` makes), silently
// swapping its persisted section plane for a different model's.
describe('restoration-ordering race — MUTATION TARGET: cross-model sectionConfig contamination', () => {
  it('does not let a notify carrying a stale model\'s config overwrite the new model\'s saved sectionConfig', async () => {
    const fileB = fileWithBytes(55, 'race-b.ifc');
    const fileA = fileWithBytes(56, 'race-a.ifc');
    const hashB = (await computeFullSourceHashFromBlob(fileB))!;
    const modelA = stubModel('race-model-a', fileA);
    const modelB = stubModel('race-model-b', fileB);
    const configB: SectionConfig = { ...STALE_CONFIG, plane: { axis: 'z', position: 5, flipped: false } };
    const configAStale: SectionConfig = { ...STALE_CONFIG, plane: { axis: 'x', position: 999, flipped: true } };

    useViewerStore.setState({ models: new Map([['race-model-a', modelA], ['race-model-b', modelB]]) });
    await mount();

    // Visit B, generate a drawing with configB, and let it save — B now has
    // a real saved sectionConfig on disk, and (leaving B below) an entry in
    // `liveMarkupCache` for its markup arrays.
    await act(async () => { useViewerStore.getState().setActiveModel('race-model-b'); });
    await flushDeep();
    await act(async () => { notifyDrawing2DSectionConfig('race-model-b', configB); });
    const entryAfterFirstSave = loadDrawing2DEntry(hashB, DEFAULTS);
    assert.ok(entryAfterFirstSave, `setup: expected an entry under model B's hash (${hashB}) after its first notify`);
    assert.deepStrictEqual(entryAfterFirstSave.sectionConfig, configB);

    // Visit A — this is the "previous model" an in-flight generation is
    // still computing FOR when the user switches away from it.
    await act(async () => { useViewerStore.getState().setActiveModel('race-model-a'); });
    await flushDeep();

    // The A -> B leg: bare, not wrapped in `act`, so this hook's own restore
    // effect has not run yet even though `setActiveModel`'s synchronous
    // patch has already restored B's markup ARRAYS via `liveMarkupCache`.
    useViewerStore.getState().setActiveModel('race-model-b');

    // The stray in-flight generation for A resolves in exactly this window:
    // it reads the NEW `activeModelId` (B, already switched — the real
    // `useDrawingGeneration.ts` shape) but the `config` it carries was
    // computed against A's geometry/section plane.
    notifyDrawing2DSectionConfig('race-model-b', configAStale);

    // Assert on the entry itself first, with a message: a `null` here (e.g.
    // if a future change removed the save entirely) must fail with a clear
    // reason, not an opaque TypeError from dereferencing straight through.
    const savedRightAfter = loadDrawing2DEntry(hashB, DEFAULTS);
    assert.ok(
      savedRightAfter,
      `expected model B's entry under its hash (${hashB}) to still exist after the stray notify`,
    );
    assert.notDeepStrictEqual(
      savedRightAfter.sectionConfig,
      configAStale,
      'model B\'s saved sectionConfig must not be replaced by a stale notify carrying model A\'s plane',
    );
    assert.deepStrictEqual(
      savedRightAfter.sectionConfig,
      configB,
      'model B\'s real saved sectionConfig must survive a notify landing before its restore effect runs',
    );

    // Let the restore effect settle and confirm the IN-MEMORY config used
    // for the next save is B's real one too, not the corrupted one.
    await flushDeep();
    await act(async () => { notifyDrawing2DSectionConfig('race-model-b', configB); });
    const entryAfterSettling = loadDrawing2DEntry(hashB, DEFAULTS);
    assert.ok(entryAfterSettling, `expected model B's entry under its hash (${hashB}) after the restore effect settled`);
    assert.deepStrictEqual(entryAfterSettling.sectionConfig, configB);
  });
});
