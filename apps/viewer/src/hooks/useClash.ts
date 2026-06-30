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

import { useCallback, useRef } from 'react';
import { useViewerStore } from '@/store';
import {
  createClashEngine,
  rulesFromPresets,
  groupClashes,
  findDuplicates,
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
import { contactClusters, type SharedFaceCluster, type Vec3 } from '@ifc-lite/clash/contact';
import { writeBCF } from '@ifc-lite/bcf';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { buildClashPairColors, CLASH_COLOR_A, CLASH_COLOR_OVERLAP } from '@/lib/clash/clash-colors';
import { posthog } from '@/lib/analytics';
import { downloadBlob } from '@/lib/export/download';

interface SelectionRef {
  modelId: string;
  expressId: number;
}

/**
 * Flatten contact clusters into a world-frame line-list (x,y,z per endpoint, two
 * per segment) for the focused-clash overlay. Prefer the shared-FACE polygon
 * outlines when any surface contact exists (flush/coincident members); otherwise
 * the intersection LINES (angled crossings); otherwise small crosses at POINT
 * contacts. This is the real contact interface, not an AABB box (#1402).
 */
function contactLineList(clusters: readonly SharedFaceCluster[]): number[] {
  const surfaces = clusters.filter((c) => c.kind === 'surface' && c.boundary.length >= 3);
  const lines = clusters.filter((c) => c.kind === 'line' && c.boundary.length >= 2);
  const points = clusters.filter((c) => c.kind === 'point');
  const out: number[] = [];
  const seg = (p: Vec3, q: Vec3) => out.push(p[0], p[1], p[2], q[0], q[1], q[2]);
  // Shared-face polygon outlines (the contact patches) and intersection lines
  // (penetration boundary) together describe the contact; render both so a thin
  // patch still reads. Points only matter when there is no surface or line.
  for (const c of surfaces) {
    const b = c.boundary;
    for (let i = 0; i < b.length; i += 1) seg(b[i], b[(i + 1) % b.length]);
  }
  for (const c of lines) seg(c.boundary[0], c.boundary[1]);
  if (surfaces.length === 0 && lines.length === 0) {
    const s = 0.05;
    for (const c of points) {
      const [x, y, z] = c.centroid;
      seg([x - s, y, z], [x + s, y, z]);
      seg([x, y - s, z], [x, y + s, z]);
      seg([x, y, z - s], [x, y, z + s]);
    }
  }
  return out;
}

/**
 * How the rest of the model is shown when a clash is focused (#1275):
 * - `highlight`: everything stays visible, the pair is just selected/framed;
 * - `isolate`:   everything else is hidden;
 * - `ghost`:     everything else fades to translucent X-Ray context.
 */
export type ClashFocusMode = 'highlight' | 'isolate' | 'ghost';

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
  const progress = useViewerStore((s) => s.clashProgress);
  const mode = useViewerStore((s) => s.clashMode);
  const tolerance = useViewerStore((s) => s.clashTolerance);
  const clearance = useViewerStore((s) => s.clashClearance);
  const groupBy = useViewerStore((s) => s.clashGroupBy);
  const clusterEpsilon = useViewerStore((s) => s.clashClusterEpsilon);
  const reportTouch = useViewerStore((s) => s.clashReportTouch);
  const clashPresets = useViewerStore((s) => s.clashPresets);
  const selectedId = useViewerStore((s) => s.clashSelectedId);
  const panelVisible = useViewerStore((s) => s.clashPanelVisible);
  /** Number of loaded models — drives the "checking a single model" framing (#1271). */
  const modelCount = useViewerStore((s) => s.models.size);

  const setMode = useViewerStore((s) => s.setClashMode);
  const setTolerance = useViewerStore((s) => s.setClashTolerance);
  const setClearance = useViewerStore((s) => s.setClashClearance);
  const setGroupBy = useViewerStore((s) => s.setClashGroupBy);
  const setSelectedId = useViewerStore((s) => s.setClashSelectedId);
  const setPanelVisible = useViewerStore((s) => s.setClashPanelVisible);
  const clear = useViewerStore((s) => s.clearClash);

  // Geometry of the last-gathered clash elements, keyed by federated ref, so a
  // focused clash can compute its real contact interface for that one pair.
  const elementsByRef = useRef(new Map<number, ClashElement>());

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
      // Indeterminate "preparing" state until the engine reports candidate counts.
      state.setClashProgress({ phase: 'broad', rule: '', done: 0, total: 0 });
      try {
        // Let the panel paint the running state before the heavy work.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const { elements, exclusions } = gatherElements();
        if (elements.length === 0) {
          state.setClashError('No model geometry is loaded. Load an IFC model first.');
          return;
        }
        // Keep per-ref geometry so focusClash can build the contact interface.
        elementsByRef.current = new Map(elements.map((e) => [e.ref, e]));
        const engine = createClashEngine({ backend: 'ts' });
        const res = await engine.run(elements, rules, {
          exclusions,
          tolerance: state.clashTolerance,
          // The TS engine yields between chunks, so these updates actually paint.
          onProgress: (p) => useViewerStore.getState().setClashProgress(p),
        });
        state.setClashResult(res);
        // Spatial clustering is the sensible BCF unit; the panel list groups by
        // its own dimension separately. Radius is the user's cluster epsilon.
        state.setClashGroups(groupClashes(res, { by: 'cluster', epsilon: state.clashClusterEpsilon }));
        state.setClashSelectedId(null);
        posthog.capture('clash_detection_run', {
          clash_count: res.clashes.length,
          rule_count: rules.length,
          mode: state.clashMode,
        });
      } catch (err) {
        console.error('[clash] detection run failed', err);
        state.setClashError(err instanceof Error ? err.message : String(err));
        posthog.captureException(err, { additional_properties: { context: 'clash_detection' } });
      } finally {
        state.setClashRunning(false);
        state.setClashProgress(null);
      }
    },
    [gatherElements],
  );

  /**
   * Run the user's ENABLED rule set (built-in discipline rules they've kept on,
   * plus any custom presets). With no enabled rules, surface a clear message
   * instead of silently finding nothing.
   */
  const runMatrix = useCallback((): Promise<void> => {
    const enabled = clashPresets.filter((p) => p.enabled);
    if (enabled.length === 0) {
      useViewerStore.getState().setClashError('All rules are disabled — enable at least one in Clash settings (⚙).');
      return Promise.resolve();
    }
    return run(rulesFromPresets(enabled, mode, mode === 'clearance' ? clearance : undefined, reportTouch));
  }, [run, mode, clearance, reportTouch, clashPresets]);

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
          ...(reportTouch ? { reportTouch: true } : {}),
        },
      ]),
    [run, mode, clearance, reportTouch],
  );

  const runPreset = useCallback(
    (presetId: string): Promise<void> => {
      const preset = useViewerStore.getState().clashPresets.find((p) => p.id === presetId);
      if (!preset) return Promise.resolve();
      return run(rulesFromPresets([preset], mode, mode === 'clearance' ? clearance : undefined, reportTouch));
    },
    [run, mode, clearance, reportTouch],
  );

  /**
   * Scan the loaded geometry for duplicate / fully-overlapping elements (#1280).
   * This is an AABB-only pass (no narrow-phase triangle work), so it's fast and
   * doesn't go through the clash engine — but it produces the same `ClashResult`
   * shape, so the panel, grouping and BCF export render it unchanged.
   */
  const runDuplicates = useCallback(async (): Promise<void> => {
    const state = useViewerStore.getState();
    state.setClashRunning(true);
    state.setClashError(null);
    state.setClashProgress({ phase: 'broad', rule: 'duplicates', done: 0, total: 0 });
    try {
      // Paint the running state before the (synchronous) scan blocks the thread.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const { elements, exclusions } = gatherElements();
      if (elements.length === 0) {
        state.setClashError('No model geometry is loaded. Load an IFC model first.');
        return;
      }
      const res = findDuplicates(elements, { exclusions });
      state.setClashResult(res);
      state.setClashGroups(groupClashes(res, { by: 'cluster', epsilon: state.clashClusterEpsilon }));
      state.setClashSelectedId(null);
      posthog.capture('clash_duplicate_scan', { duplicate_count: res.clashes.length });
    } catch (err) {
      console.error('[clash] duplicate scan failed', err);
      state.setClashError(err instanceof Error ? err.message : String(err));
      posthog.captureException(err, { additional_properties: { context: 'clash_duplicates' } });
    } finally {
      state.setClashRunning(false);
      state.setClashProgress(null);
    }
  }, [gatherElements]);

  const refOf = useCallback((ref: ClashElementRef): SelectionRef | null => {
    return useViewerStore.getState().fromGlobalId(ref.ref);
  }, []);

  /**
   * Apply a focus mode to a set of global ids in the shared visibility channels:
   * - `highlight`: clear isolation + ghosting (pair highlighted in full context);
   * - `isolate`:   hide everything except the ids (#1275);
   * - `ghost`:     keep the ids solid and fade the rest to translucent context
   *                via the renderer's X-Ray path (#1275 "see them in context").
   */
  const applyFocusMode = useCallback((globalIds: number[], mode: ClashFocusMode): void => {
    const state = useViewerStore.getState();
    if (mode === 'isolate') state.setIsolatedEntities(new Set(globalIds));
    else if (mode === 'ghost') state.setGhostExceptEntities(new Set(globalIds));
    else {
      state.clearIsolation();
      state.clearGhost();
    }
  }, []);

  /**
   * Select both elements of a clash, highlight them, frame the camera, and apply
   * the chosen focus `mode` (highlight / isolate / ghost) — #1275.
   */
  const focusClash = useCallback(
    (clash: Clash, mode: ClashFocusMode = 'highlight'): void => {
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
      // Do NOT select the pair. Selecting forced a "selected" state (the 2-SEL
      // counter, and in isolate/ghost the elements read as selected). Instead we
      // just glow the two elements in distinct vibrant colours via the clash
      // highlight channel — the renderer gives highlighted ids the same glow /
      // opaque / stay-solid-through-ghost treatment as a selection, so the
      // colours show in highlight, isolate AND ghost with no selection. (#1277/#1339)
      state.clearEntitySelection();
      // Colour the two elements via the renderer COLOUR-OVERRIDE channel (the
      // same path the lens uses) — this repaints their actual albedo, so it
      // works on batched AND GPU-instanced geometry (e.g. Tekla steel members),
      // and crucially is NOT the selection highlight: the pair shows the distinct
      // amber/cyan clash colours, never the selection blue. (#1277/#1339)
      const colors = buildClashPairColors(a ? clash.a.ref : null, b ? clash.b.ref : null);
      state.setClashHighlightColors(colors); // record for framing + teardown
      state.setPendingColorUpdates(colors);  // actually paint A amber / B cyan
      // Mark the contact as a distinct third colour (#1277/#1402). Prefer the
      // REAL contact interface (shared-face polygon / intersection line) computed
      // for this one pair; fall back to the AABB box if it can't be built.
      let contactDrawn = false;
      const elA = elementsByRef.current.get(clash.a.ref);
      const elB = elementsByRef.current.get(clash.b.ref);
      if (elA && elB) {
        try {
          const clusters = contactClusters(
            { id: elA.key, positions: elA.positions, indices: elA.indices },
            { id: elB.key, positions: elB.positions, indices: elB.indices },
            { epsilon: Math.max(state.clashTolerance, 0.002) },
          );
          const vertices = contactLineList(clusters);
          if (vertices.length >= 6) {
            state.setClashContactLines({ vertices, color: CLASH_COLOR_OVERLAP });
            state.setClashOverlapBox(null);
            contactDrawn = true;
          }
        } catch {
          // Contact geometry failed (degenerate mesh); fall back to the box.
        }
      }
      if (!contactDrawn) {
        state.setClashContactLines(null);
        state.setClashOverlapBox(clash.bounds ? { min: clash.bounds.min, max: clash.bounds.max } : null);
      }
      applyFocusMode(globalIds, mode);
      state.setClashSelectedId(clash.id);
      // frameSelection also frames the clash ids (see Viewport), so the camera
      // encloses the pair without a selection.
      requestAnimationFrame(() => state.cameraCallbacks.frameSelection?.());
    },
    [refOf, applyFocusMode],
  );

  /**
   * Focus a SINGLE element of a clash pair so the user can step through each side
   * and read it on its own (#1276), applying the chosen focus `mode`.
   */
  const selectElement = useCallback(
    (el: ClashElementRef, mode: ClashFocusMode = 'highlight'): void => {
      const state = useViewerStore.getState();
      const ref = refOf(el);
      if (!ref) return;
      // Colour-override (no selection), consistent with focusClash — one element
      // in focus is painted the clash A colour and framed, without a selected
      // state or the selection-blue.
      state.clearEntitySelection();
      const one = new Map<number, [number, number, number, number]>([[el.ref, CLASH_COLOR_A]]);
      state.setClashHighlightColors(one);
      state.setPendingColorUpdates(one);
      state.setClashOverlapBox(null); state.setClashContactLines(null);
      applyFocusMode([el.ref], mode);
      requestAnimationFrame(() => state.cameraCallbacks.frameSelection?.());
    },
    [refOf, applyFocusMode],
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
    // Showing every clashing element at once — an element can be A in one clash
    // and B in another, so per-pair colours are ambiguous here. Drop any stale
    // pair colours (restoring an active lens) and rely on the selection outline.
    state.setClashHighlightColors(null);
    state.setPendingColorUpdates(state.lensAppliedColors ?? new Map());
    state.setClashOverlapBox(null); state.setClashContactLines(null);
  }, [refOf]);

  const clearHighlight = useCallback((): void => {
    const state = useViewerStore.getState();
    state.clearEntitySelection();
    state.clearIsolation(); // drop any clash isolation so the full model returns
    state.clearGhost(); // and any X-Ray ghosting
    state.setClashHighlightColors(null);
    // Restore the colour-override channel to whatever owned it (an active lens),
    // or clear it — don't leave the clash A/B colours painted. (#1277 review)
    state.setPendingColorUpdates(state.lensAppliedColors ?? new Map());
    state.setClashOverlapBox(null); state.setClashContactLines(null);
    setSelectedId(null);
  }, [setSelectedId]);

  /**
   * Preview what a given export config would produce, WITHOUT building anything:
   * how many clashes survive the severity filter and how many BCF topics they
   * collapse into under the chosen grouping (incl. the overflow marker topic).
   * Cheap (pure grouping) so the dialog can call it on every keystroke.
   */
  const bcfPreview = useCallback((config: ClashBcfConfig): { clashes: number; topics: number } => {
    const state = useViewerStore.getState();
    const current = state.clashResult;
    if (!current) return { clashes: 0, topics: 0 };
    const filtered = filterResultBySeverity(current, new Set(config.severities));
    if (filtered.clashes.length === 0) return { clashes: 0, topics: 0 };
    const groups = groupClashes(filtered, { by: config.groupBy, epsilon: state.clashClusterEpsilon });
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
      const groups = groupClashes(filtered, { by: config.groupBy, epsilon: state.clashClusterEpsilon });

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
              // Repaint the full multi-selection too — the snapshot loop drove the
              // renderer directly without touching the store, so the store's
              // selectedEntityIds reference never changed and useRenderUpdates
              // won't re-fire. Without this the clash highlight vanishes post-export.
              selectedIds: saved.selectedEntityIds,
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
    const state = useViewerStore.getState();
    state.clearEntitySelection();
    state.clearIsolation();
    state.clearGhost();
    // Drop the clash colour-override (restoring an active lens) + overlap box.
    state.setPendingColorUpdates(state.lensAppliedColors ?? new Map());
    state.setClashOverlapBox(null); state.setClashContactLines(null);
    clear();
  }, [clear]);

  return {
    // state
    result,
    groups,
    running,
    error,
    progress,
    mode,
    tolerance,
    clearance,
    groupBy,
    selectedId,
    panelVisible,
    modelCount,
    // Only enabled presets show as run chips; the settings dialog manages the full set.
    presets: clashPresets.filter((p) => p.enabled),
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
    runDuplicates,
    focusClash,
    selectElement,
    highlightAll,
    clearHighlight,
    exportBcf,
    bcfPreview,
    clearAll,
  };
}
