/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import type { SectionPlane } from '@/store/types';
import { MAX_SECTION_PLANES, orderedSectionPlanes, sectionPlaneCount } from '@/lib/section/section-plane-set';

export interface SectionPlaneSetView {
  active: SectionPlane;
  /** Every plane in creation order (the chips' order), whichever is active. */
  planes: SectionPlane[];
  /** How many cuts the user has made; the untouched placeholder is none. */
  count: number;
  atLimit: boolean;
}

/** The cutting-plane set as the Section bar reads it (#7545). */
export function useSectionPlaneSet(): SectionPlaneSetView {
  const active = useViewerStore((s) => s.sectionPlane);
  const inactive = useViewerStore((s) => s.inactiveSectionPlanes);
  return useMemo(() => {
    const count = sectionPlaneCount(active, inactive);
    return { active, planes: orderedSectionPlanes(active, inactive), count, atLimit: 1 + inactive.length >= MAX_SECTION_PLANES };
  }, [active, inactive]);
}
