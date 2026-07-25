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
import { serializeZoneSets, parseZoneSetFile } from '../../lib/zones/persistence.js';

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
  exportZoneSetsJSON: () => string;
  importZoneSetsJSON: (json: string) => { ok: true } | { ok: false; error: string };
  clearAllZoneSets: () => void;
}

const DEFAULT_ZONE: Omit<Zone, 'id'> = {
  name: 'New zone',
  center: [0, 0, 0],
  size: [5, 3, 5],
  rotationY: 0,
};

export const createZonesSlice: StateCreator<ZonesSlice, [], [], ZonesSlice> = (set, get) => ({
  zoneSets: loadPersistedZoneSets(),
  zoneAssignments: new Map(),
  zoneAssignmentTiming: null,
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
    return { zoneSets, editingZone };
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
    const zoneSets = state.zoneSets.map((zs) => (zs.id === setId ? { ...zs, zones, updatedAt: Date.now() } : zs));
    savePersistedZoneSets(zoneSets);
    return { zoneSets };
  }),

  addZone: (setId, zone) => {
    const zoneSet = get().zoneSets.find((zs) => zs.id === setId);
    if (!zoneSet) return null;
    const id = crypto.randomUUID();
    const newZone: Zone = { ...DEFAULT_ZONE, ...zone, id };
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
        zones: zs.zones.map((z) => (z.id === zoneId ? { ...z, ...patch } : z)),
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

  exportZoneSetsJSON: () => JSON.stringify(serializeZoneSets(get().zoneSets), null, 2),

  importZoneSetsJSON: (json) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, error: 'Not valid JSON.' };
    }
    const result = parseZoneSetFile(parsed);
    if (!result.ok) return { ok: false, error: result.error };
    set(() => {
      savePersistedZoneSets(result.zoneSets);
      return { zoneSets: result.zoneSets };
    });
    return { ok: true };
  },

  clearAllZoneSets: () => set(() => {
    savePersistedZoneSets([]);
    return { zoneSets: [], zoneAssignments: new Map(), zoneAssignmentTiming: null, editingZone: null };
  }),
});
