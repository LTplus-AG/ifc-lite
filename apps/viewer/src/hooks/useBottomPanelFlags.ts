/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bottom strip's flags as one shallow-compared object, so a reader
 * subscribes once for every panel in the table instead of once per flag.
 */
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { BOTTOM_PANEL_FLAG, BOTTOM_PANEL_IDS, type BottomPanelFlags } from '@/lib/panels/bottom-panels';

export function useBottomPanelFlags(): BottomPanelFlags {
  return useViewerStore(useShallow((s) => {
    const flags = {} as BottomPanelFlags;
    for (const id of BOTTOM_PANEL_IDS) flags[BOTTOM_PANEL_FLAG[id]] = s[BOTTOM_PANEL_FLAG[id]];
    return flags;
  }));
}
