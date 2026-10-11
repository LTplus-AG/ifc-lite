/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saving and reopening a captured run through the mounted Compare panel
 * (#7370), over the committed revision pair. A session capture is lost on
 * session reset; a saved one survives reset, reload, backup export/import and
 * a refused write's retry, and reopens to reconcile exactly as before. The
 * saved side is the bytes IndexedDB holds, read back through the library.
 */

import '@/test/setup-dom.js';
import '@/test/content-fixture';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { render, click, cleanup, waitFor } from '@/test/render';
import { clearContentDatabase, refuseContentWrites } from '@/test/content-fixture';
import { revisionPair, runClash, runIds, type RevisionPair } from '@/lib/compare/revision-pair.test-support';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { computeFullSourceHash } from '@/utils/sourceContentHash';
import { readContentRows } from '@/lib/storage/content-database';
import { createContentBackup, importContentBackup, parseContentBackup } from '@/lib/storage/content-backup';
import { initialContentStatus } from '@/lib/storage/content-library';
import { CompareAnalysisSections } from './CompareAnalysisSections';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); act(() => useViewerStore.setState(initial, true)); });

type Library = typeof import('@/lib/compare/saved-analysis-runs');
let library: Library | null = null;
/** The saved-run library, loaded only once the Save control was found, starting from what IndexedDB holds
 * (the fixture clears it before each test). Without the feature that lookup fails as an assertion. */
async function savedRuns(): Promise<Library> {
  library ??= await import('@/lib/compare/saved-analysis-runs');
  await act(async () => { assert.equal(await library!.analysisRunLibrary.restore(), true); });
  return library;
}
const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'public', 'samples');

/** The pair opened as the loader opens it: each model carries the SHA-256 of its committed file. */
async function open(pair: RevisionPair, ...ids: Array<'A' | 'B'>) {
  const hash = async (file: string) => (await computeFullSourceHash(readFileSync(join(SAMPLES, file))))!;
  const files = { A: [pair.base, 'building-architecture.ifc'], B: [pair.head, 'building-architecture-rev-b.ifc'] } as const;
  const models = new Map(await Promise.all(ids.map(async id => [id, { ...files[id][0], sourceContentHash: await hash(files[id][1]) }] as const)));
  act(() => useViewerStore.setState({ models, activeModelId: ids[0], compareResult: pair.compare }));
}

/** A native clash run published the way `useClash` publishes it: stamped with placement. */
async function publishClash(pair: RevisionPair) {
  const clash = stampAnalysisReport(await runClash(pair, ['A', 'B']), captureAnalysisStamp(true));
  act(() => useViewerStore.setState({ clashResult: clash, clashRawResult: clash }));
}

const button = (root: HTMLElement, name: RegExp) => {
  const found = [...root.querySelectorAll('button')].find(b => name.test(b.textContent ?? '') || name.test(b.getAttribute('aria-label') ?? ''));
  assert.ok(found, `button ${name}`);
  return found;
};

/** The saved-run list is a lazy chunk: wait for its Reopen control, then press it. */
async function reopen(root: HTMLElement) {
  await waitFor(() => [...root.querySelectorAll('button')].some(b => (b.getAttribute('aria-label') ?? '').startsWith('Reopen saved run')), 'saved-run list');
  act(() => click(button(root, /^Reopen saved run/)));
}

function mount(pair: RevisionPair) {
  const root = render(<CompareAnalysisSections result={pair.compare} />);
  act(() => click(button(root, /Reconcile findings across revisions/)));
  return root;
}

/** A fresh page: nothing visible until the library reads IndexedDB again. */
async function reload({ analysisRunLibrary, useSavedAnalysisRuns }: Library) {
  cleanup();
  act(() => useSavedAnalysisRuns.setState({ entries: [], status: initialContentStatus() }));
  await act(async () => { assert.equal(await analysisRunLibrary.restore(), true); });
}

const outcomeText = (root: HTMLElement) => root.querySelector('output')?.textContent ?? '';

describe('saved runs for reconciliation (#7370)', () => {
  it('a saved run survives session reset, reload, backup export/import and reopens to reconcile as before', async t => {
    const pair = await revisionPair(t);
    if (!pair) return;
    await open(pair, 'A', 'B');
    await publishClash(pair);
    let root = mount(pair);
    // Two native runs in one session, base and head, reconciled the way #6921 does it.
    act(() => click(button(root, /Capture current run/)));
    await publishClash(pair);
    act(() => click(button(root, /Capture current run/)));
    act(() => click(button(root, /^Reconcile$/)));
    const native = outcomeText(root);
    assert.match(native, /1New/);
    const save = button(root, /Save head run/);
    const lib = await savedRuns(), { useSavedAnalysisRuns } = lib;
    act(() => click(save));
    await waitFor(() => /Saved\. You can reopen this run after a reload\./.test(root.textContent ?? ''), 'save confirmation');
    const [saved] = useSavedAnalysisRuns.getState().entries;
    assert.equal(useSavedAnalysisRuns.getState().status.items[saved.id], 'saved');
    const stored = await readContentRows('analysisRuns');
    assert.deepEqual(stored.map(row => row.payload), [JSON.parse(JSON.stringify(saved))]);

    // A session reset drops every capture: this is the loss the saved library exists for.
    act(() => useViewerStore.getState().resetViewerState());
    assert.deepEqual(useViewerStore.getState().compareRunCaptures, []);

    await reload(lib);
    assert.deepEqual(useSavedAnalysisRuns.getState().entries, [saved]);

    // Backup export, a cleared browser, then import: the same evidence comes back.
    const backup = JSON.stringify(createContentBackup({ validation: [], comparison: [], document: [],
      analysisRuns: useSavedAnalysisRuns.getState().entries }, { analysisRuns: useSavedAnalysisRuns.getState().status }));
    await act(async () => { await clearContentDatabase(); });
    await reload(lib);
    assert.deepEqual(useSavedAnalysisRuns.getState().entries, []);
    await act(async () => { assert.equal(await importContentBackup(parseContentBackup(backup)), 1); });
    await reload(lib);
    assert.deepEqual(useSavedAnalysisRuns.getState().entries, [saved]);

    // Reopen into the reset session and reconcile it against a new native run.
    await open(pair, 'A', 'B');
    await publishClash(pair);
    root = mount(pair);
    await reopen(root);
    assert.deepEqual(useViewerStore.getState().compareRunCaptures.map(run => run.id), [saved.id]);
    act(() => click(button(root, /Capture current run/)));
    const [base, head] = [...root.querySelectorAll('select')];
    assert.equal(base.value, saved.id, 'the reopened run is the base');
    assert.notEqual(head.value, saved.id, 'the new capture is the head');
    act(() => click(button(root, /^Reconcile$/)));
    assert.equal(outcomeText(root), native, 'the reopened run reconciles exactly as the session capture did');
  });

  it('reopening names why it refuses, and changes nothing', async t => {
    const pair = await revisionPair(t);
    if (!pair) return;
    await open(pair, 'A', 'B');
    await publishClash(pair);
    let root = mount(pair);
    act(() => click(button(root, /Capture current run/)));
    const save = button(root, /Save head run/);
    const { useSavedAnalysisRuns } = await savedRuns();
    act(() => click(save));
    await waitFor(() => useSavedAnalysisRuns.getState().entries.length === 1, 'saved');
    act(() => useViewerStore.getState().resetViewerState());

    // Only rev-b is open now, and it has unsaved edits.
    await open(pair, 'B');
    act(() => useViewerStore.setState({ dirtyModels: new Set(['B']) }));
    root = mount(pair);
    await reopen(root);
    const alert = root.querySelector('[role="alert"]');
    assert.ok(alert, 'the refusal is announced');
    assert.match(alert.textContent ?? '', /This saved run cannot be reopened:/);
    assert.match(alert.textContent ?? '', /building-architecture\.ifc is not open\./);
    assert.match(alert.textContent ?? '', /building-architecture-rev-b\.ifc has unsaved edits/);
    assert.doesNotMatch(alert.textContent ?? '', /m0|m1|clash-run-|fingerprint|hash/i, 'internal keys, ids and jargon are not shown');
    assert.deepEqual(useViewerStore.getState().compareRunCaptures, []);
  });

  it('reopening while the old capture is still held replaces it with the run bound to the current model ids', async t => {
    const pair = await revisionPair(t);
    if (!pair) return;
    await open(pair, 'A', 'B');
    await publishClash(pair);
    let root = mount(pair);
    act(() => click(button(root, /Capture current run/)));
    const save = button(root, /Save head run/);
    const { useSavedAnalysisRuns } = await savedRuns();
    act(() => click(save));
    await waitFor(() => useSavedAnalysisRuns.getState().status.items[useSavedAnalysisRuns.getState().entries[0]?.id ?? ''] === 'saved', 'saved');
    const [saved] = useSavedAnalysisRuns.getState().entries;

    // The same two files reopened under new viewer ids, without a session reset: the old capture is still held.
    cleanup();
    const { models } = useViewerStore.getState();
    const moved = { A: 'A-reopened', B: 'B-reopened' } as const;
    const compare = { ...pair.compare, baseModelId: moved.A, headModelId: moved.B };
    act(() => useViewerStore.setState({ compareResult: compare, clashResult: null, clashRawResult: null,
      models: new Map([...models].map(([id, m]) => [moved[id as 'A' | 'B'], { ...m, id: moved[id as 'A' | 'B'] }])) }));
    assert.deepEqual(useViewerStore.getState().compareRunCaptures.map(run => run.modelIds), [['A', 'B']]);
    root = render(<CompareAnalysisSections result={compare} />);
    act(() => click(button(root, /Reconcile findings across revisions/)));
    await reopen(root);
    assert.equal(root.querySelector('[role="alert"]'), null, 'the run binds');
    assert.deepEqual(useViewerStore.getState().compareRunCaptures.map(run => [run.id, run.modelIds]), [[saved.id, [moved.A, moved.B]]]);
    act(() => click(button(root, /^Reconcile$/)));
    assert.ok(root.querySelector('output'), 'the reopened run reconciles under the current ids');
    assert.equal(root.querySelector('[role="alert"]'), null);
  });

  it('a reopened run becomes the base beside the current head capture', async t => {
    const pair = await revisionPair(t);
    if (!pair) return;
    await open(pair, 'A', 'B');
    await publishClash(pair);
    let root = mount(pair);
    act(() => click(button(root, /Capture current run/)));
    const save = button(root, /Save head run/);
    const { useSavedAnalysisRuns } = await savedRuns();
    act(() => click(save));
    await waitFor(() => useSavedAnalysisRuns.getState().status.items[useSavedAnalysisRuns.getState().entries[0]?.id ?? ''] === 'saved', 'saved');
    const [saved] = useSavedAnalysisRuns.getState().entries;
    act(() => useViewerStore.getState().resetViewerState());

    // A new session captures its own run first, then reopens the saved one.
    cleanup();
    await open(pair, 'A', 'B');
    await publishClash(pair);
    root = mount(pair);
    act(() => click(button(root, /Capture current run/)));
    const [live] = useViewerStore.getState().compareRunCaptures;
    await reopen(root);
    const [base, head] = [...root.querySelectorAll('select')];
    assert.deepEqual([base.value, head.value], [saved.id, live.id], 'the saved run is the base, the current capture the head');
    act(() => click(button(root, /^Reconcile$/)));
    assert.ok(root.querySelector('output'), 'the pair reconciles');
  });

  it('Save reads the models once its code has loaded: a model closed meanwhile refuses the save', async t => {
    const pair = await revisionPair(t);
    if (!pair) return;
    await open(pair, 'A', 'B');
    await publishClash(pair);
    const root = mount(pair);
    act(() => click(button(root, /Capture current run/)));
    const save = button(root, /Save head run/);
    const { useSavedAnalysisRuns } = await savedRuns();
    // Click, then close A before the save code resolves (a dynamic import always settles later).
    act(() => {
      click(save);
      useViewerStore.setState({ models: new Map([...useViewerStore.getState().models].filter(([id]) => id === 'B')) });
    });
    await waitFor(() => /A model this run examined is no longer open/.test(root.textContent ?? ''), 'refusal');
    assert.deepEqual(useSavedAnalysisRuns.getState().entries, []);
  });

  it('a save still running when the analysis kind changes reports nothing to the other kind', async t => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const idsReport = await runIds(pair, 'B');
    await open(pair, 'A', 'B');
    await publishClash(pair);
    const root = mount(pair);
    act(() => click(button(root, /Capture current run/)));
    const save = button(root, /Save head run/);
    const { useSavedAnalysisRuns } = await savedRuns();
    // The validation view has a run of its own, so a misdirected message would be on screen there.
    act(() => { useViewerStore.getState().addCompareRunCapture({ kind: 'validation', id: 'validation-run', capturedAt: '2026-10-11T08:00:00.000Z',
      modelIds: ['B'], stamp: null, report: idsReport }); });
    const validation = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(input => input.value === 'validation');
    assert.ok(validation);
    act(() => { click(save); click(validation); });
    await waitFor(() => { const [entry] = useSavedAnalysisRuns.getState().entries;
      return !!entry && useSavedAnalysisRuns.getState().status.items[entry.id] === 'saved'; }, 'save committed');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(validation.checked, true);
    assert.ok(button(root, /Save head run/), 'the validation view shows its own head run');
    assert.doesNotMatch(root.textContent ?? '', /Saved\. You can reopen|could not be saved/, 'the clash save is not reported under Validation');
  });

  it('a refused write says the run is not stored yet; a retry stores it', async t => {
    const pair = await revisionPair(t);
    if (!pair) return;
    await open(pair, 'A', 'B');
    await publishClash(pair);
    const root = mount(pair);
    act(() => click(button(root, /Capture current run/)));
    const save = button(root, /Save head run/);
    const { analysisRunLibrary } = await savedRuns();
    const refused = refuseContentWrites();
    try {
      act(() => click(save));
      await waitFor(() => /The run could not be saved in this browser\./.test(root.textContent ?? ''), 'refusal');
      assert.match(root.textContent ?? '', /Not stored in this browser yet/);
    } finally { refused.mock.restore(); }
    assert.deepEqual(await readContentRows('analysisRuns'), []);
    await act(async () => { assert.equal(await analysisRunLibrary.retry(), true); });
    assert.equal((await readContentRows('analysisRuns')).length, 1);
    assert.doesNotMatch(root.textContent ?? '', /Not stored in this browser yet/);
  });
});
