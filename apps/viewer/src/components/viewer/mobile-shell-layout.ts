/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CSSProperties } from 'react';
import { mobileCommandPlacement, mobilePanelHost, type FormFactor, type SegmentRect } from '@/lib/layout/form-factor';

/**
 * The mobile shell's grid (#9718): where the viewport, the docked panel pane
 * and the command bar sit, per form factor. One grid with three named areas
 * (`view`, `pane`, `bar`) instead of one tree per layout, so rotating, folding
 * or unfolding only restyles the shell: the viewport keeps its place in the
 * React tree and its WebGPU canvas is never remounted.
 *
 * - A modal sheet host (portrait phone, cover): the viewport over the bar. The
 *   sheet floats inside the viewport area; there is no pane.
 * - A side pane on a phone on its side: viewport | pane | rail. The pane sits
 *   between the model and the rail, 40% of the width clamped to 280-380px, and
 *   pads the top and bottom insets, the two screen edges it touches.
 * - A side pane on a near-tablet: the pane right of the viewport, the bar under
 *   both. 360px plus the right inset, which it pads with the top one.
 * - A fold: the shell is fixed to the window, so its tracks are the segments'
 *   own coordinates. The viewport fills the first segment exactly; the hinge
 *   is an empty track; the second segment holds the pane over the bar. The pane
 *   pads the insets of the screen edges it touches.
 *
 * The pane collapses to nothing when no panel is open (`empty:hidden` on the
 * slot), so its `auto` track is zero and the viewport takes the whole width.
 */
export interface MobileShellLayout {
  /** Fixed to the window: the fold's segment coordinates are window coordinates. */
  readonly fixed: boolean;
  readonly shell: CSSProperties;
  readonly pane: CSSProperties;
}

const SIDE_RAIL_PANE_WIDTH = 'clamp(280px, 40vw, 380px)';
const TABLET_PANE_WIDTH = 'calc(360px + env(safe-area-inset-right))';

const px = (n: number) => `${Math.max(0, Math.round(n))}px`;

/** The fold's segments in reading order: top to bottom, or left to right. */
function inReadingOrder(segments: readonly [SegmentRect, SegmentRect]): [SegmentRect, SegmentRect] {
  const [a, b] = segments;
  return a.y < b.y || (a.y === b.y && a.x <= b.x) ? [a, b] : [b, a];
}

export function mobileShellLayout(formFactor: FormFactor): MobileShellLayout {
  const host = mobilePanelHost(formFactor);
  const fold = formFactor.fold;

  if (host === 'segment' && fold) {
    const [view, controls] = inReadingOrder(fold.segments);
    if (fold.orientation === 'tabletop') {
      return {
        fixed: true,
        shell: {
          gridTemplateAreas: '"." "view" "." "pane" "bar"',
          gridTemplateRows: `${px(view.y)} ${px(view.height)} ${px(controls.y - view.y - view.height)} minmax(0, 1fr) auto`,
          gridTemplateColumns: 'minmax(0, 1fr)',
        },
        pane: { paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' },
      };
    }
    return {
      fixed: true,
      shell: {
        gridTemplateAreas: '". view . pane" ". view . bar"',
        gridTemplateColumns: `${px(view.x)} ${px(view.width)} ${px(controls.x - view.x - view.width)} minmax(0, 1fr)`,
        gridTemplateRows: 'minmax(0, 1fr) auto',
      },
      pane: { paddingTop: 'env(safe-area-inset-top)', paddingRight: 'env(safe-area-inset-right)' },
    };
  }

  if (host === 'side-pane' && mobileCommandPlacement(formFactor) === 'side-rail') {
    return {
      fixed: false,
      shell: {
        gridTemplateAreas: '"view pane bar"',
        gridTemplateColumns: 'minmax(0, 1fr) auto auto',
        gridTemplateRows: 'minmax(0, 1fr)',
      },
      pane: {
        width: SIDE_RAIL_PANE_WIDTH,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      },
    };
  }

  if (host === 'side-pane') {
    return {
      fixed: false,
      shell: {
        gridTemplateAreas: '"view pane" "bar bar"',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        gridTemplateRows: 'minmax(0, 1fr) auto',
      },
      pane: {
        width: TABLET_PANE_WIDTH,
        paddingTop: 'env(safe-area-inset-top)',
        paddingRight: 'env(safe-area-inset-right)',
      },
    };
  }

  return {
    fixed: false,
    shell: {
      gridTemplateAreas: '"view" "bar"',
      gridTemplateColumns: 'minmax(0, 1fr)',
      gridTemplateRows: 'minmax(0, 1fr) auto',
    },
    pane: {},
  };
}
