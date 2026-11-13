/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A file chosen with the file input while the WebGPU check is still running
 * opens by itself once the check passes (#9493). The input's file is already
 * in hand, so replaying the open needs no user gesture (`replay: 'free'`).
 * The observable proof that the file reached the open routing is the
 * unsupported-format toast it raises for a `.blend` file, which needs no wasm
 * parser (same seam as `ViewportContainer.windowDrop.test.tsx`).
 */
import '@/test/setup-dom.js';
import { after, afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { advance, cleanup, render } from '@/test/render.js';
import { latestToast } from '@/test/toasts.js';
import { useViewerStore } from '@/store';
import { viewportLightingEn } from '@/i18n/catalogues/viewport-lighting.en';
import { ViewportContainer } from './ViewportContainer.js';
import { fieldTelemetry } from '@/lib/perf/fieldTelemetryLoader.js';

const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
const originalSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

beforeEach(() => {
  useViewerStore.setState({ ifcDataStore: null, geometryResult: null, models: new Map(), error: null, lastLoadRetry: null });
});
after(() => fieldTelemetry?.resetFieldEventsForTests());
afterEach(() => {
  cleanup();
  useViewerStore.setState({ error: null, lastLoadRetry: null });
  if (originalGpu) Object.defineProperty(navigator, 'gpu', originalGpu);
  else Reflect.deleteProperty(navigator, 'gpu');
  if (originalSecure) Object.defineProperty(window, 'isSecureContext', originalSecure);
  else Reflect.deleteProperty(window, 'isSecureContext');
});

it('a file chosen with the file input during the WebGPU check opens once the check passes (#9493 re-review)', async () => {
  let settle!: (adapter: object) => void;
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: { requestAdapter: () => new Promise<object>((resolve) => { settle = resolve; }) },
  });
  render(<ViewportContainer />);
  await advance(0);

  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(input, 'the viewport renders its hidden file input');
  const before = latestToast();
  Object.defineProperty(input, 'files', { value: [new File(['x'], 'chosen.blend')], configurable: true });
  act(() => { input.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.equal(useViewerStore.getState().error, viewportLightingEn['viewportLighting.container.loadErrorCard.webgpuChecking']);
  assert.equal(latestToast(), before, 'nothing is routed while the check is running');

  await act(async () => { settle({ features: new Set(), limits: {} }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(useViewerStore.getState().error, null, 'the checking card is gone');
  assert.match(latestToast(), /chosen\.blend/, 'the chosen file reached the open routing');
});
