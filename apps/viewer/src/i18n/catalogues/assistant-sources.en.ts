/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Assistant's source register (#6833): picker groups and the explicit
 * reasons a panel has nothing to discuss. Per-source strings live in the
 * `assistant-pack-*.en.ts` catalogues beside their adapters.
 */
export const assistantSourcesEn = {
  'assistantSources.groupChecks': 'Checks',
  'assistantSources.groupCoordination': 'Coordination',
  'assistantSources.groupQuantities': 'Quantities',
  'assistantSources.groupModel': 'Model',
  'assistantSources.groupAutomation': 'Automation',
  'assistantSources.unsupportedTitle': 'Not discussable',
  'assistantSources.unsupportedHint': 'These panels have no native analysis result to attach.',
  'assistantSources.boundaryAppearance': 'Display styling settings, not an analysis result.',
  'assistantSources.boundaryModel': 'Authoring tools. Discuss edits through Changes or Change sets.',
  'assistantSources.boundaryExtensions': 'Installed extensions and their permissions. Discuss an extension’s output in the panel that shows it.',
  'assistantSources.boundaryCollab': 'Live session roster and permissions; there is no analysis result.',
  'assistantSources.boundarySources': 'Cloud connections and retrieval. Credentials and endpoint grants are never evidence.',
  'assistantSources.boundaryPresentation': 'Saved camera views for presenting; there is no analysis result.',
  'assistantSources.boundaryAssistant': 'The Assistant itself. Saved conversations are reopened, not attached as evidence.',
  'assistantSources.boundaryEnvironment': 'Sky, lighting and sun-time display settings. No solar analysis is recorded, and display settings are not daylight performance.',
} as const satisfies Record<string, TranslationValue>;
