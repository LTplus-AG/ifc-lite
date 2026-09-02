/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BYOK (Bring Your Own Key) API key storage.
 *
 * Stores user-provided API keys for Anthropic and OpenAI in localStorage.
 * Keys are sent directly from the browser to the provider APIs — they never
 * pass through our server proxy.
 */

import { posthog } from '../lib/analytics';

export type ApiKeyProvider = 'anthropic' | 'openai';

export interface ApiKeyConfig {
  anthropicKey: string;
  /** Sent as `anthropic-workspace-id`; see `lib/llm/anthropic-client.ts`. */
  anthropicWorkspaceId: string;
  openaiKey: string;
}

const STORAGE_KEY = 'ifc-lite:api-keys:v1';
const CHANGED_EVENT = 'ifc-lite:api-keys-changed';

const EMPTY_CONFIG: ApiKeyConfig = {
  anthropicKey: '',
  anthropicWorkspaceId: '',
  openaiKey: '',
};

function sanitize(value: unknown): ApiKeyConfig {
  const parsed = value && typeof value === 'object' ? (value as Partial<ApiKeyConfig>) : {};
  return {
    anthropicKey: typeof parsed.anthropicKey === 'string' ? parsed.anthropicKey.trim() : '',
    anthropicWorkspaceId:
      typeof parsed.anthropicWorkspaceId === 'string' ? parsed.anthropicWorkspaceId.trim() : '',
    openaiKey: typeof parsed.openaiKey === 'string' ? parsed.openaiKey.trim() : '',
  };
}

export function getApiKeys(): ApiKeyConfig {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

export function updateApiKeys(updates: Partial<ApiKeyConfig>): ApiKeyConfig {
  const next = { ...getApiKeys(), ...updates };
  // Trim keys before saving
  next.anthropicKey = next.anthropicKey.trim();
  next.anthropicWorkspaceId = next.anthropicWorkspaceId.trim();
  next.openaiKey = next.openaiKey.trim();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(CHANGED_EVENT));
  posthog.capture('byok_key_saved', {
    // Every write lands here, so the event name undercounts nothing and
    // overcounts key saves: a workspace-id edit and a key save were previously
    // indistinguishable. Naming the fields written keeps the funnel readable
    // and answers the question the workspace field raises — how many BYOK
    // users need one — without a second event.
    saved_fields: Object.keys(updates).sort().join(','),
    has_anthropic: next.anthropicKey.length > 0,
    has_anthropic_workspace: next.anthropicWorkspaceId.length > 0,
    has_openai: next.openaiKey.length > 0,
  });
  return next;
}

/**
 * Which stored field holds each provider's key, and which fields are bound to
 * that key and must not outlive it.
 *
 * The rule below is about credentials, not about Anthropic. Stating it with a
 * per-provider branch instead of a table is how the next companion field — an
 * OpenAI org or project id, say — would quietly inherit a passthrough and keep
 * a stale value bound to a replaced key: this change's own bug, one provider
 * over. Adding a field here is the whole of adopting clear-on-replace and
 * {@link clearProvider}. It is NOT the whole of adopting the field: the save
 * path below still names `anthropicWorkspaceId` directly, because the form's
 * draft shape does. Generalise that too when a second companion field exists,
 * rather than trusting this comment to have covered it.
 */
const KEY_FIELD: Record<ApiKeyProvider, keyof ApiKeyConfig> = {
  anthropic: 'anthropicKey',
  openai: 'openaiKey',
};

const KEY_COMPANIONS: Record<ApiKeyProvider, Array<keyof ApiKeyConfig>> = {
  anthropic: ['anthropicWorkspaceId'],
  openai: [],
};

/**
 * The fields a key write touches, clear-on-replace included.
 *
 * A new Anthropic key drops the stored workspace id with it. The id names a
 * workspace the OLD key could reach; carrying it over sends every request to a
 * workspace the new key was never granted, and the 400 that comes back names a
 * workspace the user does not remember choosing. Re-entering an id is one
 * paste, and the error message says to — chasing a stale one is not. This
 * matters most on the path the walkthrough now recommends: replacing a
 * multi-workspace key with one scoped to a single workspace.
 *
 * Only a key that actually differs drops it. Re-pasting the same key — what
 * someone does when a request fails and they want to be sure the key is set —
 * changes no binding, so discarding a still-correct id there would create the
 * failure the user was checking for. And "replaces" needs a previous key to
 * replace: with none stored, the id was entered for THIS key, since a fresh
 * user can fill the visible workspace box before pasting the key.
 */
function keyWriteUpdates(
  stored: ApiKeyConfig,
  provider: ApiKeyProvider,
  apiKey: string,
): Partial<ApiKeyConfig> {
  const field = KEY_FIELD[provider];
  const updates: Partial<ApiKeyConfig> = { [field]: apiKey };
  const replacesKey = stored[field] !== '' && apiKey.trim() !== stored[field];
  if (replacesKey) {
    for (const companion of KEY_COMPANIONS[provider]) updates[companion] = '';
  }
  return updates;
}

/**
 * Commit one provider's credential form in a single write.
 *
 * `apiKey` empty means "keep the stored key": the key box is a replace field
 * that starts blank, so an empty one is not a request to clear anything.
 *
 * `workspaceId` undefined means the user did not touch that box, so
 * {@link keyWriteUpdates}'s clear-on-replace rule stands. A string means what
 * they typed wins over that rule — which is what lets someone paste a new key
 * and the new key's workspace id together and have both survive. While these
 * were two separate saves, the ordinary first run dropped the id silently and
 * the request went out headerless while the box still displayed it.
 */
export function saveCredential(
  provider: ApiKeyProvider,
  draft: { apiKey: string; workspaceId?: string },
): ApiKeyConfig {
  const stored = getApiKeys();
  const apiKey = draft.apiKey.trim();
  // Genuinely ONE write. Two calls would fire `byok_key_saved` twice per click,
  // and the first would report `has_anthropic_workspace: false` for a user in
  // the act of saving one — miscounting the exact population that property
  // exists to measure.
  const updates: Partial<ApiKeyConfig> = apiKey
    ? keyWriteUpdates(stored, provider, apiKey)
    : {};
  if (provider === 'anthropic' && draft.workspaceId !== undefined) {
    updates.anthropicWorkspaceId = draft.workspaceId;
  }
  return Object.keys(updates).length > 0 ? updateApiKeys(updates) : stored;
}

/**
 * Drop one provider's whole credential — the key and everything bound to it.
 *
 * Same table as {@link keyWriteUpdates}, for the same reason: the pairing is a
 * fact about the credential, not about whichever surface offers the button.
 */
export function clearProvider(provider: ApiKeyProvider): ApiKeyConfig {
  const updates: Partial<ApiKeyConfig> = { [KEY_FIELD[provider]]: '' };
  for (const companion of KEY_COMPANIONS[provider]) updates[companion] = '';
  return updateApiKeys(updates);
}

export function clearApiKeys(): ApiKeyConfig {
  localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(CHANGED_EVENT));
  return { ...EMPTY_CONFIG };
}

export function subscribeApiKeys(listener: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHANGED_EVENT, listener);
}

export function hasAnthropicKey(): boolean {
  return getApiKeys().anthropicKey.length > 0;
}

export function hasOpenaiKey(): boolean {
  return getApiKeys().openaiKey.length > 0;
}

export function hasAnyApiKey(): boolean {
  return hasAnthropicKey() || hasOpenaiKey();
}
