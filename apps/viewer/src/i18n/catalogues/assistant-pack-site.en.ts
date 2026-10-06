/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** Assistant evidence adapters in `lib/assistant/adapters/pack-site.ts` (#6833). */
export const assistantPackSiteEn = {
  'assistantSources.zones.description': 'Which zone each element falls in, with its mesh volume per zone and the reason when a volume is missing',
  'assistantSources.zones.rows': 'Each row is one element in one zone it reaches, with its volume share',
  'assistantSources.zones.unavailable': 'No zone assignment is available. Create a zone set and let the elements be assigned first.',
  'assistantSources.zones.suggestSummary': 'Summarise how the elements are distributed across the zones',
  'assistantSources.zones.suggestUnmeasured': 'Which elements have no measured volume, and why?',
  'assistantSources.zones.noSets': 'No zone sets',
  'assistantSources.zones.notAssigned': 'Elements not assigned yet',
  'assistantSources.zones.ready': { one: '{count} zone set', other: '{count} zone sets' },

  'assistantSources.placement.description': 'Each model\'s workspace move and heading, its georeference and any double georeference',
  'assistantSources.placement.rows': 'Each row is one loaded model with its placement and georeference',
  'assistantSources.placement.unavailable': 'No model is loaded, so there is no placement to discuss.',
  'assistantSources.placement.suggestAlignment': 'Are the loaded models placed consistently with each other?',
  'assistantSources.placement.suggestGeoref': 'Explain the georeference of each model and anything that looks wrong',

  'assistantSources.layerDiff.title': 'Layer changes',
  'assistantSources.layerDiff.description': 'What one IFCX layer adds, changes and deletes in the composed stack',
  'assistantSources.layerDiff.rows': 'Each row is one path the layer added, modified or deleted',
  'assistantSources.layerDiff.unavailable': 'No layer diff has been computed. Open a layer\'s changes in the Layers panel first.',
  'assistantSources.layerDiff.suggestSummary': 'Summarise what this layer changes',
  'assistantSources.layerDiff.suggestReview': 'What should a reviewer check before accepting this layer?',
  'assistantSources.layerDiff.noStack': 'No layer stack loaded',
  'assistantSources.layerDiff.running': 'Computing layer changes',
  'assistantSources.layerDiff.notRun': 'No layer changes opened',
  'assistantSources.layerDiff.ready': { one: '{count} change', other: '{count} changes' },

  'assistantSources.selection.title': 'Selection',
  'assistantSources.selection.description': 'The selected elements with their attributes, property sets and quantities, edits included',
  'assistantSources.selection.rows': 'Each row is one selected element as the Properties panel shows it',
  'assistantSources.selection.unavailable': 'Nothing is selected. Select one or more elements first.',
  'assistantSources.selection.suggestExplain': 'Explain what is selected and anything notable about it',
  'assistantSources.selection.suggestCompare': 'How do the selected elements differ from each other?',
  'assistantSources.selection.none': 'Nothing selected',
  'assistantSources.selection.ready': { one: '{count} element selected', other: '{count} elements selected' },
} as const satisfies Record<string, TranslationValue>;
