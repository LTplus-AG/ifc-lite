/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { TranslationKey } from '@/i18n';
export type ArtifactPreset = 'wall-measurement-list' | 'ifc-class-count-chart';
/** Intent belongs to the clicked action, never to translated or edited text. */
export function artifactPresetForSuggestion(key: TranslationKey): ArtifactPreset | undefined {
  if (key === 'assistantArtifacts.suggestList') return 'wall-measurement-list';
  if (key === 'assistantArtifacts.suggestChart') return 'ifc-class-count-chart';
  return undefined;
}
