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

import { canonicalModelId, getByokModelsForSource, getModelById } from '@/lib/llm/models';

const STORAGE_KEY = 'ifc-lite:playground-model:v1';
const CHANGED_EVENT = 'ifc-lite:playground-model-changed';

function isValidAnthropicModel(id: string): boolean {
  // Via getModelById so a retired id (see MODEL_ID_MIGRATIONS) still validates.
  return getModelById(id)?.source === 'anthropic';
}

/**
 * Default when nothing is in storage. Opus 5 plans a 25-tool loop better than
 * the cheaper entries and costs half what Fable 5 does, so it is worth naming
 * rather than taking whatever sorts first. It is checked against the registry
 * so a refresh that drops it degrades to the first Anthropic model instead of
 * sending a dead id to the API.
 */
const PREFERRED_MODEL = 'claude-opus-5';
const FALLBACK_MODEL = isValidAnthropicModel(PREFERRED_MODEL)
  ? PREFERRED_MODEL
  : (getByokModelsForSource('anthropic')[0]?.id ?? PREFERRED_MODEL);

export function getPlaygroundModel(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isValidAnthropicModel(stored)) return canonicalModelId(stored);
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
