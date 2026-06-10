/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Space Sketch (DCEL) — interactive test surface for the persistent
 * `SpacePlateHandle` topology editor (rust/geometry `space_dcel`).
 *
 * Self-contained: owns its own wasm handle + local state (no shared slice).
 * Seed from the active storey's walls (or a demo plate), drag a shared vertex
 * (both rooms follow), split a room — between corners OR new nodes added
 * anywhere on a wall — merge two rooms, then Bake to real `IfcSpace` through
 * the viewer's existing `addSpace`.
 *
 * Fluency (RFC §4.2): hover telegraphs the op; dragging snaps to other
 * vertices (Shift = ortho). Undo/redo snapshots the plate via `duplicate()`
 * (each clone owns its heap, freed deterministically — never JS GC). 2D plan
 * sketch; 3D-on-model registration is the next step.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useConstructionUnderlay } from '@/hooks/useConstructionUnderlay';
import { useIfc } from '@/hooks/useIfc';
import init, { SpacePlateHandle } from '@ifc-lite/wasm';
import {
  extractWallSegmentsForStorey,
  offsetRoomFootprint,
  existingSpaceFootprintsByStorey,
  GENERATED_SPACE_OBJECTTYPE,
  type BoundaryMode,
} from '@ifc-lite/create';
import { X, Undo2, Redo2, Building2, Layers } from 'lucide-react';

let wasmReady: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
  if (!wasmReady) wasmReady = init().then(() => undefined);
  return wasmReady;
}

interface Room {
  face: number;
  area: number;
  simple: boolean;
  outline: [number, number][];
}
interface Boundary {
  edge: number;
  source: number | null;
}
type Mode = 'drag' | 'split' | 'merge';
type Pt = [number, number];
type Hover =
  | { kind: 'vertex'; pos: Pt }
  | { kind: 'edge'; edge: number; rooms: number[]; a: Pt; b: Pt }
  | null;
/** A split endpoint the user picked — an existing corner, or a point on a wall
 *  edge (which becomes a new node when the cut is committed). */
type SplitTarget = { kind: 'vertex'; vid: number; pos: Pt } | { kind: 'edge'; edge: number; pos: Pt };

const SVG_W = 580;
const SVG_H = 460;
const PAD = 36;
const PICK_PX = 12;
const SNAP_PX = 10;
const MAX_UNDO = 40;
const BAKE_HEIGHT = 3;
const EPS = 1e-6;

/** Absolute polygon area (shoelace), m². */
function polyArea(pts: Pt[]): number {
  let a = 0;
  for (let k = 0; k < pts.length; k++) { const p = pts[k], q = pts[(k + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2;
}
/** Ray-cast point-in-polygon. */
function pointInPoly(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const centroid = (pts: Pt[]): Pt => {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  return [cx / pts.length, cy / pts.length];
};

interface Fit { scale: number; minX: number; minY: number }

function computeFit(rooms: Room[]): Fit {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rooms) for (const [x, y] of r.outline) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (!isFinite(minX)) return { scale: 1, minX: 0, minY: 0 };
  const scale = Math.min((SVG_W - 2 * PAD) / Math.max(maxX - minX, 1e-6), (SVG_H - 2 * PAD) / Math.max(maxY - minY, 1e-6));
  return { scale, minX, minY };
}

const sX = (f: Fit, x: number) => PAD + (x - f.minX) * f.scale;
const sY = (f: Fit, y: number) => SVG_H - PAD - (y - f.minY) * f.scale;
const wX = (f: Fit, sx: number) => f.minX + (sx - PAD) / f.scale;
const wY = (f: Fit, sy: number) => f.minY + (SVG_H - PAD - sy) / f.scale;

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function projectOnSeg(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dy];
}

function uniqueVerts(rooms: Room[]): Pt[] {
  const seen = new Set<string>();
  const out: Pt[] = [];
  for (const r of rooms) for (const p of r.outline) {
    const k = `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  }
  return out;
}

const ROOM_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#84cc16', '#a855f7', '#ef4444'];

export function SpaceSketchOverlay() {
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const addSpace = useViewerStore((s) => s.addSpace);
  const removeEntity = useViewerStore((s) => s.removeEntity);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const { ifcDataStore } = useIfc();

  const plateRef = useRef<SpacePlateHandle | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<Fit>({ scale: 1, minX: 0, minY: 0 });
  const rafRef = useRef<number | null>(null);
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buildSeqRef = useRef(0);
  // IfcSpace expressIds this session created per storey — so a re-bake (or
  // "Generate all") replaces the spaces it dropped instead of duplicating.
  const generatedRef = useRef<Map<number, number[]>>(new Map());
  const moveRef = useRef<{ x: number; y: number; shift: boolean } | null>(null);

  const dragRef = useRef<number | null>(null);
  const dragStartRef = useRef<Pt | null>(null);
  const otherVertsRef = useRef<Pt[]>([]);
  const pendingUndoRef = useRef<SpacePlateHandle | null>(null);
  const draggedRef = useRef(false);

  const undoRef = useRef<SpacePlateHandle[]>([]);
  const redoRef = useRef<SpacePlateHandle[]>([]);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [mode, setMode] = useState<Mode>('drag');
  const [hover, setHover] = useState<Hover>(null);
  const [splitPick, setSplitPick] = useState<SplitTarget | null>(null);
  const [splitHover, setSplitHover] = useState<Pt | null>(null);
  const [snapPos, setSnapPos] = useState<Pt | null>(null);
  const [derivedStorey, setDerivedStorey] = useState<number | null>(null);
  const [snapTol, setSnapTol] = useState<number | null>(null); // null = auto-escalate
  const [usedTol, setUsedTol] = useState(0.1);
  const snapTolRef = useRef<number | null>(null);
  const lastBuildRef = useRef<{ coords: Float64Array; sources: Int32Array; label: string; storey: number | null } | null>(null);
  // Wall segments + thicknesses from the last derive, kept for net-footprint
  // inset at bake (so the IfcSpace solid stops at the inner wall face).
  const extractionRef = useRef<{
    segments: Parameters<typeof offsetRoomFootprint>[1];
    thicknesses: Parameters<typeof offsetRoomFootprint>[2];
  } | null>(null);
  const [hist, setHist] = useState(0);
  const [status, setStatus] = useState('Load the demo plate or derive from a storey.');
  const [showBuilding, setShowBuilding] = useState(true);
  const [boundaryMode, setBoundaryMode] = useState<BoundaryMode>('inner');

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
  const { lines: underlay } = useConstructionUnderlay(showBuilding && rooms.length > 0, derivedFloorElev);

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
  }, [underlay, showBuilding, hist]);
  const [storeyId, setStoreyId] = useState<number | null>(null);
  const lastDerivedRef = useRef<number | null>(null);
  useEffect(() => {
    if (storeyId == null && storeys.length) setStoreyId(storeys[0].id);
  }, [storeys, storeyId]);

  // Click anywhere outside the panel closes the tool. Esc closes too.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setActiveTool('select');
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActiveTool('select'); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [setActiveTool]);

  const refreshRooms = useCallback(() => {
    const plate = plateRef.current;
    if (plate) setRooms(plate.snapshot() as Room[]);
  }, []);

  const freeHistory = useCallback(() => {
    undoRef.current.forEach((h) => h.free());
    redoRef.current.forEach((h) => h.free());
    undoRef.current = [];
    redoRef.current = [];
    pendingUndoRef.current?.free();
    pendingUndoRef.current = null;
  }, []);

  const commitUndo = useCallback((snap: SpacePlateHandle) => {
    undoRef.current.push(snap);
    if (undoRef.current.length > MAX_UNDO) undoRef.current.shift()!.free();
    redoRef.current.forEach((h) => h.free());
    redoRef.current = [];
    setHist((v) => v + 1);
  }, []);

  const resetInteraction = useCallback(() => {
    setHover(null); setSplitPick(null); setSplitHover(null); setSnapPos(null);
    dragRef.current = null; dragStartRef.current = null;
    pendingUndoRef.current?.free(); pendingUndoRef.current = null;
  }, []);

  const undo = useCallback(() => {
    const plate = plateRef.current;
    if (!plate || !undoRef.current.length) return;
    redoRef.current.push(plate);
    plateRef.current = undoRef.current.pop()!;
    resetInteraction(); refreshRooms(); setHist((v) => v + 1);
    setStatus('Undo.');
  }, [resetInteraction, refreshRooms]);

  const redo = useCallback(() => {
    const plate = plateRef.current;
    if (!plate || !redoRef.current.length) return;
    undoRef.current.push(plate);
    plateRef.current = redoRef.current.pop()!;
    resetInteraction(); refreshRooms(); setHist((v) => v + 1);
    setStatus('Redo.');
  }, [resetInteraction, refreshRooms]);

  const buildFrom = useCallback(async (coords: Float64Array, sources: Int32Array, label: string, storey: number | null) => {
    // Re-entrancy guard: a rapid rebuild (snap slider) must not let an older
    // async build free/replace the plate a newer one is using — that races the
    // shared wasm heap. Only the latest build applies; superseded ones bail.
    const seq = ++buildSeqRef.current;
    try {
      await ensureWasm();
      if (seq !== buildSeqRef.current) return;
      plateRef.current?.free();
      freeHistory();
      // Real wall centrelines don't meet exactly at corners — they're offset
      // by ~half the wall thickness. A tight snap leaves the loop open (0
      // rooms). Auto-escalate: take the first tolerance that encloses rooms,
      // else the largest tried (least surprising than silently finding none).
      lastBuildRef.current = { coords, sources, label, storey };
      const manual = snapTolRef.current;
      let plate: SpacePlateHandle | null = null;
      let used = 0.1;
      if (manual != null) {
        plate = new SpacePlateHandle(coords, sources, manual, 0.5);
        used = manual;
      } else {
        for (const tol of [0.1, 0.25, 0.5]) {
          const p = new SpacePlateHandle(coords, sources, tol, 0.5);
          plate?.free();
          plate = p;
          used = tol;
          if (p.roomCount > 0) break;
        }
      }
      if (seq !== buildSeqRef.current) { plate?.free(); return; }
      plateRef.current = plate!;
      setUsedTol(used);
      const snap = plate!.snapshot() as Room[];
      fitRef.current = computeFit(snap);
      resetInteraction();
      setDerivedStorey(storey);
      setRooms(snap); setHist((v) => v + 1);
      const total = snap.reduce((s, r) => s + r.area, 0);
      setStatus(`${label}: ${snap.length} room(s), ${total.toFixed(1)} m² · snap ${used}m${manual == null ? ' (auto)' : ''}.`);
    } catch (e) {
      setStatus(`Build failed: ${String(e)}`);
    }
  }, [freeHistory, resetInteraction]);

  // Manual snap override (null → back to auto-escalate). Rebuilds the current
  // plate from its source segments at the chosen tolerance.
  const rebuildWithSnap = useCallback((tol: number | null) => {
    snapTolRef.current = tol;
    setSnapTol(tol);
    if (tol != null) setUsedTol(tol); // move the slider thumb/label immediately
    // Debounce the actual rebuild: the range input fires onChange on every
    // tick, and buildFrom is async + frees/creates wasm handles — rebuilding
    // per tick raced the shared heap and froze the editor. Rebuild once the
    // slider settles.
    if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    rebuildTimerRef.current = setTimeout(() => {
      rebuildTimerRef.current = null;
      const lb = lastBuildRef.current;
      if (lb) void buildFrom(lb.coords, lb.sources, lb.label, lb.storey);
    }, 180);
  }, [buildFrom]);

  const deriveFromStorey = useCallback(async () => {
    if (!ifcDataStore || storeyId == null) { setStatus('No model / storey to derive from.'); return; }
    try {
      const { segments, considered, skipped, wallThicknesses } = extractWallSegmentsForStorey(ifcDataStore, storeyId);
      if (!segments.length) {
        setStatus(`No wall axes on storey ${storeyId} (${considered} walls, ${skipped.length} skipped).`);
        return;
      }
      extractionRef.current = { segments, thicknesses: wallThicknesses };
      const coords = new Float64Array(segments.length * 4);
      const sources = new Int32Array(segments.length).fill(-1);
      segments.forEach((s, i) => {
        coords[i * 4] = s.a[0]; coords[i * 4 + 1] = s.a[1];
        coords[i * 4 + 2] = s.b[0]; coords[i * 4 + 3] = s.b[1];
      });
      const name = ifcDataStore.entities.getName(storeyId) || `Storey #${storeyId}`;
      await buildFrom(coords, sources, name, storeyId);
    } catch (e) {
      setStatus(`Derive failed: ${String(e)}`);
    }
  }, [ifcDataStore, storeyId, buildFrom]);

  // Auto-detect: derive rooms the moment a storey is chosen (and on open, when
  // the first storey auto-selects) so the user doesn't have to click Derive.
  // Guarded so it fires once per storey, and never clobbers a loaded demo.
  useEffect(() => {
    if (storeyId != null && ifcDataStore && lastDerivedRef.current !== storeyId) {
      lastDerivedRef.current = storeyId;
      void deriveFromStorey();
    }
  }, [storeyId, ifcDataStore, deriveFromStorey]);

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
    outlines: Pt[][],
    segments: Parameters<typeof offsetRoomFootprint>[1] | undefined,
    thicknesses: Parameters<typeof offsetRoomFootprint>[2] | undefined,
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
    for (let oi = 0; oi < outlines.length; oi++) {
      const outline = outlines[oi];
      const [cx, cy] = centroid(outline);
      if (authored.some((fp) => pointInPoly(cx, cy, fp))) { skipped++; continue; }
      const others = outlines.filter((_, j) => j !== oi);
      const inset = segments && thicknesses ? offsetRoomFootprint(outline, segments, thicknesses, boundaryMode, others) : outline;
      const res = addSpace(activeModelId, sid, {
        Profile: 'polygon', OuterCurve: inset, Height: height,
        Name: `Space ${newIds.length + 1}`, ObjectType: GENERATED_SPACE_OBJECTTYPE,
        grossFloorArea: polyArea(outline),
      });
      if (res && 'expressId' in res) newIds.push(res.expressId);
      else error ??= (res && 'error' in res ? res.error : 'unknown error');
    }
    generatedRef.current.set(sid, newIds);
    return { emitted: newIds.length, skipped, error };
  }, [activeModelId, removeEntity, addSpace, floorToFloor, boundaryMode]);

  const bake = useCallback(() => {
    const plate = plateRef.current;
    if (!plate || !activeModelId || derivedStorey == null || !ifcDataStore) {
      setStatus('Derive a storey first.');
      return;
    }
    const outlines = (plate.snapshot() as Room[]).map((r) => r.outline);
    const ext = extractionRef.current;
    const authored = existingSpaceFootprintsByStorey(ifcDataStore).get(derivedStorey) ?? [];
    const { emitted, skipped, error } = bakeStorey(derivedStorey, outlines, ext?.segments, ext?.thicknesses, authored);
    if (emitted > 0) revealSpaces();
    setStatus(error
      ? `Baked ${emitted} IfcSpace — others failed: ${error}`
      : `Baked ${emitted} IfcSpace${skipped ? `, skipped ${skipped} (already a space)` : ''}.`);
  }, [activeModelId, derivedStorey, ifcDataStore, bakeStorey, revealSpaces]);

  const bakeWholeBuilding = useCallback(async () => {
    if (!activeModelId || !ifcDataStore) { setStatus('No model loaded.'); return; }
    setStatus('Generating spaces for every storey…');
    await ensureWasm();
    const authoredMap = existingSpaceFootprintsByStorey(ifcDataStore);
    let totalEmitted = 0, totalSkipped = 0, floors = 0;
    let firstError: string | null = null;
    for (const st of storeys) {
      const { segments, wallThicknesses } = extractWallSegmentsForStorey(ifcDataStore, st.id);
      if (!segments.length) continue;
      const coords = new Float64Array(segments.length * 4);
      const sources = new Int32Array(segments.length).fill(-1);
      segments.forEach((s, i) => { coords[i * 4] = s.a[0]; coords[i * 4 + 1] = s.a[1]; coords[i * 4 + 2] = s.b[0]; coords[i * 4 + 3] = s.b[1]; });
      let plate: SpacePlateHandle | null = null;
      for (const tol of [0.1, 0.25, 0.5]) {
        const p = new SpacePlateHandle(coords, sources, tol, 0.5);
        plate?.free();
        plate = p;
        if (p.roomCount > 0) break;
      }
      const outlines = (plate!.snapshot() as Room[]).map((r) => r.outline);
      plate!.free();
      if (!outlines.length) continue;
      const { emitted, skipped, error } = bakeStorey(st.id, outlines, segments, wallThicknesses, authoredMap.get(st.id) ?? []);
      totalEmitted += emitted; totalSkipped += skipped;
      firstError ??= error;
      if (emitted) floors++;
    }
    if (totalEmitted > 0) revealSpaces();
    setStatus(firstError
      ? `Generated ${totalEmitted} IfcSpace — others failed: ${firstError}`
      : `Generated ${totalEmitted} IfcSpace across ${floors} storey(s)${totalSkipped ? `; skipped ${totalSkipped} existing` : ''}.`);
  }, [activeModelId, ifcDataStore, storeys, bakeStorey, revealSpaces]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
    freeHistory();
    plateRef.current?.free();
    plateRef.current = null;
  }, [freeHistory]);

  const svgPoint = (e: React.PointerEvent): Pt => {
    const rect = svgRef.current!.getBoundingClientRect();
    // Clamp to the canvas: during a drag the pointer is captured, so moving it
    // past the panel (e.g. dragging a vertex down off the bottom) would report
    // coordinates far outside the SVG → a huge off-screen world position. That
    // pushed the room off-canvas ("disappears") and made the SVG rasterise a
    // polygon spanning to extreme coordinates, freezing the browser.
    return [
      Math.max(0, Math.min(SVG_W, e.clientX - rect.left)),
      Math.max(0, Math.min(SVG_H, e.clientY - rect.top)),
    ];
  };

  const pickVertex = useCallback((wx: number, wy: number): number | null => {
    const plate = plateRef.current;
    if (!plate) return null;
    const v = plate.findVertexNear(wx, wy, PICK_PX / fitRef.current.scale);
    return v === undefined ? null : v;
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
    const plate = plateRef.current;
    if (!plate) return null;
    const tol = PICK_PX / fitRef.current.scale;
    let best: { face: number; edge: number; a: Pt; b: Pt; d: number } | null = null;
    for (const r of rooms) {
      const bounds = plate.boundingElements(r.face) as Boundary[];
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
    const plate = plateRef.current;
    if (!plate) return;
    if (first.kind === 'edge' && second.kind === 'edge' && first.edge === second.edge) {
      setStatus('Pick points on two different edges (or corners).'); return;
    }
    const snapshot = plate.duplicate();
    try {
      const va = first.kind === 'vertex' ? first.vid : plate.splitEdge(first.edge, first.pos[0], first.pos[1]);
      const vb = second.kind === 'vertex' ? second.vid : plate.splitEdge(second.edge, second.pos[0], second.pos[1]);
      if (va === vb) throw new Error('DegenerateCut: same point');
      const fresh = plate.snapshot() as Room[];
      const onBoundary = (r: Room, p: Pt) => r.outline.some((q) => Math.abs(q[0] - p[0]) < EPS && Math.abs(q[1] - p[1]) < EPS);
      const room = fresh.find((r) => onBoundary(r, first.pos) && onBoundary(r, second.pos));
      if (!room) throw new Error('points are not on the same room');
      plate.splitFace(room.face, va, vb, -1);
    } catch (err) {
      plate.free();
      plateRef.current = snapshot; // roll back inserted nodes + partial cut
      refreshRooms();
      setStatus(`Split rejected: ${String(err).replace(/^Error:\s*/, '')}`);
      return;
    }
    commitUndo(snapshot);
    refreshRooms();
    setStatus(`Split — ${plate.roomCount} room(s).`);
  }, [commitUndo, refreshRooms]);

  const processMove = useCallback(() => {
    rafRef.current = null;
    const m = moveRef.current;
    const plate = plateRef.current;
    if (!m || !plate) return;
    const wx = wX(fitRef.current, m.x), wy = wY(fitRef.current, m.y);

    const vid = dragRef.current;
    if (vid != null) {
      draggedRef.current = true;
      let tx = wx, ty = wy;
      if (m.shift && dragStartRef.current) {
        const [ox, oy] = dragStartRef.current;
        if (Math.abs(wx - ox) >= Math.abs(wy - oy)) ty = oy; else tx = ox;
      }
      const tol = SNAP_PX / fitRef.current.scale;
      let snapped: Pt | null = null, bestD = tol;
      for (const p of otherVertsRef.current) {
        const d = Math.hypot(p[0] - tx, p[1] - ty);
        if (d < bestD) { bestD = d; snapped = p; }
      }
      if (snapped) { tx = snapped[0]; ty = snapped[1]; }
      setSnapPos(snapped);
      try {
        plate.dragVertex(vid, tx, ty);
        refreshRooms();
      } catch (e) {
        console.debug('[space-sketch] dragVertex failed (plate torn down mid-drag?)', e);
      }
      return;
    }

    if (mode === 'merge') {
      const e = pickEdge(wx, wy);
      if (e) {
        const nbr = plate.neighborAcross(e.edge);
        setHover({ kind: 'edge', edge: e.edge, rooms: [e.face, ...(nbr !== undefined ? [nbr] : [])], a: e.a, b: e.b });
      } else setHover(null);
    } else if (mode === 'split') {
      const t = resolveSplitTarget(wx, wy);
      setSplitHover(t ? t.pos : null);
      setHover(t && t.kind === 'vertex' ? { kind: 'vertex', pos: t.pos } : null);
    } else {
      const v = pickVertex(wx, wy);
      const pos = v != null ? nearestVertPos(wx, wy) : null;
      setHover(v != null && pos ? { kind: 'vertex', pos } : null);
    }
  }, [mode, pickEdge, pickVertex, nearestVertPos, resolveSplitTarget, refreshRooms]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const [x, y] = svgPoint(e);
    moveRef.current = { x, y, shift: e.shiftKey };
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(processMove);
  }, [processMove]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const plate = plateRef.current;
    if (!plate) return;
    const [sx, sy] = svgPoint(e);
    const wx = wX(fitRef.current, sx), wy = wY(fitRef.current, sy);

    if (mode === 'drag') {
      const v = pickVertex(wx, wy);
      if (v == null) return;
      const start = nearestVertPos(wx, wy);
      dragRef.current = v;
      dragStartRef.current = start;
      draggedRef.current = false;
      pendingUndoRef.current = plate.duplicate();
      otherVertsRef.current = start
        ? uniqueVerts(rooms).filter((p) => Math.hypot(p[0] - start[0], p[1] - start[1]) > 1e-6)
        : uniqueVerts(rooms);
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (mode === 'merge') {
      const hit = pickEdge(wx, wy);
      if (!hit) { setStatus('No edge under cursor.'); return; }
      const snap = plate.duplicate();
      try {
        plate.mergeFaces(hit.edge);
        commitUndo(snap); refreshRooms(); setHover(null);
        setStatus(`Merged across wall — ${plate.roomCount} room(s) left.`);
      } catch (err) {
        // Roll back to the pre-merge snapshot (mirror performSplit) in case
        // mergeFaces mutated before throwing.
        plate.free();
        plateRef.current = snap;
        refreshRooms();
        setStatus(`Merge rejected: ${String(err).replace(/^Error:\s*/, '')}`);
      }
      return;
    }
    if (mode === 'split') {
      const target = resolveSplitTarget(wx, wy);
      if (!target) { setStatus('Click a corner or anywhere on a wall.'); return; }
      if (!splitPick) { setSplitPick(target); setStatus('Pick the second point (corner or wall) on the same room.'); return; }
      const first = splitPick;
      setSplitPick(null);
      performSplit(first, target);
    }
  }, [mode, pickVertex, nearestVertPos, pickEdge, rooms, splitPick, resolveSplitTarget, performSplit, commitUndo, refreshRooms]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (dragRef.current == null) return;
    dragRef.current = null; dragStartRef.current = null; setSnapPos(null);
    svgRef.current?.releasePointerCapture(e.pointerId);
    if (draggedRef.current && pendingUndoRef.current) commitUndo(pendingUndoRef.current);
    else pendingUndoRef.current?.free();
    pendingUndoRef.current = null;
    const total = rooms.reduce((s, r) => s + r.area, 0);
    if (draggedRef.current) setStatus(`Drag done — ${rooms.length} room(s), ${total.toFixed(1)} m² (conserved).`);
  }, [rooms, commitUndo]);

  const f = fitRef.current;
  const total = rooms.reduce((s, r) => s + r.area, 0);
  const mergeRooms = hover?.kind === 'edge' ? new Set(hover.rooms) : null;
  const cursorWorld = moveRef.current ? [wX(f, moveRef.current.x), wY(f, moveRef.current.y)] as Pt : null;
  const cursor = dragRef.current != null ? 'grabbing' : (mode === 'drag' && hover?.kind === 'vertex') ? 'grab' : 'crosshair';
  const canUndo = undoRef.current.length > 0;
  const canRedo = redoRef.current.length > 0;
  void hist;

  const gridStep = f.scale > 14 ? 1 : f.scale > 5 ? 2 : 5;
  const gridLines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  if (rooms.length) {
    const gx0 = Math.floor(wX(f, PAD) / gridStep) * gridStep;
    const gx1 = Math.ceil(wX(f, SVG_W - PAD) / gridStep) * gridStep;
    const gy0 = Math.floor(wY(f, SVG_H - PAD) / gridStep) * gridStep;
    const gy1 = Math.ceil(wY(f, PAD) / gridStep) * gridStep;
    for (let x = gx0; x <= gx1; x += gridStep) gridLines.push({ x1: sX(f, x), y1: PAD, x2: sX(f, x), y2: SVG_H - PAD });
    for (let y = gy0; y <= gy1; y += gridStep) gridLines.push({ x1: PAD, y1: sY(f, y), x2: SVG_W - PAD, y2: sY(f, y) });
  }

  const iconBtn = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
  const previewEnd = splitHover ?? cursorWorld;
  // The 2D preview (and bake) show the room at the chosen wall boundary; the
  // editable vertices stay on the centreline (the topology). `center` shows the
  // raw centreline.
  const ext = extractionRef.current;
  const displayOutline = (outline: Pt[], others: Pt[][]): Pt[] =>
    boundaryMode === 'center' || !ext ? outline : offsetRoomFootprint(outline, ext.segments, ext.thicknesses, boundaryMode, others);

  return (
    <div ref={panelRef} className="absolute left-1/2 top-4 -translate-x-1/2 z-30 rounded-xl border bg-background/95 shadow-xl backdrop-blur p-3 select-none pointer-events-auto"
         style={{ width: SVG_W + 24 }}>
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Layers className="h-4 w-4 text-muted-foreground" /> Space Sketch
        </div>
        <button className={iconBtn} onClick={() => setActiveTool('select')} title="Close (Esc)"><X className="h-4 w-4" /></button>
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

      {/* Edit: mode + history */}
      <div className="flex items-center gap-1.5 mb-2">
        <div className="inline-flex rounded-md border p-0.5">
          {(['drag', 'split', 'merge'] as Mode[]).map((m) => (
            <button key={m}
              className={`rounded px-2 py-0.5 text-xs capitalize transition-colors ${mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => { setMode(m); setSplitPick(null); setSplitHover(null); setHover(null); }}
              disabled={!rooms.length}>{m}</button>
          ))}
        </div>
        <button className={iconBtn} onClick={undo} disabled={!canUndo} title="Undo"><Undo2 className="h-4 w-4" /></button>
        <button className={iconBtn} onClick={redo} disabled={!canRedo} title="Redo"><Redo2 className="h-4 w-4" /></button>
        <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground"
          title="Corner-closing tolerance — larger closes bigger gaps but can over-merge">
          <span>snap</span>
          <input type="range" min={0.05} max={1} step={0.05} value={usedTol} className="w-20 accent-primary"
            disabled={derivedStorey == null} onChange={(e) => rebuildWithSnap(Number(e.target.value))} />
          <button className="tabular-nums hover:text-foreground" onClick={() => rebuildWithSnap(null)}
            title="Reset to automatic snap">{usedTol.toFixed(2)}m{snapTol == null ? '·a' : ''}</button>
        </div>
      </div>

      {/* View: boundary relative to walls + building underlay */}
      <div className="flex items-center gap-2 mb-2 text-[11px] text-muted-foreground">
        <span title="Where the space boundary sits relative to its walls — drives the 2D preview and the bake">Boundary</span>
        <div className="inline-flex rounded-md border p-0.5">
          {(['center', 'inner', 'outer'] as BoundaryMode[]).map((m) => (
            <button key={m}
              className={`rounded px-2 py-0.5 capitalize transition-colors ${boundaryMode === m ? 'bg-primary text-primary-foreground' : 'hover:text-foreground'}`}
              onClick={() => setBoundaryMode(m)}
              title={m === 'center' ? 'Wall centreline' : m === 'inner' ? 'Inner (net) face' : 'Outer (gross) face'}>{m}</button>
          ))}
        </div>
        <button className={`${iconBtn} ml-auto ${showBuilding ? 'bg-primary/10 text-primary hover:bg-primary/15' : ''}`}
          onClick={() => setShowBuilding((v) => !v)}
          title="Show surrounding building elements (plan cut ~1.2 m above the floor)"><Building2 className="h-4 w-4" /></button>
      </div>

      <svg ref={svgRef} width={SVG_W} height={SVG_H} style={{ cursor }}
        className="rounded border bg-muted/20 touch-none"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag}
        onPointerLeave={() => { setHover(null); setSplitHover(null); }}>
        {gridLines.map((l, i) => <line key={`g${i}`} {...l} stroke="currentColor" strokeOpacity={0.06} strokeWidth={1} />)}

        {/* Building-element underlay (plan cut ~1.2 m above the storey) for orientation. */}
        {underlayEls}

        {rooms.map((r, ri) => {
          const color = ROOM_COLORS[ri % ROOM_COLORS.length];
          const disp = displayOutline(r.outline, rooms.filter((_, j) => j !== ri).map((x) => x.outline));
          const pts = disp.map((p) => `${sX(f, p[0])},${sY(f, p[1])}`).join(' ');
          const [cwx, cwy] = centroid(disp);
          const cx = sX(f, cwx), cy = sY(f, cwy);
          const lit = mergeRooms?.has(r.face);
          const bad = !r.simple;
          const area = boundaryMode === 'center' ? r.area : polyArea(disp);
          return (
            <g key={r.face}>
              {boundaryMode !== 'center' && (
                <polygon points={r.outline.map((p) => `${sX(f, p[0])},${sY(f, p[1])}`).join(' ')}
                  fill="none" stroke={color} strokeOpacity={0.25} strokeDasharray="3 3" strokeWidth={1} />
              )}
              <polygon points={pts} fill={bad ? '#ef4444' : color} fillOpacity={lit ? 0.42 : bad ? 0.3 : 0.16}
                stroke={bad ? '#ef4444' : color} strokeWidth={lit ? 3 : 2} />
              <text x={cx} y={cy - 5} textAnchor="middle" fontSize={12} fontWeight={600} fill="currentColor" className="pointer-events-none">{area.toFixed(2)}</text>
              <text x={cx} y={cy + 9} textAnchor="middle" fontSize={9} fill="currentColor" opacity={0.55} className="pointer-events-none">m²</text>
            </g>
          );
        })}

        {hover?.kind === 'edge' && (
          <line x1={sX(f, hover.a[0])} y1={sY(f, hover.a[1])} x2={sX(f, hover.b[0])} y2={sY(f, hover.b[1])} stroke="#ef4444" strokeWidth={4} strokeLinecap="round" />
        )}
        {splitPick && previewEnd && (
          <line x1={sX(f, splitPick.pos[0])} y1={sY(f, splitPick.pos[1])} x2={sX(f, previewEnd[0])} y2={sY(f, previewEnd[1])}
            stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="5 4" />
        )}
        {/* split candidate node (corner or new node on a wall) */}
        {mode === 'split' && splitHover && (
          <circle cx={sX(f, splitHover[0])} cy={sY(f, splitHover[1])} r={5} fill="#3b82f6" fillOpacity={0.5} stroke="#3b82f6" strokeWidth={1.5} pointerEvents="none" />
        )}
        {/* first committed split pick */}
        {splitPick && (
          <circle cx={sX(f, splitPick.pos[0])} cy={sY(f, splitPick.pos[1])} r={5} fill="#3b82f6" stroke="#fff" strokeWidth={1.5} pointerEvents="none" />
        )}
        {snapPos && (
          <g pointerEvents="none">
            <circle cx={sX(f, snapPos[0])} cy={sY(f, snapPos[1])} r={9} fill="none" stroke="#22c55e" strokeWidth={1.5} />
            <circle cx={sX(f, snapPos[0])} cy={sY(f, snapPos[1])} r={2.5} fill="#22c55e" />
          </g>
        )}

        {uniqueVerts(rooms).map((p, i) => {
          const isHover = hover?.kind === 'vertex' && Math.abs(hover.pos[0] - p[0]) < EPS && Math.abs(hover.pos[1] - p[1]) < EPS;
          return (
            <circle key={i} cx={sX(f, p[0])} cy={sY(f, p[1])} r={isHover ? 6 : 4}
              fill={isHover ? '#fbbf24' : '#fff'} stroke="#334155" strokeWidth={1.5} pointerEvents="none" />
          );
        })}
      </svg>

      <div className="mt-2.5 flex items-center gap-2">
        <button className="h-8 shrink-0 rounded-md bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
          onClick={bake} disabled={derivedStorey == null || !rooms.length}
          title="Write this storey's rooms as IfcSpace — replaces any this tool already dropped here">Bake storey</button>
        <div className="min-w-0 flex-1 text-right text-xs text-muted-foreground leading-tight">
          <div>{rooms.length} room(s) · {total.toFixed(1)} m²</div>
          {status && <div className="truncate">{status}</div>}
        </div>
      </div>
      <div className="mt-1.5 text-[11px] text-muted-foreground">
        {!rooms.length && 'Pick a storey to derive its rooms, or “Generate all” for the whole building.'}
        {!!rooms.length && mode === 'drag' && 'Drag a vertex — shared vertices move both rooms; snaps to others, Shift = ortho.'}
        {!!rooms.length && mode === 'split' && 'Click two points — corners or anywhere on a wall (new nodes added as needed).'}
        {!!rooms.length && mode === 'merge' && 'Hover highlights the wall + both rooms; click to merge them.'}
      </div>
    </div>
  );
}
