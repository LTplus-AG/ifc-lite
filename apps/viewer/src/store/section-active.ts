/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section cut the user can actually SEE, or `null`.
 *
 * `sectionPlane.enabled` alone is not that fact. Opening the Section tool
 * restores the last cardinal cut and flips `enabled` on (`SectionPanel`), and
 * nothing turns it off again when the user switches to another tool. The
 * renderer only applies the cut while the Section tool is active
 * (`useAnimationLoop` / `buildRenderOptions` gate on `activeTool === 'section'`),
 * so the cut disappears from the screen while `enabled` stays `true`.
 *
 * Anything that records "the current view" (BCF viewpoints, basket views) must
 * read this, not `enabled`: a BCF viewpoint carried a `<ClippingPlanes>` the
 * user never saw, and BIMcollab / usBIM then opened the topic cut (#4806).
 */

import type { SectionPlane } from './types.js';

export function activeSectionPlane(state: {
  activeTool: string;
  sectionPlane: SectionPlane;
}): SectionPlane | null {
  return state.activeTool === 'section' && state.sectionPlane.enabled ? state.sectionPlane : null;
}
