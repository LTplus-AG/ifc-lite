/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const PREFS_KEY_PREFIX = 'ifc-lite-source-prefs:';

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

export function loadSavedSourcePrefs(providerId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(PREFS_KEY_PREFIX + providerId);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isStringRecord(parsed)) {
      console.warn(`Ignoring malformed saved source prefs for "${providerId}"`);
      return {};
    }
    return parsed;
  } catch (err) {
    console.warn(`Failed to parse saved source prefs for "${providerId}"`, err);
    return {};
  }
}

export function saveSourcePrefs(providerId: string, values: Record<string, string>): void {
  localStorage.setItem(PREFS_KEY_PREFIX + providerId, JSON.stringify(values));
}

/** Clears saved preferences (including any stored API key) for a provider. */
export function clearSourcePrefs(providerId: string): void {
  localStorage.removeItem(PREFS_KEY_PREFIX + providerId);
}
