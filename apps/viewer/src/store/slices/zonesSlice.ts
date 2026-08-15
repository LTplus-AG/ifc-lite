/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Location zones (issue #1810 v1): user-defined oriented boxes ("Sections",
 * "Takt areas", ...) that elements get classified into. This slice owns the
 * zone-set CRUD + the last-computed per-element assignment cache; the actual
 * classification math lives in `lib/zones` (pure, unit-tested) and the
 * orchestration that gathers world-space element bounds across every
 * federated model and calls it lives in `useZoneAssignmentSync` (mirrors how
 * `useClash` owns clash's gather-and-run step while `clashSlice` only holds
 * state).
 *
 * Zone sets auto-persist to localStorage (survives a reload) in addition to
 * the explicit JSON export/import path (survives moving to another machine
 * or sharing with a teammate) — same two-tier persistence as clash presets.
 */

import type { StateCreator } from 'zustand';
import type { Zone, ZoneSet, ZoneAssignmentsByElement } from '../../lib/zones/types.js';
import type { ZoneApportionmentEntry } from '../../lib/zones/apportionment-cache.js';
import { serializeZoneSets, parseZoneSetFile } from '../../lib/zones/persistence.js';
import { isConvexFootprint, normalizePrismBounds } from '../../lib/zones/prism.js';

const ZONE_SETS_STORAGE_KEY = 'ifc-lite:zone-sets';

function loadPersistedZoneSets(): ZoneSet[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(ZONE_SETS_STORAGE_KEY);
    if (!raw) return [];
    const result = parseZoneSetFile(JSON.parse(raw));
    return result.ok ? result.zoneSets : [];
  } catch (error) {
    console.warn('[zones] failed to load persisted zone sets', error);
    return [];
  }
}

function savePersistedZoneSets(zoneSets: ZoneSet[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ZONE_SETS_STORAGE_KEY, JSON.stringify(serializeZoneSets(zoneSets)));
  } catch (error) {
    // Quota exceeded / private mode — best effort; the explicit JSON export
    // is the durable path for anyone who needs guarantees.
    console.warn('[zones] failed to persist zone sets to localStorage', error);
  }
}

/** Diagnostics from the last `setZoneAssignments` call — surfaced in the
 *  zones panel so the "off the interaction path" quality bar is visible,
 *  not just asserted. */
export interface ZoneAssignmentTiming {
  elapsedMs: number;
  elementCount: number;
  zoneSetCount: number;
  computedAt: number;
}

export interface ZonesSlice {
  zoneSets: ZoneSet[];
  /** Last computed classification, keyed by federated global id ->
   *  (zoneSetId -> assignment). Recomputed by `useZoneAssignmentSync`
   *  whenever the loaded models or the zone sets change. */
  zoneAssignments: ZoneAssignmentsByElement;
  zoneAssignmentTiming: ZoneAssignmentTiming | null;
  /**
   * Per-zone-set VOLUME apportionment (issue #2508), keyed by zone-set id.
   *
   * Written only by an explicit user action (`useZoneApportionment`), never by
   * model load — clipping is memory-bandwidth bound, so the win is doing less
   * of it. Each entry carries the `zoneSetRevision` it was computed against and
   * readers MUST go through `validEntry`, which drops it when the zones have
   * moved since. That is why no zone mutator below touches this map: a check on
   * read cannot be forgotten the way a clear on write can.
   */
  zoneApportionment: Map<string, ZoneApportionmentEntry>;
  /** Which single zone is currently being interactively edited (move/resize/
   *  rotate gizmo). Non-null gates the 3D handles on AND stops the zone
   *  overlay from being pass-through for picking, so it must be cleared on
   *  tool switch / Escape / commit. */
  editingZone: { setId: string; zoneId: string } | null;

  createZoneSet: (name: string) => string;
  removeZoneSet: (setId: string) => void;
  renameZoneSet: (setId: string, name: string) => void;
  setZoneSetVisible: (setId: string, visible: boolean) => void;
  /** Replace every zone in a set at once (e.g. "generate from storeys"). */
  replaceZonesInSet: (setId: string, zones: Zone[]) => void;
  /** Any field omitted from `zone` falls back to a sane default (a 5x3x5m
   *  unrotated box at the world origin), so a UI "+ Add zone" button can call
   *  this with just `{ name }` and let the user reposition afterwards. */
  addZone: (setId: string, zone?: Partial<Omit<Zone, 'id'>>) => string | null;
  updateZone: (setId: string, zoneId: string, patch: Partial<Omit<Zone, 'id'>>) => void;
  removeZone: (setId: string, zoneId: string) => void;
  setEditingZone: (target: { setId: string; zoneId: string } | null) => void;
  /** Written by `useZoneAssignmentSync` after it gathers element bounds and
   *  runs the (pure) assignment engine. Not meant to be called with
   *  hand-computed data from a UI component. */
  setZoneAssignments: (assignments: ZoneAssignmentsByElement, timing: ZoneAssignmentTiming) => void;
  /** Store one zone set's apportionment results. Replaces any previous entry
   *  for that set outright — a stale-revision entry must not survive a
   *  recompute by being merged into the new one. */
  setZoneApportionment: (setId: string, entry: ZoneApportionmentEntry) => void;
  exportZoneSetsJSON: () => string;
  importZoneSetsJSON: (json: string) => { ok: true } | { ok: false; error: string };
  clearAllZoneSets: () => void;
}

/**
 * Drop apportionment entries whose zone set no longer exists.
 *
 * The revision check on read cannot do this job: `validEntry` is only ever
 * asked about a set that is still in `zoneSets`, so an entry for a set that was
 * deleted or replaced by an import is never read again and never freed — it
 * holds one `Map` per apportioned element for the rest of the session. Returns
 * the SAME map when nothing is orphaned, so the common path allocates nothing
 * and downstream subscribers do not re-render.
 */
function pruneApportionment(
  cache: Map<string, ZoneApportionmentEntry>,
  zoneSets: readonly ZoneSet[],
): Map<string, ZoneApportionmentEntry> {
  if (cache.size === 0) return cache;
  const live = new Set(zoneSets.map((zs) => zs.id));
  let orphaned = false;
  for (const id of cache.keys()) {
    if (!live.has(id)) { orphaned = true; break; }
  }
  if (!orphaned) return cache;
  return new Map([...cache].filter(([id]) => live.has(id)));
}

const DEFAULT_ZONE: Omit<Zone, 'id'> = {
  name: 'New zone',
  center: [0, 0, 0],
  size: [5, 3, 5],
  rotationY: 0,
};

/**
 * The one door every zone goes through on its way INTO the store.
 *
 * A prism zone (#2508 item 4) carries two things the rest of the app relies on
 * and cannot check for itself: its footprint is CONVEX (the sweep, the point
 * test and the overlap test are each silently wrong otherwise), and its
 * `center` / `size` in X/Z are that footprint's bounding box (every bounds
 * consumer reads them). `parseZoneSetFile` enforces both for the import path;
 * these three mutators are the other way in, and a caller reaching them with a
 * hand-built footprint would otherwise install a zone that misreports volumes.
 * A non-convex footprint is dropped rather than kept, leaving a plain box: a
 * zone that is visibly the wrong shape beats one that quietly answers wrong.
 */
function acceptZone(zone: Zone): Zone {
  if (!zone.footprint) return zone;
  if (!isConvexFootprint(zone.footprint)) {
    const { footprint: _dropped, ...box } = zone;
    console.warn('[zones] ignoring a non-convex footprint; the zone stays a box', zone.id);
    return box;
  }
  return normalizePrismBounds(zone);
}

export const createZonesSlice: StateCreator<ZonesSlice, [], [], ZonesSlice> = (set, get) => ({
  zoneSets: loadPersistedZoneSets(),
  zoneAssignments: new Map(),
  zoneAssignmentTiming: null,
  zoneApportionment: new Map(),
  editingZone: null,

  createZoneSet: (name) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const zoneSet: ZoneSet = { id, name: name.trim() || 'Untitled set', zones: [], visible: true, createdAt: now, updatedAt: now };
    set((state) => {
      const zoneSets = [...state.zoneSets, zoneSet];
      savePersistedZoneSets(zoneSets);
      return { zoneSets };
    });
    return id;
  },

  removeZoneSet: (setId) => set((state) => {
    const zoneSets = state.zoneSets.filter((zs) => zs.id !== setId);
    savePersistedZoneSets(zoneSets);
    const editingZone = state.editingZone?.setId === setId ? null : state.editingZone;
    // The revision check cannot retire this one: `validEntry` is only ever
    // asked about a set that still EXISTS, so an entry for a deleted set is
    // never read and never dropped — it just holds a Map per element for the
    // rest of the session. Deletion is also the one moment where "this set is
    // gone" is unambiguous, so it is the right place to drop it.
    return { zoneSets, editingZone, zoneApportionment: pruneApportionment(state.zoneApportionment, zoneSets) };
  }),

  renameZoneSet: (setId, name) => set((state) => {
    const trimmed = name.trim();
    if (!trimmed) return state;
    const zoneSets = state.zoneSets.map((zs) => (zs.id === setId ? { ...zs, name: trimmed, updatedAt: Date.now() } : zs));
    savePersistedZoneSets(zoneSets);
    return { zoneSets };
  }),

  setZoneSetVisible: (setId, visible) => set((state) => {
    const zoneSets = state.zoneSets.map((zs) => (zs.id === setId ? { ...zs, visible } : zs));
    savePersistedZoneSets(zoneSets);
    return { zoneSets };
  }),

  replaceZonesInSet: (setId, zones) => set((state) => {
    const zoneSets = state.zoneSets.map((zs) => (zs.id === setId
      ? { ...zs, zones: zones.map(acceptZone), updatedAt: Date.now() }
      : zs));
    savePersistedZoneSets(zoneSets);
    // Replacing a set's zones wholesale (e.g. "generate from storeys") can
    // remove the zone an edit session points at — same invariant as
    // `removeZone`: never leave `editingZone` dangling on a zone that no
    // longer exists (CodeRabbit review of PR #1869).
    const editing = state.editingZone;
    const editingZone = editing?.setId === setId && !zones.some((z) => z.id === editing.zoneId)
      ? null
      : editing;
    return { zoneSets, editingZone };
  }),

  addZone: (setId, zone) => {
    const zoneSet = get().zoneSets.find((zs) => zs.id === setId);
    if (!zoneSet) return null;
    const id = crypto.randomUUID();
    const newZone: Zone = acceptZone({ ...DEFAULT_ZONE, ...zone, id });
    set((state) => {
      const zoneSets = state.zoneSets.map((zs) => (zs.id === setId ? { ...zs, zones: [...zs.zones, newZone], updatedAt: Date.now() } : zs));
      savePersistedZoneSets(zoneSets);
      return { zoneSets };
    });
    return id;
  },

  updateZone: (setId, zoneId, patch) => set((state) => {
    const zoneSets = state.zoneSets.map((zs) => {
      if (zs.id !== setId) return zs;
      return {
        ...zs,
        zones: zs.zones.map((z) => (z.id === zoneId ? acceptZone({ ...z, ...patch }) : z)),
        updatedAt: Date.now(),
      };
    });
    savePersistedZoneSets(zoneSets);
    return { zoneSets };
  }),

  removeZone: (setId, zoneId) => set((state) => {
    const zoneSets = state.zoneSets.map((zs) => (zs.id === setId
      ? { ...zs, zones: zs.zones.filter((z) => z.id !== zoneId), updatedAt: Date.now() }
      : zs));
    savePersistedZoneSets(zoneSets);
    const editingZone = state.editingZone?.setId === setId && state.editingZone.zoneId === zoneId ? null : state.editingZone;
    return { zoneSets, editingZone };
  }),

  setEditingZone: (target) => set({ editingZone: target }),

  setZoneAssignments: (assignments, timing) => set({ zoneAssignments: assignments, zoneAssignmentTiming: timing }),

  setZoneApportionment: (setId, entry) => set((state) => {
    const zoneApportionment = new Map(state.zoneApportionment);
    zoneApportionment.set(setId, entry);
    return { zoneApportionment };
  }),

  exportZoneSetsJSON: () => JSON.stringify(serializeZoneSets(get().zoneSets), null, 2),

  importZoneSetsJSON: (json) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      // Keep the structured user-facing error, but never swallow silently
      // (house rule): the console carries the actual parse failure.
      console.warn('[zones] failed to parse imported zone-set JSON', error);
      return { ok: false, error: 'Not valid JSON.' };
    }
    const result = parseZoneSetFile(parsed);
    if (!result.ok) return { ok: false, error: result.error };
    set((state) => {
      savePersistedZoneSets(result.zoneSets);
      // Import replaces every set — clear an edit session unless the imported
      // data still contains the exact set + zone it points at (CodeRabbit
      // review of PR #1869; same dangling-`editingZone` invariant as
      // `removeZoneSet`/`removeZone`).
      const editing = state.editingZone;
      const editingZone = editing !== null && result.zoneSets.some(
        (zs) => zs.id === editing.setId && zs.zones.some((z) => z.id === editing.zoneId),
      )
        ? editing
        : null;
      return {
        zoneSets: result.zoneSets,
        editingZone,
        // Import REPLACES every set, so any cached apportionment whose set id
        // did not come back is orphaned. An id that DID come back keeps its
        // entry and is retired by `validEntry` on the next read if the imported
        // zones differ — the revision covers that case, and only that case.
        zoneApportionment: pruneApportionment(state.zoneApportionment, result.zoneSets),
      };
    });
    return { ok: true };
  },

  clearAllZoneSets: () => set(() => {
    savePersistedZoneSets([]);
    return { zoneSets: [], zoneAssignments: new Map(), zoneAssignmentTiming: null, zoneApportionment: new Map(), editingZone: null };
  }),
});
