/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import { useViewerStore } from '@/store';
import { closeActiveAnalysisExtension } from '@/services/analysis-extensions';

export type MeasurementPanelTab = 'list' | 'point' | 'quantities' | 'centreline';
export const useMeasurementDestination = create<{ tab: MeasurementPanelTab | null; revision: number }>(() => ({ tab: null, revision: 0 }));

/** Consume only the request this panel observed, without clearing a newer request. */
export function consumeMeasurementDestination(revision: number): MeasurementPanelTab | null {
  const current = useMeasurementDestination.getState();
  if (!revision || current.revision !== revision || !current.tab) return null;
  useMeasurementDestination.setState({ tab: null });
  return current.tab;
}

/** A destination names a real tab, independent of the active picking mode (#8947). */
export function openMeasurementDestination(tab: MeasurementPanelTab): void {
  closeActiveAnalysisExtension();
  useMeasurementDestination.setState(s => ({ tab, revision: s.revision + 1 }));
  useViewerStore.getState().openPanelInHome('measurements', 'palette');
}
