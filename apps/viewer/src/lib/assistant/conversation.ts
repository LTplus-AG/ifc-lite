/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SavedConversation, AssistantMessage } from './persistence';
import { create } from 'zustand';
import type { EvidenceSnapshot } from './evidence';
import type { RootBudget } from '@ifc-lite/ai';
import { createRootBudget } from '../llm/root-budget';
import { currentConversationLanguage, isLanguageTag, setGenerationLanguagePreference, type ConversationLanguage } from './language';

interface ConversationState {
  snapshot: EvidenceSnapshot | null;
  archived: SavedConversation | null;
  messages: AssistantMessage[];
  output: string;
  pendingPrompt: string | null;
  status: 'idle' | 'streaming' | 'error';
  error: string | null;
  controller: AbortController | null;
  /** One root budget per evidence snapshot: every send, retry and repair follow-up draws on it. */
  budget: RootBudget;
  /** UI locale at start and the language answers are written in; saved with the conversation. */
  language: ConversationLanguage;
}
export const useAssistant = create<ConversationState>(() => ({
  snapshot: null, archived: null, messages: [], pendingPrompt: null, output: '', status: 'idle', error: null, controller: null,
  budget: createRootBudget(), language: currentConversationLanguage(),
}));

export function replaceEvidence(snapshot: EvidenceSnapshot) {
  useAssistant.getState().controller?.abort();
  useAssistant.setState({ snapshot, archived: null, messages: [], pendingPrompt: null, output: '', status: 'idle', error: null, controller: null,
    budget: createRootBudget(), language: currentConversationLanguage() });
}

/** Change the language later answers in this conversation are written in; also the default for new ones. */
export function setConversationGenerationLanguage(generation: string) {
  if (!isLanguageTag(generation)) return;
  setGenerationLanguagePreference(generation);
  useAssistant.setState(s => ({ language: { ...s.language, generation } }));
}

export function cancelAssistant() {
  useAssistant.getState().controller?.abort();
  useAssistant.setState({ controller: null, pendingPrompt: null, status: 'idle', output: '' });
}
