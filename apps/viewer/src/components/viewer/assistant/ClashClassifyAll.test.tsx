/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { act, useState } from 'react';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeClashes } from '@ifc-lite/clash';
import { render, click, cleanup, waitFor } from '@/test/render';
import { clashFindings, serveClassifier } from '@/test/clash-classifier-stub';
import { useViewerStore } from '@/store';
import type { ClassifyRunResult } from '@/lib/assistant/clash-classify-run';
import { ClashClassifyAll } from './ClashClassifyAll';

const pendingReplies: Array<() => void> = [];
function holdClassifier() {
  const requests = serveClassifier();
  const transport = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const reply = transport(input, init);
    return new Promise<Response>((resolve, reject) => {
      pendingReplies.push(() => { void reply.then(resolve, reject); });
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch;
  return requests;
}

const initial = useViewerStore.getState();
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); for (const finish of pendingReplies.splice(0)) finish(); globalThis.fetch = originalFetch; useViewerStore.setState(initial, true); });

// #6906: closing the review mid-run must not keep spending budget or report into a panel that is gone.
test('unmounting during a full-run classification aborts the in-flight request and reports nothing', async () => {
  const clashes = clashFindings(250);
  const result = { clashes, summary: summarizeClashes(clashes), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  useViewerStore.setState({ clashResult: result, chatActiveModel: 'test/free-model' });
  const requests = holdClassifier();
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

// C-10: ClashGroupReview keeps the component mounted while switching results.
test('C-10 replacing the result aborts the old classification and resets its controls', async () => {
  const clashes = clashFindings(250);
  const result = { clashes, summary: summarizeClashes(clashes), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  useViewerStore.setState({ clashResult: result, chatActiveModel: 'test/free-model' });
  const requests = holdClassifier();
  const stubbed = globalThis.fetch;
  let signal: AbortSignal | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal ?? undefined; return stubbed(input, init); }) as typeof fetch;
  const results: ClassifyRunResult[] = [];
  let replace!: () => void;
  function Host() {
    const [current, setCurrent] = useState(result);
    replace = () => setCurrent({ ...result });
    return <ClashClassifyAll result={current} enabled onResult={run => results.push(run)} />;
  }
  const ui = render(<Host />);
  click([...ui.querySelectorAll('button')].find(b => b.textContent === 'Classify all findings')!);
  await waitFor(() => requests.length === 1, 'classification started');
  act(() => replace());
  assert.equal(signal?.aborted, true, 'old request aborted on result replacement');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  assert.equal(results.length, 0, 'old result never reaches the new review');
  assert.equal([...ui.querySelectorAll('button')].some(b => b.textContent === 'Classify all findings'), true);
});

test('C-10 selecting another model aborts the classification owner', async () => {
  const clashes = clashFindings(10);
  const result = { clashes, summary: summarizeClashes(clashes), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  useViewerStore.setState({ clashResult: result, chatActiveModel: 'test/free-model' });
  const requests = holdClassifier();
  const transport = globalThis.fetch;
  let signal: AbortSignal | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal ?? undefined; return transport(input, init); }) as typeof fetch;
  const ui = render(<ClashClassifyAll result={result} enabled onResult={() => {}} />);
  click([...ui.querySelectorAll('button')].find(button => button.textContent === 'Classify all findings')!);
  await waitFor(() => requests.length === 1, 'classification started');
  act(() => useViewerStore.setState({ chatActiveModel: 'test/other-free-model' }));
  assert.equal(signal?.aborted, true);
});

test('C-10 same-tick classification presses start one request', async () => {
  const clashes = clashFindings(10);
  const result = { clashes, summary: summarizeClashes(clashes), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  useViewerStore.setState({ clashResult: result, chatActiveModel: 'test/free-model' });
  serveClassifier(); const transport = globalThis.fetch;
  const releases: Array<() => void> = [];
  let starts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { starts++; await new Promise<void>(resolve => releases.push(resolve)); return transport(input, init); }) as typeof fetch;
  const ui = render(<ClashClassifyAll result={result} enabled onResult={() => {}} />);
  const start = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Classify all findings')!;
  act(() => { start.click(); start.click(); });
  await waitFor(() => starts > 0, 'classification transport started');
  const count = starts;
  await act(async () => { for (const release of releases) release(); });
  assert.equal(count, 1);
});
