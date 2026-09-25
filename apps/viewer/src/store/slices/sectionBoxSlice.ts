/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section box's actions (#5513, charter #5478 §6), composed into
 * `createSectionSlice` — beside `sectionSlice.ts` rather than inside it
 * because that module sits at its recorded module-size budget.
 *
 * Box mode is `sectionPlane.box`: set, the renderer clips to the box
 * (`sectionRenderClip`) and the plane is off; the cardinal `axis` /
 * `position` are kept so the Drawing panel and BCF keep a plane to read.
 * Entering box mode drops a face-picked plane, and the cardinal actions
 * (`setSectionPlaneAxis`) and a face pick (`setSectionPlaneFromFace`) drop
 * the box — one cut at a time, the same exclusivity `custom` has.
 *
 * The box is model-relative geometry, so it is never persisted; the
 * last-used mode records only that the user was in box mode, and the
 * Section tool resumes a parked box through `store/section-active.ts`.
 */

import type { StateCreator } from 'zustand';
import type { SectionBox, SectionBoxFace } from '../types.js';
import { moveSectionBoxFace } from '@/lib/section/section-box';
import { saveLastSectionMode } from './sectionLastMode.js';
import type { SectionSlice } from './sectionSlice.js';

export interface SectionBoxSlice {
  /** Cut with `box`: sets `sectionPlane.box`, drops a face-picked plane, turns the cut on. */
  setSectionBox: (box: SectionBox) => void;
  /** Move one face of the box to `value` (world units along its axis); the opposite face is a hard stop. No-op outside box mode. */
  setSectionBoxFace: (face: SectionBoxFace, value: number) => void;
}

export const createSectionBoxSlice: StateCreator<SectionSlice, [], [], SectionBoxSlice> = (set) => ({
  setSectionBox: (box) => set((state) => {
    saveLastSectionMode({ kind: 'box' });
    return {
      sectionPlane: { ...state.sectionPlane, box: { min: [...box.min], max: [...box.max] }, custom: undefined, enabled: true },
      sectionPickMode: false,
      sectionPickPreview: null,
    };
  }),

  setSectionBoxFace: (face, value) => set((state) => {
    const box = state.sectionPlane.box;
    if (!box) return state;
    const next = moveSectionBoxFace(box, face, value);
    return next === box ? state : { sectionPlane: { ...state.sectionPlane, box: next } };
  }),
});
