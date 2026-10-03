/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon tour: what changed when the tabbed ribbon became the default
 * toolbar. Orientation, not training - where the commands went, how the
 * tabs follow your work, and how to reclaim the vertical space. Target:
 * about a minute, no model needed.
 */

import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

export const RIBBON_TOUR: TourDefinition = {
  id: 'ribbon',
  title: 'The new ribbon',
  description: 'Where the toolbar commands went and how tabs follow your work.',
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
        // Expanding the band for the tour must not overwrite the user's
        // persisted collapsed preference.
        store.setState({ ribbonCollapsed: false });
        store.getState().setRibbonTab('home');
      },
    },
    {
      id: 'follow-work',
      kind: 'passive',
      anchor: TOUR_ANCHORS.ribbonFollowWork,
      placement: 'bottom',
      // The tour opens the View band itself: the anchors below live there.
      // An "Open the View tab" action step used to do it and was skipped in
      // 70 of 76 field runs, on the same tab strip the step before had just
      // spotlighted; the switch is now shown, not assigned.
      prepare: (store) => store.getState().setRibbonTab('view'),
      title: 'Tabs follow your work',
      body: 'This is the View tab: each tab swaps the band beneath it for its own groups. Select something in 3D and the Elements tab opens itself; clear the selection and you land back where you were. Turning on edit mode does the same for Author. Follow work switches that off if you would rather steer by hand.',
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
