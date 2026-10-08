/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Assistant composer's unsent text (#6926). Held outside the panel so a
 * draft survives the panel unmounting: switching the narrow-layout sheet to
 * the source and back, moving the Assistant between dock, split and floating
 * hosts, or popping it out. Runtime only; a reload starts empty.
 */

import { create } from 'zustand';
import type { ArtifactPreset } from './artifacts/artifact-preset';

type PresetIntent = { preset: ArtifactPreset; evidenceId: string };
export const useAssistantDraft = create<{ text: string; intent: PresetIntent | null }>(() => ({ text: '', intent: null }));

export function setAssistantDraft(text: string, intent: PresetIntent | null = null): void {
  useAssistantDraft.setState({ text, intent });
}
