/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8568: in the default build a dropped `.splat` is a model file: the drop
 * routing hands it to the canonical loader instead of raising the
 * unsupported-format toast that a kill-switch build or an unknown extension
 * gets. Loading through to a published capture is `useIfcLoader.gaussian*.test.tsx`.
 */
import '@/test/setup-dom.js';
import { after, afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { advance, cleanup, render } from '@/test/render.js';
import { latestToast } from '@/test/toasts.js';
import { useViewerStore } from '@/store';
import { fieldTelemetry } from '@/lib/perf/fieldTelemetryLoader.js';
import { setGaussianBuild } from '@/test/gaussian-loader-harness';
import { ViewportContainer } from './ViewportContainer.js';

function drop(target: EventTarget, file: File): void {
  const dataTransfer = {
    types: ['Files'], files: [file], items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
    dropEffect: 'none', effectAllowed: 'all',
  } as unknown as DataTransfer;
  for (const type of ['dragenter', 'dragover', 'drop']) {
    const event = new window.Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    act(() => { target.dispatchEvent(event); });
  }
}

const restoreBuild = setGaussianBuild(undefined);
Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(), limits: {} }) } });
after(() => { restoreBuild(); Reflect.deleteProperty(navigator, 'gpu'); fieldTelemetry?.resetFieldEventsForTests(); });
afterEach(() => cleanup());

it('a dropped .splat reaches the canonical loader, not the unsupported-format toast (#8568)', async () => {
  useViewerStore.setState({ ifcDataStore: null, geometryResult: null, models: new Map(), error: null, loadingFileName: null });
  render(<ViewportContainer />);
  await advance(0);
  const before = latestToast();
  const chrome = document.createElement('div');
  document.body.appendChild(chrome);
  drop(chrome, new File([new Uint8Array(32)], 'scan.splat'));
  for (let i = 0; i < 50 && useViewerStore.getState().loadingFileName !== 'scan.splat'; i++) await advance(20);
  assert.equal(useViewerStore.getState().loadingFileName, 'scan.splat', 'the drop started a canonical load of the capture');
  assert.equal(latestToast(), before, 'no unsupported-format toast');
  useViewerStore.getState().activeLoadCanceller?.();
  chrome.remove();
});
