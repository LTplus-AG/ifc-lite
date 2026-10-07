/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '../storage/content-library';
import { assistantContent, type SavedConversation } from './persistence';
import { useAssistant, cancelAssistant } from './conversation';
import { currentConversationLanguage } from './language';

export const useAssistantLibrary = create<{ entries: SavedConversation[]; status: ContentStatus }>(() => ({ entries: [], status: initialContentStatus() }));
export const assistantLibrary = createContentLibrary(assistantContent,
  () => useAssistantLibrary.getState().entries,
  (entries, status) => useAssistantLibrary.setState({ entries, status }));

export function openConversation(entry: SavedConversation): void {
  cancelAssistant();
  // Archived evidence is never treated as current, even if model names happen to match.
  useAssistant.setState({ snapshot: null, archived: structuredClone(entry), messages: entry.messages,
    error: null, status: 'idle', output: '', pendingPrompt: null, language: entry.language ?? currentConversationLanguage() });
}
