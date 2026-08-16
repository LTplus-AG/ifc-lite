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
import type { ClashFocusMode } from '@/store/slices/clashSlice';
import {
  createClashEngine,
  rulesFromPresets,
  groupClashes,
  groupDuplicateSets,
  findDuplicates,
  clashReviewKey,
  type Clash,
  type ClashElement,
  type ClashElementRef,
  type ClashGroup,
  type ClashResult,
  type ClashReviewStatus,
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
import { clashFramingBounds } from '@/lib/clash/clash-framing';
import { computeClashIntersectionSolid } from '@/lib/clash/intersection-solid';
import { restoreOverridesForGhosting } from '@/lib/clash/ghost-color-overrides';
import { createLatestWinsGuard } from '@/lib/clash/latest-wins';
import { posthog } from '@/lib/analytics';
import { errorCaptureProps } from '@/lib/load-errors';
import { downloadBlob } from '@/lib/export/download';
import { nextFrameOrTimeout } from '@/utils/frameWait';

/**
 * Upper bound on the "let the panel paint first" frame wait before a clash run.
 * Purely cosmetic work, so a short bound is enough to keep a hidden tab from
 * blocking the run entirely. (#2385)
 */
const PAINT_FRAME_WAIT_MS = 250;

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
 *
 * Canonical definition lives in the clash store slice (so the panel's choice
 * persists across panel switches); imported at the top + re-exported here for
 * existing consumers. (#1464)
 */
export type { ClashFocusMode };

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
  /** Per-clash review state + the status view filter (#1468). */
  const reviews = useViewerStore((s) => s.clashReviews);
  const statusFilter = useViewerStore((s) => s.clashStatusFilter);
  /** Number of loaded models — drives the "checking a single model" framing (#1271). */
  const modelCount = useViewerStore((s) => s.models.size);

  const setMode = useViewerStore((s) => s.setClashMode);
  const setTolerance = useViewerStore((s) => s.setClashTolerance);
  const setClearance = useViewerStore((s) => s.setClashClearance);
  const setGroupBy = useViewerStore((s) => s.setClashGroupBy);
  const setSelectedId = useViewerStore((s) => s.setClashSelectedId);
  const setPanelVisible = useViewerStore((s) => s.setClashPanelVisible);
  const setClashReview = useViewerStore((s) => s.setClashReview);
  const toggleStatusFilter = useViewerStore((s) => s.toggleClashStatusFilter);
  const clear = useViewerStore((s) => s.clearClash);

  // Geometry of the last-gathered clash elements, keyed by federated ref, so a
  // focused clash can compute its real contact interface for that one pair.
  const elementsByRef = useRef(new Map<number, ClashElement>());

  /**
   * Staleness guard for the on-demand intersection-solid compute: bumped on
   * every `focusClash` / `selectElement` / teardown call, captured locally by
   * the async compute below, and re-checked before the result is ever written
   * to the store. Without this, selecting clash A then quickly clash B could
   * have A's compute resolve AFTER B is focused and paint A's stale solid over
   * B's pair — the store has no other signal that a request was superseded.
   */
  const solidRequestGuard = useRef(createLatestWinsGuard());

  /**
   * The EXACT Set references this hook last installed into the SHARED
   * isolation / ghost visibility channels (`isolatedEntities` /
   * `ghostExceptEntities`). Those channels are shared with features clash does
   * not own - "Isolate in 3D" from the advanced filter (#2532), assembly
   * isolation (#2531), the spaces X-ray - so clash teardown may only release a
   * presentation clash itself installed. Reference identity is the provenance
   * test: the visibility slice stores a fresh `Set` per write, so once another
   * feature writes the channel the recorded reference no longer matches and
   * the release below leaves that state standing. (#2574 regression: the
   * run-start discard cleared these channels unconditionally, so a user's
   * isolation was destroyed before any clash result existed.)
   */
  const appliedIsolation = useRef<ReadonlySet<number> | null>(null);
  const appliedGhost = useRef<ReadonlySet<number> | null>(null);

  /** Install clash isolation into the shared channel, recording exactly what
   *  was installed so `releaseClashVisibility` can release only that. */
  const installClashIsolation = useCallback((ids: Set<number>): void => {
    useViewerStore.getState().setIsolatedEntities(ids);
    appliedIsolation.current = useViewerStore.getState().isolatedEntities;
    appliedGhost.current = null; // setIsolatedEntities cleared any ghosting
  }, []);

  /** Install clash ghosting (X-Ray context) into the shared channel, with the
   *  same install-record contract as `installClashIsolation`. */
  const installClashGhost = useCallback((ids: Set<number>): void => {
    useViewerStore.getState().setGhostExceptEntities(ids);
    appliedGhost.current = useViewerStore.getState().ghostExceptEntities;
    appliedIsolation.current = null; // setGhostExceptEntities cleared isolation
  }, []);

  /**
   * Release the isolation/ghost presentation clash itself installed - and ONLY
   * that. Isolation or ghosting established by another feature (#2532 / #2531
   * / spaces X-ray) no longer reference-matches the install record, so it
   * survives a clash run untouched.
   */
  const releaseClashVisibility = useCallback((): void => {
    const state = useViewerStore.getState();
    if (appliedIsolation.current !== null && state.isolatedEntities === appliedIsolation.current) {
      state.clearIsolation();
    }
    if (appliedGhost.current !== null && state.ghostExceptEntities === appliedGhost.current) {
      state.clearGhost();
    }
    appliedIsolation.current = null;
    appliedGhost.current = null;
  }, []);

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

  /**
   * Drop any in-flight or already-applied intersection-solid presentation
   * before a detection flow replaces the clash result set. `focusClash`'s
   * async solid compute is keyed to `solidRequestGuard`; without this, `run()`
   * / `runDuplicates()` cleared `clashSelectedId` but left the guard token
   * valid, so a compute that was still in flight for the OLD result set could
   * resolve after the new run finished and repaint its stale mesh plus the
   * full-model ghosting over results the user can no longer see the pair for
   * (CodeRabbit #2574). Mirrors the teardown `clearHighlight` already does.
   *
   * Only CLASH-OWNED state is discarded: the solid, the pair colours, the
   * contact markers, and the isolation/ghost presentation clash itself
   * installed (via `releaseClashVisibility`). Isolation or ghosting another
   * feature established (#2532 / #2531 / spaces X-ray) must survive a run
   * start - the unconditional clears that shipped with #2574 destroyed a
   * user's isolation before any clash result existed.
   */
  const discardSolidPresentation = useCallback((): void => {
    const state = useViewerStore.getState();
    solidRequestGuard.current.begin();
    state.clearClashSolid();
    releaseClashVisibility();
    state.setClashHighlightColors(null);
    state.setPendingColorUpdates(state.lensAppliedColors ?? new Map());
    state.setClashOverlapBox(null);
    state.setClashContactLines(null);
  }, [releaseClashVisibility]);

  const run = useCallback(
    async (rules: ClashRule[]): Promise<void> => {
      const state = useViewerStore.getState();
      discardSolidPresentation();
      state.setClashRunning(true);
      state.setClashError(null);
      // Indeterminate "preparing" state until the engine reports candidate counts.
      state.setClashProgress({ phase: 'broad', rule: '', done: 0, total: 0 });
      try {
        // Let the panel paint the running state before the heavy work. Bounded:
        // a hidden tab never delivers a frame, and the whole run sits after this
        // await, so an unbounded wait means the run simply never starts. (#2385)
        await nextFrameOrTimeout(PAINT_FRAME_WAIT_MS);
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
        // Completed-run signal for baseline consumers (clash tour run gate).
        state.bumpClashRunSeq();
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
        posthog.captureException(err, { context: 'clash_detection', ...errorCaptureProps(err) });
      } finally {
        state.setClashRunning(false);
        state.setClashProgress(null);
      }
    },
    [gatherElements, discardSolidPresentation],
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
    discardSolidPresentation();
    state.setClashRunning(true);
    state.setClashError(null);
    state.setClashProgress({ phase: 'broad', rule: 'duplicates', done: 0, total: 0 });
    try {
      // Paint the running state before the (synchronous) scan blocks the thread.
      // Bounded for the same reason as the clash run above (#2385).
      await nextFrameOrTimeout(PAINT_FRAME_WAIT_MS);
      const { elements, exclusions } = gatherElements();
      if (elements.length === 0) {
        state.setClashError('No model geometry is loaded. Load an IFC model first.');
        return;
      }
      // The duplicate scan has its own tolerance ("how far apart may two
      // elements be and still be the same object", default 10 mm) — the clash
      // engine's `clashTolerance` is a touching band (2 mm) and means something
      // else, so it must not leak in here. Settable in Clash settings (#2530
      // review: the knob was previously unreachable from the viewer).
      const res = findDuplicates(elements, {
        exclusions,
        positionTolerance: state.clashDuplicateTolerance,
      });
      state.setClashResult(res);
      // Completed-run signal for baseline consumers (clash tour run gate).
      state.bumpClashRunSeq();
      // Coincident SETS, not spatial clusters: three copies of one column are one
      // finding, and two unrelated duplicate pairs a metre apart stay two. The
      // panel renders these as its sections (see duplicate-set-sections.ts).
      const sets = groupDuplicateSets(res);
      state.setClashGroups(sets);
      state.setClashSelectedId(null);
      // duplicate_count counts SETS — what the panel now reports as findings —
      // not pairwise rows, which overstate N copies by N(N−1)/2 (#2530 review).
      posthog.capture('clash_duplicate_scan', {
        duplicate_count: sets.length,
        pair_count: res.clashes.length,
      });
    } catch (err) {
      console.error('[clash] duplicate scan failed', err);
      state.setClashError(err instanceof Error ? err.message : String(err));
      posthog.captureException(err, { context: 'clash_duplicates', ...errorCaptureProps(err) });
    } finally {
      state.setClashRunning(false);
      state.setClashProgress(null);
    }
  }, [gatherElements, discardSolidPresentation]);

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
    if (mode === 'isolate') installClashIsolation(new Set(globalIds));
    else if (mode === 'ghost') installClashGhost(new Set(globalIds));
    else {
      // Full-context highlight clears both channels outright - the user asked
      // to see this pair against the WHOLE model, so any isolation would hide
      // it (pre-#2574 contract, #1275). Clash then owns neither channel.
      const state = useViewerStore.getState();
      state.clearIsolation();
      state.clearGhost();
      appliedIsolation.current = null;
      appliedGhost.current = null;
    }
  }, [installClashIsolation, installClashGhost]);

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
      // Frame the CONTACT region (tight overlap box grown by a little context),
      // not the union of the two whole elements; a long clashing member would
      // otherwise dominate and push the overlap tiny and off-centre (#1466).
      // Fall back to frameSelection if the bounds are missing or the isometric
      // callback isn't registered yet (renderer not mounted).
      const framing = clash.bounds ? clashFramingBounds(clash.bounds) : null;
      requestAnimationFrame(() => {
        const cb = useViewerStore.getState().cameraCallbacks;
        if (framing && cb.frameClashRegion) {
          cb.frameClashRegion(
            { x: framing.min[0], y: framing.min[1], z: framing.min[2] },
            { x: framing.max[0], y: framing.max[1], z: framing.max[2] },
          );
        } else {
          cb.frameSelection?.();
        }
      });

      // On-demand TRUE intersection volume (BIMcollab Zoom / Solibri style):
      // computed for this ONE pair only, never eagerly for the whole result
      // set — 88 pairs computed eagerly measured 216 ms on the bridge model,
      // and only ~1/3 of real clashes resolve to a solid at all (the rest are
      // genuine grazing contacts below the kernel's snap resolution). The
      // synchronous contact-marker painting above is what the user sees the
      // instant they click; this only ever UPGRADES that view, asynchronously.
      const mySolidToken = solidRequestGuard.current.begin();
      state.setClashSolidComputing();
      if (elA && elB) {
        computeClashIntersectionSolid(elA.positions, elA.indices, elB.positions, elB.indices)
          .then((result) => {
            // Stale: the user moved to a different clash (or deselected)
            // while this was in flight. Every teardown path (clearHighlight,
            // clearAll, highlightAll, panel unmount, and the next focusClash)
            // also calls `begin()`, so this is the one check that covers all
            // of them without duplicating the guard at each site.
            if (!solidRequestGuard.current.isCurrent(mySolidToken)) return;
            const s = useViewerStore.getState();
            if (result.isSolid) {
              s.setClashSolid({ positions: result.positions, indices: result.indices }, result.volumeM3);
              // BIMcollab-style presentation: ghost the ENTIRE model — the two
              // parents included — regardless of the panel's Highlight/
              // Isolate/Ghost preference. The screenshot that set this target
              // shows nothing opaque except the overlap itself; leaving the
              // pair (or the rest of the model) opaque would bury the solid
              // again, the exact "hard to see" complaint this answers. The
              // user's chosen focus mode still governs the fallback below,
              // and is restored the moment this clash is deselected (`clearGhost`/
              // `clearHighlight` do not know about this override — they just
              // clear ghosting outright, which is correct either way).
              // Installed through the provenance record so the run-start
              // discard can later release this full-model ghost as clash-owned
              // (it replaces any isolate-mode focus: setGhostExceptEntities
              // clears isolation).
              const ghostExceptEntities = new Set<number>();
              installClashGhost(ghostExceptEntities);
              // Drop the amber/cyan pair tint: ghosted, the pair should read
              // as ordinary translucent context (grey, like the rest), not a
              // coloured ghost — the solid alone carries the "here" colour.
              s.setClashHighlightColors(null);
              // Restoring `lensAppliedColors` verbatim would defeat the
              // ghosting: the renderer promotes any entity carrying a
              // colour override to the opaque, depth-writing pipeline
              // (packages/renderer/src/overlay-routing.ts), and
              // `ghostExceptIds` only supplies alpha through the transparent
              // path — it does not survive that promotion. With any lens,
              // Pset, or IDS colouring active, every overridden entity
              // (including the two clash parents) would render opaque again,
              // burying the solid behind them (#2574). Filter the restored
              // map down to entities this ghost does NOT cover — today that's
              // every entity (`ghostExceptEntities` is empty), so this
              // collapses to an empty map and takes the same
              // `clearColorOverrides()` path as "no lens active".
              s.setPendingColorUpdates(restoreOverridesForGhosting(s.lensAppliedColors, ghostExceptEntities));
              // The box/contact-line marker is superseded by the solid.
              s.setClashContactLines(null);
              s.setClashOverlapBox(null);
            } else {
              // No solid: today's contact marker (already painted above) IS
              // the presentation. Only the status changes, so the panel can
              // say why — "no solid" must not read as "no clash".
              s.setClashSolidUnavailable(result.reason, result.thicknessM, result.requiredM);
            }
          })
          .catch(() => {
            if (!solidRequestGuard.current.isCurrent(mySolidToken)) return;
            useViewerStore.getState().setClashSolidUnavailable('compute-error', 0, 0);
          });
      } else {
        // No cached geometry for one/both refs (e.g. gathered before this
        // model finished loading) — nothing to compute; the contact marker
        // stays the presentation, same as before this feature existed.
        state.setClashSolidUnavailable('empty-operand', 0, 0);
      }
    },
    [refOf, applyFocusMode, installClashGhost],
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
      // Single-element step-through has no PAIR to compute a solid for —
      // supersede any in-flight compute from a prior focusClash and drop its
      // solid so it can't paint over this one-element view.
      solidRequestGuard.current.begin();
      state.clearClashSolid();
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
    solidRequestGuard.current.begin();
    state.clearClashSolid();
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
    solidRequestGuard.current.begin();
    state.clearClashSolid();
    setSelectedId(null);
  }, [setSelectedId]);

  /** Current review status of a clash ('open' when unreviewed). Reactive: reads
   *  the subscribed reviews map so the panel repaints on any review change. (#1468) */
  const reviewOf = useCallback(
    (clash: Clash): ClashReviewStatus => reviews.get(clashReviewKey(clash))?.status ?? 'open',
    [reviews],
  );

  /** Current review comment of a clash ('' when none). */
  const reviewCommentOf = useCallback(
    (clash: Clash): string => reviews.get(clashReviewKey(clash))?.comment ?? '',
    [reviews],
  );

  /** Set a clash's review status and/or comment (persists). Resetting to open
   *  with no comment drops the entry. (#1468) */
  const setReview = useCallback(
    (clash: Clash, patch: { status?: ClashReviewStatus; comment?: string }) =>
      setClashReview(clashReviewKey(clash), patch),
    [setClashReview],
  );

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
            // restoreEvictedForCapture: isolation may reveal batches evicted
            // under the GPU residency budget — restore synchronously so the
            // BCF snapshot is complete.
            renderer.render({ isolatedIds: isolation, selectedId: null, clearColor: SNAPSHOT_CLEAR_COLOR, restoreEvictedForCapture: true });
            const device = renderer.getGPUDevice();
            if (device) await device.queue.onSubmittedWorkDone();
            // Let the compositor present the frame before reading the canvas.
            // FRAME-WAIT-ALLOW(#2385): must NOT be raced against a timer — the
            // point is that the frame was actually presented, and timing out
            // would read a stale canvas into the BCF snapshot. A hidden tab
            // cannot produce a valid snapshot at all, so bounding buys nothing.
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const dataUrl = await renderer.captureScreenshot();
            done += 1;
            onProgress?.(done, total);
            return dataUrl ? dataUrlToBytes(dataUrl) : undefined;
          };
        }
      }

      // Each topic's status follows its members' review status (least-resolved
      // wins), mapped to a BCF status in the bridge. Read the live reviews map so
      // an edit made just before export is reflected. (#1468)
      const reviewsMap = state.clashReviews;
      const reviewStatusOf = (clash: Clash): ClashReviewStatus =>
        reviewsMap.get(clashReviewKey(clash))?.status ?? 'open';

      try {
        const project = await createBCFFromClashResult(filtered, groups, {
          author: 'clash@ifc-lite',
          projectName: 'Clash report',
          reviewStatusOf,
          // Resolve model ids to file names for the BCF Header (#1591).
          modelNameOf: (id) => state.models.get(id)?.name ?? id,
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
    solidRequestGuard.current.begin();
    state.clearClashSolid();
    clear();
  }, [clear]);

  /**
   * Cancel any in-flight on-demand solid compute without touching anything
   * else — for callers (the panel's unmount cleanup) that reset ghost/
   * isolation/colour state themselves and just need the async result, if it
   * lands after teardown, to be dropped instead of re-applying a solid + full-
   * model ghost onto a view the user has already left. Idempotent.
   */
  const invalidateSolidCompute = useCallback((): void => {
    solidRequestGuard.current.begin();
  }, []);

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
    statusFilter,
    // Only enabled presets show as run chips; the settings dialog manages the full set.
    presets: clashPresets.filter((p) => p.enabled),
    // settings
    setMode,
    setTolerance,
    setClearance,
    setGroupBy,
    setPanelVisible,
    // review (#1468)
    reviewOf,
    reviewCommentOf,
    setReview,
    toggleStatusFilter,
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
    invalidateSolidCompute,
  };
}
