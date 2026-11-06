/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useRef } from 'react';
import type { TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { MAX_SECTION_PLANES } from '@/lib/section/section-plane-set';
import { sectionBoxFromBounds } from '@/lib/section/section-box';
import { useAddSectionPlane, type AddKind } from './tools/SectionAddMenu';
import { useSectionDistance } from './tools/useSectionDistance';

/** Mounted adapter only: fitting, face picking and alignment stay in the real hook. */
export function useSectionPaletteHost() {
  const add = useAddSectionPlane();
  const distance = useSectionDistance();
  const models = useViewerStore(s => s.models);
  const geometry = useViewerStore(s => s.geometryResult);
  const placement = useViewerStore(s => s.modelPlacement);
  const latest = useRef({ add, bounds: distance.bounds, models, geometry, placement });
  latest.current = { add, bounds: distance.bounds, models, geometry, placement };
  return useMemo(() => ({
    sectionAddUnavailable: (kind: AddKind): TranslationKey | undefined => {
      const s = useViewerStore.getState();
      if (1 + s.inactiveSectionPlanes.length >= MAX_SECTION_PLANES) return 'commandPalette.availability.sectionLimit';
      if (kind === 'box' && (s.models !== latest.current.models || s.geometryResult !== latest.current.geometry
        || s.modelPlacement !== latest.current.placement)) return 'commandPalette.availability.loading';
      if (kind === 'box' && !sectionBoxFromBounds(s.cameraCallbacks.selectionBounds?.() ?? null)
        && !sectionBoxFromBounds(latest.current.bounds)) return 'commandPalette.availability.sectionBounds';
      return undefined;
    },
    addSectionPlane: (kind: AddKind) => {
      useViewerStore.getState().setActiveTool('section');
      return latest.current.add(kind);
    },
  }), []);
}
