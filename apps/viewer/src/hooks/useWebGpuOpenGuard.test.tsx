/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The open guard's "WebGPU is still being checked" notice must move on when
 * the adapter probe settles, whatever the probe's answer and whatever locale
 * is active by then (G1). The transition used to be keyed on the notice's
 * translated text: a supported answer left "still being checked" up for good,
 * and a locale switch mid-probe broke the hand-over to "unsupported".
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { viewportLightingEn } from '@/i18n/catalogues/viewport-lighting.en';
import { useViewerStore } from '@/store';
import { useWebGpuOpenGuard, type WebGpuOpenGuard } from './useWebGpuOpenGuard.js';
import { retryWebGPU } from './useWebGPU.js';

const CHECKING = 'viewportLighting.container.loadErrorCard.webgpuChecking';
const UNSUPPORTED = 'viewportLighting.container.loadErrorCard.webgpuUnsupported';
registerLocale('g1-pseudo', { [CHECKING]: '⟦checking⟧', [UNSUPPORTED]: '⟦unsupported⟧' });

const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
const originalActivation = Object.getOwnPropertyDescriptor(navigator, 'userActivation');

function setActivation(isActive: boolean) {
  Object.defineProperty(navigator, 'userActivation', { value: { isActive, hasBeenActive: true }, configurable: true });
}

/** A fresh `navigator.gpu` whose adapter request settles when the test says so. */
function pendingAdapter(): (adapter: object | null) => void {
  let settle!: (adapter: object | null) => void;
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'gpu', {
    value: { requestAdapter: () => new Promise<object | null>((resolve) => { settle = resolve; }) },
    configurable: true,
  });
  return (adapter) => settle(adapter);
}

let guard!: WebGpuOpenGuard['guard'];
function OpenProbe() {
  guard = useWebGpuOpenGuard().guard;
  return null;
}

async function settleProbe(settle: (adapter: object | null) => void, adapter: object | null) {
  await act(async () => { settle(adapter); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  setLocale('en');
  useViewerStore.getState().resetViewerState();
});
afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({ error: null, lastLoadRetry: null });
  if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
  else Reflect.deleteProperty(window, 'isSecureContext');
  if (originalGpu) Object.defineProperty(navigator, 'gpu', originalGpu);
  else Reflect.deleteProperty(navigator, 'gpu');
  if (originalActivation) Object.defineProperty(navigator, 'userActivation', originalActivation);
  else Reflect.deleteProperty(navigator, 'userActivation');
});

/** Mounts the guard, shows the unsupported card for `attempt`, then makes the re-check Retry starts pass. */
async function unsupportedCard(attempt: () => void) {
  const settle = pendingAdapter();
  render(<OpenProbe />);
  act(attempt);
  await settleProbe(settle, null);
  assert.equal(useViewerStore.getState().error, viewportLightingEn[UNSUPPORTED]);
  Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({}) }, configurable: true });
}

async function pressRetry() {
  await act(async () => { useViewerStore.getState().lastLoadRetry?.(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** The load-error card as plain values: its text and whether it offers Retry. */
function card() {
  const { error, lastLoadRetry } = useViewerStore.getState();
  return { error, hasRetry: lastLoadRetry !== null };
}
const NO_CARD = { error: null, hasRetry: false };

describe('useWebGpuOpenGuard pending-probe notice (G1)', () => {
  it('pending -> supported: a drop opens once, and the card and its Retry clear together (#9493 review: partial clear)', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    let opened = 0;
    const attempt = () => { if (guard(attempt, { replay: 'free' })) opened += 1; };
    act(attempt);
    assert.equal(opened, 0);
    assert.deepEqual(card(), { error: viewportLightingEn[CHECKING], hasRetry: true }, 'the drop explains the pending check');

    await settleProbe(settle, {});
    assert.deepEqual(card(), NO_CARD, '"still being checked" and its Retry must not outlive the check');
    assert.equal(opened, 1, 'the dropped model opens once WebGPU turns out to be supported');
  });

  it('pending -> retrying -> supported, opted in: Retry opens a drop once and clears the card (#9493 review: double open, stuck card)', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    let opened = 0;
    const attempt = () => { if (guard(attempt, { replay: 'free' })) opened += 1; };
    act(attempt);
    const retry = useViewerStore.getState().lastLoadRetry;
    assert.ok(retry, 'the checking card offers Retry');
    act(() => { retry(); retry(); }); // waits on the same pending probe; a second click coalesces

    await settleProbe(settle, {});
    assert.equal(opened, 1, `Retry and the settled check must not both open the model (opened ${opened} times)`);
    assert.deepEqual(card(), NO_CARD, 'the checking card must not stay up after Retry\'s check passes');
  });

  it('pending -> retrying -> supported, picker whose activation expired: Retry clears the card and never replays the open (#9493 review: activation)', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    let calls = 0;
    const attempt = () => { calls += 1; guard(attempt); };
    act(attempt);
    act(() => useViewerStore.getState().lastLoadRetry?.());
    await settleProbe(settle, {});
    assert.equal(calls, 1, 'the open must not run again once the click\'s activation is gone');
    assert.deepEqual(card(), NO_CARD, 'the user clicks Open again on a clean viewport');
  });

  it('pending -> supported without opt-in: an open that needs a user gesture is not replayed; the card just clears', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    let opened = 0;
    const attempt = () => { if (guard(attempt)) opened += 1; };
    act(attempt);
    await settleProbe(settle, {});
    assert.deepEqual(card(), NO_CARD);
    assert.equal(opened, 0, 'a picker-style open must wait for the user to click again');
  });

  it('pending -> supported with no retry: the notice clears', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    act(() => { guard(); });
    assert.deepEqual(card(), { error: viewportLightingEn[CHECKING], hasRetry: false });
    await settleProbe(settle, {});
    assert.deepEqual(card(), NO_CARD);
  });

  it('a resumed open that throws reports its error on the load-error card (#9493 review: lost notice)', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    const errors = mock.method(console, 'error', () => {});
    try {
      act(() => { guard(() => { throw new Error('model routing failed'); }, { replay: 'free' }); });
      await settleProbe(settle, {});
      assert.deepEqual(card(), { error: 'model routing failed', hasRetry: false }, 'the failure is shown, not swallowed');
      assert.equal(errors.mock.callCount(), 1);
    } finally {
      errors.mock.restore();
    }
  });

  it('a resumed open that re-enters guard() during a new check keeps the new notice (#9493 review: recursive guard)', async () => {
    const settleFirst = pendingAdapter();
    render(<OpenProbe />);
    let settleSecond: ((adapter: object | null) => void) | undefined;
    let secondOpened = 0;
    const second = () => { if (guard(second, { replay: 'free' })) secondOpened += 1; };
    const first = () => {
      if (!guard(first, { replay: 'free' })) return;
      // While the first open runs, the GPU changes and a fresh check starts.
      settleSecond = pendingAdapter();
      void retryWebGPU();
      second();
    };
    act(first);
    await settleProbe(settleFirst, {});
    assert.deepEqual(card(), { error: viewportLightingEn[CHECKING], hasRetry: true }, 'the re-entered open shows its own pending card');
    assert.ok(settleSecond);
    await settleProbe(settleSecond, {});
    assert.equal(secondOpened, 1, 'the re-entered open resumes when its own check passes');
    assert.deepEqual(card(), NO_CARD);
  });

  it('pending -> unsupported after a locale switch: the card follows the locale and keeps Retry', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    act(() => { guard(() => {}); });
    assert.equal(card().error, viewportLightingEn[CHECKING]);

    act(() => setLocale('g1-pseudo'));
    assert.equal(card().error, '⟦checking⟧', 'the pending notice follows the locale');
    await settleProbe(settle, null);
    assert.deepEqual(card(), { error: '⟦unsupported⟧', hasRetry: true }, 'Retry survives the hand-over');
  });

  it('retrying -> unsupported: the card hands over to "unsupported" and Retry works again', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    let opened = 0;
    const attempt = () => { if (guard(attempt, { replay: 'free' })) opened += 1; };
    act(attempt);
    act(() => useViewerStore.getState().lastLoadRetry?.());
    await settleProbe(settle, null);
    assert.deepEqual(card(), { error: viewportLightingEn[UNSUPPORTED], hasRetry: true });

    Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({}) }, configurable: true });
    await act(async () => { useViewerStore.getState().lastLoadRetry?.(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(opened, 1, 'the second Retry rechecks and opens');
    assert.deepEqual(card(), NO_CARD);
  });

  it('retrying, still checking: a locale switch re-renders the card it shows, then a passing check clears it (#9493 review)', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    let opened = 0;
    const attempt = () => { if (guard(attempt, { replay: 'free' })) opened += 1; };
    act(attempt);
    act(() => useViewerStore.getState().lastLoadRetry?.());
    act(() => setLocale('g1-pseudo'));
    assert.deepEqual(card(), { error: '⟦checking⟧', hasRetry: true }, 'the Retry-owned checking card follows the locale');
    await settleProbe(settle, {});
    assert.equal(opened, 1);
    assert.deepEqual(card(), NO_CARD);
  });

  it('retrying from the unsupported card: a locale switch during the re-check keeps it the unsupported text, in the new locale (#9493 review)', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    act(() => { guard(() => {}); });
    await settleProbe(settle, null);
    assert.equal(card().error, viewportLightingEn[UNSUPPORTED]);

    const settleRecheck = pendingAdapter();
    act(() => useViewerStore.getState().lastLoadRetry?.());
    act(() => setLocale('g1-pseudo'));
    assert.deepEqual(card(), { error: '⟦unsupported⟧', hasRetry: true });
    await settleProbe(settleRecheck, null);
    assert.deepEqual(card(), { error: '⟦unsupported⟧', hasRetry: true });
  });

  it('Start blank (on-retry): Retry on the unsupported card replays it after the re-check, no gesture needed (#9493 re-review)', async () => {
    let opened = 0;
    const attempt = () => { if (guard(attempt, { replay: 'on-retry' })) opened += 1; };
    setActivation(false);
    await unsupportedCard(attempt);
    await pressRetry();
    assert.equal(opened, 1, 'Start blank opens after Retry, as it did before');
    assert.deepEqual(card(), NO_CARD);
  });

  it('Start blank (on-retry): a passing pending check clears the card without opening (#9493 re-review)', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    let opened = 0;
    const attempt = () => { if (guard(attempt, { replay: 'on-retry' })) opened += 1; };
    act(attempt);
    await settleProbe(settle, {});
    assert.equal(opened, 0);
    assert.deepEqual(card(), NO_CARD);
  });

  it('picker (activation): Retry on the unsupported card replays it while the click is still active, and not once it expired (#9493 re-review)', async () => {
    for (const isActive of [true, false]) {
      useViewerStore.getState().resetViewerState();
      let opened = 0;
      const attempt = () => { if (guard(attempt)) opened += 1; };
      await unsupportedCard(attempt);
      setActivation(isActive);
      await pressRetry();
      assert.equal(opened, isActive ? 1 : 0, `activation active=${isActive}`);
      assert.deepEqual(card(), NO_CARD, `activation active=${isActive}: the card clears either way`);
      cleanup();
    }
  });

  it('Retry clicked after the check already passed runs even a picker inside the click (#9493 re-review)', async () => {
    let opened = 0;
    const attempt = () => { if (guard(attempt)) opened += 1; };
    await unsupportedCard(attempt);
    // Something else re-checked first: WebGPU is supported, our card is still up.
    await act(async () => { await retryWebGPU(); });
    assert.deepEqual(card(), { error: viewportLightingEn[UNSUPPORTED], hasRetry: true });
    setActivation(false); // only the synchronous path can open it now
    act(() => useViewerStore.getState().lastLoadRetry?.());
    assert.equal(opened, 1);
    assert.deepEqual(card(), NO_CARD);
  });

  it('a dismissed card\'s Retry starts no re-check (#9493 re-review)', async () => {
    let opened = 0;
    const attempt = () => { if (guard(attempt, { replay: 'free' })) opened += 1; };
    await unsupportedCard(attempt);
    let requests = 0;
    Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => { requests += 1; return {}; } }, configurable: true });
    const retry = useViewerStore.getState().lastLoadRetry;
    assert.ok(retry);
    useViewerStore.getState().setError(null); // dismissed
    await act(async () => { retry(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(requests, 0, 'no adapter re-check for a card that is gone');
    assert.equal(opened, 0);
  });

  it('a newer card with the same text but another Retry is left alone (#9493 re-review)', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    let opened = 0;
    const attempt = () => { if (guard(attempt, { replay: 'free' })) opened += 1; };
    act(attempt);
    useViewerStore.setState({ lastLoadRetry: () => {} });
    await settleProbe(settle, {});
    assert.equal(opened, 0);
    assert.deepEqual(card(), { error: viewportLightingEn[CHECKING], hasRetry: true });
  });

  it('when the last guard unmounts mid-check, its card goes and a later mount does not replay the old open (#9493 re-review)', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    let opened = 0;
    act(() => { guard(() => { opened += 1; }, { replay: 'free' }); });
    cleanup();
    assert.deepEqual(card(), NO_CARD);
    render(<OpenProbe />);
    await settleProbe(settle, {});
    assert.equal(opened, 0);
  });

  it('pending -> newer error: a settled check leaves the newer error alone', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    act(() => { guard(() => {}, { replay: 'free' }); });
    useViewerStore.setState({ error: 'newer load failed', lastLoadRetry: null });
    await settleProbe(settle, {});
    assert.deepEqual(card(), { error: 'newer load failed', hasRetry: false });
  });
});
