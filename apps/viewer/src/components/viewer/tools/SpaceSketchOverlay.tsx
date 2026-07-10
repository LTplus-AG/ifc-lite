/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Space Sketch (DCEL) — interactive test surface for the persistent
 * `SpacePlateHandle` topology editor (rust/geometry `space_dcel`).
 *
 * Self-contained: owns its own wasm handle + local state (no shared slice).
 * Rooms are derived from the active storey's RENDERED wall meshes (min-area
 * footprint rectangles → gap detection → lifted onto the wall axis), then the
 * user can drag a shared vertex (both rooms follow), split a room — between
 * corners OR new nodes added anywhere on a wall — merge two rooms, then Bake to
 * real `IfcSpace` through the viewer's existing `addSpace`.
 *
 * Fluency (RFC §4.2): hover telegraphs the op; drawing/dragging/cutting snap to
 * other vertices + walls, with Shift = ortho (which dominates snap). Undo/redo
 * snapshots the plate via `duplicate()`
 * (each clone owns its heap, freed deterministically — never JS GC). 2D plan
 * sketch; 3D-on-model registration is the next step.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useConstructionUnderlay } from '@/hooks/useConstructionUnderlay';
import { useIfc } from '@/hooks/useIfc';
import { snapPoint, alignToAxes, type SnapKind } from '@/lib/space-snap';
import { editError } from '@/lib/space-edit-error';
import { pointerButton, isRemoveModifier } from '@/lib/space-interaction';
import {
  SpacePlateSession,
  ensureSpaceWasm,
  snapshotRoomsFromRects,
  flattenWallRects,
  type Room,
  type Boundary,
} from '@/lib/space-plate-session';
import { wallRectsFromMeshes, type WallRect } from '@/lib/wall-rects-from-meshes';
import {
  polyArea, pointInPoly, centroid, uniqueVerts, distToSeg, projectOnSeg,
  computeFit, zoomFit, sX, sY, wX, wY, PAD, type Fit, type Pt,
} from '@/lib/space-sketch-geometry';
import {
  existingSpaceFootprintsByStorey,
  GENERATED_SPACE_OBJECTTYPE,
  type BoundaryMode,
} from '@ifc-lite/create';
import { X, Undo2, Redo2, Layers, Maximize, AlertTriangle, Magnet, SlidersHorizontal, HelpCircle, Eraser } from 'lucide-react';
import { SpaceSketchCanvas } from './space-sketch/SpaceSketchCanvas';
import { OptionsPopover, HelpPopover } from './space-sketch/SpaceSketchPopovers';
import type { Hover, SplitTarget, IntentTone } from './space-sketch/types';

const DEFAULT_W = 580;
const DEFAULT_H = 460;
const MIN_W = 360;
const MIN_H = 280;
const PICK_PX = 12;
const SNAP_PX = 10;
const BAKE_HEIGHT = 3;
const EPS = 1e-6;

/** Lock `p` to a horizontal or vertical line through `anchor` (Shift-ortho),
 *  whichever axis the cursor moved further along. Used for straight cut lines. */
function orthoLock(anchor: Pt, p: Pt): Pt {
  return Math.abs(p[0] - anchor[0]) >= Math.abs(p[1] - anchor[1]) ? [p[0], anchor[1]] : [anchor[0], p[1]];
}

export function SpaceSketchOverlay() {
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const addSpace = useViewerStore((s) => s.addSpace);
  const removeEntity = useViewerStore((s) => s.removeEntity);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  // Rooms are derived from the RENDERED wall meshes (the geometry the user sees),
  // so the room lines land on the rendered wall faces — not from STEP source
  // geometry, which has no per-wall thickness here and a centroid-biased axis.
  const geometryResult = useViewerStore((s) => s.geometryResult);
  const { ifcDataStore } = useIfc();

  const sessionRef = useRef<SpacePlateSession | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<Fit>({ scale: 1, offX: PAD, offY: DEFAULT_H - PAD });
  const rafRef = useRef<number | null>(null);
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buildSeqRef = useRef(0);
  // IfcSpace expressIds this session created per storey — so a re-bake (or
  // "Generate all") replaces the spaces it dropped instead of duplicating.
  const generatedRef = useRef<Map<number, number[]>>(new Map());
  const moveRef = useRef<{ x: number; y: number; shift: boolean; del: boolean } | null>(null);

  const dragRef = useRef<number | null>(null);
  const dragStartRef = useRef<Pt | null>(null);
  const otherVertsRef = useRef<Pt[]>([]);
  const draggedRef = useRef(false);
  const panningRef = useRef(false); // Issue 4: middle-mouse / empty-drag panning
  const resizeRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  // While drawing, Undo pops the last placed point onto this stack and Redo
  // re-adds it — so point placement uses the panel Undo/Redo, not a separate
  // draw-only control. Cleared when the draw is committed/cancelled.
  const drawRedoRef = useRef<Pt[]>([]);
  // Timestamp of the last bare Esc — a second within 400 ms closes the panel.
  const escTimeRef = useRef(0);
  // Building wall lines (room frame) for snapping; synced from a memo so the
  // per-frame pointer math can read it without re-binding processMove.
  const buildingSegmentsRef = useRef<Array<[Pt, Pt]>>([]);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [hover, setHover] = useState<Hover>(null);
  const [splitPick, setSplitPick] = useState<SplitTarget | null>(null);
  const [splitHover, setSplitHover] = useState<Pt | null>(null);
  const [snapPos, setSnapPos] = useState<Pt | null>(null);
  // What the live snap landed on, so the cue can differ for a wall vs a corner.
  const [snapKind, setSnapKind] = useState<SnapKind>('none');
  // Snap every node to the building's 2D wall lines (corners + along walls).
  // Default on; the magnet toggle in the toolbar turns it off (vertex-only).
  const [snapToBuilding, setSnapToBuilding] = useState(true);
  // True once the user has edited the plate (drag/split/merge/draw/dissolve)
  // since the last bake/derive — drives the "close with unbaked edits" guard.
  const [dirty, setDirty] = useState(false);
  // Disclosure popovers (self-managed; no radix Popover primitive here) + the
  // unbaked-edits close confirmation. Keep the default panel clean.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  // Issue 3: the vertex that an ⌥/Ctrl-click would dissolve — telegraphed live.
  const [deleteHover, setDeleteHover] = useState<Pt | null>(null);
  // Issue 2: the in-progress drawn room (world coords) + the live cursor point.
  const [drawPts, setDrawPts] = useState<Pt[]>([]);
  const [drawCursor, setDrawCursor] = useState<Pt | null>(null);
  // Alignment guides while drawing: reference corners whose X (vertical guide)
  // / Y (horizontal guide) the cursor is currently locked to — so the closing
  // corner can line up under the first point, etc.
  const [alignGuides, setAlignGuides] = useState<{ vRef: Pt | null; hRef: Pt | null }>({ vRef: null, hRef: null });
  // Live "what will this click do" label, shown top-right of the canvas.
  const [intent, setIntent] = useState<{ text: string; tone: IntentTone } | null>(null);
  // Issue 4: canvas size (resizable) + a tick that forces a re-render whenever
  // the view transform in fitRef changes (zoom/pan/fit) without making the
  // per-frame pointer math go through React state.
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [fitTick, setFitTick] = useState(0);
  const applyFit = useCallback((next: Fit) => { fitRef.current = next; setFitTick((t) => t + 1); }, []);
  const [derivedStorey, setDerivedStorey] = useState<number | null>(null);
  const [snapTol, setSnapTol] = useState<number | null>(null); // null = auto-escalate
  const [usedTol, setUsedTol] = useState(0.1);
  const snapTolRef = useRef<number | null>(null);
  const lastBuildRef = useRef<{ rects: WallRect[]; label: string; storey: number | null } | null>(null);
  // Wall centrelines + thicknesses from the last derive, kept for the leak
  // diagnostics overlay + the "has wall data" affordance.
  const extractionRef = useRef<{
    segments: { a: Pt; b: Pt }[];
    thicknesses: number[];
  } | null>(null);
  const [hist, setHist] = useState(0);
  const [status, setStatus] = useState('Pick a storey to derive rooms from its walls.');
  const [showBuilding, setShowBuilding] = useState(true);
  const [showDiagnostics, setShowDiagnostics] = useState(false); // Issue 7 — leak diagnostics
  // Default to the wall AXIS (face-based rooms are the gaps between wall
  // rectangles): `center` puts the room outline + nodes on the true wall
  // centreline. `inner`/`outer` show the net/gross faces.
  const [boundaryMode, setBoundaryMode] = useState<BoundaryMode>('center');
  // Transient "12 → 9 rooms" badge after a corner-tolerance rebuild — the
  // effect on the plan is otherwise invisible (Issue 5).
  const [snapDelta, setSnapDelta] = useState<{ from: number; to: number } | null>(null);
  const pendingSnapPrevRef = useRef<number | null>(null);
  const snapDeltaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Every IfcBuildingStorey with its resolved name + elevation, low → high.
  const storeys = useMemo(() => {
    if (!ifcDataStore) return [] as { id: number; name: string; elev: number }[];
    const elevs = ifcDataStore.spatialHierarchy?.storeyElevations;
    const list = ifcDataStore.getEntitiesByType('IfcBuildingStorey').map((s) => ({
      id: s.expressId,
      name: ifcDataStore.entities.getName(s.expressId) || `Storey #${s.expressId}`,
      elev: elevs?.get(s.expressId) ?? 0,
    }));
    list.sort((a, b) => a.elev - b.elev);
    return list;
  }, [ifcDataStore]);

  const derivedFloorElev = useMemo(
    () => (derivedStorey == null ? null : storeys.find((s) => s.id === derivedStorey)?.elev ?? null),
    [derivedStorey, storeys],
  );
  // Compute the underlay whenever a storey is derived (so snapping works even
  // before any room exists — e.g. drawing the FIRST room must still snap to the
  // building walls), not only when rooms are already present. Gated by show OR
  // snap so it's not computed when neither needs it.
  const { lines: underlay } = useConstructionUnderlay((showBuilding || snapToBuilding) && derivedFloorElev != null, derivedFloorElev);

  // Building wall lines as snap segments (room frame), only while snapping is on.
  const buildingSegments = useMemo<Array<[Pt, Pt]>>(
    () => (snapToBuilding ? underlay.map((l) => [l.a, l.b] as [Pt, Pt]) : []),
    [underlay, snapToBuilding],
  );
  useEffect(() => { buildingSegmentsRef.current = buildingSegments; }, [buildingSegments]);

  // Pre-render the (potentially large) building underlay once per (re)derive,
  // NOT on every drag frame — re-creating hundreds of SVG lines each frame
  // froze the editor (and the runaway drag dragged the room off-canvas). It
  // only changes when the plate is rebuilt, tracked by `hist`.
  const underlayEls = useMemo(() => {
    if (!showBuilding || underlay.length === 0) return null;
    const f = fitRef.current;
    return underlay.map((l, i) => (
      <line key={`b${i}`}
        x1={sX(f, l.a[0])} y1={sY(f, l.a[1])} x2={sX(f, l.b[0])} y2={sY(f, l.b[1])}
        stroke="currentColor"
        strokeOpacity={l.hidden ? 0.16 : 0.34}
        strokeWidth={l.hidden ? 0.8 : 1.1}
        strokeDasharray={l.hidden ? '3 3' : undefined}
        pointerEvents="none" />
    ));
  }, [underlay, showBuilding, fitTick]);
  const [storeyId, setStoreyId] = useState<number | null>(null);
  const lastDerivedRef = useRef<string | null>(null);
  // Connect to the shared active storey instead of always defaulting to the
  // lowest storey: seed from whatever the user already picked in the hierarchy,
  // and follow it when it changes while the panel is open. The in-panel storey
  // <select> stays as a local override; a later hierarchy pick wins.
  const activeStorey = useViewerStore((s) => s.activeStorey);
  // Match the active storey to THIS model's storey list by express-id. We don't
  // compare modelId: `storeys` already comes from the active model's store, so
  // membership is inherently model-scoped — and `activeModelId` can be null for
  // a single model in the map (where the hierarchy stores the model UUID), so a
  // strict modelId equality wrongly failed and fell back to the lowest storey.
  const lastActiveStoreyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!storeys.length) return;
    const sketchModelId = activeStorey?.modelId ?? activeModelId ?? 'legacy';
    const activeHere =
      activeStorey && storeys.some((s) => s.id === activeStorey.expressId)
        ? activeStorey.expressId
        : null;
    const activeKey = activeHere == null ? null : `${sketchModelId}:${activeHere}`;
    // Follow the shared active storey when it changes to one in this model.
    if (activeKey != null && activeKey !== lastActiveStoreyRef.current) {
      lastActiveStoreyRef.current = activeKey;
      setStoreyId(activeHere);
      return;
    }
    // Initial seed: prefer the active storey, else the lowest.
    if (storeyId == null) setStoreyId(activeHere ?? storeys[0].id);
  }, [storeys, storeyId, activeStorey, activeModelId]);

  // Panel stays open while you work — it no longer closes on an outside click
  // (you need to click the hierarchy to pick a storey) or on a single Esc.
  // Keyboard handling (Esc aborts the current op / double-Esc closes / Enter
  // closes a drawn room) lives below, after `commitDraw` is defined.

  // Re-read the rooms from the session into render state (cheap per-frame use
  // during a drag — no history/dirty side effects).
  const refreshRooms = useCallback(() => {
    const s = sessionRef.current;
    if (s) setRooms(s.rooms());
  }, []);

  // After any committed plate change: re-render the canvas, refresh the
  // undo/redo button states (`hist`), and mirror the session's dirty flag.
  const commit = useCallback(() => {
    const s = sessionRef.current;
    setRooms(s?.rooms() ?? []);
    setHist((v) => v + 1);
    setDirty(s?.dirty ?? false);
  }, []);

  const resetInteraction = useCallback(() => {
    setHover(null); setSplitPick(null); setSplitHover(null); setSnapPos(null);
    dragRef.current = null; dragStartRef.current = null;
    sessionRef.current?.cancelDrag(); // discard any in-flight drag snapshot
  }, []);

  const undo = useCallback(() => {
    // While drawing, Undo removes the last placed point (no separate draw undo).
    if (drawPts.length > 0) {
      drawRedoRef.current.push(drawPts[drawPts.length - 1]);
      setDrawPts((p) => p.slice(0, -1));
      setStatus('Removed last point.');
      return;
    }
    if (sessionRef.current?.undo()) {
      resetInteraction(); commit();
      setStatus('Undo.');
    }
  }, [drawPts, resetInteraction, commit]);

  const redo = useCallback(() => {
    // While drawing, Redo re-adds the last point Undo removed.
    if (drawRedoRef.current.length > 0) {
      const pt = drawRedoRef.current.pop()!;
      setDrawPts((p) => [...p, pt]);
      setStatus('Re-added point.');
      return;
    }
    if (sessionRef.current?.redo()) {
      resetInteraction(); commit();
      setStatus('Redo.');
    }
  }, [resetInteraction, commit]);

  // Ctrl/Cmd+Z (Shift = redo) must drive THIS overlay's history, not the 3D
  // model behind the panel. The global handler in useKeyboardShortcuts routes
  // Ctrl+Z to the active model's mutation stack; a capture-phase listener here
  // runs before it and stopPropagation()s, so the sketch and the in-panel
  // Undo/Redo buttons share one history. Skip when a text input is focused so
  // native field undo (and the global handler, which also skips inputs) is
  // untouched. The overlay only mounts while the tool is active, so this
  // listener's lifetime is exactly the tool's.
  useEffect(() => {
    const onUndoRedo = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || !(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', onUndoRedo, true);
    return () => window.removeEventListener('keydown', onUndoRedo, true);
  }, [undo, redo]);

  // Wheel = zoom about the cursor (Issue 4). A native non-passive listener so
  // preventDefault() actually stops the page from scrolling under the panel.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015); // scroll up → zoom in
      const next = zoomFit(fitRef.current, factor, e.clientX - rect.left, e.clientY - rect.top);
      if (next.scale >= 0.5 && next.scale <= 5000) { fitRef.current = next; setFitTick((t) => t + 1); }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Build a face-based plate from the storey's wall RECTANGLES (read from the
  // rendered meshes): rooms are the gaps between walls, so the room boundary IS
  // the rendered wall faces and every node lands on the true wall axis. `snapTol`
  // welds nearby rectangle corners (default 5 cm); a manual override comes from
  // the slider.
  const buildFrom = useCallback(async (rects: WallRect[], label: string, storey: number | null) => {
    // Re-entrancy guard: a rapid rebuild (snap slider) must not let an older
    // async build free/replace the plate a newer one is using — that races the
    // shared wasm heap. Only the latest build applies; superseded ones bail.
    const seq = ++buildSeqRef.current;
    try {
      await ensureSpaceWasm();
      if (seq !== buildSeqRef.current) return;
      lastBuildRef.current = { rects, label, storey };
      const snapTol = snapTolRef.current ?? 0.05;
      let session = sessionRef.current;
      if (!session) { session = new SpacePlateSession(); sessionRef.current = session; }
      const { rooms: snap } = session.buildFromRects(flattenWallRects(rects.map((r) => r.corners)), snapTol, 0.3);
      setUsedTol(snapTol);
      applyFit(computeFit(snap, sizeRef.current.w, sizeRef.current.h));
      resetInteraction();
      setDerivedStorey(storey);
      setRooms(snap); setHist((v) => v + 1);
      setDirty(false); // a fresh derive is the new clean baseline
      // Surface the room-count consequence of a weld-tolerance change (only a
      // snap rebuild sets pendingSnapPrevRef; an initial derive leaves it null).
      const prevCount = pendingSnapPrevRef.current;
      pendingSnapPrevRef.current = null;
      if (prevCount != null && prevCount !== snap.length) {
        setSnapDelta({ from: prevCount, to: snap.length });
        if (snapDeltaTimerRef.current) clearTimeout(snapDeltaTimerRef.current);
        snapDeltaTimerRef.current = setTimeout(() => setSnapDelta(null), 1800);
      }
      const total = snap.reduce((s, r) => s + r.area, 0);
      setStatus(`${label}: ${snap.length} room(s), ${total.toFixed(1)} m² · ${rects.length} walls.`);
    } catch (e) {
      setStatus(`Build failed: ${String(e)}`);
    }
  }, [resetInteraction, applyFit]);

  // Manual weld-tolerance override (null → 5 cm default). Rebuilds the current
  // plate from its wall rectangles at the chosen tolerance.
  const rebuildWithSnap = useCallback((tol: number | null) => {
    snapTolRef.current = tol;
    setSnapTol(tol);
    if (tol != null) setUsedTol(tol); // move the slider thumb/label immediately
    // Remember the room count before this rebuild so buildFrom can flash the delta.
    pendingSnapPrevRef.current = sessionRef.current?.roomCount ?? null;
    // Debounce the actual rebuild: the range input fires onChange on every
    // tick, and buildFrom is async + frees/creates wasm handles — rebuilding
    // per tick raced the shared heap and froze the editor. Rebuild once the
    // slider settles.
    if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    rebuildTimerRef.current = setTimeout(() => {
      rebuildTimerRef.current = null;
      const lb = lastBuildRef.current;
      if (lb) void buildFrom(lb.rects, lb.label, lb.storey);
    }, 180);
  }, [buildFrom]);

  const deriveFromStorey = useCallback(async () => {
    if (!ifcDataStore || storeyId == null) { setStatus('No model / storey to derive from.'); return; }
    const meshes = geometryResult?.meshes;
    if (!meshes || meshes.length === 0) { setStatus('Model geometry still loading — try again in a moment.'); return; }
    try {
      const elev = storeys.find((s) => s.id === storeyId)?.elev ?? 0;
      const rects = wallRectsFromMeshes(meshes, geometryResult?.coordinateInfo, elev, floorToFloor(storeyId));
      if (!rects.length) {
        setStatus(`No walls found on storey ${storeyId} (no rendered wall meshes in its height band).`);
        return;
      }
      extractionRef.current = {
        segments: rects.map((r) => ({ a: r.centreline[0], b: r.centreline[1] })),
        thicknesses: rects.map((r) => r.thickness),
      };
      const name = ifcDataStore.entities.getName(storeyId) || `Storey #${storeyId}`;
      await buildFrom(rects, name, storeyId);
    } catch (e) {
      setStatus(`Derive failed: ${String(e)}`);
    }
    // floorToFloor depends on `storeys`; both are stable per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ifcDataStore, storeyId, geometryResult, buildFrom, storeys]);

  // Auto-detect: derive rooms the moment a storey is chosen (and on open, when
  // the first storey auto-selects) so the user doesn't have to click Derive.
  // Guarded so it fires once per storey, and never clobbers a loaded demo.
  useEffect(() => {
    // Key by model + storey so switching to another model with the same storey
    // express-id still re-derives (a bare-id guard would treat it as unchanged
    // and leave the previous model's rooms on screen).
    const deriveKey = storeyId == null ? null : `${activeModelId ?? 'legacy'}:${storeyId}`;
    if (deriveKey != null && ifcDataStore && lastDerivedRef.current !== deriveKey) {
      lastDerivedRef.current = deriveKey;
      void deriveFromStorey();
    }
  }, [storeyId, activeModelId, ifcDataStore, deriveFromStorey]);

  const floorToFloor = useCallback((sid: number): number => {
    const idx = storeys.findIndex((s) => s.id === sid);
    const next = idx >= 0 ? storeys[idx + 1] : undefined;
    const ff = next ? next.elev - storeys[idx].elev : BAKE_HEIGHT;
    return ff > 0.1 && ff < 50 ? ff : BAKE_HEIGHT;
  }, [storeys]);

  /**
   * IfcSpace is class-hidden by default (TYPE_VISIBILITY_SEMANTIC_DEFAULTS).
   * Flip the toggle on after a successful bake so the user sees what they
   * just created — and, since the toggle persists, so the spaces are still
   * visible when the exported file is reopened.
   */
  const revealSpaces = useCallback(() => {
    const s = useViewerStore.getState();
    if (!s.typeVisibility.spaces) s.toggleTypeVisibility('spaces');
  }, []);

  /**
   * Bake one storey's rooms to IfcSpace — the single path both "Bake" and
   * "Generate all" use, so they're consistent. (1) Replace: remove the spaces
   * this session previously dropped on the storey. (2) Skip rooms that overlap
   * an existing authored space (dedup). (3) Emit each via `addSpace`, which
   * mirrors a mesh into the 3D scene immediately. Net (inner-face) outline,
   * floor-to-floor height. Returns counts.
   */
  const bakeStorey = useCallback((
    sid: number,
    rooms: { outline: Pt[]; boundary: Pt[] }[],
    authored: Pt[][],
  ): { emitted: number; skipped: number; error: string | null } => {
    if (!activeModelId) return { emitted: 0, skipped: 0, error: null };
    for (const id of generatedRef.current.get(sid) ?? []) removeEntity(activeModelId, id);
    generatedRef.current.delete(sid);
    const height = floorToFloor(sid);
    const newIds: number[] = [];
    let skipped = 0;
    // An addSpace failure (anchor resolution, missing mutation view, …) is
    // NOT an "already a space" skip — keep the first error so the status
    // line tells the user the truth instead of silently dropping spaces
    // that would then be missing from the export.
    let error: string | null = null;
    for (const room of rooms) {
      const [cx, cy] = centroid(room.outline);
      if (authored.some((fp) => pointInPoly(cx, cy, fp))) { skipped++; continue; }
      // `boundary` is the engine's net/gross/centre outline; gross area stays on
      // the centreline so the quantity reflects the room, not the wall face.
      const res = addSpace(activeModelId, sid, {
        Profile: 'polygon', OuterCurve: room.boundary, Height: height,
        Name: `Space ${newIds.length + 1}`, ObjectType: GENERATED_SPACE_OBJECTTYPE,
        grossFloorArea: polyArea(room.outline),
      });
      if (res && 'expressId' in res) newIds.push(res.expressId);
      else error ??= (res && 'error' in res ? res.error : 'unknown error');
    }
    generatedRef.current.set(sid, newIds);
    return { emitted: newIds.length, skipped, error };
  }, [activeModelId, removeEntity, addSpace, floorToFloor]);

  const bake = useCallback(() => {
    const session = sessionRef.current;
    if (!session?.alive || !activeModelId || derivedStorey == null || !ifcDataStore) {
      setStatus('Derive a storey first.');
      return;
    }
    const rooms = session.rooms().map((r) => ({
      outline: r.outline,
      boundary: session.boundaryOutline(r.face, boundaryMode),
    }));
    const authored = existingSpaceFootprintsByStorey(ifcDataStore).get(derivedStorey) ?? [];
    const { emitted, skipped, error } = bakeStorey(derivedStorey, rooms, authored);
    if (emitted > 0) revealSpaces();
    if (!error) { session.dirty = false; setDirty(false); } // rooms now written to IfcSpace
    setStatus(error
      ? `Baked ${emitted} IfcSpace — others failed: ${error}`
      : `Baked ${emitted} IfcSpace${skipped ? `, skipped ${skipped} (already a space)` : ''}.`);
  }, [activeModelId, derivedStorey, ifcDataStore, bakeStorey, revealSpaces, boundaryMode]);

  const bakeWholeBuilding = useCallback(async () => {
    if (!activeModelId || !ifcDataStore) { setStatus('No model loaded.'); return; }
    const meshes = geometryResult?.meshes;
    if (!meshes || meshes.length === 0) { setStatus('Model geometry still loading.'); return; }
    setStatus('Generating spaces for every storey…');
    await ensureSpaceWasm();
    const authoredMap = existingSpaceFootprintsByStorey(ifcDataStore);
    const coord = geometryResult?.coordinateInfo;
    let totalEmitted = 0, totalSkipped = 0, floors = 0;
    let firstError: string | null = null;
    for (const st of storeys) {
      const rects = wallRectsFromMeshes(meshes, coord, st.elev, floorToFloor(st.id));
      if (!rects.length) continue;
      try {
        // Throwaway face-based plate per storey (deterministic free handled by the
        // session module); this path doesn't touch the live session. Reads each
        // room's wall axis + the boundary outline at the chosen mode.
        const rooms = snapshotRoomsFromRects(flattenWallRects(rects.map((r) => r.corners)), boundaryMode);
        if (!rooms.length) continue;
        const { emitted, skipped, error } = bakeStorey(st.id, rooms, authoredMap.get(st.id) ?? []);
        totalEmitted += emitted; totalSkipped += skipped;
        firstError ??= error;
        if (emitted) floors++;
      } catch (e) {
        // A storey that exceeds the arrangement input cap (or otherwise fails to
        // build) must not abort the whole run or leave an unhandled rejection that
        // can tear down the canvas; record it and move on to the next storey.
        firstError ??= e instanceof Error ? e.message : String(e);
      }
    }
    if (totalEmitted > 0) revealSpaces();
    if (!firstError) { if (sessionRef.current) sessionRef.current.dirty = false; setDirty(false); }
    setStatus(firstError
      ? `Generated ${totalEmitted} IfcSpace — others failed: ${firstError}`
      : `Generated ${totalEmitted} IfcSpace across ${floors} storey(s)${totalSkipped ? `; skipped ${totalSkipped} existing` : ''}.`);
  }, [activeModelId, ifcDataStore, geometryResult, storeys, floorToFloor, bakeStorey, revealSpaces, boundaryMode]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    if (snapDeltaTimerRef.current) clearTimeout(snapDeltaTimerRef.current);
    sessionRef.current?.dispose();
    sessionRef.current = null;
  }, []);

  const svgPoint = (e: React.MouseEvent): Pt => {
    const rect = svgRef.current!.getBoundingClientRect();
    // Clamp to the canvas: during a drag the pointer is captured, so moving it
    // past the panel (e.g. dragging a vertex down off the bottom) would report
    // coordinates far outside the SVG → a huge off-screen world position. That
    // pushed the room off-canvas ("disappears") and made the SVG rasterise a
    // polygon spanning to extreme coordinates, freezing the browser.
    return [
      Math.max(0, Math.min(sizeRef.current.w, e.clientX - rect.left)),
      Math.max(0, Math.min(sizeRef.current.h, e.clientY - rect.top)),
    ];
  };

  const pickVertex = useCallback((wx: number, wy: number): number | null => {
    return sessionRef.current?.findVertexNear(wx, wy, PICK_PX / fitRef.current.scale) ?? null;
  }, []);

  const nearestVertPos = useCallback((wx: number, wy: number): Pt | null => {
    let best: Pt | null = null, bestD = PICK_PX / fitRef.current.scale;
    for (const r of rooms) for (const p of r.outline) {
      const d = Math.hypot(p[0] - wx, p[1] - wy);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }, [rooms]);

  const pickEdge = useCallback((wx: number, wy: number): { face: number; edge: number; a: Pt; b: Pt } | null => {
    const session = sessionRef.current;
    if (!session) return null;
    const tol = PICK_PX / fitRef.current.scale;
    let best: { face: number; edge: number; a: Pt; b: Pt; d: number } | null = null;
    for (const r of rooms) {
      const bounds = session.boundingElements(r.face);
      const n = r.outline.length;
      for (let i = 0; i < n; i++) {
        const a = r.outline[i], b = r.outline[(i + 1) % n];
        const d = distToSeg(wx, wy, a[0], a[1], b[0], b[1]);
        if (d <= tol && (!best || d < best.d) && bounds[i]) best = { face: r.face, edge: bounds[i].edge, a, b, d };
      }
    }
    return best ? { face: best.face, edge: best.edge, a: best.a, b: best.b } : null;
  }, [rooms]);

  // Resolve a click to a split endpoint: snap to an existing corner, else a
  // point projected onto the nearest wall edge (a new node on commit).
  const resolveSplitTarget = useCallback((wx: number, wy: number): SplitTarget | null => {
    const v = pickVertex(wx, wy);
    if (v != null) { const pos = nearestVertPos(wx, wy); return pos ? { kind: 'vertex', vid: v, pos } : null; }
    const e = pickEdge(wx, wy);
    if (e) return { kind: 'edge', edge: e.edge, pos: projectOnSeg([wx, wy], e.a, e.b) };
    return null;
  }, [pickVertex, nearestVertPos, pickEdge]);

  // Commit a split between two targets, inserting nodes for edge endpoints.
  // The whole gesture is atomic: on any failure the inserted nodes roll back.
  const performSplit = useCallback((first: SplitTarget, second: SplitTarget) => {
    const session = sessionRef.current;
    if (!session?.alive) return;
    if (first.kind === 'edge' && second.kind === 'edge' && first.edge === second.edge) {
      setStatus('Pick points on two different edges (or corners).'); return;
    }
    try {
      // One atomic edit: insert any edge-endpoint nodes, then cut between them.
      // session.edit rolls the whole thing back if any step throws.
      session.edit((h) => {
        const va = first.kind === 'vertex' ? first.vid : h.splitEdge(first.edge, first.pos[0], first.pos[1]);
        const vb = second.kind === 'vertex' ? second.vid : h.splitEdge(second.edge, second.pos[0], second.pos[1]);
        if (va === vb) throw new Error('the two cut points are the same');
        const fresh = h.snapshot() as Room[];
        const onBoundary = (r: Room, p: Pt) => r.outline.some((q) => Math.abs(q[0] - p[0]) < EPS && Math.abs(q[1] - p[1]) < EPS);
        const room = fresh.find((r) => onBoundary(r, first.pos) && onBoundary(r, second.pos));
        if (!room) throw new Error('the two points are not on the same room');
        h.splitFace(room.face, va, vb, -1);
      });
      commit();
      setStatus(`Split — ${session.roomCount} room(s).`);
    } catch (err) {
      commit(); // session rolled the plate back; re-render the restored state
      setStatus(`Split rejected: ${editError(err).message}`);
    }
  }, [commit]);

  // Commit the in-progress drawn polygon as a new room face (Issue 2). The new
  // room is its own connected component — it doesn't merge into existing walls.
  const commitDraw = useCallback(() => {
    const session = sessionRef.current;
    if (!session?.alive) return;
    // Drop trailing duplicate point(s) — e.g. the second click of a double-click
    // close lands on the same spot as the final corner.
    let pts = drawPts;
    while (pts.length >= 2 && Math.hypot(pts[pts.length - 1][0] - pts[pts.length - 2][0], pts[pts.length - 1][1] - pts[pts.length - 2][1]) < EPS) {
      pts = pts.slice(0, -1);
    }
    if (pts.length < 3) { setStatus('A room needs at least 3 points.'); return; }
    try {
      session.edit((h) => h.addFace(new Float64Array(pts.flat()), -1));
      setDrawPts([]); setDrawCursor(null); drawRedoRef.current = []; setAlignGuides({ vRef: null, hRef: null });
      commit();
      setStatus(`Drew a room — ${session.roomCount} room(s).`);
    } catch (err) {
      commit(); // session rolled back the partial draw
      setStatus(`Draw rejected: ${editError(err).message}`);
    }
  }, [drawPts, commit]);

  // Single Esc aborts the in-progress operation (in priority order); it does NOT
  // close the panel. Returns true if something was aborted.
  const abortCurrentOp = useCallback((): boolean => {
    if (drawPts.length > 0) {
      setDrawPts([]); setDrawCursor(null); drawRedoRef.current = []; setAlignGuides({ vRef: null, hRef: null });
      setStatus('Draw cancelled.');
      return true;
    }
    if (splitPick) {
      setSplitPick(null); setSplitHover(null);
      setStatus('Split cancelled.');
      return true;
    }
    if (dragRef.current != null) {
      sessionRef.current?.cancelDrag(); // revert the live drag to its pre-drag snapshot
      refreshRooms();
      dragRef.current = null; dragStartRef.current = null;
      draggedRef.current = false; setSnapPos(null);
      setStatus('Drag cancelled.');
      return true;
    }
    return false;
  }, [drawPts, splitPick, refreshRooms]);

  // While the panel is open, Esc belongs to the sketch — NOT the global
  // shortcut (which closes the tool and would lose the sketch). Capture-phase +
  // stopImmediatePropagation beats the window-level handler in useKeyboardShortcuts.
  // Esc: close a popover/confirm → abort the current op → (double-tap) close, with
  // an unbaked-edits guard. Enter closes a drawn room.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation(); // own Esc; don't let the global handler close us
        if (helpOpen || optionsOpen) { setHelpOpen(false); setOptionsOpen(false); return; }
        if (confirmClose) { setConfirmClose(false); return; } // Esc cancels the confirm (never discards)
        const now = Date.now();
        if (abortCurrentOp()) { escTimeRef.current = 0; return; }
        if (now - escTimeRef.current <= 400) {
          escTimeRef.current = 0;
          if (dirty) setConfirmClose(true); // guard unbaked edits — must click Discard
          else setActiveTool('select');
        } else { escTimeRef.current = now; setStatus(dirty ? 'Unbaked edits — Esc again to review.' : 'Press Esc again to close.'); }
      } else if (e.key === 'Enter' && drawPts.length > 0 && !inField) {
        e.preventDefault();
        e.stopImmediatePropagation();
        commitDraw();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [abortCurrentOp, commitDraw, drawPts.length, dirty, helpOpen, optionsOpen, confirmClose, setActiveTool]);

  // Close request from the ✕ button: guard unbaked edits with an inline confirm.
  const requestClose = useCallback(() => {
    if (dirty) setConfirmClose(true);
    else setActiveTool('select');
  }, [dirty, setActiveTool]);

  // "Clean up" — sweep the whole plate clean in the engine: remove dangling
  // spur walls, isolated nodes, and redundant collinear nodes left by the
  // non-destructive wall arrangement. Area-neutral and idempotent (the Rust
  // `prune` does the topology surgery; real corners and wall junctions stay).
  const cleanupOrphans = useCallback(() => {
    const session = sessionRef.current;
    if (!session?.alive || !rooms.length) return;
    try {
      // Commit only if prune actually removed something (no-op → no undo entry).
      const removed = session.edit((h) => h.prune(), (n) => n > 0);
      if (removed > 0) {
        commit();
        setStatus(`Cleaned up ${removed} orphan wall${removed === 1 ? '' : 's'}/node${removed === 1 ? '' : 's'} — ${session.roomCount} room(s).`);
      } else {
        setStatus('Nothing to clean up — no orphan walls or nodes.');
      }
    } catch (err) {
      commit();
      setStatus(`Cleanup failed: ${editError(err).message}`);
    }
  }, [rooms, commit]);

  const processMove = useCallback(() => {
    rafRef.current = null;
    const m = moveRef.current;
    const session = sessionRef.current;
    if (!m || !session?.alive) return;
    const wx = wX(fitRef.current, m.x), wy = wY(fitRef.current, m.y);

    const vid = dragRef.current;
    if (vid != null) {
      draggedRef.current = true;
      // Snap to other room vertices + building wall lines (corners and along
      // walls), with Shift constraining to ortho from the drag start first.
      const snap = snapPoint([wx, wy], {
        vertices: otherVertsRef.current,
        segments: buildingSegmentsRef.current,
        tol: SNAP_PX / fitRef.current.scale,
        ortho: m.shift,
        anchor: dragStartRef.current,
      });
      setSnapPos(snap.kind === 'none' ? null : snap.pt);
      setSnapKind(snap.kind);
      setIntent({ text: snap.kind === 'line' ? 'Move onto wall' : snap.kind === 'vertex' ? 'Move onto corner' : m.shift ? 'Move (straight)' : 'Move node', tone: 'move' });
      session.dragTo(vid, snap.pt[0], snap.pt[1]);
      refreshRooms();
      return;
    }

    // Drawing a new room: preview the next corner. Strong osnap (room vertices +
    // building walls) wins; otherwise align to the drawn corners' axes (so the
    // closing corner locks under the first), Shift = ortho from the last corner.
    if (drawPts.length > 0) {
      const tol = PICK_PX / fitRef.current.scale;
      const anchor = drawPts[drawPts.length - 1];
      const snap = snapPoint([wx, wy], { vertices: uniqueVerts(rooms), segments: buildingSegmentsRef.current, tol, ortho: m.shift, anchor });
      let pt = snap.pt;
      // Axis-align to the drawn corners only when NOT holding Shift — under Shift
      // the ortho constraint is authoritative and alignToAxes (which snaps X and Y
      // independently) would pull the point off the straight line.
      if (snap.kind === 'none' && !m.shift) {
        const al = alignToAxes(snap.pt, drawPts, tol);
        pt = al.pt; setSnapKind('none'); setAlignGuides({ vRef: al.vRef, hRef: al.hRef });
      } else {
        setSnapKind(snap.kind); setAlignGuides({ vRef: null, hRef: null });
      }
      setDrawCursor(pt);
      const closing = drawPts.length >= 3 && Math.hypot(pt[0] - drawPts[0][0], pt[1] - drawPts[0][1]) <= tol;
      setIntent({ text: closing ? 'Close room' : m.shift ? 'Add corner (straight)' : 'Add corner', tone: 'draw' });
      return;
    }

    // Cutting: preview the second point. Track the cursor (snapped target or raw)
    // so the rubber band follows even over empty space.
    if (splitPick) {
      // Shift = straight cut: lock the second point ortho from the first, then
      // resolve onto a wall/corner along that line (so a rectangular room cuts
      // cleanly perpendicular). Shift dominates — snap can't bend the cut.
      const cur: Pt = m.shift ? orthoLock(splitPick.pos, [wx, wy]) : [wx, wy];
      const t = resolveSplitTarget(cur[0], cur[1]);
      setSplitHover(t ? t.pos : cur);
      setHover(t && t.kind === 'vertex' ? { kind: 'vertex', pos: t.pos } : null);
      setIntent({ text: t ? (m.shift ? 'Finish cut (straight)' : 'Finish cut here') : 'Click a wall or corner to cut', tone: 'cut' });
      return;
    }

    // Idle hover — context cues + the intent label by what's under the cursor.
    const v = pickVertex(wx, wy);
    if (v != null) {
      const pos = nearestVertPos(wx, wy);
      setHover(pos ? { kind: 'vertex', pos } : null);
      setDeleteHover(m.del && pos ? pos : null); // ⌥/Ctrl telegraphs node removal
      setSplitHover(null); setDrawCursor(null); setSnapPos(null); setAlignGuides({ vRef: null, hRef: null });
      setIntent(m.del ? { text: 'Remove node', tone: 'remove' } : { text: 'Move node', tone: 'move' });
      return;
    }
    const ed = pickEdge(wx, wy);
    if (ed != null) {
      setDeleteHover(null); setDrawCursor(null); setSnapPos(null);
      if (m.del) {
        // ⌥/Ctrl over a wall → remove preview. A distinct room across → merge;
        // otherwise removeEdge deletes the wall and cleans up the orphans.
        const nbr = session.neighborAcross(ed.edge);
        const shared = nbr !== undefined && nbr !== ed.face;
        setHover({ kind: 'edge', edge: ed.edge, rooms: [ed.face, ...(shared ? [nbr] : [])], a: ed.a, b: ed.b });
        setSplitHover(null);
        setIntent({ text: shared ? 'Merge rooms' : 'Remove wall', tone: 'remove' });
      } else {
        // plain → cut cue ("+") at the projected point on the wall.
        setHover(null);
        setSplitHover(projectOnSeg([wx, wy], ed.a, ed.b));
        setIntent({ text: 'Cut from here', tone: 'cut' });
      }
      return;
    }
    // Empty space → draw a room (or Shift = pan; hide the draw dot then).
    setHover(null); setDeleteHover(null); setSplitHover(null); setAlignGuides({ vRef: null, hRef: null });
    const tol = PICK_PX / fitRef.current.scale;
    const snap = snapPoint([wx, wy], { vertices: uniqueVerts(rooms), segments: buildingSegmentsRef.current, tol });
    setDrawCursor(m.shift ? null : snap.pt); setSnapKind(snap.kind);
    setIntent(m.shift ? { text: 'Pan', tone: 'pan' } : { text: 'Draw room', tone: 'draw' });
  }, [drawPts, splitPick, rooms, pickEdge, pickVertex, nearestVertPos, resolveSplitTarget, refreshRooms]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (panningRef.current) {
      // Pan by the raw pointer delta (movement*), so it doesn't fight the
      // canvas-edge clamp in svgPoint.
      fitRef.current = { scale: fitRef.current.scale, offX: fitRef.current.offX + e.movementX, offY: fitRef.current.offY + e.movementY };
      setFitTick((t) => t + 1);
      return;
    }
    const [x, y] = svgPoint(e);
    moveRef.current = { x, y, shift: e.shiftKey, del: isRemoveModifier(e) };
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(processMove);
  }, [processMove]);

  // Pressing/releasing a modifier re-evaluates the hover preview at the current
  // cursor (so the action label + cues flip the instant you hold ⌥/Ctrl/Shift,
  // without having to move). No-op until the cursor has been over the canvas.
  useEffect(() => {
    const onMod = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' && e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'Shift') return;
      const m = moveRef.current;
      if (!m || dragRef.current != null || panningRef.current) return;
      m.del = isRemoveModifier(e);
      m.shift = e.shiftKey;
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(processMove);
    };
    window.addEventListener('keydown', onMod);
    window.addEventListener('keyup', onMod);
    return () => { window.removeEventListener('keydown', onMod); window.removeEventListener('keyup', onMod); };
  }, [processMove]);

  // The "remove at this point" gesture, shared by modifier+left-click
  // (onPointerDown) and right-click / macOS Ctrl-click (onContextMenu): a node
  // dissolves or its incident wall is removed; a wall is removed; both auto-clean
  // the orphans. Returns true if it acted on something under the cursor.
  const removeAtPoint = useCallback((wx: number, wy: number): boolean => {
    const session = sessionRef.current;
    if (!session?.alive) return false;
    // Over a node → dissolve it, else remove one of its incident walls.
    const v = pickVertex(wx, wy);
    if (v != null) {
      const vp = nearestVertPos(wx, wy);
      try {
        // One atomic edit: a degree-2 node dissolves (straighten/remove); a wall
        // junction (3+ walls) won't, so fall back to removing one incident wall
        // (removeEdge unions two real rooms, or deletes a bridge/spur wall and
        // auto-cleans the orphans — handling the BridgeEdge/BordersExterior
        // cases the old merge-only path rejected). Throws if nothing is
        // removable, so session.edit rolls back.
        const outcome = session.edit((h): 'node' | 'wall' => {
          try { h.dissolveVertex(v); return 'node'; }
          catch (dissolveErr) {
            const reason = editError(dissolveErr).message;
            if (vp) {
              for (const r of rooms) {
                const n = r.outline.length;
                const k = r.outline.findIndex((p) => Math.abs(p[0] - vp[0]) < EPS && Math.abs(p[1] - vp[1]) < EPS);
                if (k < 0) continue;
                const bounds = h.boundingElements(r.face) as Boundary[];
                for (const idx of [k, (k - 1 + n) % n]) {
                  const b = bounds[idx];
                  if (!b) continue;
                  try { h.removeEdge(b.edge); return 'wall'; }
                  catch { /* an enclosing wall — try the next incident wall */ }
                }
              }
            }
            throw new Error(`no wall here separates two rooms${reason ? ` (${reason})` : ''}`);
          }
        });
        commit(); setHover(null); setDeleteHover(null);
        setStatus(outcome === 'node'
          ? `Removed node — ${session.roomCount} room(s).`
          : `Removed wall & cleaned up — ${session.roomCount} room(s).`);
      } catch (err) {
        commit(); // session rolled back
        setStatus(`Can’t remove this node — ${editError(err).message}.`);
      }
      return true;
    }
    // Over a wall → remove it (merge two rooms / delete a bridge-spur + clean up).
    const ed = pickEdge(wx, wy);
    if (ed != null) {
      try {
        // removeEdge unions two real rooms, or deletes a bridge/spur wall and
        // auto-cleans the orphans — only a real enclosing wall is refused.
        session.edit((h) => h.removeEdge(ed.edge));
        commit(); setHover(null);
        setStatus(`Removed wall — ${session.roomCount} room(s) left.`);
      } catch (err) {
        commit();
        setStatus(`Can't remove this wall: ${editError(err).message}`);
      }
      return true;
    }
    return false; // nothing under the cursor
  }, [pickVertex, pickEdge, nearestVertPos, rooms, commit]);

  // Right-click / macOS Ctrl-click is the remove gesture. macOS turns Ctrl-click
  // into a real right-click (button 2 + contextmenu), so routing it here — rather
  // than the button-2 pointerdown — makes Ctrl-click remove reliably, matching
  // Cmd/Alt-click. preventDefault keeps the native menu away regardless.
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!sessionRef.current?.alive) return;
    if (drawPts.length > 0 || splitPick) return; // mid-gesture → leave it to Esc
    const [sx, sy] = svgPoint(e);
    removeAtPoint(wX(fitRef.current, sx), wY(fitRef.current, sy));
  }, [drawPts, splitPick, removeAtPoint]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const session = sessionRef.current;
    if (!session?.alive) return;
    // Middle-mouse drag pans the view in any mode (Issue 4).
    if (pointerButton(e) === 'middle') {
      panningRef.current = true;
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    // Right-click (incl. macOS Ctrl-click) is the remove gesture — handled in
    // onContextMenu so it fires reliably; ignore it here so a secondary-button
    // press never starts a drag / cut / draw.
    if (pointerButton(e) === 'secondary') return;
    const [sx, sy] = svgPoint(e);
    const wx = wX(fitRef.current, sx), wy = wY(fitRef.current, sy);
    // Dissolve/merge intent on a left-click held with a modifier (Win/Linux
    // Ctrl, macOS Alt/Cmd; macOS Ctrl-click arrives via onContextMenu instead).
    const mod = isRemoveModifier(e);
    const tol = PICK_PX / fitRef.current.scale;

    // 1. Drawing in progress → add a corner (or close on the first dot).
    if (drawPts.length > 0) {
      const anchor = drawPts[drawPts.length - 1];
      const snap = snapPoint([wx, wy], { vertices: uniqueVerts(rooms), segments: buildingSegmentsRef.current, tol, ortho: e.shiftKey, anchor });
      // Under Shift the ortho point is authoritative; only axis-align when free.
      const p = snap.kind === 'none' && !e.shiftKey ? alignToAxes(snap.pt, drawPts, tol).pt : snap.pt;
      setAlignGuides({ vRef: null, hRef: null });
      if (drawPts.length >= 3) {
        const first = drawPts[0];
        if (Math.hypot(p[0] - first[0], p[1] - first[1]) <= tol) { commitDraw(); return; }
      }
      drawRedoRef.current = [];
      setDrawPts((pts) => [...pts, p]);
      setStatus(`Drawing — ${drawPts.length + 1} pt(s) · Enter / double-click / first dot to close · Shift = straight · Ctrl+Z removes last.`);
      return;
    }

    // 2. Cutting in progress → place the second cut point and split (Shift =
    // straight cut, ortho from the first point).
    if (splitPick) {
      const cur: Pt = e.shiftKey ? orthoLock(splitPick.pos, [wx, wy]) : [wx, wy];
      const target = resolveSplitTarget(cur[0], cur[1]);
      if (!target) { setStatus('Click another wall (or corner) on the same room to finish the cut.'); return; }
      const first = splitPick;
      setSplitPick(null); setSplitHover(null);
      performSplit(first, target);
      return;
    }

    // Modifier + left-click anywhere on a node/wall → remove (shared with the
    // right-click path). macOS Ctrl-click is a right-click → onContextMenu.
    if (mod) { removeAtPoint(wx, wy); return; }

    // 3. Over a node → drag it.
    const v = pickVertex(wx, wy);
    if (v != null) {
      const start = nearestVertPos(wx, wy);
      dragRef.current = v; dragStartRef.current = start; draggedRef.current = false;
      session.beginDrag(); // pre-drag snapshot; committed on drop, reverted on cancel
      otherVertsRef.current = start
        ? uniqueVerts(rooms).filter((p) => Math.hypot(p[0] - start[0], p[1] - start[1]) > 1e-6)
        : uniqueVerts(rooms);
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }

    // 4. Over a wall → start a cut (first point) by inserting a node.
    const ed = pickEdge(wx, wy);
    if (ed != null) {
      // Insert a node on the wall RIGHT NOW (so "add a node" actually adds one,
      // visible + undoable), and arm a cut from it. A second wall/corner click
      // splits the room between the two; Esc/elsewhere keeps the added node.
      try {
        const pos = projectOnSeg([wx, wy], ed.a, ed.b);
        const va = session.edit((h) => h.splitEdge(ed.edge, pos[0], pos[1]));
        commit();
        setSplitPick({ kind: 'vertex', vid: va, pos });
        setSplitHover(pos);
        setStatus('Node added — click another wall or corner to split between them, or Esc to keep the node.');
      } catch (err) {
        commit();
        setStatus(`Can't add node here: ${editError(err).message}`);
      }
      return;
    }

    // 5. Empty space → Shift pans (so you can still pan now that a plain click
    //    draws). Otherwise start drawing a new room.
    if (e.shiftKey) {
      panningRef.current = true;
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    const snap = snapPoint([wx, wy], { vertices: uniqueVerts(rooms), segments: buildingSegmentsRef.current, tol });
    drawRedoRef.current = [];
    setDrawPts([snap.pt]);
    setStatus('Drawing — click to add corners · Enter / double-click / first dot to close · Shift = straight.');
  }, [drawPts, splitPick, pickVertex, nearestVertPos, pickEdge, rooms, resolveSplitTarget, performSplit, commit, commitDraw, removeAtPoint]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (panningRef.current) {
      panningRef.current = false;
      svgRef.current?.releasePointerCapture(e.pointerId);
      return;
    }
    if (dragRef.current == null) return;
    dragRef.current = null; dragStartRef.current = null; setSnapPos(null);
    svgRef.current?.releasePointerCapture(e.pointerId);
    const session = sessionRef.current;
    if (draggedRef.current) { session?.commitDrag(); commit(); }
    else session?.cancelDrag(); // a click without a drag → discard the snapshot
    const total = rooms.reduce((s, r) => s + r.area, 0);
    if (draggedRef.current) setStatus(`Drag done — ${rooms.length} room(s), ${total.toFixed(1)} m² (conserved).`);
  }, [rooms, commit]);

  const f = fitRef.current;
  const total = rooms.reduce((s, r) => s + r.area, 0);
  const mergeRooms = hover?.kind === 'edge' ? new Set(hover.rooms) : null;
  const cursorWorld = moveRef.current ? [wX(f, moveRef.current.x), wY(f, moveRef.current.y)] as Pt : null;
  const cursor = panningRef.current || dragRef.current != null ? 'grabbing' : hover?.kind === 'vertex' ? 'grab' : 'crosshair';
  // During a draw, Undo/Redo act on the placed points (not the plate stack).
  // `hist` bumps on every committed change so these recompute on re-render.
  const canUndo = drawPts.length > 0 || (sessionRef.current?.canUndo ?? false);
  const canRedo = drawRedoRef.current.length > 0 || (sessionRef.current?.canRedo ?? false);
  void hist; void fitTick;

  const gridStep = f.scale > 14 ? 1 : f.scale > 5 ? 2 : 5;
  const gridLines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  if (rooms.length) {
    const gx0 = Math.floor(wX(f, PAD) / gridStep) * gridStep;
    const gx1 = Math.ceil(wX(f, size.w - PAD) / gridStep) * gridStep;
    const gy0 = Math.floor(wY(f, size.h - PAD) / gridStep) * gridStep;
    const gy1 = Math.ceil(wY(f, PAD) / gridStep) * gridStep;
    for (let x = gx0; x <= gx1; x += gridStep) gridLines.push({ x1: sX(f, x), y1: PAD, x2: sX(f, x), y2: size.h - PAD });
    for (let y = gy0; y <= gy1; y += gridStep) gridLines.push({ x1: PAD, y1: sY(f, y), x2: size.w - PAD, y2: sY(f, y) });
  }

  const iconBtn = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
  const previewEnd = splitHover ?? cursorWorld;
  // The 2D preview (and bake) show the room at the chosen wall boundary; the
  // editable vertices stay on the centreline (the topology). `center` shows the
  // raw centreline.
  const ext = extractionRef.current;
  // Per-room display outline at the chosen boundary, plus whether the inset
  // actually changed the room. Inner/Outer silently fall back to the centreline
  // when no wall offset applies (no wall ran along the room's edges, or a
  // fully-internal room in Outer mode) — flag those so the toggle doesn't look
  // broken (Issue 6).
  const boundaryInfo = useMemo(
    () =>
      rooms.map((r) => {
        if (boundaryMode === 'center') return { disp: r.outline, unbounded: false };
        // Net/gross outline straight from the engine (per-edge wall thickness);
        // it falls back to the centreline when no wall offset applies, so a
        // no-change result flags the room as unbounded (Issue 6).
        const disp = sessionRef.current?.boundaryOutline(r.face, boundaryMode) ?? r.outline;
        return { disp, unbounded: Math.abs(polyArea(disp) - r.area) < 1e-3 };
      }),
    // `hist` re-derives this after a plate edit (rooms identity also changes then).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rooms, boundaryMode, hist],
  );
  const unboundedCount = boundaryMode === 'center' ? 0 : boundaryInfo.filter((b) => b.unbounded).length;

  // Issue 7 — leak diagnostics: classify each derive wall segment as bounding
  // (its centreline lies along a room edge) vs non-bounding (a stray/leaked wall
  // that enclosed nothing). Purely geometric, so it needs no source provenance.
  const diagnostics = useMemo(() => {
    if (!showDiagnostics || !ext) return null;
    const tol = 0.35; // m — segment midpoint within this of a room edge ⇒ bounding
    return ext.segments.map((s) => {
      const mx = (s.a[0] + s.b[0]) / 2, my = (s.a[1] + s.b[1]) / 2;
      let bounding = false;
      for (const r of rooms) {
        const n = r.outline.length;
        for (let i = 0; i < n && !bounding; i++) {
          const a = r.outline[i], b = r.outline[(i + 1) % n];
          if (distToSeg(mx, my, a[0], a[1], b[0], b[1]) <= tol) bounding = true;
        }
        if (bounding) break;
      }
      return { a: s.a as Pt, b: s.b as Pt, bounding };
    });
  }, [showDiagnostics, ext, rooms]);
  const leakCount = diagnostics ? diagnostics.filter((s) => !s.bounding).length : 0;
  const badCount = rooms.filter((r) => !r.simple).length;

  return (
    <div ref={panelRef} className="absolute left-1/2 top-4 -translate-x-1/2 z-30 rounded-xl border bg-background/95 shadow-xl backdrop-blur p-3 select-none pointer-events-auto"
         style={{ width: size.w + 24 }}>
      {/* Inline unbaked-edits close confirmation (not a native dialog). */}
      {confirmClose && (
        <div className="absolute inset-x-0 top-0 z-40 flex items-center gap-2 rounded-t-xl border-b border-amber-600/40 bg-amber-500 px-3 py-2 text-xs text-amber-950">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1 font-medium">Unbaked edits will be lost.</span>
          <button onClick={() => setConfirmClose(false)} className="rounded px-2 py-1 font-medium hover:bg-black/10">Keep editing</button>
          <button onClick={() => { setConfirmClose(false); setActiveTool('select'); }} className="rounded bg-amber-950 px-2 py-1 font-medium text-amber-50 hover:bg-amber-900">Discard &amp; close</button>
        </div>
      )}

      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Layers className="h-4 w-4 text-muted-foreground" /> Space Sketch
          {dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="Unbaked edits" />}
        </div>
        <div className="flex items-center gap-0.5">
          <button className={`${iconBtn} ${helpOpen ? 'bg-muted text-foreground' : ''}`} aria-pressed={helpOpen}
            onClick={() => { setHelpOpen((v) => !v); setOptionsOpen(false); }} title="How it works"><HelpCircle className="h-4 w-4" /></button>
          <button className={iconBtn} onClick={requestClose} title="Close (double-tap Esc)"><X className="h-4 w-4" /></button>
        </div>
      </div>

      {/* Storey + whole-building */}
      <div className="flex items-center gap-2 mb-2">
        <select className="h-8 flex-1 min-w-0 rounded-md border bg-background px-2 text-xs" value={storeyId ?? ''}
          onChange={(e) => setStoreyId(Number(e.target.value))} disabled={!storeys.length}>
          {storeys.length ? storeys.map((s) => <option key={s.id} value={s.id}>{s.name}</option>) : <option>no model</option>}
        </select>
        <button className="h-8 shrink-0 rounded-md bg-indigo-600 px-3 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          onClick={() => void bakeWholeBuilding()} disabled={!activeModelId}
          title="Create IfcSpace for every storey at once — auto floor-to-floor height, skips rooms that already have a space">Generate all</button>
      </div>

      {/* Action row — modeless, so no mode tabs: history · snap · options · fit,
          with a live room tally. Secondary settings hide behind Options. */}
      <div className="flex items-center gap-1 mb-2">
        <button className={iconBtn} onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)"><Undo2 className="h-4 w-4" /></button>
        <button className={iconBtn} onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)"><Redo2 className="h-4 w-4" /></button>
        <span className="mx-0.5 h-5 w-px bg-border" />
        <button className={`${iconBtn} ${snapToBuilding ? 'bg-primary/10 text-primary hover:bg-primary/15' : ''}`}
          onClick={() => setSnapToBuilding((v) => !v)} aria-pressed={snapToBuilding}
          title={snapToBuilding ? 'Snap to walls + corners: on' : 'Snap to walls + corners: off'}><Magnet className="h-4 w-4" /></button>
        <button className={`${iconBtn} relative ${optionsOpen ? 'bg-muted text-foreground' : ''}`} aria-pressed={optionsOpen}
          onClick={() => { setOptionsOpen((v) => !v); setHelpOpen(false); }} title="Options — boundary, corner tolerance, underlay">
          <SlidersHorizontal className="h-4 w-4" />
          {(boundaryMode !== 'inner' || snapTol != null || showDiagnostics) && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}
        </button>
        <button className={iconBtn} onClick={cleanupOrphans}
          disabled={!rooms.length} title="Clean up — remove orphaned inner walls & redundant nodes (room shapes unchanged)"><Eraser className="h-4 w-4" /></button>
        <button className={iconBtn} onClick={() => applyFit(computeFit(rooms, sizeRef.current.w, sizeRef.current.h))}
          disabled={!rooms.length} title="Fit plan to canvas (reset zoom & pan)"><Maximize className="h-4 w-4" /></button>
        <span className="ml-auto pr-1 text-[11px] tabular-nums text-muted-foreground">
          {rooms.length} {rooms.length === 1 ? 'room' : 'rooms'} · {total.toFixed(1)} m²
        </span>
      </div>

      {/* Click-away backdrop for the disclosure popovers (panel-local). */}
      {(optionsOpen || helpOpen) && (
        <div className="absolute inset-0 z-10" aria-hidden onMouseDown={() => { setOptionsOpen(false); setHelpOpen(false); }} />
      )}

      {/* Disclosure popovers (Options / Help) — kept out of the default flow. */}
      {optionsOpen && (
        <OptionsPopover
          boundaryMode={boundaryMode}
          onBoundaryMode={setBoundaryMode}
          hasWallData={!!ext}
          snapDelta={snapDelta}
          usedTol={usedTol}
          snapDisabled={derivedStorey == null}
          onSnap={rebuildWithSnap}
          snapTol={snapTol}
          showBuilding={showBuilding}
          onToggleBuilding={() => setShowBuilding((v) => !v)}
          showDiagnostics={showDiagnostics}
          onToggleDiagnostics={() => setShowDiagnostics((v) => !v)}
        />
      )}
      {helpOpen && <HelpPopover />}

      <SpaceSketchCanvas
        svgRef={svgRef}
        width={size.w}
        height={size.h}
        cursor={cursor}
        fit={f}
        gridLines={gridLines}
        underlay={underlayEls}
        rooms={rooms}
        boundaryInfo={boundaryInfo}
        boundaryMode={boundaryMode}
        mergeFaces={mergeRooms}
        diagnostics={diagnostics}
        hover={hover}
        splitPick={splitPick}
        previewEnd={previewEnd}
        splitHover={splitHover}
        snapPos={snapPos}
        snapKind={snapKind}
        drawPts={drawPts}
        drawCursor={drawCursor}
        alignGuides={alignGuides}
        deleteHover={deleteHover}
        intent={optionsOpen || helpOpen || confirmClose ? null : intent}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onDoubleClick={() => { if (drawPts.length > 0) commitDraw(); }}
        onContextMenu={onContextMenu}
        onPointerLeave={() => { setHover(null); setSplitHover(null); setDeleteHover(null); setDrawCursor(null); setAlignGuides({ vRef: null, hRef: null }); setIntent(null); }}
      />

      {/* Footer — an in-the-moment hint only while drawing/cutting (the full
          legend lives behind “?”), the live status, then the primary action. */}
      <div className="mt-2.5 space-y-1.5">
        {(drawPts.length > 0 || splitPick) && (
          <div className="text-[11px] leading-tight text-primary">
            {drawPts.length > 0
              ? 'Click corners · Enter / double-click / first dot to close · Shift = straight · Esc cancels.'
              : 'Click another wall or corner to finish the cut · Esc cancels.'}
          </div>
        )}
        {status && drawPts.length === 0 && !splitPick && (
          <div className="truncate text-[11px] leading-tight text-muted-foreground" title={status}>{status}</div>
        )}
        {unboundedCount > 0 && (
          <div className="text-[11px] leading-tight text-amber-600 dark:text-amber-500">
            {unboundedCount} room(s) unchanged by “{boundaryMode}” (dashed) — no wall offset.
          </div>
        )}
        {showDiagnostics && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
            <span className="text-emerald-600 dark:text-emerald-500">▬ bounds a room</span>
            <span className="text-red-500">╌ bounds nothing ({leakCount})</span>
            <span className="text-red-500">▦ failed to close ({badCount})</span>
          </div>
        )}
        <button className="h-9 w-full rounded-md bg-emerald-600 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
          onClick={bake} disabled={derivedStorey == null || !rooms.length}
          title="Write this storey's rooms as IfcSpace — replaces any this tool already dropped here">
          Bake storey to IfcSpace
        </button>
      </div>

      {/* Resize grip (Issue 4) — drag to grow/shrink the canvas; the plan stays
          put (hit ⤢ to reframe). */}
      <div
        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); resizeRef.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { const r = resizeRef.current; if (!r) return; setSize({ w: Math.max(MIN_W, Math.round(r.w + (e.clientX - r.x))), h: Math.max(MIN_H, Math.round(r.h + (e.clientY - r.y))) }); }}
        onPointerUp={(e) => { resizeRef.current = null; (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); }}
        title="Drag to resize the panel"
        className="absolute bottom-1 right-1 h-3.5 w-3.5 cursor-nwse-resize text-muted-foreground/50 hover:text-foreground"
        style={{ touchAction: 'none' }}>
        <svg viewBox="0 0 10 10" className="h-full w-full" pointerEvents="none"><path d="M9 2 L2 9 M9 6 L6 9" stroke="currentColor" strokeWidth={1.2} fill="none" /></svg>
      </div>
    </div>
  );
}
