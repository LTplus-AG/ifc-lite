/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Comparison evidence sent to the assistant (#6921), over the committed
 * revision pair with a native clash run loaded: the outbound payload carries
 * the native diff, the impact section with its limitations, and the last
 * reconciliation — compatible counts, or the refusal with its reasons, never
 * findings for incompatible runs. A reconciliation computed for another
 * comparison is not sent.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { fixtureModels } from '@/test/store-fixture';
import { reconcileContextOf } from '@/lib/compare/compare-analysis-state';
import { reconcileRuns } from '@/lib/compare/run-reconcile';
import type { CapturedRun } from '@/lib/compare/run-reconcile-types';
import { PINS, revisionPair, runClash, type RevisionPair } from '@/lib/compare/revision-pair.test-support';
import { captureEvidence } from './evidence';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial, true); });

interface Payload {
  totalRows: number;
  evidence: { summary: { counts: unknown; impact: { totals: Record<string, number>; limitations: string; sources: Record<string, string> };
    reconciliation: { compatible: boolean; counts?: Record<string, number>; excluded?: number; incompatibilities?: Array<{ code: string }> } | null };
  rows: Array<{ citation: string; data: { section: string; state?: string; kind?: string; identity?: string } }> };
}

async function seed(pair: RevisionPair) {
  const clash = await runClash(pair, ['A', 'B']);
  useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), compareResult: pair.compare, clashResult: clash, clashRawResult: clash });
  const run: CapturedRun = { kind: 'clash', id: 'joint', capturedAt: '2026-10-05T00:00:00.000Z', modelIds: ['A', 'B'], stamp: null, result: clash };
  return run;
}
const payload = () => JSON.parse(captureEvidence('compare').payload) as Payload;

describe('comparison evidence for the assistant (#6921)', () => {
  it('sends the diff, the impact and a compatible reconciliation, each row in its section', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const run = await seed(pair);
    const state = useViewerStore.getState();
    state.setCompareReconciliation({ outcome: reconcileRuns(run, run, reconcileContextOf(state)), comparison: pair.compare });
    const sent = payload();
    assert.deepEqual(sent.evidence.summary.counts, { added: 1, deleted: 1, modified: 2, unchanged: 19 });
    assert.equal(sent.evidence.summary.impact.totals.clash, 2);
    assert.equal(sent.evidence.summary.impact.sources.validation, 'unavailable');
    assert.match(sent.evidence.summary.impact.limitations, /not proof that the change caused or fixed it/);
    assert.equal(sent.evidence.summary.reconciliation?.compatible, true);
    assert.deepEqual(sent.evidence.summary.reconciliation?.counts, { new: 1, resolved: 0, persisting: 0, changed: 0, notEvaluated: 0 });
    assert.equal(sent.evidence.summary.reconciliation?.excluded, 1);
    // Changed diff entries lead the diff section; impact and reconciliation rows follow it.
    const sections = sent.evidence.rows.map(row => row.data.section);
    assert.deepEqual(sent.evidence.rows.slice(0, 4).map(row => row.data.state).sort(), ['added', 'deleted', 'modified', 'modified']);
    assert.equal(sections.filter(s => s === 'impact').length, 2);
    const reconciliation = sent.evidence.rows.filter(row => row.data.section === 'reconciliation');
    assert.equal(reconciliation.length, 1);
    assert.ok(reconciliation[0].data.identity?.includes(PINS.clashAdded));
    assert.equal(sent.totalRows, pair.compare.diff.entries.length + 2 + 1);
  });

  it('sends a refusal with its reasons and no findings, and nothing for another comparison', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const run = await seed(pair);
    const wider: CapturedRun = { ...run, id: 'wider', result: await runClash(pair, ['A', 'B'], { tolerance: 0.01 }) } as CapturedRun;
    const state = useViewerStore.getState();
    state.setCompareReconciliation({ outcome: reconcileRuns(run, wider, reconcileContextOf(state)), comparison: pair.compare });
    const refused = payload();
    assert.deepEqual(refused.evidence.summary.reconciliation, { kind: 'clash', compatible: false, incompatibilities:
      [{ code: 'settingsDiffer', detail: 'tolerance 0.002 / 0.01; excludeVoidsAndHosts true / true' }] });
    assert.equal(refused.evidence.rows.some(row => row.data.section === 'reconciliation'), false);

    state.setCompareReconciliation({ outcome: reconcileRuns(run, run, reconcileContextOf(state)), comparison: { ...pair.compare } });
    assert.equal(payload().evidence.summary.reconciliation, null);
  });
});
