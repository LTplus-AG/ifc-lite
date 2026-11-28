/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react';
import { useViewerStore } from '@/store';
import { sectionBoxFromBounds } from '@/lib/section/section-box';
import { chooseAlignmentMode, leaveAlignmentMode } from '@/lib/section/alignment-controller';
import type { SectionPlaneAxis } from '@/store/types';
import { useSectionDistance } from './useSectionDistance';

// Shared by the command palette and the lazy toolbar. Keep menu markup in the toolbar.
export type AddKind = SectionPlaneAxis | 'face' | 'box' | 'alignment';

/** Add a plane of `kind`; false when the set is full. One place, so the menu and the empty state cannot differ. */
export function useAddSectionPlane(): (kind: AddKind) => boolean {
  const distance = useSectionDistance();
  return useCallback((kind) => {
    const store = useViewerStore.getState();
    leaveAlignmentMode();
    if (kind === 'down' || kind === 'front' || kind === 'side') return store.addSectionPlane(kind) !== null;
    if (kind === 'face') return store.armSectionFacePickForNewPlane();
    if (kind === 'alignment') {
      if (!store.prepareNewSectionPlane()) return false;
      chooseAlignmentMode();
      return true;
    }
    // A box fits the selection when there is one (the bounds Frame uses), else the model;
    // with neither known there is nothing to cut with, so no plane is made.
    const selected = store.cameraCallbacks.selectionBounds?.() ?? null;
    const box = sectionBoxFromBounds(selected) ?? sectionBoxFromBounds(distance.bounds);
    if (!box || !store.prepareNewSectionPlane()) return false;
    useViewerStore.getState().setSectionBox(box);
    return true;
  }, [distance.bounds]);
}

type AddLabelKey = 'sectionPlanes.addDown' | 'sectionPlanes.addFront' | 'sectionPlanes.addSide' | 'sectionPlanes.addFace' | 'sectionPlanes.addBox' | 'sectionPlanes.addAlignment';
type AddTitleKey = 'sectionPlanes.addDownTitle' | 'sectionPlanes.addFrontTitle' | 'sectionPlanes.addSideTitle' | 'sectionPlanes.addFaceTitle' | 'sectionPlanes.addBoxTitle' | 'sectionPlanes.addAlignmentTitle';

/** Every way to add, with a title that says what it makes, so each choice explains itself on hover (#8672). */
export const SECTION_ADD_ENTRIES: ReadonlyArray<{ kind: AddKind; labelKey: AddLabelKey; titleKey: AddTitleKey }> = [
  { kind: 'down', labelKey: 'sectionPlanes.addDown', titleKey: 'sectionPlanes.addDownTitle' },
  { kind: 'front', labelKey: 'sectionPlanes.addFront', titleKey: 'sectionPlanes.addFrontTitle' },
  { kind: 'side', labelKey: 'sectionPlanes.addSide', titleKey: 'sectionPlanes.addSideTitle' },
  { kind: 'face', labelKey: 'sectionPlanes.addFace', titleKey: 'sectionPlanes.addFaceTitle' },
  { kind: 'box', labelKey: 'sectionPlanes.addBox', titleKey: 'sectionPlanes.addBoxTitle' },
  { kind: 'alignment', labelKey: 'sectionPlanes.addAlignment', titleKey: 'sectionPlanes.addAlignmentTitle' },
];
