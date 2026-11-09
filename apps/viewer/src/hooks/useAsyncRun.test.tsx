/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { cleanup, render } from '@/test/render.js';
import { abortError, deferred, interleave, type Deferred } from '@/test/race.js';
import { useAsyncRun, type AsyncRun, type AsyncRunContext, type AsyncRunState } from './useAsyncRun.js';

afterEach(cleanup);

interface Harness {
  api: () => AsyncRun<string, number>;
  /** Every task invocation, in order: its context and the promise it awaits. */
  calls: Array<{ run: AsyncRunContext<number>; gate: Deferred<string> }>;
  outcomes: string[];
  rerender: (key: unknown) => void;
}

/** Plain-value view of the state, so a failing assert never serialises DOM. */
function describe(state: AsyncRunState<string, number>): string {
  switch (state.kind) {
    case 'running': return state.progress === undefined ? 'running' : `running:${state.progress}`;
    case 'succeeded': return `succeeded:${state.result}`;
    case 'failed': return `failed:${String(state.error)}`;
    default: return state.kind;
  }
}

function mount(initialKey: unknown = 'a'): Harness {
  let latest: AsyncRun<string, number> | null = null;
  let setKey: ((key: unknown) => void) | null = null;
  const calls: Harness['calls'] = [];
  const outcomes: string[] = [];
  function Probe() {
    const [runKey, set] = useState<unknown>(initialKey);
    setKey = set;
    latest = useAsyncRun<string, number>({ key: runKey, label: 'test' });
    return null;
  }
  render(<Probe />);
  return {
    api: () => { assert.ok(latest); return latest; },
    calls,
    outcomes,
    rerender: (key) => { assert.ok(setKey); setKey(() => key); },
  };
}

/** Start a held task; its outcome is appended to `outcomes` when it settles. */
function begin(h: Harness, how: 'start' | 'restart' = 'start'): void {
  void h.api()[how]((run) => {
    const gate = deferred<string>();
    h.calls.push({ run, gate });
    return gate.promise;
  }).then((outcome) => { h.outcomes.push(outcome.kind === 'succeeded' ? `succeeded:${outcome.result}` : outcome.kind); });
}

const state = (h: Harness) => describe(h.api().state);
const quiet = <T,>(fn: () => Promise<T>) => async () => {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
};

test('two starts in one tick run the task once; the second is refused before busy re-renders', async () => {
  const h = mount();
  await act(async () => { begin(h); begin(h); });
  assert.equal(h.calls.length, 1, 'the ref lease, not a disabled button, refuses the second press');
  assert.deepEqual([...h.outcomes], ['refused']);
  assert.equal(state(h), 'running');
  assert.equal(h.api().busy, true);
  await act(() => interleave(() => h.calls[0].gate.resolve('a')));
  assert.deepEqual([...h.outcomes], ['refused', 'succeeded:a']);
  assert.equal(state(h), 'succeeded:a');
  assert.equal(h.api().busy, false);
});

test('a thrown error is a failed state and outcome, and busy clears', quiet(async () => {
  const h = mount();
  await act(async () => begin(h));
  await act(() => interleave(() => h.calls[0].gate.reject(new Error('boom'))));
  assert.equal(state(h), 'failed:Error: boom');
  assert.deepEqual([...h.outcomes], ['failed']);
  assert.equal(h.api().busy, false, 'a rejected run cannot leave the owner stuck busy');
}));

test('an AbortError from the task is cancelled, not failed', async () => {
  const h = mount();
  await act(async () => begin(h));
  await act(() => interleave(() => h.calls[0].gate.reject(abortError())));
  assert.equal(state(h), 'cancelled');
  assert.deepEqual([...h.outcomes], ['cancelled']);
});

test('cancel aborts the signal; the run settling late cannot overwrite the cancelled state', async () => {
  const h = mount();
  await act(async () => begin(h));
  const { run, gate } = h.calls[0];
  await act(async () => h.api().cancel());
  assert.equal(run.signal.aborted, true, 'the task can stop its own work');
  assert.equal(run.isCurrent(), false);
  assert.equal(state(h), 'cancelled');
  await act(() => interleave(() => gate.resolve('late')));
  assert.equal(state(h), 'cancelled', 'a late result does not land');
  assert.deepEqual([...h.outcomes], ['cancelled']);
});

test('reset returns to idle and lets a new run start; the old run cannot clear the new busy', async () => {
  const h = mount();
  await act(async () => begin(h));
  await act(async () => h.api().reset());
  assert.equal(state(h), 'idle');
  await act(async () => begin(h));
  assert.equal(h.calls.length, 2);
  await act(() => interleave(() => h.calls[0].gate.resolve('old')));
  assert.equal(state(h), 'running', "the older settle is not the owner's");
  assert.equal(h.api().busy, true);
  await act(() => interleave(() => h.calls[1].gate.resolve('new')));
  assert.equal(state(h), 'succeeded:new');
  assert.deepEqual([...h.outcomes], ['cancelled', 'succeeded:new']);
});

test('restart supersedes: the running run is aborted and the new one owns the state', async () => {
  const h = mount();
  await act(async () => begin(h));
  await act(async () => begin(h, 'restart'));
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].run.signal.aborted, true);
  assert.equal(h.calls[1].run.signal.aborted, false);
  await act(() => interleave(() => h.calls[1].gate.resolve('second'), () => h.calls[0].gate.resolve('first')));
  assert.equal(state(h), 'succeeded:second', 'the superseded answer arriving last does not win');
  assert.deepEqual([...h.outcomes], ['succeeded:second', 'cancelled']);
});

test('progress from the current run is shown; progress from an abandoned run is not', async () => {
  const h = mount();
  await act(async () => begin(h));
  await act(async () => h.calls[0].run.progress(1));
  assert.equal(state(h), 'running:1');
  await act(async () => begin(h, 'restart'));
  await act(async () => h.calls[0].run.progress(9));
  assert.equal(state(h), 'running', 'the superseded run reports nothing');
});

test('a key change aborts the run in flight and starts the new subject from idle', async () => {
  const h = mount('entity-1');
  await act(async () => begin(h));
  const first = h.calls[0];
  await act(async () => h.rerender('entity-2'));
  assert.equal(first.run.signal.aborted, true);
  assert.equal(state(h), 'idle');
  await act(() => interleave(() => first.gate.resolve('for entity-1')));
  assert.equal(state(h), 'idle', "entity-1's answer never lands on entity-2");
  await act(async () => begin(h));
  assert.equal(h.calls.length, 2, 'the new subject can start at once');
});

test('the same key on re-render keeps the run', async () => {
  const h = mount('entity-1');
  await act(async () => begin(h));
  await act(async () => h.rerender('entity-1'));
  assert.equal(h.calls[0].run.signal.aborted, false);
  assert.equal(state(h), 'running');
});

test('unmount aborts the run; its late settle is cancelled and writes nothing', async () => {
  const h = mount();
  await act(async () => begin(h));
  const { run, gate } = h.calls[0];
  cleanup();
  assert.equal(run.signal.aborted, true);
  assert.equal(run.isCurrent(), false);
  await interleave(() => gate.resolve('late'));
  assert.deepEqual([...h.outcomes], ['cancelled']);
});

test('an abandoned run that throws leaves the newer run running and busy', quiet(async () => {
  const h = mount();
  await act(async () => begin(h));
  await act(async () => h.api().reset());
  await act(async () => begin(h));
  await act(() => interleave(() => h.calls[0].gate.reject(new Error('old failure'))));
  assert.equal(state(h), 'running', "the old run's failure is not the newer run's");
  assert.equal(h.calls[1].run.isCurrent(), true, 'the newer run still owns the hook');
  await act(async () => begin(h));
  assert.equal(h.calls.length, 2, 'so a third press is still refused');
}));
