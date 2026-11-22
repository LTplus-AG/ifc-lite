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

import type { useViewerStore } from '@/store';
import { A2UI_DEMO_PROMPT, A2UI_DEMO_REPLY } from './demo-reply.js';

/** The viewer store, passed in so this chunk imports nothing the entry already loaded. */
export type DemoStore = Pick<typeof useViewerStore, 'getState' | 'subscribe'>;

const CHUNK_CHARS = 32;
const CHUNK_MS = 25;

function modelReady(store: DemoStore): boolean {
  return [...store.getState().models.values()].some((m) => !!m.ifcDataStore);
}

export async function playA2uiDemo(viewerStore: DemoStore, reply = A2UI_DEMO_REPLY, prompt = A2UI_DEMO_PROMPT): Promise<void> {
  const store = viewerStore.getState();
  if (store.chatStatus === 'streaming' || store.chatStatus === 'sending') return;
  // The chat lives in the script panel, so open both.
  store.setScriptPanelVisible(true);
  store.setChatPanelVisible(true);
  store.addChatMessage({ id: crypto.randomUUID(), role: 'user', content: prompt, createdAt: Date.now() });
  store.setChatStatus('streaming');
  for (let end = CHUNK_CHARS; end < reply.length; end += CHUNK_CHARS) {
    viewerStore.getState().updateLastAssistantMessage(reply.slice(0, end));
    await new Promise((resolve) => setTimeout(resolve, CHUNK_MS));
  }
  viewerStore.getState().finalizeAssistantMessage(reply);
}

/** Play the demo once, as soon as a model with data is loaded. */
export function armA2uiDemo(store: DemoStore): void {
  if (modelReady(store)) {
    void playA2uiDemo(store);
    return;
  }
  const unsubscribe = store.subscribe(() => {
    if (!modelReady(store)) return;
    unsubscribe();
    void playA2uiDemo(store);
  });
}
