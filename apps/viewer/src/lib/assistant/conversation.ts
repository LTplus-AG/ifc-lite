/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import type { EvidenceSnapshot } from './evidence';
import type { StreamMessage } from '@/lib/llm/stream-client';

interface ConversationState {
  snapshot: EvidenceSnapshot | null;
  messages: StreamMessage[];
  output: string;
  pendingPrompt: string | null;
  status: 'idle' | 'streaming' | 'error';
  error: string | null;
  controller: AbortController | null;
}
export const useAssistant = create<ConversationState>(() => ({
  snapshot: null, messages: [], pendingPrompt: null, output: '', status: 'idle', error: null, controller: null,
}));

export function replaceEvidence(snapshot: EvidenceSnapshot) {
  useAssistant.getState().controller?.abort();
  useAssistant.setState({ snapshot, messages: [], pendingPrompt: null, output: '', status: 'idle', error: null, controller: null });
}

export function cancelAssistant() {
  useAssistant.getState().controller?.abort();
  useAssistant.setState({ controller: null, pendingPrompt: null, status: 'idle', output: '' });
}
