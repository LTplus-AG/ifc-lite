/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon tour: what changed when the tabbed ribbon became the default
 * toolbar. Orientation, not training - where the commands went, how the
 * tabs follow your work, how to reclaim the vertical space, and the way
 * back to the classic strip. Target: about a minute, no model needed.
 *
 * The first step switches the toolbar style so the tour also works when
 * started from the Learn hub in classic mode; the snapshot restores the
 * user's own style on finish or abort.
 */

import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

export const RIBBON_TOUR: TourDefinition = {
  id: 'ribbon',
  title: 'The new ribbon',
  description: 'Where the toolbar commands went, how tabs follow your work, and how to switch back.',
  minutes: 1,
  version: 1,
  steps: [
    {
      id: 'tabs',
      kind: 'passive',
      anchor: TOUR_ANCHORS.ribbonTabs,
      placement: 'bottom',
      title: 'Commands live in tabs now',
      body: 'Everything from the old single strip is here, grouped by task: File, Home, View, Elements, Analyze, Author. Nothing was removed, and every shortcut still works.',
      prepare: (store) => {
        store.getState().setToolbarStyle('ribbon');
        store.getState().setRibbonCollapsed(false);
        store.getState().setRibbonTab('home');
      },
    },
    {
      id: 'open-view',
      kind: 'action',
      anchor: TOUR_ANCHORS.ribbonTabs,
      placement: 'bottom',
      title: 'Open the View tab',
      body: 'Click View. Each tab swaps the band beneath it for its own groups.',
      gate: { predicate: (s) => s.ribbonTab === 'view' },
    },
    {
      id: 'follow-work',
      kind: 'passive',
      anchor: TOUR_ANCHORS.ribbonFollowWork,
      placement: 'bottom',
      // Idempotent re-open: the anchors below live in the View band, and the
      // user may have skipped the step that opened it.
      prepare: (store) => store.getState().setRibbonTab('view'),
      title: 'Tabs follow your work',
      body: 'Select something in 3D and the Elements tab opens itself; clear the selection and you land back where you were. Turning on edit mode does the same for Author. Follow work switches that off if you would rather steer by hand.',
    },
    {
      id: 'classic',
      kind: 'passive',
      anchor: TOUR_ANCHORS.ribbonClassicSwitch,
      placement: 'bottom',
      prepare: (store) => store.getState().setRibbonTab('view'),
      title: 'The way back',
      body: 'Prefer the old strip? Classic bar brings it back and this browser remembers the choice. Its View menu has the way here again, so nothing is one-way.',
    },
    {
      id: 'collapse',
      kind: 'passive',
      anchor: TOUR_ANCHORS.ribbonCollapse,
      placement: 'bottom',
      title: 'Reclaim the height',
      body: 'Collapse the band to the tab strip with this chevron, or by double-clicking the active tab. That is remembered too, so the ribbon costs you one strip at most.',
    },
  ],
};
