/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Save a captured run as portable evidence, and bind a saved run back to the
 * open models (#7370).
 *
 * Saving replaces every session model id by a join key and records each
 * model's name and source identities, taken from the run's own stamp when it
 * has one (the identity at run start) and otherwise from the open model.
 *
 * A placement-stamped run also records every other model open in its frame,
 * so reopening it checks those the way its session would.
 *
 * Binding resolves each saved model to exactly one open model with the same
 * source content, and refuses, naming every problem, when a model is not
 * open, is open as another version of the file, matches more than one open
 * model, has no recorded source identity, has moved since a placement-
 * stamped run, or when either side had unsaved edits (the file identity then
 * no longer describes the elements). A bound run is the native capture
 * again under the current model ids, so the reconciler applies its own
 * compatibility checks and refusals to it unchanged: a run saved stale stays
 * stale, and one saved without a freshness stamp stays unknown.
 */

import type { Clash, ClashElementRef, ClashResult } from '@ifc-lite/clash';
import type { ValidationReport } from '@ifc-lite/ids';
import type { ViewerState } from '@/store';
import { analysisStampFrom, isAnalysisStale, type AnalysisStamp } from '@/hooks/useAnalysisStaleness';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { equalTranslation } from '@/lib/model-placement/translation';
import { recordReportRuleSet, reportRuleSetOf } from '@/lib/validation/report-rule-set';
import type { CapturedRun } from './run-reconcile-types';
import type { SavedAnalysisRun, SavedClashRef, SavedDistance, SavedRunClash, SavedRunModel, SavedRunValidationReport } from './saved-analysis-run-schema';

type BindingState = Pick<ViewerState, 'models' | 'mutationVersion' | 'geometryContentVersion' | 'modelPlacement' | 'hasChanges'>;

/** Why a capture cannot be saved; `model` names the model a run could never be matched to again. */
export type SaveRefusal = { reason: 'modelClosed' | 'empty' } | { reason: 'sourceUnknown'; model: string };
export type BindRefusalCode = 'runEdited' | 'frameChanged' | 'modelSetChanged' | 'modelEdited' | 'sourceUnknown' | 'modelMissing' | 'modelReplaced' | 'modelAmbiguous' | 'modelMoved';
export interface BindRefusal { code: BindRefusalCode; model?: string; before?: number; open?: number }

const distanceOf = (value: number): SavedDistance =>
  Number.isFinite(value) ? value : Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
const distanceFrom = (value: SavedDistance): number => typeof value === 'number' ? value : Number(value);
const json = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

/** An element without a GlobalId is keyed `expressid:<model>:<id>` (clash `syntheticKey`); move its model part to `to`. */
function rekey(key: string, to: (model: string) => string | undefined): string {
  const match = /^expressid:([^:]*):(.*)$/.exec(key);
  const model = match ? to(decodeURIComponent(match[1])) : undefined;
  return match && model !== undefined ? `expressid:${encodeURIComponent(model)}:${match[2]}` : key;
}
type Coverage = NonNullable<ClashResult['ruleCoverage']>[number];
const rekeyCoverage = (coverage: Coverage, to: (model: string) => string | undefined): Coverage => ({ ...coverage,
  ...(coverage.matchedKeysA ? { matchedKeysA: coverage.matchedKeysA.map(k => rekey(k, to)) } : {}),
  ...(coverage.matchedKeysB ? { matchedKeysB: coverage.matchedKeysB.map(k => rekey(k, to)) } : {}) });

function nativeModelIds(run: CapturedRun): string[] {
  const ids = new Set(run.modelIds ?? []);
  if (run.kind === 'clash') for (const clash of run.result.clashes) { ids.add(clash.a.model); ids.add(clash.b.model); }
  else {
    for (const info of run.report.modelInfo) ids.add(info.modelId);
    for (const spec of run.report.specificationResults) {
      for (const entity of spec.entityResults) ids.add(entity.modelId);
      for (const set of spec.setResults ?? []) for (const member of set.members) ids.add(member.modelId);
    }
  }
  return [...ids].sort();
}

/** The capture as portable evidence, or why it cannot be saved. */
export function portableAnalysisRun(run: CapturedRun, state: BindingState, now = new Date()):
  { ok: true; saved: SavedAnalysisRun } | ({ ok: false } & SaveRefusal) {
  const ids = nativeModelIds(run);
  if (ids.length === 0) return { ok: false, reason: 'empty' };
  const keyOf = new Map(ids.map((id, index) => [id, `m${index}`]));
  const key = (id: string) => keyOf.get(id)!;
  const stamp = run.stamp;
  const portableModel = (id: string, modelKey: string): SavedRunModel | SaveRefusal => {
    const recorded = stamp?.placement?.get(id), open = state.models.get(id);
    // Without the run's own record or the open model, nothing says which file the run examined.
    const identity = recorded ?? open;
    if (!identity) return { reason: 'modelClosed' };
    const name = identity.name?.trim() ? identity.name : open?.name?.trim() ? open.name : '';
    // A run that could never be matched to its file again is refused now, not saved and refused on every reopen.
    if (!identity.sourceFingerprint && !identity.sourceContentHash || !name) return { reason: 'sourceUnknown', model: name };
    return { key: modelKey, name,
      ...(identity.sourceFingerprint ? { sourceFingerprint: identity.sourceFingerprint } : {}),
      ...(identity.sourceContentHash ? { sourceContentHash: identity.sourceContentHash } : {}),
      ...(recorded ? { placement: { translation: [...recorded.translation] as [number, number, number], angle: recorded.angle,
        pivot: [...recorded.pivot] as [number, number, number] } } : {}) };
  };
  const models: SavedRunModel[] = [];
  for (const id of ids) {
    const model = portableModel(id, key(id));
    if ('reason' in model) return { ok: false, ...model };
    models.push(model);
  }
  // Every other model open when a placement-stamped run started is part of its frame: its session goes stale
  // when any of them closes, is replaced or moves (`isAnalysisStale`), so each is recorded to be checked on reopen.
  const others: SavedRunModel[] = [];
  for (const id of [...stamp?.placement?.keys() ?? []].filter(id => !keyOf.has(id)).sort()) {
    const model = portableModel(id, `f${others.length}`);
    if ('reason' in model) return { ok: false, ...model };
    others.push(model);
  }
  const freshness = stamp === null ? 'unknown' as const : isAnalysisStale(stamp, state) ? 'stale' as const : 'current' as const;
  const base = {
    version: 1 as const, id: run.id, capturedAt: run.capturedAt, savedAt: now.toISOString(), models,
    examined: run.modelIds ? run.modelIds.map(key) : null, freshness,
    // Nothing changed since a current run, so today's unsaved edits are the ones it saw; otherwise that is unknown.
    edited: freshness === 'current' ? ids.some(id => state.hasChanges(id)) : null,
    placementRecorded: stamp?.placement !== undefined,
    frame: stamp?.placement ? { realignedFrameKey: stamp.realignedFrameKey ?? null, openModels: stamp.placement.size, others } : null,
  };
  if (run.kind === 'clash') {
    // A renderer id is offset by the model's load position; the express id inside it is the file's own.
    const ref = (element: ClashElementRef): SavedClashRef | null => {
      const model = state.models.get(element.model);
      if (!model) return null;
      return { key: rekey(element.key, id => keyOf.get(id)), model: key(element.model), tag: element.tag, ...(element.name !== undefined ? { name: element.name } : {}),
        expressId: element.ref - model.idOffset };
    };
    const clashes: SavedRunClash[] = [];
    for (const clash of run.result.clashes) {
      const a = ref(clash.a), b = ref(clash.b);
      if (!a || !b) return { ok: false, reason: 'modelClosed' };
      clashes.push({ ...json<Omit<Clash, 'a' | 'b' | 'distance'>>({ ...clash, a: undefined, b: undefined, distance: undefined }),
        a, b, distance: distanceOf(clash.distance) });
    }
    const rulesRun = run.result.rulesRun.map(({ membersA: _a, membersB: _b, ...rule }) => rule);
    const coverage = run.result.ruleCoverage?.map(entry => rekeyCoverage(entry, id => keyOf.get(id)));
    return { ok: true, saved: { ...base, kind: 'clash',
      result: { ...json<Omit<ClashResult, 'clashes' | 'rulesRun'>>({ ...run.result, clashes: undefined, rulesRun: undefined, ruleCoverage: coverage }),
        rulesRun: json(rulesRun), clashes } } };
  }
  const report = json<SavedRunValidationReport>(run.report);
  for (const info of report.modelInfo) info.modelId = key(info.modelId);
  for (const spec of report.specificationResults) {
    for (const entity of spec.entityResults) entity.modelId = key(entity.modelId);
    for (const set of spec.setResults ?? []) for (const member of set.members) member.modelId = key(member.modelId);
  }
  const content = reportRuleSetOf(run.report);
  return { ok: true, saved: { ...base, kind: 'validation', report,
    ruleSet: content ? { file: content.file, rules: [...content.rules] } : null } };
}

function sameSource(saved: SavedRunModel, open: { sourceFingerprint?: string; sourceContentHash?: string }): boolean {
  // The full-content hash decides whenever both sides have it; the sampled fingerprint only when one side lacks it.
  if (saved.sourceContentHash && open.sourceContentHash) return saved.sourceContentHash === open.sourceContentHash;
  return !!saved.sourceFingerprint && saved.sourceFingerprint === open.sourceFingerprint;
}

/** Resolve each saved model to one open model, or every reason it cannot be. */
export function bindSavedModels(saved: Pick<SavedAnalysisRun, 'models' | 'edited' | 'placementRecorded' | 'frame'>, state: BindingState):
  { ok: true; ids: Map<string, string> } | { ok: false; refusals: BindRefusal[] } {
  const refusals: BindRefusal[] = [];
  if (saved.edited) refusals.push({ code: 'runEdited' });
  // In its session a placement-stamped run goes stale when the realignment or the open-model set changes
  // (`isAnalysisStale`); a reopened run gets a fresh stamp, so either difference refuses here instead.
  if (saved.frame) {
    if ((state.modelPlacement.realignedFrameKey ?? null) !== saved.frame.realignedFrameKey) refusals.push({ code: 'frameChanged' });
    if (state.models.size !== saved.frame.openModels) refusals.push({ code: 'modelSetChanged', before: saved.frame.openModels, open: state.models.size });
  }
  const ids = new Map<string, string>();
  const claimed = new Map<string, string>();
  // The frame's other models are bound like the examined ones (same file, open once, unedited, unmoved), never used by the run.
  for (const model of [...saved.models, ...saved.frame?.others ?? []]) {
    if (!model.sourceContentHash && !model.sourceFingerprint) { refusals.push({ code: 'sourceUnknown', model: model.name }); continue; }
    const matches = [...state.models].filter(([, open]) => sameSource(model, open)).map(([id]) => id);
    if (matches.length === 0) {
      refusals.push({ code: [...state.models.values()].some(open => open.name === model.name) ? 'modelReplaced' : 'modelMissing', model: model.name });
      continue;
    }
    // Two open copies of one file, or two saved models claiming one open model: neither has an identity.
    if (matches.length > 1 || claimed.has(matches[0])) { refusals.push({ code: 'modelAmbiguous', model: model.name }); continue; }
    const id = matches[0];
    claimed.set(id, model.key);
    // Unsaved edits mean the open model no longer is the file its source identity names.
    if (state.hasChanges(id)) { refusals.push({ code: 'modelEdited', model: model.name }); continue; }
    if (saved.placementRecorded) {
      const rotation = placementFor(state.modelPlacement, id).rotation;
      // A placement-stamped run without a model's placement cannot show the model has not moved.
      if (!model.placement || !equalTranslation(model.placement.translation, displayedTranslation(state.modelPlacement, id))
        || model.placement.angle !== rotation.angle || !equalTranslation(model.placement.pivot, rotation.pivot)) {
        refusals.push({ code: 'modelMoved', model: model.name });
        continue;
      }
    }
    ids.set(model.key, id);
  }
  return refusals.length ? { ok: false, refusals } : { ok: true, ids };
}

/** A stamp no state can match: the run was already stale when saved, and reopening it does not make it current. */
const STALE_STAMP: AnalysisStamp = { mutationVersion: -1, geometryContentVersion: -1 };

/** The saved run as a session capture under the open model ids, or every reason it cannot be bound. */
export function bindSavedAnalysisRun(saved: SavedAnalysisRun, state: BindingState):
  { ok: true; run: CapturedRun } | { ok: false; refusals: BindRefusal[] } {
  const bound = bindSavedModels(saved, state);
  if (!bound.ok) return bound;
  const id = (key: string) => bound.ids.get(key)!;
  const stamp = saved.freshness === 'unknown' ? null : saved.freshness === 'stale' ? STALE_STAMP
    : analysisStampFrom(state, saved.placementRecorded);
  const common = { id: saved.id, capturedAt: saved.capturedAt, modelIds: saved.examined ? saved.examined.map(id).sort() : null, stamp };
  if (saved.kind === 'clash') {
    const ref = (element: SavedClashRef): ClashElementRef => {
      const { expressId, model, ...rest } = element;
      const modelId = id(model);
      return { ...rest, key: rekey(rest.key, k => bound.ids.get(k)), model: modelId, ref: expressId + state.models.get(modelId)!.idOffset };
    };
    const copy = structuredClone(saved.result);
    const result: ClashResult = { ...copy,
      ...(copy.ruleCoverage ? { ruleCoverage: copy.ruleCoverage.map(entry => rekeyCoverage(entry, k => bound.ids.get(k))) } : {}),
      clashes: copy.clashes.map(clash => ({ ...clash, a: ref(clash.a), b: ref(clash.b), distance: distanceFrom(clash.distance) })) };
    return { ok: true, run: { ...common, kind: 'clash', result } };
  }
  const copy = structuredClone(saved.report);
  for (const info of copy.modelInfo) info.modelId = id(info.modelId);
  for (const spec of copy.specificationResults) {
    for (const entity of spec.entityResults) entity.modelId = id(entity.modelId);
    for (const set of spec.setResults ?? []) for (const member of set.members) member.modelId = id(member.modelId);
  }
  const report: ValidationReport = { ...copy, timestamp: new Date(copy.timestamp) };
  if (saved.ruleSet) recordReportRuleSet(report, { file: saved.ruleSet.file, rules: new Map(saved.ruleSet.rules) });
  return { ok: true, run: { ...common, kind: 'validation', report } };
}
