/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The no-model state of a model-dependent workspace panel
 * (`components/viewer/PanelModelGate.tsx`): what a panel opened on an empty
 * viewer says. Its two buttons reuse the welcome card's own labels
 * (`viewportLighting.container.emptyState.*`): one action, one name.
 */
export const panelNoModelEn = {
  'panelNoModel.title': 'No model loaded',
  'panelNoModel.description': '{panel} works on a model. Load the demo project, or open your own file.',
  'panelNoModel.bannerDescription': 'No model loaded. {panel} needs one to show results.',
  'panelNoModel.dropHint': 'or drop a file anywhere in the window',
  'panelNoModel.close': 'Close panel',
} as const;
