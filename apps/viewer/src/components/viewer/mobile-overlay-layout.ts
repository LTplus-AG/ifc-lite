/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CSSProperties } from 'react';
import type { MobileCommandPlacement } from '@/lib/layout/form-factor';

/**
 * Where the phone layout's bottom row sits, in one place: the Home/zoom pill
 * on the left (`ViewportOverlays`) and the Panels button on the right
 * (`MobilePanelLauncher`) share this, so the two read as one row instead of
 * two unrelated floats.
 *
 * Offsets from the viewport's own edges, plus the system insets (#9718) only
 * on an edge the viewport actually shares with the screen:
 * - `bottom-bar`: the command bar sits under the viewport and owns the home
 *   indicator's inset, so the row is a plain 0.75rem above the bar. The
 *   sides are the screen's, so they keep the left/right insets.
 * - `side-rail` (a phone on its side): the viewport reaches the screen's
 *   bottom, so the row clears the home indicator, and its left edge clears
 *   the Dynamic Island or punch hole when that side is on the left. The
 *   right edge is the rail's, which owns the right inset.
 *
 * It replaced a fixed `15%` of the viewport's height, which kept the row
 * clear of the iOS Safari URL bar overlay; the mobile shell now stops above
 * that overlay itself (`useVisualViewportBottomInset` in `ViewerLayout`).
 */
export const MOBILE_NAV_ROW: Record<MobileCommandPlacement, { bottom: string; left: string; right: string }> = {
  'bottom-bar': {
    bottom: '0.75rem',
    left: 'max(1rem, env(safe-area-inset-left))',
    right: 'max(1rem, env(safe-area-inset-right))',
  },
  'side-rail': {
    bottom: 'calc(0.75rem + env(safe-area-inset-bottom))',
    left: 'max(1rem, env(safe-area-inset-left))',
    right: '1rem',
  },
};

/** The row's 44px controls plus a 0.5rem gap: what a passive readout above the row clears. */
const ROW_CLEARANCE = '3.25rem';

/** Style for a control in the row, anchored to one side. */
export function mobileNavRowStyle(placement: MobileCommandPlacement, side: 'left' | 'right'): CSSProperties {
  const row = MOBILE_NAV_ROW[placement];
  return { bottom: row.bottom, [side]: row[side] };
}

/** The bottom offset that clears the row, for what stacks above it (the bottom-centre HUD, the hidden count). */
export function mobileNavRowClearance(placement: MobileCommandPlacement): string {
  return `calc(${MOBILE_NAV_ROW[placement].bottom} + ${ROW_CLEARANCE})`;
}
