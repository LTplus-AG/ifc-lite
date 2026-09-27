/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The docked `placement` side panel's own chrome (#5505): the header, the
 * Local / Georeference tabs, and the two tabs' empty/start states. The Local
 * tab's form controls stay catalogued in `reposition-panel.en.ts` (unchanged,
 * moved verbatim from the floating `RepositionPanel`), and the Georeference
 * tab's metrics/nudge/apply chrome stays in `cesium-geo.en.ts` (unchanged,
 * moved verbatim from the floating `CesiumPlacementEditor`).
 */
export const placementPanelEn = {
  'placementPanel.title': 'Placement',
  'placementPanel.headerCloseTitle': 'Close placement panel',
  'placementPanel.tabs.local': 'Local',
  'placementPanel.tabs.georeference': 'Georeference',

  'placementPanel.local.emptyTitle': 'No models selected',
  'placementPanel.local.emptyHint': 'Choose the models to move, then start repositioning.',
  'placementPanel.local.startButton': 'Start repositioning',

  'placementPanel.georeference.emptyTitle': 'No georeferenced model',
  'placementPanel.georeference.emptyHint': 'Load a model with a map conversion (IfcMapConversion) to edit its site anchor here.',
  'placementPanel.georeference.editToggleOn': 'Editing',
  'placementPanel.georeference.editToggleOff': 'Edit anchor',
  'placementPanel.georeference.startHint': 'Drag the plane and height handle in the 3D view, or nudge the anchor below.',
} as const satisfies Record<string, TranslationValue>;
