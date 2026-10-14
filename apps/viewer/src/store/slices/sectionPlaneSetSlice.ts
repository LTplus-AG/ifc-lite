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

/** What Undo gives back after a removal: the whole set as it was. */
export interface SectionUndoRecord {
  label: 'removed' | 'cleared';
  /** Name of the plane removed, for the toast. */
  name: string;
  active: SectionPlane;
  inactive: SectionPlane[];
}

export interface SectionPlaneSetSlice {
  /** Every plane except the active one (`sectionPlane`). Written only by this slice. */
  inactiveSectionPlanes: SectionPlane[];
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
    sectionPickTarget: 'replace',
    sectionUndo: null,

    addSectionPlane: (axis) => {
      const room = withRoomForNew(get());
      if (!room) return null;
      set({ sectionPlane: room.active, inactiveSectionPlanes: room.inactive, sectionUndo: null });
      // The active plane is now the new one: the existing action cuts it exactly as it always has.
      get().setSectionPlaneAxis(axis);
      return get().sectionPlane.id;
    },

    armSectionFacePickForNewPlane: () => {
      if (!withRoomForNew(get())) return false;
      get().setSectionPickMode(true);
      set({ sectionPickTarget: 'new' });
      return true;
    },

    prepareNewSectionPlane: () => {
      const room = withRoomForNew(get());
      if (!room) return false;
      set({ sectionPlane: room.active, inactiveSectionPlanes: room.inactive, sectionUndo: null });
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
      set({ sectionPlane: copy, inactiveSectionPlanes: [...state.inactiveSectionPlanes, state.sectionPlane], sectionUndo: null });
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

    undoSectionChange: () => {
      const record = get().sectionUndo;
      if (!record) return;
      set({ sectionPlane: record.active, inactiveSectionPlanes: record.inactive, sectionUndo: null });
      if (record.active.enabled || record.inactive.some((p) => p.enabled)) reveal();
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
