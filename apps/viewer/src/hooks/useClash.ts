/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash detection orchestration (Phase 1). Gathers `ClashElement`s from every
 * loaded model via the STEP adapter, runs the (robust, in-process) TypeScript
 * engine, and drives the viewer: selecting + framing a clash pair, highlighting
 * all, and exporting a *grouped* BCF. Coloring/identity flow through the
 * renderer's selection channel and the federation registry.
 */

import { useCallback } from 'react';
import { useViewerStore } from '@/store';
import {
  createClashEngine,
  disciplineMatrixRules,
  groupClashes,
  CLASH_RULE_PRESETS,
  type Clash,
  type ClashElement,
  type ClashElementRef,
  type ClashRule,
  type ExclusionSet,
} from '@ifc-lite/clash';
import { elementsFromStep } from '@ifc-lite/clash/step';
import { createBCFFromClashResult } from '@ifc-lite/clash/bcf';
import { writeBCF } from '@ifc-lite/bcf';

interface SelectionRef {
  modelId: string;
  expressId: number;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function useClash() {
  const result = useViewerStore((s) => s.clashResult);
  const groups = useViewerStore((s) => s.clashGroups);
  const running = useViewerStore((s) => s.clashRunning);
  const error = useViewerStore((s) => s.clashError);
  const mode = useViewerStore((s) => s.clashMode);
  const tolerance = useViewerStore((s) => s.clashTolerance);
  const clearance = useViewerStore((s) => s.clashClearance);
  const groupBy = useViewerStore((s) => s.clashGroupBy);
  const selectedId = useViewerStore((s) => s.clashSelectedId);
  const panelVisible = useViewerStore((s) => s.clashPanelVisible);

  const setMode = useViewerStore((s) => s.setClashMode);
  const setTolerance = useViewerStore((s) => s.setClashTolerance);
  const setClearance = useViewerStore((s) => s.setClashClearance);
  const setGroupBy = useViewerStore((s) => s.setClashGroupBy);
  const setSelectedId = useViewerStore((s) => s.setClashSelectedId);
  const setPanelVisible = useViewerStore((s) => s.setClashPanelVisible);
  const clear = useViewerStore((s) => s.clearClash);

  /** Build clash elements + merged exclusions from every loaded model. */
  const gatherElements = useCallback((): { elements: ClashElement[]; exclusions: ExclusionSet } => {
    const state = useViewerStore.getState();
    const elements: ClashElement[] = [];
    const exclusions: ExclusionSet = new Set<string>();
    const federation = { toGlobalId: (modelId: string, expressId: number) => state.toGlobalId(modelId, expressId) };

    for (const [modelId, model] of state.models) {
      const store = model.ifcDataStore;
      const meshes = model.geometryResult?.meshes;
      if (!store || !meshes || meshes.length === 0) continue;
      const built = elementsFromStep({ store, meshes, modelId, federation });
      elements.push(...built.elements);
      for (const key of built.exclusions) exclusions.add(key);
    }
    return { elements, exclusions };
  }, []);

  const run = useCallback(
    async (rules: ClashRule[]): Promise<void> => {
      const state = useViewerStore.getState();
      state.setClashRunning(true);
      state.setClashError(null);
      try {
        // Let the panel paint the running state before the (sync) heavy work.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const { elements, exclusions } = gatherElements();
        if (elements.length === 0) {
          state.setClashError('No model geometry is loaded. Load an IFC model first.');
          return;
        }
        const engine = createClashEngine({ backend: 'ts' });
        const res = await engine.run(elements, rules, { exclusions, tolerance: state.clashTolerance });
        state.setClashResult(res);
        // Spatial clustering is the sensible BCF unit; the panel list groups by
        // its own dimension separately.
        state.setClashGroups(groupClashes(res, { by: 'cluster' }));
        state.setClashSelectedId(null);
      } catch (err) {
        console.error('[clash] detection run failed', err);
        state.setClashError(err instanceof Error ? err.message : String(err));
      } finally {
        state.setClashRunning(false);
      }
    },
    [gatherElements],
  );

  const runMatrix = useCallback((): Promise<void> => run(disciplineMatrixRules(mode)), [run, mode]);

  const runPreset = useCallback(
    (presetId: string): Promise<void> => {
      const preset = CLASH_RULE_PRESETS.find((p) => p.id === presetId);
      if (!preset) return Promise.resolve();
      return run([
        {
          id: preset.id,
          name: preset.name,
          a: preset.selectorA,
          b: preset.selectorB,
          mode,
          severity: preset.severity,
          ...(mode === 'clearance' ? { clearance } : {}),
        },
      ]);
    },
    [run, mode, clearance],
  );

  const refOf = useCallback((ref: ClashElementRef): SelectionRef | null => {
    return useViewerStore.getState().fromGlobalId(ref.ref);
  }, []);

  /** Select both elements of a clash and frame the camera on them. */
  const focusClash = useCallback(
    (clash: Clash): void => {
      const state = useViewerStore.getState();
      const refs = [refOf(clash.a), refOf(clash.b)].filter((r): r is SelectionRef => r !== null);
      if (refs.length === 0) return;
      // Replace any existing selection so the camera frames only this clash pair.
      state.clearEntitySelection();
      state.addEntitiesToSelection(refs);
      state.setClashSelectedId(clash.id);
      requestAnimationFrame(() => state.cameraCallbacks.frameSelection?.());
    },
    [refOf],
  );

  /** Select every element involved in any clash. */
  const highlightAll = useCallback((): void => {
    const state = useViewerStore.getState();
    const current = state.clashResult;
    if (!current) return;
    const refs: SelectionRef[] = [];
    for (const clash of current.clashes) {
      const a = refOf(clash.a);
      const b = refOf(clash.b);
      if (a) refs.push(a);
      if (b) refs.push(b);
    }
    if (refs.length > 0) state.addEntitiesToSelection(refs);
  }, [refOf]);

  const clearHighlight = useCallback((): void => {
    useViewerStore.getState().clearEntitySelection();
    setSelectedId(null);
  }, [setSelectedId]);

  const exportBcf = useCallback(async (): Promise<void> => {
    const state = useViewerStore.getState();
    const current = state.clashResult;
    const currentGroups = state.clashGroups;
    if (!current || !currentGroups || currentGroups.length === 0) return;
    const project = await createBCFFromClashResult(current, currentGroups, {
      author: 'clash@ifc-lite',
      projectName: 'Clash report',
    });
    const blob = await writeBCF(project);
    downloadBlob(blob, 'clashes.bcfzip');
  }, []);

  const clearAll = useCallback((): void => {
    useViewerStore.getState().clearEntitySelection();
    clear();
  }, [clear]);

  return {
    // state
    result,
    groups,
    running,
    error,
    mode,
    tolerance,
    clearance,
    groupBy,
    selectedId,
    panelVisible,
    presets: CLASH_RULE_PRESETS,
    // settings
    setMode,
    setTolerance,
    setClearance,
    setGroupBy,
    setPanelVisible,
    // actions
    run,
    runMatrix,
    runPreset,
    focusClash,
    highlightAll,
    clearHighlight,
    exportBcf,
    clearAll,
  };
}
