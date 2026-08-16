/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginManifest } from '@ifc-lite/plugin-api';

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

/** Manifest-declared preference defaults, e.g. `{ region: 'eu' }` for every pref carrying a `default`. */
export function manifestPreferenceDefaults(manifest: PluginManifest): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const pref of manifest.preferences) {
    if (pref.default !== undefined) defaults[pref.name] = pref.default;
  }
  return defaults;
}

/**
 * The preference values a provider should actually run with: manifest
 * defaults, overridden by whatever the user saved. Every `createContext`
 * call site must use this rather than the raw saved record — otherwise a
 * declared default is shown in the settings form but never reaches
 * `ctx.getPreference`.
 */
export function loadResolvedSourcePrefs(manifest: PluginManifest): Record<string, string> {
  return { ...manifestPreferenceDefaults(manifest), ...loadSavedSourcePrefs(manifest.name) };
}

/**
 * Whether every preference the manifest marks `required` has a non-blank
 * value. Gates both "Browse" on the provider row and a favourite's jump, which
 * have to agree — a favourite that opens a browser the row itself refuses to
 * open would dead-end on the provider's own "missing API key" error.
 */
export function isPrefsConfigured(manifest: PluginManifest, prefs: Record<string, string>): boolean {
  return manifest.preferences
    .filter((pref) => pref.required)
    .every((pref) => Boolean(prefs[pref.name]?.trim()));
}

export function saveSourcePrefs(providerId: string, values: Record<string, string>): void {
  try {
    localStorage.setItem(PREFS_KEY_PREFIX + providerId, JSON.stringify(values));
  } catch (err) {
    console.warn(`[sources] Failed to save prefs for "${providerId}" (storage unavailable?)`, err);
  }
}

/** Clears saved preferences (including any stored API key) for a provider. */
export function clearSourcePrefs(providerId: string): void {
  try {
    localStorage.removeItem(PREFS_KEY_PREFIX + providerId);
  } catch (err) {
    console.warn(`[sources] Failed to clear prefs for "${providerId}"`, err);
  }
}
