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
  type ClashGroup,
  type ClashResult,
  type ClashRule,
  type ClashSeverity,
  type ExclusionSet,
} from '@ifc-lite/clash';
import { elementsFromStep } from '@ifc-lite/clash/step';
import { createBCFFromClashResult } from '@ifc-lite/clash/bcf';
import { writeBCF } from '@ifc-lite/bcf';
import { getGlobalRenderer } from '@/hooks/useBCF';

interface SelectionRef {
  modelId: string;
  expressId: number;
}

/** How clashes collapse into BCF topics. `storey` is omitted — Clash has no
 *  storey, so it degrades to `rule` (see grouping.ts) and would only confuse. */
export type ClashBcfGroupBy = 'cluster' | 'rule' | 'typePair' | 'element';

/** User-controllable settings for a BCF export — "what gets created". */
export interface ClashBcfConfig {
  /** Grouping dimension → one BCF topic per group. */
  groupBy: ClashBcfGroupBy;
  /** Only clashes of these severities become topics. */
  severities: ClashSeverity[];
  /** Render each topic's viewpoint offscreen and embed a PNG snapshot. */
  includeSnapshots: boolean;
  /** Initial BCF topic status (Open / In Progress / ...). */
  status: string;
  /** Safety cap on topic count; overflow is recorded in one marker topic. */
  maxTopics: number;
}

/** Dark, neutral background for offscreen snapshot captures (Tokyo Night base). */
const SNAPSHOT_CLEAR_COLOR: [number, number, number, number] = [0.04, 0.05, 0.1, 1];

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Decode a `data:image/png;base64,...` URL into raw PNG bytes for the BCF zip. */
function dataUrlToBytes(dataUrl: string): Uint8Array | undefined {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return undefined;
  try {
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

/** Drop clashes whose severity is not selected; total is kept consistent. */
function filterResultBySeverity(result: ClashResult, severities: Set<ClashSeverity>): ClashResult {
  const clashes = result.clashes.filter((c) => severities.has(c.severity));
  return { ...result, clashes, summary: { ...result.summary, total: clashes.length } };
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

  const runMatrix = useCallback(
    (): Promise<void> => run(disciplineMatrixRules(mode, mode === 'clearance' ? clearance : undefined)),
    [run, mode, clearance],
  );

  /**
   * Detect ALL clashes in the loaded geometry — a single self-clash rule over
   * every element (every element vs every other), no discipline matrix or
   * A/B selectors needed. For a single loaded model this is "all clashes inside
   * the model".
   */
  const runAll = useCallback(
    (): Promise<void> =>
      run([
        {
          id: 'all-clashes',
          name: 'All elements',
          a: '*',
          mode,
          ...(mode === 'clearance' ? { clearance } : {}),
        },
      ]),
    [run, mode, clearance],
  );

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

  /** Select both elements of a clash, highlight them, and frame the camera. */
  const focusClash = useCallback(
    (clash: Clash): void => {
      const state = useViewerStore.getState();
      const a = refOf(clash.a);
      const b = refOf(clash.b);
      const refs = [a, b].filter((r): r is SelectionRef => r !== null);
      if (refs.length === 0) return;
      // The renderer highlights the GLOBAL-id set (`selectedEntityIds`) and
      // `frameSelection` frames it — `clash.X.ref` IS the federated global id
      // (see gatherElements), so drive those, not just the model-aware set.
      const globalIds: number[] = [];
      if (a) globalIds.push(clash.a.ref);
      if (b) globalIds.push(clash.b.ref);
      // Replace any existing selection so the camera frames only this clash pair.
      state.clearEntitySelection();
      state.setSelectedEntityIds(globalIds); // highlight BOTH elements + frame target
      state.addEntitiesToSelection(refs); // model-aware context for the properties panel
      state.setClashSelectedId(clash.id);
      requestAnimationFrame(() => state.cameraCallbacks.frameSelection?.());
    },
    [refOf],
  );

  /** Highlight every element involved in any clash. */
  const highlightAll = useCallback((): void => {
    const state = useViewerStore.getState();
    const current = state.clashResult;
    if (!current) return;
    // Drive the renderer's global-id highlight set (`selectedEntityIds`); the
    // model-aware set is added alongside for properties / federation context.
    const globalIds = new Set<number>();
    const refs: SelectionRef[] = [];
    for (const clash of current.clashes) {
      for (const el of [clash.a, clash.b]) {
        const ref = refOf(el);
        if (ref) {
          globalIds.add(el.ref);
          refs.push(ref);
        }
      }
    }
    if (globalIds.size === 0) return;
    state.setSelectedEntityIds([...globalIds]);
    state.addEntitiesToSelection(refs);
  }, [refOf]);

  const clearHighlight = useCallback((): void => {
    useViewerStore.getState().clearEntitySelection();
    setSelectedId(null);
  }, [setSelectedId]);

  /**
   * Preview what a given export config would produce, WITHOUT building anything:
   * how many clashes survive the severity filter and how many BCF topics they
   * collapse into under the chosen grouping (incl. the overflow marker topic).
   * Cheap (pure grouping) so the dialog can call it on every keystroke.
   */
  const bcfPreview = useCallback((config: ClashBcfConfig): { clashes: number; topics: number } => {
    const current = useViewerStore.getState().clashResult;
    if (!current) return { clashes: 0, topics: 0 };
    const filtered = filterResultBySeverity(current, new Set(config.severities));
    if (filtered.clashes.length === 0) return { clashes: 0, topics: 0 };
    const groups = groupClashes(filtered, { by: config.groupBy });
    const capped = Math.min(groups.length, config.maxTopics);
    const overflow = groups.length > config.maxTopics ? 1 : 0;
    return { clashes: filtered.clashes.length, topics: capped + overflow };
  }, []);

  /**
   * Export the current clash result to a BCF 2.1 archive under `config`.
   *
   * Filters by severity, groups along the chosen dimension (one topic per
   * group), and — when `includeSnapshots` is on and a renderer is live —
   * renders each topic's framing viewpoint offscreen and embeds a PNG. The
   * snapshot pass mirrors the IDS batch path: save viewer state, then per group
   * frame the bounds + isolate the members + capture, and restore at the end.
   * `onProgress(done, total)` ticks once per captured snapshot.
   */
  const exportBcf = useCallback(
    async (config: ClashBcfConfig, onProgress?: (done: number, total: number) => void): Promise<void> => {
      const state = useViewerStore.getState();
      const current = state.clashResult;
      if (!current) return;
      const filtered = filterResultBySeverity(current, new Set(config.severities));
      if (filtered.clashes.length === 0) return;
      const groups = groupClashes(filtered, { by: config.groupBy });

      let restore: (() => void) | undefined;
      let snapshotProvider: ((group: ClashGroup) => Promise<Uint8Array | undefined>) | undefined;

      if (config.includeSnapshots) {
        const renderer = getGlobalRenderer();
        if (renderer) {
          const saved = {
            selectedEntityId: state.selectedEntityId,
            selectedEntityIds: state.selectedEntityIds,
            isolatedEntities: state.isolatedEntities,
            hiddenEntities: state.hiddenEntities,
          };
          restore = () => {
            useViewerStore.setState({
              selectedEntityId: saved.selectedEntityId,
              selectedEntityIds: saved.selectedEntityIds,
              isolatedEntities: saved.isolatedEntities,
              hiddenEntities: saved.hiddenEntities,
            });
            renderer.render({
              hiddenIds: saved.hiddenEntities,
              isolatedIds: saved.isolatedEntities,
              selectedId: saved.selectedEntityId,
            });
          };
          const total = Math.min(groups.length, config.maxTopics);
          const camera = renderer.getCamera();
          let done = 0;
          snapshotProvider = async (group: ClashGroup): Promise<Uint8Array | undefined> => {
            const b = group.bounds;
            await camera.frameBounds(
              { x: b.min[0], y: b.min[1], z: b.min[2] },
              { x: b.max[0], y: b.max[1], z: b.max[2] },
              1,
            );
            // Isolate just this topic's members so the snapshot is unambiguous;
            // no selection highlight so the captured colours read true.
            const isolation = new Set<number>();
            for (const m of group.members) {
              isolation.add(m.a.ref);
              isolation.add(m.b.ref);
            }
            renderer.render({ isolatedIds: isolation, selectedId: null, clearColor: SNAPSHOT_CLEAR_COLOR });
            const device = renderer.getGPUDevice();
            if (device) await device.queue.onSubmittedWorkDone();
            // Let the compositor present the frame before reading the canvas.
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const dataUrl = await renderer.captureScreenshot();
            done += 1;
            onProgress?.(done, total);
            return dataUrl ? dataUrlToBytes(dataUrl) : undefined;
          };
        }
      }

      try {
        const project = await createBCFFromClashResult(filtered, groups, {
          author: 'clash@ifc-lite',
          projectName: 'Clash report',
          status: config.status,
          maxTopics: config.maxTopics,
          ...(snapshotProvider ? { snapshotProvider } : {}),
        });
        const blob = await writeBCF(project);
        downloadBlob(blob, 'clashes.bcfzip');
      } finally {
        restore?.();
      }
    },
    [],
  );

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
    runAll,
    runMatrix,
    runPreset,
    focusClash,
    highlightAll,
    clearHighlight,
    exportBcf,
    bcfPreview,
    clearAll,
  };
}
