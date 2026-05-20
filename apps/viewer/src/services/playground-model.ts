/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-tab persistence for the model the /mcp/playground chat uses.
 *
 * The playground driver calls Anthropic's `messages.create` with the native
 * tools API, so the selected model must be Anthropic. We keep a separate
 * preference from the viewer's `chatActiveModel` so the two pages can default
 * differently — the viewer often runs on a free proxy model, while playground
 * users have already opted into BYOK by being here.
 */

import { getByokModelsForSource } from '@/lib/llm/models';

const STORAGE_KEY = 'ifc-lite:playground-model:v1';
const CHANGED_EVENT = 'ifc-lite:playground-model-changed';

/**
 * Default fallback when nothing is in storage. Sonnet hits the sweet spot for
 * tool-calling agentic loops — fast enough for 25 sequential tool calls,
 * smart enough to pick the right tool. Opus 4.7 is better at planning but
 * costs ~3x; Haiku is faster but more likely to mis-pick tools.
 */
const FALLBACK_MODEL = 'claude-sonnet-4-6';

function isValidAnthropicModel(id: string): boolean {
  return getByokModelsForSource('anthropic').some((m) => m.id === id);
}

export function getPlaygroundModel(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isValidAnthropicModel(stored)) return stored;
  } catch {
    /* localStorage blocked / quota-exceeded — fall through to default */
  }
  return FALLBACK_MODEL;
}

export function setPlaygroundModel(modelId: string): void {
  if (!isValidAnthropicModel(modelId)) return;
  try {
    localStorage.setItem(STORAGE_KEY, modelId);
  } catch {
    /* storage write failed — selection only lives for this tab session */
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function subscribePlaygroundModel(listener: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHANGED_EVENT, listener);
}
