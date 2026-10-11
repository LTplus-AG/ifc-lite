/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved analysis runs (#7370) over the committed revision pair. Every run is
 * native (TS clash engine over the real meshes, `validateIDS` over the
 * committed IDS); the models carry the real SHA-256 of their committed
 * files. A run saved as portable evidence and bound back must reconcile
 * exactly as the session capture did, under whatever ids the models have now,
 * and must refuse, naming every reason, when its models cannot be resolved.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClashRule } from '@ifc-lite/clash';
import { StepExporter } from '@ifc-lite/export';
import { IfcParser } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import { analysisStampFrom, isAnalysisStale } from '@/hooks/useAnalysisStaleness';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { computeFullSourceHash } from '@/utils/sourceContentHash';
import { reconcileContextOf } from './compare-analysis-state';
import { reconcileRuns } from './run-reconcile';
import type { CapturedRun, ReconcileOutcome } from './run-reconcile-types';
import { revisionPair, runClash, runIds, type LoadedModel, type RevisionPair } from './revision-pair.test-support';
import { bindSavedAnalysisRun, portableAnalysisRun } from './saved-analysis-run-binding';
import { decodeSavedAnalysisRun, type SavedAnalysisRun } from './saved-analysis-run-schema';

const RULES: ClashRule[] = [
  { id: 'WALLS', name: 'Wall clearance', a: 'IfcWall', mode: 'clearance', clearance: 0.3, reportTouch: true },
  { id: 'WALLxFURN', name: 'Wall x furniture', a: 'IfcWall', b: 'IfcFurniture|IfcBuildingElementProxy', mode: 'clearance', clearance: 0.5 },
  { id: 'DUCTxWALL', name: 'Duct x wall', a: 'IfcDuctSegment', b: 'IfcWall', mode: 'hard' },
];
const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public', 'samples');

type State = Pick<ViewerState, 'models' | 'mutationVersion' | 'geometryContentVersion' | 'modelPlacement' | 'hasChanges' | 'compareResult'>;

let hashes: Promise<{ A: string; B: string }> | null = null;
/** The full-content identity the loader records: SHA-256 of the committed bytes. */
function sourceHashes() {
  hashes ??= Promise.all(['building-architecture.ifc', 'building-architecture-rev-b.ifc'].map(async file =>
    (await computeFullSourceHash(readFileSync(join(SAMPLES, file))))!)).then(([A, B]) => ({ A, B }));
  return hashes;
}

/** The pair as a viewer session: models under the given ids, each with its real source hash. */
async function session(pair: RevisionPair, ids: { A?: string; B?: string } = {}, edited: string[] = []): Promise<State> {
  const hash = await sourceHashes();
  const open = (model: LoadedModel, id: string, sourceContentHash: string) =>
    [id, { ...model, id, sourceContentHash, sourceFingerprint: undefined }] as const;
  const a = ids.A ?? 'A', b = ids.B ?? 'B';
  return { models: new Map([open(pair.base, a, hash.A), open(pair.head, b, hash.B)]), mutationVersion: 0, geometryContentVersion: 0,
    modelPlacement: emptyPlacementState(), hasChanges: (id: string) => edited.includes(id),
    compareResult: { ...pair.compare, baseModelId: a, headModelId: b } };
}

let seq = 0;
const capture = (state: State, run: { kind: 'clash'; result: Awaited<ReturnType<typeof runClash>> } | { kind: 'validation'; report: Awaited<ReturnType<typeof runIds>> },
  modelIds: string[], placement = run.kind === 'clash'): CapturedRun =>
  ({ id: `run-${++seq}`, capturedAt: '2026-10-11T08:00:00.000Z', modelIds, stamp: analysisStampFrom(state, placement), ...run } as CapturedRun);

/** Save as the Save control does, through the JSON a backup or IndexedDB row carries, then bind into `into`. */
function roundTrip(run: CapturedRun, from: State, into: State) {
  const portable = portableAnalysisRun(run, from);
  assert.ok(portable.ok, portable.ok ? '' : portable.reason);
  const decoded = decodeSavedAnalysisRun(JSON.parse(JSON.stringify(portable.saved)));
  assert.ok(decoded, 'the saved run decodes from its own JSON');
  return { saved: decoded, bound: bindSavedAnalysisRun(decoded, into) };
}

const ok = (outcome: ReconcileOutcome) => { assert.ok(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.incompatibilities)); return outcome; };
const byState = (outcome: Extract<ReconcileOutcome, { ok: true }>) => ({ counts: outcome.counts, partial: outcome.partial, excluded: outcome.excluded,
  findings: outcome.findings.map(f => [f.state, f.identity, f.reason ?? null, f.changes ?? null]).sort((x, y) => String(x).localeCompare(String(y))) });
const reconcile = (state: State, base: CapturedRun, head: CapturedRun) => {
  const ctx = reconcileContextOf(state as unknown as ViewerState);
  assert.ok(ctx);
  return reconcileRuns(base, head, ctx);
};

describe('saved analysis runs reconcile across sessions (#7370)', () => {
  it('a saved native clash base reconciles exactly as its session capture did, under new model ids', async t => {
    const pair = await revisionPair(t); if (!pair) return;
    const before = await session(pair);
    const base = capture(before, { kind: 'clash', result: await runClash(pair, ['A'], { rules: RULES }) }, ['A']);
    const head = capture(before, { kind: 'clash', result: await runClash(pair, ['B'], { rules: RULES }) }, ['B']);
    const native = ok(reconcile(before, base, head));
    assert.deepEqual(native.counts, { new: 1, resolved: 2, persisting: 3, changed: 0, notEvaluated: 2 });

    // A later session opened the same two files under different ids; the head runs again natively there.
    const after = await session(pair, { A: 'A-session-2' });
    const { saved, bound } = roundTrip(base, before, after);
    assert.ok(saved.kind === 'clash');
    assert.ok(!JSON.stringify(saved).includes('"A"'), 'no session model id is stored');
    assert.equal(saved.models[0].sourceContentHash, (await sourceHashes()).A);
    assert.ok(bound.ok);
    assert.deepEqual(bound.run.modelIds, ['A-session-2']);
    assert.ok(bound.run.kind === 'clash' && bound.run.result.clashes.every(c => c.a.model === 'A-session-2'));
    const reopened = ok(reconcile(after, bound.run, capture(after, { kind: 'clash', result: await runClash(pair, ['B'], { rules: RULES }) }, ['B'])));
    assert.deepEqual(byState(reopened), byState(native));
  });

  it('the saved element identities are the files\' own: a native IFC export, re-parsed, names the same elements', async t => {
    const pair = await revisionPair(t); if (!pair) return;
    const state = await session(pair);
    const run = capture(state, { kind: 'clash', result: await runClash(pair, ['A', 'B'], { rules: RULES }) }, ['A', 'B']);
    const portable = portableAnalysisRun(run, state);
    assert.ok(portable.ok && portable.saved.kind === 'clash' && portable.saved.result.clashes.length > 0);
    const saved = portable.saved;
    const reparsed = new Map<string, Awaited<ReturnType<IfcParser['parseColumnar']>>>();
    for (const [model, source] of [[saved.models.find(m => m.name === pair.base.name)!, pair.base], [saved.models.find(m => m.name === pair.head.name)!, pair.head]] as const) {
      const step = new StepExporter(source.ifcDataStore).export({ schema: 'IFC4' });
      reparsed.set(model.key, await new IfcParser().parseColumnar(step.content.slice().buffer, { disableWorkerScan: true }));
    }
    let checked = 0;
    for (const clash of saved.result.clashes) for (const ref of [clash.a, clash.b]) {
      if (ref.key.startsWith('expressid:')) continue;
      const store = reparsed.get(ref.model)!;
      assert.equal(store.entities.getGlobalId(ref.expressId), ref.key.split(':')[0], `${ref.model}#${ref.expressId}`);
      checked++;
    }
    assert.ok(checked > 0);
  });

  it('an element without a GlobalId keeps its model-scoped key under the model it is bound to', async t => {
    const pair = await revisionPair(t); if (!pair) return;
    const before = await session(pair);
    const result = await runClash(pair, ['A'], { rules: RULES });
    // The clash adapter's fallback key for an element whose file carries no GlobalId.
    const synthetic = { ...result, clashes: result.clashes.map((c, i) => i === 0 ? { ...c, a: { ...c.a, key: 'expressid:A:42' } } : c) };
    const { saved, bound } = roundTrip(capture(before, { kind: 'clash', result: synthetic }, ['A']), before, await session(pair, { A: 'A-session-2' }));
    assert.ok(saved.kind === 'clash' && saved.result.clashes[0].a.key === `expressid:${saved.models[0].key}:42`);
    assert.ok(bound.ok && bound.run.kind === 'clash');
    assert.equal(bound.run.result.clashes[0].a.key, 'expressid:A-session-2:42');
    assert.deepEqual(bound.run.result.clashes.slice(1).map(c => c.a.key), result.clashes.slice(1).map(c => c.a.key), 'GlobalId keys are unchanged');
  });

  it('a saved truncated run stays truncated: reopened as base it still never calls a head finding new', async t => {
    const pair = await revisionPair(t); if (!pair) return;
    const state = await session(pair);
    const base = capture(state, { kind: 'clash', result: await runClash(pair, ['A'], { rules: RULES, maxCandidatePairs: 1 }) }, ['A']);
    const head = capture(state, { kind: 'clash', result: await runClash(pair, ['B'], { rules: RULES }) }, ['B']);
    const { bound } = roundTrip(base, state, state);
    assert.ok(bound.ok && bound.run.kind === 'clash' && bound.run.result.truncated);
    const outcome = ok(reconcile(state, bound.run, head));
    assert.equal(outcome.counts.new, 0);
    assert.deepEqual(byState(outcome), byState(ok(reconcile(state, base, head))));
  });

  it('a saved native IDS run reconciles as the session capture did; changed rules still refuse', async t => {
    const pair = await revisionPair(t); if (!pair) return;
    const before = await session(pair);
    const base = capture(before, { kind: 'validation', report: await runIds(pair, 'A') }, ['A']);
    const head = capture(before, { kind: 'validation', report: await runIds(pair, 'B') }, ['B']);
    const native = ok(reconcile(before, base, head));
    const after = await session(pair, { A: 'A-session-2' });
    const { bound } = roundTrip(base, before, after);
    assert.ok(bound.ok && bound.run.kind === 'validation');
    assert.ok(bound.run.report.timestamp instanceof Date);
    assert.deepEqual(byState(ok(reconcile(after, bound.run, head))), byState(native));

    const edited = capture(before, { kind: 'validation', report: await runIds(pair, 'B', { edit: xml => xml.replace('Walls are external', 'Walls are outside') }) }, ['B']);
    const refused = reconcile(after, bound.run, edited);
    assert.ok(!refused.ok);
    assert.ok(refused.incompatibilities.some(i => i.code === 'specificationsDiffer'), JSON.stringify(refused.incompatibilities));
  });

  it('a run saved stale stays stale, and one without a freshness stamp stays unknown', async t => {
    const pair = await revisionPair(t); if (!pair) return;
    const state = await session(pair);
    const head = capture(state, { kind: 'validation', report: await runIds(pair, 'B') }, ['B']);
    const run = capture(state, { kind: 'validation', report: await runIds(pair, 'A') }, ['A']);
    const later = { ...state, mutationVersion: 1 };
    const stale = roundTrip(run, later, state);
    assert.equal(stale.saved.freshness, 'stale');
    assert.equal(stale.saved.edited, null, 'whether a stale run saw unsaved edits is unknown');
    assert.ok(stale.bound.ok);
    const staleOutcome = reconcile(state, stale.bound.run, head);
    assert.ok(!staleOutcome.ok && staleOutcome.incompatibilities.some(i => i.code === 'runStale' && i.sides?.includes('base')));

    const unknown = roundTrip({ ...run, stamp: null }, state, state);
    assert.equal(unknown.saved.freshness, 'unknown');
    assert.ok(unknown.bound.ok && unknown.bound.run.stamp === null);
    const unknownOutcome = reconcile(state, unknown.bound.run, head);
    assert.ok(!unknownOutcome.ok && unknownOutcome.incompatibilities.some(i => i.code === 'runFreshnessUnknown'));
  });

  it('reopening refuses, naming every model, when a model is missing, another revision, ambiguous, unrecorded, moved or edited', async t => {
    const pair = await revisionPair(t); if (!pair) return;
    const state = await session(pair);
    const run = capture(state, { kind: 'clash', result: await runClash(pair, ['A', 'B'], { rules: RULES }) }, ['A', 'B']);
    const portable = portableAnalysisRun(run, state);
    assert.ok(portable.ok);
    const saved = portable.saved;
    const refusals = (into: State, entry: SavedAnalysisRun = saved) => {
      const bound = bindSavedAnalysisRun(entry, into);
      return bound.ok ? [] : bound.refusals.map(r => `${r.code}:${r.model ?? ''}`);
    };
    const A = pair.base.name, B = pair.head.name;
    assert.deepEqual(refusals(state), []);

    // Only rev-b open: A is not open at all.
    const onlyB: State = { ...state, models: new Map([...state.models].filter(([id]) => id === 'B')) };
    assert.deepEqual(refusals(onlyB), ['modelSetChanged:', `modelMissing:${A}`]);
    // A file named like A, but rev-b's bytes: another revision of the file, never silently bound.
    const replaced: State = { ...state, models: new Map([...state.models].map(([id, m]) =>
      [id, id === 'A' ? { ...m, sourceContentHash: state.models.get('B')!.sourceContentHash } : m])) };
    assert.deepEqual(refusals(replaced), [`modelReplaced:${A}`, `modelAmbiguous:${B}`]);
    // Two open copies of rev-b: neither is the run's model.
    const twice: State = { ...state, models: new Map([...state.models, ['B-copy', { ...state.models.get('B')!, id: 'B-copy' }]]) };
    assert.deepEqual(refusals(twice), ['modelSetChanged:', `modelAmbiguous:${B}`]);
    // No recorded source identity: unknown historical metadata stays unavailable.
    const unrecorded = { ...saved, models: saved.models.map(m => ({ key: m.key, name: m.name, ...(m.placement ? { placement: m.placement } : {}) })) };
    assert.deepEqual(refusals(state, unrecorded), [`sourceUnknown:${A}`, `sourceUnknown:${B}`]);
    // A clash run records placement; B moved since.
    const moved: State = { ...state, modelPlacement: { ...state.modelPlacement,
      placements: new Map([['B', { translation: [1, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false }]]) } };
    assert.deepEqual(refusals(moved), [`modelMoved:${B}`]);
    // Unsaved edits on the open side, and on the run's side.
    assert.deepEqual(refusals({ ...state, hasChanges: id => id === 'B' }), [`modelEdited:${B}`]);
    const editedRun = portableAnalysisRun(run, { ...state, hasChanges: id => id === 'A' });
    assert.ok(editedRun.ok && editedRun.saved.edited === true);
    assert.deepEqual(refusals(state, editedRun.saved), ['runEdited:']);
  });

  it('Save refuses a run it could never reopen: a closed model without a record, or a model without a source identity', async t => {
    const pair = await revisionPair(t); if (!pair) return;
    const state = await session(pair);
    // A validation stamp records no per-model identity; once the model is closed nothing says which file it was.
    const run = capture(state, { kind: 'validation', report: await runIds(pair, 'B') }, ['B']);
    assert.equal(run.stamp?.placement, undefined);
    const onlyA: State = { ...state, models: new Map([...state.models].filter(([id]) => id === 'A')) };
    assert.deepEqual(portableAnalysisRun(run, onlyA), { ok: false, reason: 'modelClosed' });
    // Open, but loaded from no recognisable file (no content hash, no fingerprint): refused by name, not saved.
    const anonymous: State = { ...state, models: new Map([...state.models].map(([id, m]) =>
      [id, id === 'B' ? { ...m, sourceContentHash: undefined, sourceFingerprint: undefined } : m])) };
    assert.deepEqual(portableAnalysisRun(run, anonymous), { ok: false, reason: 'sourceUnknown', model: pair.head.name });
  });

  it('a clash run stays as stale as its session would call it: another realignment frame or open-model set refuses', async t => {
    const pair = await revisionPair(t); if (!pair) return;
    const base = await session(pair);
    // The workspace was explicitly realigned when the run was made (`commitRealignmentFrame`).
    const realigned: State = { ...base, modelPlacement: { ...base.modelPlacement, realignedFrameKey: 'crs:EPSG:2056' } };
    const run = capture(realigned, { kind: 'clash', result: await runClash(pair, ['A'], { rules: RULES }) }, ['A']);
    const portable = portableAnalysisRun(run, realigned);
    assert.ok(portable.ok && portable.saved.freshness === 'current');
    assert.deepEqual(portable.saved.frame, { realignedFrameKey: 'crs:EPSG:2056', openModels: 2 });
    const saved = decodeSavedAnalysisRun(JSON.parse(JSON.stringify(portable.saved)))!;
    const codes = (into: State) => { const bound = bindSavedAnalysisRun(saved, into); return bound.ok ? [] : bound.refusals.map(r => r.code); };
    assert.deepEqual(codes(realigned), [], 'the same frame and models bind');

    // Another frame: the session capture is stale there, so the saved run must not come back current.
    assert.equal(isAnalysisStale(run.stamp, base), true);
    assert.deepEqual(codes(base), ['frameChanged']);
    // B, which the run did not examine, closed after Save: stale in session, refused on reopen.
    const withoutB: State = { ...realigned, models: new Map([...realigned.models].filter(([id]) => id === 'A')) };
    assert.equal(isAnalysisStale(run.stamp, withoutB), true);
    const refused = bindSavedAnalysisRun(saved, withoutB);
    assert.ok(!refused.ok);
    assert.deepEqual(refused.refusals, [{ code: 'modelSetChanged', before: 2, open: 1 }]);
  });

  it('element refs survive a different load position: express ids are stored, renderer ids rebuilt from the bound model', async t => {
    const pair = await revisionPair(t); if (!pair) return;
    const plain = await session(pair);
    const result = await runClash(pair, ['A', 'B'], { rules: RULES });
    // B loaded second, its renderer ids shifted by its federation offset as the viewer shifts them.
    const offset = (state: State, id: string, by: number): State => ({ ...state, models: new Map([...state.models].map(([key, m]) =>
      [key, key === id ? { ...m, idOffset: by } : m])) });
    const shifted = { ...result, clashes: result.clashes.map(c => ({ ...c,
      a: c.a.model === 'B' ? { ...c.a, ref: c.a.ref + 50_000 } : c.a, b: c.b.model === 'B' ? { ...c.b, ref: c.b.ref + 50_000 } : c.b })) };
    const before = offset(plain, 'B', 50_000);
    const { saved, bound } = roundTrip(capture(before, { kind: 'clash', result: shifted }, ['A', 'B']), before, offset(plain, 'B', 7));
    assert.ok(saved.kind === 'clash' && bound.ok && bound.run.kind === 'clash');
    const keyOfB = saved.models.find(m => m.name === pair.head.name)!.key;
    let checked = 0;
    for (const [i, clash] of saved.result.clashes.entries()) for (const side of ['a', 'b'] as const) {
      const ref = clash[side];
      if (ref.model !== keyOfB || ref.key.startsWith('expressid:')) continue;
      assert.equal(pair.head.ifcDataStore.entities.getGlobalId(ref.expressId), ref.key.split(':')[0], 'the stored id is the file\'s own');
      assert.equal(bound.run.result.clashes[i][side].ref, ref.expressId + 7, 'rebuilt at the new offset');
      checked++;
    }
    assert.ok(checked > 0);
  });

  it('a capture whose model was closed cannot be saved; the stored payload is strict', async t => {
    const pair = await revisionPair(t); if (!pair) return;
    const state = await session(pair);
    const run = capture(state, { kind: 'clash', result: await runClash(pair, ['A', 'B'], { rules: RULES }) }, ['A', 'B']);
    const closed = portableAnalysisRun(run, { ...state, models: new Map([...state.models].filter(([id]) => id === 'A')) });
    assert.deepEqual(closed, { ok: false, reason: 'modelClosed' });

    const portable = portableAnalysisRun(run, state);
    assert.ok(portable.ok && portable.saved.kind === 'clash');
    const json = JSON.parse(JSON.stringify(portable.saved));
    assert.ok(decodeSavedAnalysisRun(json));
    const tampered = (edit: (value: typeof json) => void) => { const copy = structuredClone(json); edit(copy); return decodeSavedAnalysisRun(copy); };
    assert.equal(tampered(v => { v.version = 2; }), null, 'an unknown version is refused');
    assert.equal(tampered(v => { v.result.clashes[0].a.model = 'A'; }), null, 'a session id in place of a join key is refused');
    assert.equal(tampered(v => { v.result.rulesRun[0].membersA = ['1']; }), null, 'renderer member ids are never stored');
    assert.equal(tampered(v => { v.result.clashes[0].distance = null; }), null, 'a lost distance is refused, not read as 0');
    assert.equal(tampered(v => { v.freshness = 'fresh'; }), null);
    assert.equal(tampered(v => { v.frame = null; }), null, 'a placement-stamped run without its frame is refused');
    assert.equal(tampered(v => { v.models.push({ ...v.models[0] }); }), null, 'duplicate join keys are refused');
  });
});
