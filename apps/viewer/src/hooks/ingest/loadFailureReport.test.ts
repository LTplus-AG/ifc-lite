/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { loadFailureReporter } from './loadFailureReport.js';

const activity = { fail: (message: string) => message };

afterEach(() => { useViewerStore.setState({ error: null, lastLoadRetry: null }); });

describe('loadFailureReporter Retry', () => {
  it('re-runs the load by default', () => {
    const retryThisLoad = () => {};
    loadFailureReporter(undefined, activity, retryThisLoad, undefined)('failed', 'geometry_processing');
    assert.equal(useViewerStore.getState().lastLoadRetry, retryThisLoad);
  });

  it('offers no Retry when the browser lacks WebAssembly SIMD (#10784): the load would fail the same way', () => {
    loadFailureReporter(undefined, activity, () => {}, undefined)('no SIMD', 'wasm_simd_unsupported');
    assert.match(useViewerStore.getState().error ?? '', /can't run the WebAssembly SIMD instructions/);
    assert.equal(useViewerStore.getState().lastLoadRetry, null);
  });

  it('explains a raw SIMD compile failure a format branch passed under its own code', () => {
    const raw = 'LAZ parsing failed: WebAssembly.compileStreaming(): Compiling function #74 failed: Wasm SIMD unsupported @+117554';
    loadFailureReporter(undefined, activity, () => {}, undefined)(raw, 'laz_parse_failed');
    assert.match(useViewerStore.getState().error ?? '', /can't run the WebAssembly SIMD instructions/);
    assert.equal(useViewerStore.getState().lastLoadRetry, null);
  });
});
