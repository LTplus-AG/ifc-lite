/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tour registry. Per-feature mini-tours land one PR at a time by adding a
 * definition file under `tours/` and listing it here; a tour that sets
 * `panel` automatically lights up that panel's header help button.
 */

import type { WorkspacePanelId } from '@/lib/panels/registry';
import { IDS_TOUR } from './tours/ids';
import { MEASURE_SECTION_TOUR } from './tours/measure-section';
import { WELCOME_TOUR } from './tours/welcome';
import type { TourDefinition, TourId } from './types';

export const TOUR_REGISTRY: readonly TourDefinition[] = [
  WELCOME_TOUR,
  MEASURE_SECTION_TOUR,
  IDS_TOUR,
];

export function getTour(id: TourId): TourDefinition | undefined {
  return TOUR_REGISTRY.find((t) => t.id === id);
}

export function getToursForPanel(panel: WorkspacePanelId): TourDefinition[] {
  return TOUR_REGISTRY.filter((t) => t.panel === panel);
}
