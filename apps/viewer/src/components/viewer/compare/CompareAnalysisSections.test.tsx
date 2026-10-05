/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The mounted Compare panel sections (#6921) over the committed revision
 * pair: the impact section reports the native duct clash run, and the
 * reconcile section captures that run, reconciles it as base and head, then
 * refuses a second run made with a different tolerance — through the
 * buttons and selects a coordinator uses.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { render, click, cleanup } from '@/test/render';
import { fixtureModels } from '@/test/store-fixture';
import { revisionPair, runClash, type RevisionPair } from '@/lib/compare/revision-pair.test-support';
import { captureClashRun } from '@/lib/compare/compare-analysis-state';
import { CompareAnalysisSections } from './CompareAnalysisSections';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

async function seed(pair: RevisionPair, tolerance = 0.002) {
  const clash = await runClash(pair, ['A', 'B'], { tolerance });
  useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), compareResult: pair.compare,
    clashResult: clash, clashRawResult: clash, compareRunCaptures: [], compareReconciliation: null });
  return clash;
}

const button = (root: HTMLElement, name: RegExp) => {
  const found = [...root.querySelectorAll('button')].find(b => name.test(b.textContent ?? '') || name.test(b.getAttribute('aria-label') ?? ''));
  assert.ok(found, `button ${name}`);
  return found;
};

describe('Compare panel impact and reconciliation sections (#6921)', () => {
  it('shows the native impact and reconciles a run over both revisions', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    await seed(pair);
    const root = render(<CompareAnalysisSections result={pair.compare} />);
    const impactToggle = button(root, /Impact on other analyses/);
    assert.equal(impactToggle.textContent?.trim().endsWith('2'), true, 'two clash findings touch a change');
    act(() => click(impactToggle));
    assert.equal(impactToggle.getAttribute('aria-expanded'), 'true');
    assert.match(root.textContent ?? '', /Clashes2 touched/);
    assert.match(root.textContent ?? '', /Validation failuresNot loaded/);
    assert.match(root.textContent ?? '', /3GwpRmJBf7fhCP8KgMyfOD · Added/);

    act(() => click(button(root, /Reconcile findings across revisions/)));
    act(() => click(button(root, /Capture current run/)));
    assert.equal(useViewerStore.getState().compareRunCaptures.length, 1);
    act(() => click(button(root, /^Reconcile$/)));
    const status = root.querySelector('output');
    assert.ok(status, 'a compatible outcome is announced');
    assert.match(status.textContent ?? '', /1New/);
    assert.match(status.textContent ?? '', /1 finding pairs or lacks identity across revisions/);
    assert.match(root.textContent ?? '', /New · HVACxARCH: IfcDuctSegment 3GwpRmJBf7fhCP8KgMyfOD × IfcWall/);
    // Removing the run releases it and drops the outcome computed from it.
    act(() => click(button(root, /Remove the selected head run/)));
    assert.deepEqual(useViewerStore.getState().compareRunCaptures, []);
    assert.equal(root.querySelector('output'), null);
  });

  it('refuses runs made with different settings and names the difference', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    await seed(pair);
    // Two runs captured earlier in the session, newest first; the selects default to them.
    const first = captureClashRun(useViewerStore.getState());
    const wider = await runClash(pair, ['A', 'B'], { tolerance: 0.01 });
    useViewerStore.setState({ clashResult: wider, clashRawResult: wider });
    const second = captureClashRun(useViewerStore.getState());
    assert.ok(first && second);
    useViewerStore.getState().addCompareRunCapture(first);
    useViewerStore.getState().addCompareRunCapture(second);
    const root = render(<CompareAnalysisSections result={pair.compare} />);
    act(() => click(button(root, /Reconcile findings across revisions/)));
    const [base, head] = [...root.querySelectorAll('select')];
    assert.deepEqual([base.value, head.value], [first.id, second.id], 'base defaults to the earlier capture, head to the latest');
    act(() => click(button(root, /^Reconcile$/)));
    const alert = root.querySelector('[role="alert"]');
    assert.ok(alert, 'the refusal is announced');
    assert.match(alert.textContent ?? '', /The clash settings differ: tolerance 0\.002 \/ 0\.01/);
    assert.equal(root.querySelector('output'), null, 'no findings are shown for incompatible runs');
  });

  it('a capture after the panel remounts keeps the earlier run as base', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    await seed(pair);
    let root = render(<CompareAnalysisSections result={pair.compare} />);
    act(() => click(button(root, /Reconcile findings across revisions/)));
    act(() => click(button(root, /Capture current run/)));
    const [first] = useViewerStore.getState().compareRunCaptures;
    // Switching panels unmounts Compare; the coordinator reruns clash with a wider tolerance and comes back.
    cleanup();
    const wider = await runClash(pair, ['A', 'B'], { tolerance: 0.01 });
    act(() => { useViewerStore.setState({ clashResult: wider, clashRawResult: wider }); });
    root = render(<CompareAnalysisSections result={pair.compare} />);
    act(() => click(button(root, /Reconcile findings across revisions/)));
    act(() => click(button(root, /Capture current run/)));
    const [base] = [...root.querySelectorAll('select')];
    assert.equal(base.value, first.id, 'the earlier capture stays the base');
    act(() => click(button(root, /^Reconcile$/)));
    assert.ok(root.querySelector('[role="alert"]'), 'runs with different tolerances are refused');
  });
});
