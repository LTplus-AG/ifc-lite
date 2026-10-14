/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Several cutting planes at once (#7545), composed into `createSectionSlice`
 * beside `sectionBoxSlice` (the same way, and for the same reason: `sectionSlice.ts`
 * sits at its module-size budget).
 *
 * `sectionPlane` keeps meaning "the active plane": every reader that wants THE
 * cut a drawing, PDF sheet, BCF snapshot or alignment is about reads it, and
 * every existing writer (`setSectionPlaneAxis`, `flipSectionPlane`, the face
 * pick, the box, the cap style) still edits exactly that plane. The other
 * planes wait in `inactiveSectionPlanes`; activating one SWAPS it with the
 * active plane in a single `set`, so no reader ever sees two active planes or
 * none. Nothing outside this slice writes `inactiveSectionPlanes`.
 *
 * The set is never empty: a fresh viewer holds an untouched placeholder
 * (`isPristineSectionPlane`), which is what "no cuts" means. Adding to a
 * pristine set takes the placeholder over instead of stacking a ghost plane
 * behind it; removing the last plane puts a placeholder back.
 *
 * Display order is creation order (the id counter), not list position, so
 * activating a plane never reshuffles the chips.
 */

import type { StateCreator } from 'zustand';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { SectionPlane, SectionPlaneAxis } from '../types.js';
import type { SectionSlice } from './sectionSlice.js';
import {
  FIRST_SECTION_PLANE_NAME,
  MAX_SECTION_PLANES,
  createSectionPlane,
  isPristineSectionPlane,
  newSectionPlaneId,
  nextSectionPlaneName,
  orderedSectionPlanes,
  uniqueSectionPlaneName,
} from '@/lib/section/section-plane-set';

/** Whether the next face pick adds a plane or replaces the active one (today's behaviour). */
export type SectionPickTarget = 'replace' | 'new';

/** What Undo gives back after a removal: the planes it took out, merged into the set as it is by then. */
export interface SectionUndoRecord {
  label: 'removed' | 'cleared';
  /** Name of the plane removed, for the toast. */
  name: string;
  active: SectionPlane;
  inactive: SectionPlane[];
}

/**
 * The cut of an inactive plane, as its cap is drawn (#7545): the polygons and lines the cutter
 * produced, and what they were cut FROM. The active plane's cap comes from the Drawing panel's
 * own drawing; the others are cut by `useExtraSectionCaps` and parked here for the renderer.
 */
export interface SectionExtraCap {
  /** What this cut was made for: the plane's geometry and the visible model state. Stale when it differs. */
  signature: string;
  cutPolygons: Drawing2D['cutPolygons'];
  layerBaseCutPolygons?: Drawing2D['layerBaseCutPolygons'];
  lines: Drawing2D['lines'];
}

export interface SectionPlaneSetSlice {
  /** Every plane except the active one (`sectionPlane`). Written only by this slice. */
  inactiveSectionPlanes: SectionPlane[];
  /** The caps of the inactive planes, by plane id. Derived data: reset with the model, dropped with the plane. */
  sectionExtraCaps: Readonly<Record<string, SectionExtraCap>>;
  setSectionExtraCap: (id: string, cap: SectionExtraCap | null) => void;
  /** Drop every cap whose plane id is not in `keep`. */
  pruneSectionExtraCaps: (keep: readonly string[]) => void;
  sectionPickTarget: SectionPickTarget;
  /** The set before the last Remove / Clear all, until Undo or `dismissSectionUndo`. */
  sectionUndo: SectionUndoRecord | null;

  /** Add a plane through the middle of the model along `axis`; it becomes active and cutting. Returns its id, or null at the limit. */
  addSectionPlane: (axis: SectionPlaneAxis) => string | null;
  /** Arm the face pick so its commit ADDS a plane. False at the limit (nothing armed). */
  armSectionFacePickForNewPlane: () => boolean;
  /** Make room for a new active plane (a pristine one is reused); false at the limit. Used by the face-pick commit. */
  prepareNewSectionPlane: () => boolean;
  activateSectionPlane: (id: string) => void;
  /** Remove a plane; the one before it in creation order becomes active. Keeps an Undo record. */
  removeSectionPlane: (id: string) => void;
  renameSectionPlane: (id: string, name: string) => void;
  /** A copy named like the user would expect, active and cutting. Null at the limit. */
  duplicateSectionPlane: (id: string) => string | null;
  /** Remove every plane (back to a placeholder). Keeps an Undo record. */
  clearSectionPlanes: () => void;
  /** Cut on/off for any plane, active or not. */
  setSectionPlaneCutting: (id: string, enabled: boolean) => void;
  /** Show or hide a plane's quad and outline, active or not. */
  setSectionPlaneShowGizmo: (id: string, show: boolean) => void;
  undoSectionChange: () => void;
  dismissSectionUndo: () => void;
  /** Replace the whole set (saved sets, viewpoints): `planes[activeIndex]` becomes the active plane. */
  installSectionPlanes: (planes: readonly SectionPlane[], activeIndex: number) => void;
}

type SetFn = Parameters<StateCreator<SectionSlice, [], [], SectionPlaneSetSlice>>[0];
type GetFn = Parameters<StateCreator<SectionSlice, [], [], SectionPlaneSetSlice>>[1];

export const createSectionPlaneSetSlice: StateCreator<SectionSlice, [], [], SectionPlaneSetSlice> = (set: SetFn, get: GetFn) => {
  /** The hide toggle must follow every action that puts a cut on screen (#5893): see `enableSectionPlane`. */
  const reveal = (): void => {
    (get() as unknown as { setSectionVisible?: (visible: boolean) => void }).setSectionVisible?.(true);
  };

  const namesOf = (state: SectionSlice, except?: string): string[] =>
    [state.sectionPlane, ...state.inactiveSectionPlanes].filter((p) => p.id !== except).map((p) => p.name);

  /** The state after making room for one more plane, or null at the limit. */
  const withRoomForNew = (state: SectionSlice): { active: SectionPlane; inactive: SectionPlane[] } | null => {
    if (state.inactiveSectionPlanes.length === 0 && isPristineSectionPlane(state.sectionPlane)) {
      return { active: { ...state.sectionPlane, name: FIRST_SECTION_PLANE_NAME }, inactive: [] };
    }
    if (1 + state.inactiveSectionPlanes.length >= MAX_SECTION_PLANES) return null;
    return {
      active: createSectionPlane(nextSectionPlaneName(namesOf(state)), state.sectionPlane),
      inactive: [...state.inactiveSectionPlanes, state.sectionPlane],
    };
  };

  const placeholder = (state: SectionSlice): SectionPlane => createSectionPlane('', state.sectionPlane);

  return {
    inactiveSectionPlanes: [],
    sectionExtraCaps: {},
    setSectionExtraCap: (id, cap) => set((state) => {
      if (cap === null) {
        if (!(id in state.sectionExtraCaps)) return state;
        const { [id]: _dropped, ...rest } = state.sectionExtraCaps;
        return { sectionExtraCaps: rest };
      }
      return { sectionExtraCaps: { ...state.sectionExtraCaps, [id]: cap } };
    }),
    pruneSectionExtraCaps: (keep) => set((state) => {
      const kept = Object.fromEntries(Object.entries(state.sectionExtraCaps).filter(([id]) => keep.includes(id)));
      return Object.keys(kept).length === Object.keys(state.sectionExtraCaps).length ? state : { sectionExtraCaps: kept };
    }),
    sectionPickTarget: 'replace',
    sectionUndo: null,

    addSectionPlane: (axis) => {
      const room = withRoomForNew(get());
      if (!room) return null;
      set({ sectionPlane: room.active, inactiveSectionPlanes: room.inactive });
      // The active plane is now the new one: the existing action cuts it exactly as it always has.
      get().setSectionPlaneAxis(axis);
      return get().sectionPlane.id;
    },

    armSectionFacePickForNewPlane: () => {
      if (!withRoomForNew(get())) return false;
      // Straight to the state: arming through `setSectionPickMode(true)` would detach the ACTIVE plane
      // from its alignment, and this pick adds a plane instead of replacing that one.
      set({ sectionPickMode: true, sectionPickTarget: 'new' });
      return true;
    },

    prepareNewSectionPlane: () => {
      const room = withRoomForNew(get());
      if (!room) return false;
      set({ sectionPlane: room.active, inactiveSectionPlanes: room.inactive });
      return true;
    },

    activateSectionPlane: (id) => set((state) => {
      if (state.sectionPlane.id === id) return state;
      const target = state.inactiveSectionPlanes.find((p) => p.id === id);
      if (!target) return state;
      return {
        sectionPlane: target,
        inactiveSectionPlanes: [...state.inactiveSectionPlanes.filter((p) => p.id !== id), state.sectionPlane],
        // A pending pick belongs to the plane that was active when it was armed.
        sectionPickMode: false,
        sectionPickPreview: null,
        sectionPickTarget: 'replace',
      };
    }),

    removeSectionPlane: (id) => {
      const state = get();
      const ordered = orderedSectionPlanes(state.sectionPlane, state.inactiveSectionPlanes);
      const index = ordered.findIndex((p) => p.id === id);
      if (index < 0) return;
      const record: SectionUndoRecord = {
        label: 'removed', name: ordered[index]!.name, active: state.sectionPlane, inactive: state.inactiveSectionPlanes,
      };
      const rest = ordered.filter((p) => p.id !== id);
      if (rest.length === 0) {
        set({ sectionPlane: placeholder(state), inactiveSectionPlanes: [], sectionUndo: record, sectionPickMode: false, sectionPickPreview: null, sectionPickTarget: 'replace' });
        return;
      }
      const nextActive = state.sectionPlane.id === id ? rest[Math.max(0, index - 1)]! : state.sectionPlane;
      set({
        sectionPlane: nextActive,
        inactiveSectionPlanes: rest.filter((p) => p.id !== nextActive.id),
        sectionUndo: record,
        ...(state.sectionPlane.id === id ? { sectionPickMode: false, sectionPickPreview: null, sectionPickTarget: 'replace' as const } : {}),
      });
    },

    renameSectionPlane: (id, name) => set((state) => {
      const unique = uniqueSectionPlaneName(name, namesOf(state, id));
      if (!unique) return state;
      if (state.sectionPlane.id === id) return { sectionPlane: { ...state.sectionPlane, name: unique } };
      return { inactiveSectionPlanes: state.inactiveSectionPlanes.map((p) => (p.id === id ? { ...p, name: unique } : p)) };
    }),

    duplicateSectionPlane: (id) => {
      const state = get();
      const source = state.sectionPlane.id === id ? state.sectionPlane : state.inactiveSectionPlanes.find((p) => p.id === id);
      if (!source || 1 + state.inactiveSectionPlanes.length >= MAX_SECTION_PLANES) return null;
      const copy: SectionPlane = {
        ...source,
        id: newSectionPlaneId(),
        name: uniqueSectionPlaneName(`${source.name} copy`, namesOf(state)) ?? nextSectionPlaneName(namesOf(state)),
        enabled: true,
        parked: false,
        // An alignment binding follows its own plane's station; a copy is free of it.
        custom: source.custom ? { ...source.custom, alignment: undefined } : undefined,
      };
      set({ sectionPlane: copy, inactiveSectionPlanes: [...state.inactiveSectionPlanes, state.sectionPlane] });
      reveal();
      return copy.id;
    },

    clearSectionPlanes: () => {
      const state = get();
      if (state.inactiveSectionPlanes.length === 0 && isPristineSectionPlane(state.sectionPlane)) return;
      const record: SectionUndoRecord = {
        label: 'cleared', name: state.sectionPlane.name, active: state.sectionPlane, inactive: state.inactiveSectionPlanes,
      };
      set({ sectionPlane: placeholder(state), inactiveSectionPlanes: [], sectionUndo: record, sectionPickMode: false, sectionPickPreview: null, sectionPickTarget: 'replace' });
    },

    setSectionPlaneCutting: (id, enabled) => {
      const state = get();
      if (state.sectionPlane.id === id) {
        state.setSectionPlaneEnabled(enabled);
        return;
      }
      set({ inactiveSectionPlanes: state.inactiveSectionPlanes.map((p) => (p.id === id ? { ...p, enabled, parked: false } : p)) });
      if (enabled) reveal();
    },

    setSectionPlaneShowGizmo: (id, show) => set((state) => (
      state.sectionPlane.id === id
        ? { sectionPlane: { ...state.sectionPlane, showGizmo: show } }
        : { inactiveSectionPlanes: state.inactiveSectionPlanes.map((p) => (p.id === id ? { ...p, showGizmo: show } : p)) }
    )),

    // Give back the planes the removal took out, INTO the set as it is now: whatever was edited,
    // added or activated since stays as the user left it (a whole-set snapshot would revert it).
    undoSectionChange: () => {
      const record = get().sectionUndo;
      if (!record) return;
      const state = get();
      const current = [state.sectionPlane, ...state.inactiveSectionPlanes];
      const live = current.length === 1 && isPristineSectionPlane(current[0]!) ? [] : current;
      const have = new Set(live.map((p) => p.id));
      const taken = live.map((p) => p.name);
      const restored = [record.active, ...record.inactive]
        .filter((p) => !have.has(p.id))
        .slice(0, Math.max(0, MAX_SECTION_PLANES - live.length))
        .map((p) => {
          // A plane made since may have taken the name this one had.
          const name = uniqueSectionPlaneName(p.name, taken) ?? nextSectionPlaneName(taken);
          taken.push(name);
          return name === p.name ? p : { ...p, name };
        });
      if (restored.length === 0) { set({ sectionUndo: null }); return; }
      const pool = [...live, ...restored];
      const back = restored.find((p) => p.id === record.active.id);
      const active = back ?? (live.length > 0 ? state.sectionPlane : restored[0]!);
      set({ sectionPlane: active, inactiveSectionPlanes: pool.filter((p) => p.id !== active.id), sectionUndo: null });
      if (pool.some((p) => p.enabled)) reveal();
    },

    dismissSectionUndo: () => set((state) => (state.sectionUndo ? { sectionUndo: null } : state)),

    installSectionPlanes: (planes, activeIndex) => {
      const list = planes.slice(0, MAX_SECTION_PLANES);
      if (list.length === 0) return;
      const index = Math.min(Math.max(0, activeIndex), list.length - 1);
      const taken: string[] = [];
      const stamped = list.map((plane) => {
        const name = uniqueSectionPlaneName(plane.name, taken) ?? nextSectionPlaneName(taken);
        taken.push(name);
        return { ...plane, id: newSectionPlaneId(), name };
      });
      set({
        sectionPlane: stamped[index]!,
        inactiveSectionPlanes: stamped.filter((_, i) => i !== index),
        sectionUndo: null,
        sectionPickMode: false,
        sectionPickPreview: null,
        sectionPickTarget: 'replace',
      });
      if (stamped.some((p) => p.enabled)) reveal();
    },
  };
};
