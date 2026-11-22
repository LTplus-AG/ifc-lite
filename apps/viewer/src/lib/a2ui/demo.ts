/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `?a2uiDemo=1`: once a model is loaded, open the chat and play a recorded
 * assistant reply through the same store fields a live model stream writes
 * (`chatStreamingContent`, then `finalizeAssistantMessage`), so the surfaces
 * build while the text streams, exactly as with a real reply. No API key and
 * no network request. Load the sample with `?model=/samples/building-architecture.ifc`.
 */

import { useViewerStore } from '@/store';
import { A2UI_DEMO_PROMPT, A2UI_DEMO_REPLY } from './demo-reply.js';

const CHUNK_CHARS = 32;
const CHUNK_MS = 25;

function modelReady(): boolean {
  return [...useViewerStore.getState().models.values()].some((m) => !!m.ifcDataStore);
}

export async function playA2uiDemo(reply = A2UI_DEMO_REPLY, prompt = A2UI_DEMO_PROMPT): Promise<void> {
  const store = useViewerStore.getState();
  if (store.chatStatus === 'streaming' || store.chatStatus === 'sending') return;
  store.setChatPanelVisible(true);
  store.addChatMessage({ id: crypto.randomUUID(), role: 'user', content: prompt, createdAt: Date.now() });
  store.setChatStatus('streaming');
  for (let end = CHUNK_CHARS; end < reply.length; end += CHUNK_CHARS) {
    useViewerStore.getState().updateLastAssistantMessage(reply.slice(0, end));
    await new Promise((resolve) => setTimeout(resolve, CHUNK_MS));
  }
  useViewerStore.getState().finalizeAssistantMessage(reply);
}

/** Play the demo once, as soon as a model with data is loaded. */
export function armA2uiDemo(): void {
  if (modelReady()) {
    void playA2uiDemo();
    return;
  }
  const unsubscribe = useViewerStore.subscribe(() => {
    if (!modelReady()) return;
    unsubscribe();
    void playA2uiDemo();
  });
}
