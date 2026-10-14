/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Fill slice" as one switch (#7545): the cut surface painted solid, which is
 * what a section needs to be readable. The Cap popover still holds every hatch
 * detail; this is the one-click path to the answer people want most. Turning it
 * off returns to the hatch the user had, not to a default.
 *
 * Fill is a cap-look preference, so it applies to every plane (the store writes
 * the look through to all of them).
 */

import { useCallback } from 'react';
import type { SectionCapHatchId } from '@/store/types';
import { useViewerStore } from '@/store';

/** What "off" returns to when the user never had a hatch (or it was already solid). */
const DEFAULT_HATCH: SectionCapHatchId = 'diagonal';
let lastHatch: SectionCapHatchId = DEFAULT_HATCH;

/** Test seam: forget the remembered hatch. */
export function resetRememberedHatch(): void { lastHatch = DEFAULT_HATCH; }

export function useSectionFill(): { on: boolean; toggle: () => void } {
  const on = useViewerStore((s) => s.sectionPlane.showCap && s.sectionPlane.capStyle.pattern === 'solid');
  const toggle = useCallback(() => {
    const state = useViewerStore.getState();
    const { pattern } = state.sectionPlane.capStyle;
    if (state.sectionPlane.showCap && pattern === 'solid') {
      state.setSectionCapStyle({ pattern: lastHatch });
      return;
    }
    if (pattern !== 'solid') lastHatch = pattern;
    state.setSectionShowCap(true);
    state.setSectionCapStyle({ pattern: 'solid' });
  }, []);
  return { on, toggle };
}
