/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Validation reconciliation invariants beyond the happy path (#6921), over
 * the committed revision pair with native runs:
 *
 * - A rules run is compared by its rule CONTENT, not its rule-set name: an
 *   edited rule (same name, same stable rule id) is refused, never reported
 *   as resolved failures. A report whose rule content was not recorded is
 *   refused as unknown, never assumed equal.
 * - A run without an analysis stamp has unknown freshness and is refused.
 * - The base side's gaps count too: a head failure is `new` only when the
 *   base run evaluated that element; otherwise it is not evaluated and the
 *   reconciliation is partial.
 * - Two results sharing one GlobalId have no cross-revision identity; they
 *   are reported as excluded, never silently collapsed into one.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ValidationReport } from '@ifc-lite/ids';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { Rule, type RuleSetFile } from '@ifc-lite/rules';
import type { ViewerState } from '@/store';
import { reconcileContextOf } from './compare-analysis-state';
import { reconcileRuns } from './run-reconcile';
import type { CapturedRun, ReconcileContext, ReconcileOutcome } from './run-reconcile-types';
import { revisionPair, runIds, runRules, type RevisionPair } from './revision-pair.test-support';

const STAMP = { mutationVersion: 0, geometryContentVersion: 0 };
let seq = 0;
const walls = (report: ValidationReport) => {
  const spec = report.specificationResults.find(s => s.specification.name === 'Walls are external');
  assert.ok(spec, 'the committed IDS checks walls');
  return spec;
};
const run = (model: string, report: ValidationReport): CapturedRun =>
  ({ kind: 'validation', id: `v-${++seq}`, capturedAt: '2026-10-05T00:00:00.000Z', modelIds: [model], stamp: STAMP, report });

function context(pair: RevisionPair): ReconcileContext {
  const state = { compareResult: pair.compare, models: new Map([['A', pair.base], ['B', pair.head]]),
    mutationVersion: 0, geometryContentVersion: 0, modelPlacement: null } as unknown as ViewerState;
  const ctx = reconcileContextOf(state);
  assert.ok(ctx);
  return ctx;
}
function ok(outcome: ReconcileOutcome) {
  assert.ok(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.incompatibilities));
  return outcome;
}

/** Walls must carry a Name equal to `value`: every wall fails unless named so. */
const wallsNamed = (value: string): RuleSetFile => ({ version: 1, name: 'Wall naming', rules: [{
  id: 'wall-name', name: 'Walls are named',
  applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
  requirement: { kind: 'element', block: { groups: [{ rules: [Rule.attribute('Name', 'eq', value)], combinator: 'AND' }], authoredAs: 'chips' } },
}] });

describe('validation reconciliation compares rule content and freshness (#6921)', () => {
  it('refuses a rules run whose rule was edited under the same name and id', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const base = run('A', await runRules(pair, 'A', wallsNamed('never-authored-6921')));
    const edited = run('B', await runRules(pair, 'B', wallsNamed('another-value-6921')));
    const refused = reconcileRuns(base, edited, context(pair));
    assert.ok(!refused.ok, 'an edited rule must not turn base failures into resolutions');
    assert.deepEqual(refused.incompatibilities.map(i => i.code), ['sourceDiffers', 'specificationsDiffer']);
    assert.equal(refused.incompatibilities[1].detail, 'wall-name');

    // The same content in a separately built file reconciles.
    const same = ok(reconcileRuns(base, run('B', await runRules(pair, 'B', wallsNamed('never-authored-6921'))), context(pair)));
    assert.ok(same.counts.persisting > 0, 'every wall still fails the unchanged rule');
    assert.equal(same.counts.resolved, 0);
  });

  it('refuses a rules report whose rule content was never recorded', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const report = await runRules(pair, 'A', wallsNamed('never-authored-6921'));
    const head = run('B', await runRules(pair, 'B', wallsNamed('never-authored-6921')));
    const refused = reconcileRuns(run('A', { ...report }), head, context(pair));
    assert.ok(!refused.ok);
    assert.deepEqual(refused.incompatibilities.map(i => i.code), ['sourceUnknown']);
  });

  it('refuses a run with no analysis stamp: its freshness is unknown', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const base = run('A', await runIds(pair, 'A'));
    const head = run('B', await runIds(pair, 'B'));
    const refused = reconcileRuns({ ...base, stamp: null }, head, context(pair));
    assert.ok(!refused.ok);
    assert.deepEqual(refused.incompatibilities, [{ code: 'runFreshnessUnknown', sides: ['base'] }]);
  });
});

describe('validation reconciliation honours base-side gaps (#6921)', () => {
  /** A wall passing "Walls are external" in A, made non-external in B: a genuinely new failure. */
  async function newFailure(pair: RevisionPair) {
    const complete = await runIds(pair, 'A');
    const wall = walls(complete).entityResults.find(e => e.passed && e.globalId)?.globalId;
    assert.ok(wall, 'the committed IDS passes at least one wall in A');
    const view = new MutablePropertyView(pair.head.ifcDataStore.properties, 'B');
    const id = pair.head.ifcDataStore.entities.getExpressIdByGlobalId(wall);
    assert.ok(id);
    view.setProperty(id, 'Pset_WallCommon', 'IsExternal', false, PropertyValueType.Boolean);
    return { wall, head: run('B', await runIds(pair, 'B', { view })) };
  }

  it('a head failure is new only when the base run evaluated the element', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const { wall, head } = await newFailure(pair);
    const complete = ok(reconcileRuns(run('A', await runIds(pair, 'A')), head, context(pair)));
    assert.equal(complete.findings.find(f => f.identity.endsWith(wall))?.state, 'new');
    assert.equal(complete.partial, false);

    // The same base run without its passing results evaluated fewer entities than it found applicable.
    const gapped = ok(reconcileRuns(run('A', await runIds(pair, 'A', { omitPassing: true })), head, context(pair)));
    const finding = gapped.findings.find(f => f.identity.endsWith(wall));
    assert.equal(finding?.state, 'notEvaluated', 'absence from an incomplete base run is not proof the element passed');
    assert.equal(finding?.reason, 'baseNotEvaluated');
    assert.equal(gapped.counts.new, 0);
    assert.equal(gapped.partial, true);
    assert.equal(gapped.counts.persisting, complete.counts.persisting, 'failures the base did report still pair');

    // A base gap is disclosed even when no head finding happens to fall into it.
    const unedited = ok(reconcileRuns(run('A', await runIds(pair, 'A', { omitPassing: true })), run('B', await runIds(pair, 'B')), context(pair)));
    assert.equal(unedited.counts.notEvaluated, 0);
    assert.equal(unedited.partial, true);
  });

  it('reports results sharing one GlobalId as excluded instead of collapsing them', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const base = await runIds(pair, 'A');
    const head = await runIds(pair, 'B');
    const plain = ok(reconcileRuns(run('A', base), run('B', head), context(pair)));
    // Stated invariant: a model may carry one GlobalId twice (a copy-pasted element). Repeat one
    // native failing result under a second express id on the base side.
    const spec = walls(base);
    const failing = spec.entityResults.find(e => !e.passed && e.globalId);
    assert.ok(failing);
    const twin = { ...failing, expressId: failing.expressId + 1_000_000 };
    const duplicated = { ...base, specificationResults: base.specificationResults
      .map(s => s === spec ? { ...spec, entityResults: [...spec.entityResults, twin] } : s) };
    const outcome = ok(reconcileRuns(run('A', duplicated), run('B', head), context(pair)));
    assert.equal(outcome.findings.some(f => f.identity.endsWith(failing.globalId!)), false, 'an ambiguous identity is not reconciled');
    // Both base results, and the head's failing result for that GlobalId, are left out and counted.
    const headFailing = walls(head).entityResults
      .filter(e => e.globalId === failing.globalId && !e.passed).length;
    assert.equal(outcome.excluded, plain.excluded + 2 + headFailing);
  });
});
