/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persistent "yes, download this model" consent per local-model id.
 *
 * Stored in localStorage because the consent set is small (one entry per
 * model the user has ever agreed to download), and we want this to be a
 * synchronous read from the chat send path.
 */

const STORAGE_KEY = 'ifc-lite:webllm-consent:v1';

type ConsentRecord = Record<string, true>;

const listeners = new Set<() => void>();

function read(): ConsentRecord {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ConsentRecord) : {};
  } catch {
    return {};
  }
}

function write(next: ConsentRecord): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort — quota exhaustion just means we re-prompt next session
  }
  for (const l of listeners) {
    try { l(); } catch { /* swallow listener errors */ }
  }
}

export function hasWebLLMConsent(modelId: string): boolean {
  return read()[modelId] === true;
}

export function grantWebLLMConsent(modelId: string): void {
  const next = read();
  if (next[modelId] === true) return;
  next[modelId] = true;
  write(next);
}

export function revokeWebLLMConsent(modelId: string): void {
  const next = read();
  if (next[modelId] !== true) return;
  delete next[modelId];
  write(next);
}

export function subscribeWebLLMConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
