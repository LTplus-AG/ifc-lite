/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeClashes } from '@ifc-lite/clash';
import { render, click, cleanup, waitFor } from '@/test/render';
import { clashFindings, serveClassifier } from '@/test/clash-classifier-stub';
import { useViewerStore } from '@/store';
import type { ClassifyRunResult } from '@/lib/assistant/clash-classify-run';
import { ClashClassifyAll } from './ClashClassifyAll';

const initial = useViewerStore.getState();
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; useViewerStore.setState(initial, true); });

// #6906: closing the review mid-run must not keep spending budget or report into a panel that is gone.
test('unmounting during a full-run classification aborts the in-flight request and reports nothing', async () => {
  const clashes = clashFindings(250);
  const result = { clashes, summary: summarizeClashes(clashes), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  useViewerStore.setState({ clashResult: result, chatActiveModel: 'test/free-model' });
  const requests = serveClassifier({ hangOnChunk: 1 });
  const stubbed = globalThis.fetch;
  const signals: AbortSignal[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return stubbed(input, init);
  }) as typeof fetch;
  const results: ClassifyRunResult[] = [];
  const ui = render(<ClashClassifyAll result={result} enabled onResult={run => results.push(run)} />);
  click([...ui.querySelectorAll('button')].find(candidate => candidate.textContent === 'Classify all findings')!);
  await waitFor(() => requests.length === 1, 'first chunk requested');
  cleanup();
  await waitFor(() => signals.length > 0 && signals.every(signal => signal.aborted), 'request aborted on unmount');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(requests.length, 1, 'no further chunks are requested after unmount');
  assert.deepEqual(results, [], 'an unmounted review receives no result');
});
