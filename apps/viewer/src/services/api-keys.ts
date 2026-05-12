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

export interface ApiKeyConfig {
  anthropicKey: string;
  openaiKey: string;
}

const STORAGE_KEY = 'ifc-lite:api-keys:v1';
const CHANGED_EVENT = 'ifc-lite:api-keys-changed';

const EMPTY_CONFIG: ApiKeyConfig = {
  anthropicKey: '',
  openaiKey: '',
};

function sanitize(value: unknown): ApiKeyConfig {
  const parsed = value && typeof value === 'object' ? (value as Partial<ApiKeyConfig>) : {};
  return {
    anthropicKey: typeof parsed.anthropicKey === 'string' ? parsed.anthropicKey.trim() : '',
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
  next.openaiKey = next.openaiKey.trim();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(CHANGED_EVENT));
  return next;
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
