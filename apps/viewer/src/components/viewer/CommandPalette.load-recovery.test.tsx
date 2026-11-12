/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { useViewerStore } from '@/store';
import { useIfcLoader } from '@/hooks/useIfcLoader';
import { useLoadErrorCard } from '@/hooks/useLoadErrorCard';
import { selectLoadCanceller } from '@/store/slices/loadingSlice';
import { advance, cleanup, click, render, type, waitFor } from '@/test/render';
import { CommandPalette } from './CommandPalette';
import { RECENT_KEY } from './commandPaletteSearch';

let loader: ReturnType<typeof useIfcLoader>;
function Harness() {
  loader = useIfcLoader();
  const card = useLoadErrorCard();
  return <BimReactContext.Provider value={{} as BimContext}>
    <CommandPalette open onOpenChange={() => {}} />
    {card.error && <button onClick={card.dismiss}>Card dismiss</button>}
  </BimReactContext.Provider>;
}
const initial = useViewerStore.getState();
beforeEach(() => {
  localStorage.clear();
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
});
afterEach(() => { cleanup(); useViewerStore.setState(initial); localStorage.clear(); });
function row(id: string) {
  const node = document.querySelector(`[data-command-id="file:${id}"]`);
  assert.ok(node, id); return node;
}
async function frame() { await act(async () => { await advance(30); }); }
function holdHead(name: string) {
  const file = new File(['{ invalid json'], name);
  let release!: (buffer: ArrayBuffer) => void;
  let reached = false;
  const held = new Promise<ArrayBuffer>(resolve => { release = resolve; });
  // Hold only real loader I/O; no parser, load result or cancellation is replaced.
  Object.defineProperty(file, 'slice', { value: () => ({ arrayBuffer: () => { reached = true; return held; } }) });
  return { file, reached: () => reached, release: () => release(new TextEncoder().encode('{ invalid json').buffer) };
}

test('palette cancels the held actual load; an old deferred Cancel cannot stop its replacement (#8947)', async () => {
  render(<Harness />);
  const a = holdHead('held-a.ifcx');
  let pendingA!: Promise<unknown>;
  act(() => { pendingA = loader.loadFile(a.file); });
  await waitFor(a.reached, 'actual loader reached held head read');
  const cancelA = selectLoadCanceller(useViewerStore.getState());
  assert.ok(cancelA);
  const frames: FrameRequestCallback[] = [];
  const originalFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = cb => { frames.push(cb); return frames.length; };
  const b = holdHead('held-b.ifcx');
  let pendingB!: Promise<unknown>;
  try {
    click(row('cancel-load'));
    act(() => { pendingB = loader.loadFile(b.file); });
    await waitFor(b.reached, 'replacement reached actual held read');
    const cancelB = selectLoadCanceller(useViewerStore.getState());
    assert.ok(cancelB); assert.notEqual(cancelB, cancelA);
    act(() => frames.splice(0).forEach(cb => cb(0)));
    assert.equal(selectLoadCanceller(useViewerStore.getState()), cancelB);
    assert.equal(localStorage.getItem(RECENT_KEY), null, 'stale row never executes');
  } finally { globalThis.requestAnimationFrame = originalFrame; }
  try {
    click(row('cancel-load')); await frame();
    assert.equal(selectLoadCanceller(useViewerStore.getState()), null);
    assert.equal(useViewerStore.getState().loading, false);
    assert.equal(useViewerStore.getState().models.size, 0);
    assert.equal(useViewerStore.getState().error, null);
  } finally {
    a.release(); b.release();
    await act(async () => { await Promise.all([pendingA, pendingB]); });
  }
});

test('Retry replays the exact failed source once; delayed Retry/Dismiss refuse newer identical errors (#8947)', async () => {
  render(<Harness />);
  const file = new File(['{ invalid json'], 'broken.ifcx');
  await act(async () => { await loader.loadFile(file); });
  assert.match(useViewerStore.getState().error ?? '', /file is invalid/);
  const seq = useViewerStore.getState().loadErrorSeq;
  let starts = 0;
  const replayedFiles: string[] = [];
  const stop = useViewerStore.subscribe((s, previous) => {
    if (s.loading && !previous.loading) starts++;
    if (s.loadingFileName !== null && s.loadingFileName !== previous.loadingFileName) {
      replayedFiles.push(s.loadingFileName);
    }
  });
  try {
    click(row('retry-load')); click(row('retry-load')); await frame();
  } finally { stop(); }
  assert.equal(starts, 1, 'two activations of one captured failure replay it once');
  await waitFor(() => useViewerStore.getState().error !== null && useViewerStore.getState().loadErrorSeq > seq,
    'actual retry fails on identical malformed source');
  assert.deepEqual(replayedFiles, [file.name], 'the actual retry loads the same malformed file');
  assert.equal(useViewerStore.getState().loading, false);
  assert.equal(useViewerStore.getState().loadingFileName, null, 'settled load releases its shared progress UI');
  for (const id of ['retry-load', 'dismiss-load-error']) {
    const frames: FrameRequestCallback[] = [];
    const originalFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = cb => { frames.push(cb); return frames.length; };
    try {
      click(row(id));
      await act(async () => { await loader.loadFile(file); });
      const newer = useViewerStore.getState().loadErrorSeq;
      act(() => frames.splice(0).forEach(cb => cb(0)));
      assert.equal(useViewerStore.getState().loadErrorSeq, newer);
      assert.ok(useViewerStore.getState().error);
    } finally { globalThis.requestAnimationFrame = originalFrame; }
  }
  click(row('dismiss-load-error')); await frame();
  assert.equal(useViewerStore.getState().error, null);
  assert.equal(useViewerStore.getState().lastLoadRetry, null);
  await act(async () => { await loader.loadFile(file); });
  click([...document.querySelectorAll('button')].find(b => b.textContent === 'Card dismiss')!);
  assert.equal(useViewerStore.getState().lastLoadRetry, null, 'normal card shares cleanup');
  assert.match(row('retry-load').textContent ?? '', /error|retry/i);
  assert.equal(row('retry-load').getAttribute('aria-disabled'), 'true');
});

let recoveryCard: ReturnType<typeof useLoadErrorCard>;
function ReopeningRecoveryHarness() {
  loader = useIfcLoader();
  recoveryCard = useLoadErrorCard();
  const [open, setOpen] = useState(true);
  return <BimReactContext.Provider value={{} as BimContext}>
    <CommandPalette open={open} onOpenChange={setOpen} />
    <button onClick={() => setOpen(true)}>Reopen recovery palette</button>
  </BimReactContext.Provider>;
}

test('independent bindings and palette reopen consume one failure before actual federated drain settles (#8947)', async () => {
  render(<ReopeningRecoveryHarness />);
  const file = new File(['{ invalid json'], 'retry-federated.ifcx');
  const target = { kind: 'federated' as const, modelId: 'retry-federated' };
  const pending: Promise<void>[] = [];
  const retry = () => { pending.push(loader.loadFile(file, target, { retryOperation: retry })); };
  await act(async () => { await loader.loadFile(file, target, { retryOperation: retry }); });
  const failure = useViewerStore.getState().error;
  assert.match(failure ?? '', /file is invalid/);
  const sequence = useViewerStore.getState().loadErrorSeq;
  const stale = recoveryCard; // The real error-card hook is independent of the palette binding.
  const renderer = new Renderer(document.createElement('canvas'));
  const scene = renderer.getScene();
  const drain = scene.drainColdTier.bind(scene);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let drains = 0;
  // Hold the real loader's pre-error-clear boundary, then run the real scene drain.
  // Parsing, failure reporting and the retry callback remain production paths.
  scene.drainColdTier = async () => { drains++; await held; await drain(); };
  setGlobalRendererRef({ current: renderer });
  try {
    click(row('retry-load')); await frame();
    assert.equal(drains, 1, 'one actual federated retry entered the held drain');
    await waitFor(() => document.querySelector('[role="combobox"]') === null, 'activation closes the palette');
    act(() => stale.retry());
    click([...document.querySelectorAll('button')].find(b => b.textContent === 'Reopen recovery palette')!);
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
    assert.ok(input); type(input, 'Retry failed load');
    assert.equal(row('retry-load').getAttribute('aria-disabled'), 'true');
    click(row('retry-load')); await frame();
    assert.equal(drains, 1, 'old and freshly rendered bindings cannot replay the consumed failure');
    await act(async () => { release(); await Promise.all(pending); });
    assert.equal(useViewerStore.getState().error, failure, 'real parser reports the same malformed source again');
    assert.ok(useViewerStore.getState().loadErrorSeq > sequence);
    assert.equal(useViewerStore.getState().lastLoadRetry, retry, 'the same callback can own a new failure');
    const freshSequence = useViewerStore.getState().loadErrorSeq;
    act(() => { stale.retry(); stale.dismiss(); });
    assert.equal(drains, 1);
    assert.equal(useViewerStore.getState().loadErrorSeq, freshSequence, 'old actions cannot consume or dismiss the new failure');
    assert.notEqual(row('retry-load').getAttribute('aria-disabled'), 'true');
    click(row('retry-load')); await frame();
    await act(async () => { await Promise.all(pending); });
    assert.equal(drains, 2, 'the new failure invokes the real loader once more');
    assert.equal(useViewerStore.getState().error, failure);
    assert.ok(useViewerStore.getState().loadErrorSeq > freshSequence);
  } finally {
    release();
    await act(async () => { await Promise.all(pending); });
    scene.drainColdTier = drain;
    setGlobalRendererRef({ current: null });
    renderer.destroy();
  }
});

test('a synchronously throwing retry stays consumed without retiring a fresh identical failure (#8947)', () => {
  let calls = 0;
  const error = new Error('synchronous retry failure');
  const retry = () => { calls++; throw error; };
  const fail = () => { const s = useViewerStore.getState(); s.setError('same failure'); s.setLastLoadRetry(retry); };
  fail();
  render(<ReopeningRecoveryHarness />);
  const first = recoveryCard;
  assert.throws(() => act(() => first.retry()), thrown => thrown === error);
  act(() => { first.retry(); recoveryCard.retry(); });
  assert.equal(calls, 1, 'a throw does not resurrect the consumed callback');
  act(fail);
  const fresh = recoveryCard;
  const sequence = useViewerStore.getState().loadErrorSeq;
  act(() => { first.retry(); first.dismiss(); });
  assert.equal(useViewerStore.getState().loadErrorSeq, sequence);
  assert.throws(() => act(() => fresh.retry()), thrown => thrown === error);
  assert.equal(calls, 2, 'a new failure sequence remains retryable');
});
