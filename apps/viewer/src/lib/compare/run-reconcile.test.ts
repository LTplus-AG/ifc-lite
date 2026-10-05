/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Run reconciliation across the committed revision pair (#6921). Every run
 * is native: the TS clash engine over the real meshes, `validateIDS` over the
 * committed IDS, and one native property correction through
 * `MutablePropertyView` for the validation `resolved` case.
 *
 * The clash rules are declared here so that revision B's intentional changes
 * produce every state: B's moved wall leaves two clearance findings
 * (`resolved` — both elements still in B and re-examined by the same rule),
 * B's deleted chair leaves two (`notEvaluated` — the chair cannot be
 * re-examined), B's added duct makes one (`new`) and three persist.
 *
 * Invariants: incompatible runs are refused with every specific reason and
 * no findings; absence is `resolved` only after a complete, compatible
 * re-examination; one run spanning both revisions reconciles to exactly the
 * same findings as two single-revision runs, with cross-revision pairs
 * excluded rather than counted.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClashRule } from '@ifc-lite/clash';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';
import { reconcileContextOf } from './compare-analysis-state';
import { reconcileRuns } from './run-reconcile';
import type { CapturedRun, ReconcileContext, ReconcileOutcome } from './run-reconcile-types';
import { PINS, revisionPair, runClash, runIds, type RevisionPair } from './revision-pair.test-support';

const RULES: ClashRule[] = [
  { id: 'WALLS', name: 'Wall clearance', a: 'IfcWall', mode: 'clearance', clearance: 0.3, reportTouch: true },
  { id: 'WALLxFURN', name: 'Wall x furniture', a: 'IfcWall', b: 'IfcFurniture|IfcBuildingElementProxy', mode: 'clearance', clearance: 0.5 },
  { id: 'DUCTxWALL', name: 'Duct x wall', a: 'IfcDuctSegment', b: 'IfcWall', mode: 'hard' },
];
/** The plumbing wall the committed IDS's "Walls are external" fails on both revisions. */
const PLUMBING_WALL = '1uS5vfZPn9R8PlAaVd73on';

let seq = 0;
const meta = () => ({ id: `run-${++seq}`, capturedAt: '2026-10-05T00:00:00.000Z', stamp: null });
const clashRun = async (pair: RevisionPair, models: string[], options: Parameters<typeof runClash>[2] = {}): Promise<CapturedRun> =>
  ({ ...meta(), kind: 'clash', modelIds: models, result: await runClash(pair, models, { rules: RULES, ...options }) });
const idsRun = async (pair: RevisionPair, model: string, options: Parameters<typeof runIds>[2] = {}): Promise<CapturedRun> =>
  ({ ...meta(), kind: 'validation', modelIds: [model], report: await runIds(pair, model, options) });

function context(pair: RevisionPair, overrides: Partial<ReconcileContext> = {}): ReconcileContext {
  const state = { compareResult: pair.compare, models: new Map([['A', pair.base], ['B', pair.head]]),
    mutationVersion: 0, geometryContentVersion: 0, modelPlacement: null } as unknown as ViewerState;
  const ctx = reconcileContextOf(state);
  assert.ok(ctx);
  return { ...ctx, ...overrides };
}

function ok(outcome: ReconcileOutcome) {
  assert.ok(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.incompatibilities));
  return outcome;
}
const byState = (outcome: Extract<ReconcileOutcome, { ok: true }>) => Object.fromEntries(
  (['new', 'resolved', 'persisting', 'changed', 'notEvaluated'] as const).map(state =>
    [state, outcome.findings.filter(f => f.state === state).map(f => f.identity).sort()]));

describe('clash run reconciliation on the committed revision pair (#6921)', () => {
  it('classifies every finding from two single-revision runs', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const outcome = ok(reconcileRuns(await clashRun(pair, ['A']), await clashRun(pair, ['B']), context(pair)));
    assert.deepEqual(outcome.counts, { new: 1, resolved: 2, persisting: 3, changed: 0, notEvaluated: 2 });
    const states = byState(outcome);
    assert.ok(states.new[0].includes(PINS.clashAdded), 'the injected duct clash is new');
    for (const identity of states.resolved) assert.ok(identity.includes(PINS.geometryMoved), `${identity} involves the moved wall`);
    for (const identity of states.notEvaluated) assert.ok(identity.includes(PINS.deleted), `${identity} involves the deleted chair`);
    assert.ok(outcome.findings.filter(f => f.state === 'notEvaluated').every(f => f.reason === 'elementNotReexamined'));
    assert.equal(outcome.partial, true, 'unevaluated findings make the reconciliation partial');
    assert.equal(outcome.excluded, 0);
  });

  it('one run over both revisions reconciles identically and excludes cross-revision pairs', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const separate = ok(reconcileRuns(await clashRun(pair, ['A']), await clashRun(pair, ['B']), context(pair)));
    const both = await clashRun(pair, ['A', 'B']);
    const crossRevision = both.kind === 'clash' ? both.result.clashes.filter(c => c.a.model !== c.b.model).length : 0;
    assert.ok(crossRevision > 0, 'the federation run pairs A against B');
    const joint = ok(reconcileRuns(both, both, context(pair)));
    assert.deepEqual(byState(joint), byState(separate));
    assert.equal(joint.excluded, crossRevision);
  });

  it('a truncated head run never resolves', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const head = await clashRun(pair, ['B'], { maxCandidatePairs: 1 });
    assert.ok(head.kind === 'clash' && head.result.truncated, 'the cap truncated the native run');
    const outcome = ok(reconcileRuns(await clashRun(pair, ['A']), head, context(pair)));
    assert.equal(outcome.counts.resolved, 0);
    assert.ok(outcome.findings.some(f => f.reason === 'headRunTruncated'));
    assert.equal(outcome.partial, true);
  });

  it('refuses changed rules, settings, models and stale runs, naming each', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const base = await clashRun(pair, ['A']);
    const widened = RULES.map(rule => rule.id === 'WALLS' ? { ...rule, clearance: 0.4 } : rule);
    const head = await clashRun(pair, ['B'], { rules: widened, tolerance: 0.01 });
    const refused = reconcileRuns(base, head, context(pair));
    assert.equal(refused.ok, false);
    assert.ok(!refused.ok);
    assert.deepEqual(refused.incompatibilities.map(i => i.code), ['rulesDiffer', 'settingsDiffer']);
    assert.equal(refused.incompatibilities[0].detail, 'WALLS');
    assert.equal('findings' in refused, false);

    const wrongSide = reconcileRuns(await clashRun(pair, ['B']), await clashRun(pair, ['A']), context(pair));
    assert.ok(!wrongSide.ok);
    assert.deepEqual(wrongSide.incompatibilities.map(i => i.code), ['baseModelNotInRun', 'headModelNotInRun']);

    const unknown = reconcileRuns({ ...base, modelIds: null }, await clashRun(pair, ['B']), context(pair));
    assert.ok(!unknown.ok);
    assert.deepEqual(unknown.incompatibilities.map(i => i.code), ['runModelsUnknown']);

    const stale = reconcileRuns(base, await clashRun(pair, ['B']), context(pair, { isStale: run => run === base }));
    assert.ok(!stale.ok);
    assert.deepEqual(stale.incompatibilities, [{ code: 'runStale', detail: base.id }]);

    const mixed = reconcileRuns(base, await idsRun(pair, 'B'), context(pair));
    assert.ok(!mixed.ok);
    assert.deepEqual(mixed.incompatibilities.map(i => i.code), ['kindDiffers']);
    assert.deepEqual(reconcileRuns(base, base, null), { ok: false, kind: 'clash', baseRunId: base.id, headRunId: base.id,
      incompatibilities: [{ code: 'noComparison' }] });
  });
});

describe('validation run reconciliation on the committed revision pair (#6921)', () => {
  it('resolves only on an explicit passing result after a native correction', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const view = new MutablePropertyView(pair.head.ifcDataStore.properties, 'B');
    const wall = pair.head.ifcDataStore.entities.getExpressIdByGlobalId(PLUMBING_WALL);
    assert.ok(wall);
    view.setProperty(wall, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);
    const outcome = ok(reconcileRuns(await idsRun(pair, 'A'), await idsRun(pair, 'B', { view }), context(pair)));
    assert.deepEqual(outcome.counts, { new: 0, resolved: 1, persisting: 2, changed: 0, notEvaluated: 0 });
    const [resolved] = outcome.findings.filter(f => f.state === 'resolved');
    assert.ok(resolved.identity.endsWith(PLUMBING_WALL));
    assert.ok(resolved.headOccurrence, 'the passing head result is cited');
    assert.equal(outcome.partial, false);
  });

  it('a deleted element is not evaluated, never resolved', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const furniture = (xml: string) => xml.replace(/<\/specifications>/, `<specification name="Furniture is described" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IFCFURNITURE</simpleValue></name></entity></applicability>
      <requirements><attribute><name><simpleValue>Description</simpleValue></name><value><simpleValue>never-authored-6921</simpleValue></value></attribute></requirements>
    </specification></specifications>`);
    const outcome = ok(reconcileRuns(await idsRun(pair, 'A', { edit: furniture }), await idsRun(pair, 'B', { edit: furniture }), context(pair)));
    const chair = outcome.findings.find(f => f.identity.endsWith(PINS.deleted));
    assert.equal(chair?.state, 'notEvaluated');
    assert.equal(chair?.reason, 'entityNotEvaluated');
    assert.equal(outcome.partial, true);
  });

  it('refuses a different rule set, naming the differing specifications', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const renamed = (xml: string) => xml.replace('name="Walls are external"', 'name="Walls are external (revised)"');
    const refused = reconcileRuns(await idsRun(pair, 'A'), await idsRun(pair, 'B', { edit: renamed }), context(pair));
    assert.ok(!refused.ok);
    assert.deepEqual(refused.incompatibilities.map(i => i.code), ['sourceDiffers', 'specificationsDiffer']);
    assert.equal(refused.incompatibilities[1].detail, 'spec-1');
  });
});
