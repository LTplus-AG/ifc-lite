/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import { useViewerStore } from '@/store';
import { closeActiveAnalysisExtension } from '@/services/analysis-extensions';

export type MeasurementPanelTab = 'list' | 'point' | 'quantities' | 'centreline';
export const useMeasurementDestination = create<{ tab: MeasurementPanelTab; revision: number }>(() => ({ tab: 'list', revision: 0 }));

/** A destination names a real tab, independent of the active picking mode (#8947). */
export function openMeasurementDestination(tab: MeasurementPanelTab): void {
  closeActiveAnalysisExtension();
  useMeasurementDestination.setState(s => ({ tab, revision: s.revision + 1 }));
  useViewerStore.getState().openPanelInHome('measurements', 'palette');
}
