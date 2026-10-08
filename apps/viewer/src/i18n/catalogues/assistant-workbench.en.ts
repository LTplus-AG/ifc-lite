/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Coordinator layout preset, Assistant placement and return target, restrained
 * Assistant announcements and the answer language (#6926, U03):
 * `LayoutPresetSection.tsx`, `AssistantPlacementMenu.tsx`,
 * `AssistantAnnouncer.tsx`, `GenerationLanguagePicker.tsx`.
 */
export const assistantWorkbenchEn = {
  'layoutPresets.heading': 'Layout presets',
  'layoutPresets.paletteLabel': 'Layout presets…',
  'layoutPresets.coordinator.title': 'Coordinator review',
  'layoutPresets.coordinator.description': 'Clash detection docked above BCF topics; Data validation, Compare and the Assistant first on the rail.',
  'layoutPresets.preview': 'Preview',
  'layoutPresets.previewLabel': 'Preview {preset}',
  'layoutPresets.apply': 'Apply',
  'layoutPresets.applyLabel': 'Apply {preset}',
  'layoutPresets.active': 'Active',
  'layoutPresets.restore': 'Restore my layout',
  'layoutPresets.restoreHint': 'Puts back the rail, docked panels and Assistant placement you had before applying a preset.',
  'layoutPresets.changesHeading': 'Applying this preset:',
  'layoutPresets.noChanges': 'Your layout already matches this preset.',
  'layoutPresets.unchanged': 'Floating panels, pop-out windows, the bottom strip, the hierarchy pane, widths and your other hidden panels stay as they are.',
  'layoutPresets.change.railFirst': 'Moves to the top of the rail: {panels}',
  'layoutPresets.change.railShown': 'Shows on the rail again: {panels}',
  'layoutPresets.change.expand': 'Expands the sidebar',
  'layoutPresets.change.dock': 'Docks {primary}',
  'layoutPresets.change.dockSplit': 'Docks {primary} with {secondary} below it',
  'layoutPresets.change.keepDetached': 'Leaves where you put them: {panels}',
  'layoutPresets.change.assistantSplit': 'The Assistant opens below its source panel',
  'layoutPresets.change.assistantDock': 'The Assistant opens in the side dock',
  'layoutPresets.change.assistantFloating': 'The Assistant opens in a floating window',
  'layoutPresets.change.reserved': 'Keeps a place for {panels}, not available yet',
  'layoutPresets.reserved.review': 'Review workspace',
  'layoutPresets.applied': '{preset} layout applied.',
  'layoutPresets.restored': 'Your previous layout is restored.',

  'assistantPlacement.menu': 'Where the Assistant opens',
  'assistantPlacement.split': 'Below the source panel',
  'assistantPlacement.dock': 'In the side dock',
  'assistantPlacement.floating': 'In a floating window',
  'assistantPlacement.back': 'Back to {panel}',

  'assistantA11y.answering': 'Asking the model. The answer is announced when it is complete.',
  'assistantA11y.answered': 'Answer received.',
  'assistantA11y.cancelled': 'Request cancelled.',
  'assistantA11y.conversation': 'Conversation',
  'assistantA11y.answer': 'Answer {index}',

  'assistantLanguage.label': 'Answer language',
  'assistantLanguage.hint': 'Names and values from the model keep their original spelling.',
} as const satisfies Record<string, TranslationValue>;
