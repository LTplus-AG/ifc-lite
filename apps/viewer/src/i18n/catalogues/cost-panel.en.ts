/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

export const costPanelEn = {
  'costPanel.title': 'Cost',
  'costPanel.close': 'Close',
  'costPanel.noModelsLoaded': 'No models loaded.',
  'costPanel.dataUnavailable': 'Cost data unavailable — load the IFC source to inspect costs.',
  'costPanel.dataUnavailableWithError': 'Cost data unavailable: {message}',
  'costPanel.empty': 'No cost data in this model.',
  'costPanel.noItemsInModel': 'No cost items in this model.',
  'costPanel.noItemsInSchedule': 'No cost items assigned.',
  'costPanel.unassignedItems': 'Unassigned cost items',
  'costPanel.cyclicBadge': 'Nesting cycle detected',
  'costPanel.mixedCurrencyBadge': 'Mixed currency',
  'costPanel.selectPrompt': 'Select a cost item to inspect it.',
  'costPanel.itemUnavailable': 'This cost item is no longer available.',
  'costPanel.resolvedValue': 'Resolved value',
  'costPanel.unresolvedValue': 'Could not be evaluated from the loaded source.',
  'costPanel.schedule': 'Schedule',
  'costPanel.quantities': 'Quantities',
  'costPanel.assignedTargets': 'Assigned products / tasks',
  'costPanel.selectInViewport': 'Select in 3D',
  'costPanel.noAssignedTargets': 'No products or tasks assigned.',
  'costPanel.collapse': 'Collapse',
  'costPanel.expand': 'Expand',
  'costPanel.itemFallbackName': 'Cost item #{id}',
  'costPanel.scheduleFallbackName': 'Schedule #{id}',
  'costPanel.identification': 'ID {value}',
} as const satisfies Record<string, TranslationValue>;
