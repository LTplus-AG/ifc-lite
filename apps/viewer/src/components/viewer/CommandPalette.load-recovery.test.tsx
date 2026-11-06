/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { useViewerStore } from '@/store';
import { useIfcLoader } from '@/hooks/useIfcLoader';
import { useLoadErrorCard } from '@/hooks/useLoadErrorCard';
import { selectLoadCanceller } from '@/store/slices/loadingSlice';
import { advance, cleanup, click, render, type, waitFor } from '@/test/render';
import { CommandPalette } from './CommandPalette';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
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
const recoveryIds = ['cancel-load', 'retry-load', 'dismiss-load-error'];
function assertRecoveryBrowse(expected: string[]) {
  for (const id of recoveryIds) {
    assert.equal(!!document.querySelector(`[data-command-id="file:${id}"]`), expected.includes(id), id);
  }
}
function search(query: string) {
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
  assert.ok(input); type(input, query);
}
for (const loaded of [false, true]) {
  test(`inactive recovery leaves browse and recents but stays searchable (${loaded ? 'loaded' : 'unloaded'}, #8947)`, () => {
    if (loaded) useViewerStore.setState(fixtureModels(fixtureModel('loaded')));
    localStorage.setItem(RECENT_KEY, JSON.stringify(recoveryIds.map(id => `file:${id}`)));
    render(<Harness />);
    assertRecoveryBrowse([]);
    assert.ok(document.querySelector('[data-command-id="vis:hide"]'), 'other unavailable commands remain in browse');
    for (const [id, query] of [['cancel-load', 'Cancel model load'], ['retry-load', 'Retry failed load'], ['dismiss-load-error', 'Dismiss load error']]) {
      search(query);
      assert.equal(row(id).getAttribute('aria-disabled'), 'true');
      if (id !== 'cancel-load') assert.match(row(id).textContent ?? '', /No load error to recover from/);
    }
    search(''); assertRecoveryBrowse([]);
  });
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
  assertRecoveryBrowse(['cancel-load']);
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
    assertRecoveryBrowse([]);
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
  assertRecoveryBrowse(['retry-load', 'dismiss-load-error']);
  const seq = useViewerStore.getState().loadErrorSeq;
  let starts = 0;
  const stop = useViewerStore.subscribe((s, previous) => { if (s.loading && !previous.loading) starts++; });
  try {
    click(row('retry-load')); click(row('retry-load')); await frame();
  } finally { stop(); }
  assert.equal(starts, 1, 'two activations of one captured failure replay it once');
  await waitFor(() => useViewerStore.getState().error !== null && useViewerStore.getState().loadErrorSeq > seq,
    'actual retry fails on identical malformed source');
  assert.equal(useViewerStore.getState().loadingFileName, file.name);
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
  assertRecoveryBrowse([]);
  await act(async () => { await loader.loadFile(file); });
  click([...document.querySelectorAll('button')].find(b => b.textContent === 'Card dismiss')!);
  assert.equal(useViewerStore.getState().lastLoadRetry, null, 'normal card shares cleanup');
  assertRecoveryBrowse([]);
  search('Retry failed load');
  assert.match(row('retry-load').textContent ?? '', /error|retry/i);
  assert.equal(row('retry-load').getAttribute('aria-disabled'), 'true');
});
