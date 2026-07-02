/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { IfcDataStore, ScheduleExtraction } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel, SchemaVersion } from '@/store/types';
import type { GeorefMutationData } from '@/store/slices/mutationSlice';
import {
  collectChangedModels,
  totalChangeCount,
  buildChangedArtifacts,
  uniqueArtifactBase,
  mapStepSchema,
  LEGACY_MODEL_ID,
  type ChangesExportState,
  type BuildArtifactsDeps,
  type ChangesExportArtifact,
} from './model-changes.js';

// ── test builders ────────────────────────────────────────────────────────────

/** A mutation view whose only observable behavior is its modified-entity count. */
function mkView(count: number): MutablePropertyView {
  return { getModifiedEntityCount: () => count } as unknown as MutablePropertyView;
}

function mkModel(
  id: string,
  name: string,
  schemaVersion: SchemaVersion = 'IFC4',
  extra: Partial<FederatedModel> = {},
): FederatedModel {
  return {
    id,
    name,
    schemaVersion,
    ifcDataStore: {} as IfcDataStore,
    geometryResult: null,
    idOffset: 0,
    ...extra,
  } as unknown as FederatedModel;
}

function mkSchedule(taskExpressIds: number[]): ScheduleExtraction {
  return { tasks: taskExpressIds.map((expressId) => ({ expressId })) } as unknown as ScheduleExtraction;
}

function mkState(partial: Partial<ChangesExportState>): ChangesExportState {
  return {
    models: new Map(),
    ifcDataStore: null,
    geometryResult: null,
    mutationViews: new Map(),
    georefMutations: new Map(),
    scheduleData: null,
    scheduleIsEdited: false,
    scheduleSourceModelId: null,
    ...partial,
  };
}

/**
 * Independent transcription of the store's `getModifiedEntityCount`
 * (mutationSlice.ts). The equivalence test locks `collectChangedModels` to this
 * formula so drift between the badge count and the store's count is CI-caught.
 */
function referenceModifiedEntityCount(state: ChangesExportState): number {
  let count = 0;
  for (const view of state.mutationViews.values()) count += view.getModifiedEntityCount();
  for (const [modelId, gm] of state.georefMutations) {
    const hasGeoref =
      (gm.projectedCRS && Object.keys(gm.projectedCRS).length > 0) ||
      (gm.mapConversion && Object.keys(gm.mapConversion).length > 0);
    if (hasGeoref && !state.mutationViews.has(modelId)) count += 1;
  }
  const tasks = state.scheduleData?.tasks;
  let hasGenerated = false;
  if (tasks) {
    for (const t of tasks) {
      if (!t.expressId || t.expressId <= 0) {
        count++;
        hasGenerated = true;
      }
    }
  }
  if (state.scheduleIsEdited && !hasGenerated) count++;
  return count;
}

// ── collectChangedModels ─────────────────────────────────────────────────────

describe('collectChangedModels', () => {
  it('returns every changed model, not just the first (issue #1534)', () => {
    const models = new Map<string, FederatedModel>([
      ['a', mkModel('a', 'alpha.ifc')],
      ['b', mkModel('b', 'beta.ifc')],
      ['c', mkModel('c', 'gamma.ifc')],
      ['d', mkModel('d', 'delta.ifc')],
    ]);
    const mutationViews = new Map<string, MutablePropertyView>([
      ['a', mkView(1)],
      ['b', mkView(1)],
      ['c', mkView(1)],
      ['d', mkView(1)],
    ]);
    const state = mkState({ models, mutationViews });

    const result = collectChangedModels(state);
    assert.strictEqual(result.models.length, 4);
    assert.strictEqual(totalChangeCount(result), 4);
    assert.deepStrictEqual(result.models.map((m) => m.id), ['a', 'b', 'c', 'd']);
  });

  it('sums per-model counts equal to getModifiedEntityCount (anti-drift lock)', () => {
    const models = new Map<string, FederatedModel>([
      ['a', mkModel('a', 'a.ifc')],
      ['b', mkModel('b', 'b.ifc')],
      ['g', mkModel('g', 'g.ifc')], // georef-only
    ]);
    const mutationViews = new Map<string, MutablePropertyView>([
      ['a', mkView(3)],
      ['b', mkView(2)],
    ]);
    const georefMutations = new Map<string, GeorefMutationData>([
      ['g', { projectedCRS: { Name: 'EPSG:2056' } as GeorefMutationData['projectedCRS'] }],
    ]);
    const state = mkState({
      models,
      mutationViews,
      georefMutations,
      scheduleData: mkSchedule([0, 0, 5]), // 2 generated tasks
      scheduleSourceModelId: 'a',
    });

    const result = collectChangedModels(state);
    assert.strictEqual(totalChangeCount(result), referenceModifiedEntityCount(state));
  });

  it('excludes register-only views (a selection registers a 0-count view)', () => {
    const models = new Map<string, FederatedModel>([
      ['a', mkModel('a', 'a.ifc')],
      ['b', mkModel('b', 'b.ifc')],
    ]);
    const mutationViews = new Map<string, MutablePropertyView>([
      ['a', mkView(2)],
      ['b', mkView(0)], // inspected but never edited
    ]);
    const result = collectChangedModels(mkState({ models, mutationViews }));
    assert.deepStrictEqual(result.models.map((m) => m.id), ['a']);
  });

  it('counts georef edits additively so they are never dropped from export', () => {
    const models = new Map<string, FederatedModel>([
      ['g', mkModel('g', 'g.ifc')],
      ['p', mkModel('p', 'p.ifc')],
      ['v', mkModel('v', 'v.ifc')],
    ]);
    const georefMutations = new Map<string, GeorefMutationData>([
      ['g', { mapConversion: { Eastings: 100 } as GeorefMutationData['mapConversion'] }],
      ['p', { mapConversion: { Eastings: 200 } as GeorefMutationData['mapConversion'] }],
      // 'v' has a zero-count (inspection-only) view AND a georef edit — the
      // georef must still count so the edit is exported (Codex #1538 finding).
      ['v', { projectedCRS: { Name: 'EPSG:2056' } as GeorefMutationData['projectedCRS'] }],
    ]);
    const mutationViews = new Map<string, MutablePropertyView>([
      ['p', mkView(4)], // property edits + georef -> counted additively
      ['v', mkView(0)], // inspected-only view + georef
    ]);
    const result = collectChangedModels(mkState({ models, georefMutations, mutationViews }));

    assert.strictEqual(result.models.find((m) => m.id === 'g')?.changeCount, 1);
    assert.strictEqual(result.models.find((m) => m.id === 'p')?.changeCount, 5);
    assert.strictEqual(result.models.find((m) => m.id === 'v')?.changeCount, 1);
  });

  it('attributes the schedule to the declared source model only', () => {
    const models = new Map<string, FederatedModel>([
      ['a', mkModel('a', 'a.ifc')],
      ['b', mkModel('b', 'b.ifc')],
    ]);
    const mutationViews = new Map<string, MutablePropertyView>([
      ['a', mkView(1)],
      ['b', mkView(1)],
    ]);
    const state = mkState({
      models,
      mutationViews,
      scheduleData: mkSchedule([0, 0, 0]), // 3 generated
      scheduleSourceModelId: 'b',
    });
    const result = collectChangedModels(state);
    assert.strictEqual(result.scheduleTargetModelId, 'b');
    assert.strictEqual(result.models.find((m) => m.id === 'a')?.changeCount, 1);
    assert.strictEqual(result.models.find((m) => m.id === 'b')?.changeCount, 1 + 3);
    assert.strictEqual(result.models.find((m) => m.id === 'b')?.isScheduleTarget, true);
  });

  it('resolves a deterministic schedule target when the source is null', () => {
    const models = new Map<string, FederatedModel>([
      ['x', mkModel('x', 'x.ifcx', 'IFC5')], // not splice-capable
      ['y', mkModel('y', 'y.ifc', 'IFC4')], // first STEP-capable -> target
      ['z', mkModel('z', 'z.ifc', 'IFC4')],
    ]);
    const state = mkState({
      models,
      scheduleData: mkSchedule([0]), // 1 generated task, no source
      scheduleSourceModelId: null,
    });
    const result = collectChangedModels(state);
    assert.strictEqual(result.scheduleTargetModelId, 'y');
    // The target is included even with no property edits.
    assert.strictEqual(result.models.find((m) => m.id === 'y')?.changeCount, 1);
  });

  it('does not attribute the schedule to a loaded IFC5 source (cannot splice IFCX)', () => {
    const models = new Map<string, FederatedModel>([
      ['x', mkModel('x', 'x.ifcx', 'IFC5')],
      ['y', mkModel('y', 'y.ifc', 'IFC4')],
    ]);
    const mutationViews = new Map<string, MutablePropertyView>([['y', mkView(1)]]);
    const state = mkState({
      models,
      mutationViews,
      scheduleData: mkSchedule([0, 0]),
      scheduleSourceModelId: 'x', // IFC5 -> not splice-capable
    });
    const result = collectChangedModels(state);
    // No misattribution to the STEP sibling; schedule is neither counted nor
    // (later) claimed as exported.
    assert.strictEqual(result.scheduleTargetModelId, null);
    assert.strictEqual(result.models.find((m) => m.id === 'y')?.changeCount, 1);
    assert.strictEqual(totalChangeCount(result), 1);
  });

  it('drops schedule attribution when the source model was removed', () => {
    const models = new Map<string, FederatedModel>([['a', mkModel('a', 'a.ifc')]]);
    const mutationViews = new Map<string, MutablePropertyView>([['a', mkView(1)]]);
    const state = mkState({
      models,
      mutationViews,
      scheduleData: mkSchedule([0, 0, 0]),
      scheduleSourceModelId: 'gone', // dangling id (model unloaded)
    });
    const result = collectChangedModels(state);
    assert.strictEqual(result.scheduleTargetModelId, null);
    assert.strictEqual(totalChangeCount(result), 1); // only a's property edit
  });

  it('does not attribute an untouched parsed schedule', () => {
    const models = new Map<string, FederatedModel>([['a', mkModel('a', 'a.ifc')]]);
    const mutationViews = new Map<string, MutablePropertyView>([['a', mkView(1)]]);
    const state = mkState({
      models,
      mutationViews,
      scheduleData: mkSchedule([5, 6, 7]), // all parsed (existing expressIds), not edited
      scheduleIsEdited: false,
      scheduleSourceModelId: null,
    });
    const result = collectChangedModels(state);
    assert.strictEqual(result.scheduleTargetModelId, null);
    assert.strictEqual(totalChangeCount(result), 1);
  });

  it('uses the legacy store only when the federation map is empty', () => {
    const legacyDs = { schemaVersion: 'IFC4' } as IfcDataStore;
    const mutationViews = new Map<string, MutablePropertyView>([[LEGACY_MODEL_ID, mkView(2)]]);

    const legacyState = mkState({ models: new Map(), ifcDataStore: legacyDs, mutationViews });
    const legacyResult = collectChangedModels(legacyState);
    assert.deepStrictEqual(legacyResult.models.map((m) => m.id), [LEGACY_MODEL_ID]);

    // A populated map + a lingering legacy store must NOT emit a phantom entry.
    const models = new Map<string, FederatedModel>([['a', mkModel('a', 'a.ifc')]]);
    const federatedState = mkState({
      models,
      ifcDataStore: legacyDs,
      mutationViews: new Map<string, MutablePropertyView>([['a', mkView(1)]]),
    });
    const federatedResult = collectChangedModels(federatedState);
    assert.deepStrictEqual(federatedResult.models.map((m) => m.id), ['a']);
  });

  it('keeps null-dataStore (native) models in the changed set for the badge', () => {
    const models = new Map<string, FederatedModel>([
      ['n', mkModel('n', 'native.ifc', 'IFC4', { ifcDataStore: null })],
    ]);
    const georefMutations = new Map<string, GeorefMutationData>([
      ['n', { projectedCRS: { Name: 'EPSG:2056' } as GeorefMutationData['projectedCRS'] }],
    ]);
    const result = collectChangedModels(mkState({ models, georefMutations }));
    assert.strictEqual(result.models.length, 1);
    assert.strictEqual(result.models[0].ifcDataStore, null);
    assert.strictEqual(result.models[0].changeCount, 1);
  });
});

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('uniqueArtifactBase', () => {
  it('dedupes same name+ext, leaves different ext alone', () => {
    const used = new Set<string>();
    assert.strictEqual(uniqueArtifactBase('model', 'ifc', used), 'model');
    assert.strictEqual(uniqueArtifactBase('model', 'ifc', used), 'model-2');
    assert.strictEqual(uniqueArtifactBase('model', 'ifc', used), 'model-3');
    // same base, different extension is a distinct filename -> no suffix.
    assert.strictEqual(uniqueArtifactBase('model', 'ifcx', used), 'model');
  });
});

describe('mapStepSchema', () => {
  it('maps schema versions to STEP tokens', () => {
    assert.strictEqual(mapStepSchema('IFC2X3'), 'IFC2X3');
    assert.strictEqual(mapStepSchema('IFC4'), 'IFC4');
    assert.strictEqual(mapStepSchema('IFC4X3'), 'IFC4X3');
    assert.strictEqual(mapStepSchema('IFC5'), 'IFC4'); // caller routes IFC5 elsewhere
  });
});

// ── buildChangedArtifacts ────────────────────────────────────────────────────

interface StepCall {
  modelId: string;
  hasSchedule: boolean;
  scheduleSourceId: string | null;
}

function fakeDeps(overrides: Partial<BuildArtifactsDeps> = {}): {
  deps: BuildArtifactsDeps;
  stepCalls: StepCall[];
  ifcxCalls: string[];
} {
  const stepCalls: StepCall[] = [];
  const ifcxCalls: string[] = [];
  const deps: BuildArtifactsDeps = {
    resolveStepDataStore: async () => ({}) as IfcDataStore,
    exportStep: async (modelId, _ds, _view, inv): Promise<ChangesExportArtifact> => {
      stepCalls.push({
        modelId,
        hasSchedule: inv.scheduleState != null,
        scheduleSourceId: inv.scheduleState?.scheduleSourceModelId ?? null,
      });
      return { content: `STEP:${modelId}`, ext: 'ifc', mime: 'text/plain' };
    },
    exportIfcx: async (modelId): Promise<ChangesExportArtifact> => {
      ifcxCalls.push(modelId);
      return { content: `IFCX:${modelId}`, ext: 'ifcx', mime: 'application/json' };
    },
    ...overrides,
  };
  return { deps, stepCalls, ifcxCalls };
}

describe('buildChangedArtifacts', () => {
  it('produces one file per changed model', async () => {
    const models = new Map<string, FederatedModel>([
      ['a', mkModel('a', 'alpha.ifc')],
      ['b', mkModel('b', 'beta.ifc')],
    ]);
    const mutationViews = new Map<string, MutablePropertyView>([
      ['a', mkView(1)],
      ['b', mkView(1)],
    ]);
    const { deps } = fakeDeps();
    const { files, skipped } = await buildChangedArtifacts(mkState({ models, mutationViews }), deps);
    assert.strictEqual(files.length, 2);
    assert.strictEqual(skipped.length, 0);
    assert.deepStrictEqual(files.map((f) => `${f.base}.${f.ext}`), ['alpha.ifc', 'beta.ifc']);
  });

  it('splices the schedule into exactly one model', async () => {
    const models = new Map<string, FederatedModel>([
      ['a', mkModel('a', 'a.ifc')],
      ['b', mkModel('b', 'b.ifc')],
      ['c', mkModel('c', 'c.ifc')],
    ]);
    const mutationViews = new Map<string, MutablePropertyView>([
      ['a', mkView(1)],
      ['b', mkView(1)],
      ['c', mkView(1)],
    ]);
    const { deps, stepCalls } = fakeDeps();
    const state = mkState({
      models,
      mutationViews,
      scheduleData: mkSchedule([0, 0]),
      scheduleSourceModelId: 'b',
    });
    const result = await buildChangedArtifacts(state, deps);
    const withSchedule = stepCalls.filter((c) => c.hasSchedule);
    assert.strictEqual(withSchedule.length, 1);
    assert.strictEqual(withSchedule[0].modelId, 'b');
    // The splice gate matches on scheduleSourceModelId === modelId, so the
    // passed state's source must be rewritten to the resolved target id.
    assert.strictEqual(withSchedule[0].scheduleSourceId, 'b');
    assert.strictEqual(result.scheduleSpliced, true);
  });

  it('rewrites the schedule source to the target when the original source is null', async () => {
    // Unattributed schedule (null source) must still splice into a real target,
    // with the source rewritten so the STEP gate matches (not relying on the
    // legacy null-source fallback).
    const models = new Map<string, FederatedModel>([['only', mkModel('only', 'only.ifc')]]);
    const { deps, stepCalls } = fakeDeps();
    const state = mkState({
      models,
      scheduleData: mkSchedule([0]),
      scheduleSourceModelId: null,
    });
    await buildChangedArtifacts(state, deps);
    const withSchedule = stepCalls.filter((c) => c.hasSchedule);
    assert.strictEqual(withSchedule.length, 1);
    assert.strictEqual(withSchedule[0].modelId, 'only');
    assert.strictEqual(withSchedule[0].scheduleSourceId, 'only');
  });

  it('does not splice the schedule into any model when no target is splice-capable', async () => {
    // IFC5-only session with a pending schedule: nothing can receive the splice,
    // so no STEP file carries it and no file falsely claims it.
    const models = new Map<string, FederatedModel>([['x', mkModel('x', 'x.ifcx', 'IFC5')]]);
    const mutationViews = new Map<string, MutablePropertyView>([['x', mkView(1)]]);
    const { deps, stepCalls, ifcxCalls } = fakeDeps();
    const state = mkState({
      models,
      mutationViews,
      scheduleData: mkSchedule([0, 0]),
      scheduleSourceModelId: 'x',
    });
    const result = await buildChangedArtifacts(state, deps);
    assert.strictEqual(stepCalls.length, 0);
    assert.deepStrictEqual(ifcxCalls, ['x']);
    assert.strictEqual(result.scheduleSpliced, false);
  });

  it('dedupes colliding filenames across models', async () => {
    const models = new Map<string, FederatedModel>([
      ['a', mkModel('a', 'model.ifc')],
      ['b', mkModel('b', 'model.ifc')],
    ]);
    const mutationViews = new Map<string, MutablePropertyView>([
      ['a', mkView(1)],
      ['b', mkView(1)],
    ]);
    const { deps } = fakeDeps();
    const { files } = await buildChangedArtifacts(mkState({ models, mutationViews }), deps);
    assert.deepStrictEqual(files.map((f) => `${f.base}.${f.ext}`), ['model.ifc', 'model-2.ifc']);
  });

  it('routes IFC5 models to the IFCX exporter (mixed batch keeps both)', async () => {
    const models = new Map<string, FederatedModel>([
      ['s', mkModel('s', 'step.ifc', 'IFC4')],
      ['x', mkModel('x', 'usd.ifcx', 'IFC5')],
    ]);
    const mutationViews = new Map<string, MutablePropertyView>([
      ['s', mkView(1)],
      ['x', mkView(1)],
    ]);
    const { deps, ifcxCalls } = fakeDeps();
    const { files } = await buildChangedArtifacts(mkState({ models, mutationViews }), deps);
    assert.deepStrictEqual(ifcxCalls, ['x']);
    const exts = files.map((f) => f.ext).sort();
    assert.deepStrictEqual(exts, ['ifc', 'ifcx']);
  });

  it('skips a model that cannot be hydrated and still exports the rest', async () => {
    const models = new Map<string, FederatedModel>([
      ['a', mkModel('a', 'a.ifc')],
      ['b', mkModel('b', 'b.ifc')],
    ]);
    const mutationViews = new Map<string, MutablePropertyView>([
      ['a', mkView(1)],
      ['b', mkView(1)],
    ]);
    const { deps } = fakeDeps({
      resolveStepDataStore: async (id) => (id === 'a' ? null : ({} as IfcDataStore)),
    });
    const { files, skipped } = await buildChangedArtifacts(mkState({ models, mutationViews }), deps);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].modelId, 'b');
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0].name, 'a.ifc');
  });

  it('continues the batch when one export throws', async () => {
    const models = new Map<string, FederatedModel>([
      ['a', mkModel('a', 'a.ifc')],
      ['b', mkModel('b', 'b.ifc')],
    ]);
    const mutationViews = new Map<string, MutablePropertyView>([
      ['a', mkView(1)],
      ['b', mkView(1)],
    ]);
    const { deps } = fakeDeps({
      exportStep: async (modelId, _ds, _view, _inv): Promise<ChangesExportArtifact> => {
        if (modelId === 'a') throw new Error('boom');
        return { content: `STEP:${modelId}`, ext: 'ifc', mime: 'text/plain' };
      },
    });
    const { files, skipped } = await buildChangedArtifacts(mkState({ models, mutationViews }), deps);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].modelId, 'b');
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0].reason, 'boom');
  });
});
