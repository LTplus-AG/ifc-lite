/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flavor diff computer.
 *
 * Compare two flavors and produce a structured difference suitable for
 * the import-review UI. Extensions, lenses, saved queries, keybindings,
 * settings, and the prompt overlay each diff independently.
 *
 * Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md §4.
 */

import type { Flavor, FlavorExtension, KeybindingOverride, SavedLens, SavedQuery } from './types.js';
import type { JsonValue } from '../types.js';

export interface FlavorDiff {
  extensions: ExtensionDiff;
  lenses: ListDiff<SavedLens>;
  savedQueries: ListDiff<SavedQuery>;
  keybindings: ListDiff<KeybindingOverride>;
  settings: SettingsDiff;
  promptOverlay: PromptOverlayDiff;
}

export interface ExtensionDiff {
  added: FlavorExtension[];
  removed: FlavorExtension[];
  versionChanged: Array<{
    id: string;
    from: string;
    to: string;
    capabilitiesAdded: string[];
    capabilitiesRemoved: string[];
  }>;
  capabilityChanged: Array<{
    id: string;
    added: string[];
    removed: string[];
  }>;
  unchanged: string[];
}

export interface ListDiff<T> {
  added: T[];
  removed: T[];
  changed: Array<{ ours: T; theirs: T }>;
}

export interface SettingsDiff {
  added: Record<string, JsonValue>;
  removed: string[];
  changed: Array<{ key: string; ours: JsonValue; theirs: JsonValue }>;
}

export interface PromptOverlayDiff {
  /** True iff the overlay text changed (or appeared / disappeared). */
  changed: boolean;
  /** Previous content (theirs side of the comparison). */
  from?: string;
  /** New content (ours side). */
  to?: string;
}

/**
 * Compute the structured diff `ours - theirs`. Result describes how to
 * transform `theirs` into `ours`.
 *
 * Naming convention: `ours` is the user's active flavor; `theirs` is
 * the flavor being compared against (e.g. imported file, registry
 * version).
 */
export function diffFlavors(theirs: Flavor, ours: Flavor): FlavorDiff {
  return {
    extensions: diffExtensions(theirs.extensions, ours.extensions),
    lenses: diffById(theirs.lenses, ours.lenses, (l) => l.id),
    savedQueries: diffById(theirs.savedQueries, ours.savedQueries, (q) => q.id),
    keybindings: diffById(theirs.keybindings, ours.keybindings, (k) => `${k.command}@${k.key}`),
    settings: diffSettings(theirs.settings, ours.settings),
    promptOverlay: diffPromptOverlay(theirs.promptOverlay?.content, ours.promptOverlay?.content),
  };
}

function diffExtensions(
  theirs: readonly FlavorExtension[],
  ours: readonly FlavorExtension[],
): ExtensionDiff {
  const theirsById = new Map(theirs.map((e) => [e.id, e]));
  const oursById = new Map(ours.map((e) => [e.id, e]));

  const added: FlavorExtension[] = [];
  const removed: FlavorExtension[] = [];
  const versionChanged: ExtensionDiff['versionChanged'] = [];
  const capabilityChanged: ExtensionDiff['capabilityChanged'] = [];
  const unchanged: string[] = [];

  for (const ext of ours) {
    const theirCopy = theirsById.get(ext.id);
    if (!theirCopy) {
      added.push(ext);
      continue;
    }
    if (theirCopy.version !== ext.version) {
      const caps = diffStringSets(theirCopy.grantedCapabilities, ext.grantedCapabilities);
      versionChanged.push({
        id: ext.id,
        from: theirCopy.version,
        to: ext.version,
        capabilitiesAdded: caps.added,
        capabilitiesRemoved: caps.removed,
      });
      continue;
    }
    const caps = diffStringSets(theirCopy.grantedCapabilities, ext.grantedCapabilities);
    if (caps.added.length > 0 || caps.removed.length > 0) {
      capabilityChanged.push({ id: ext.id, added: caps.added, removed: caps.removed });
      continue;
    }
    unchanged.push(ext.id);
  }
  for (const ext of theirs) {
    if (!oursById.has(ext.id)) removed.push(ext);
  }

  return { added, removed, versionChanged, capabilityChanged, unchanged };
}

function diffById<T>(
  theirs: readonly T[],
  ours: readonly T[],
  keyOf: (item: T) => string,
): ListDiff<T> {
  const theirsByKey = new Map(theirs.map((item) => [keyOf(item), item]));
  const oursByKey = new Map(ours.map((item) => [keyOf(item), item]));

  const added: T[] = [];
  const removed: T[] = [];
  const changed: Array<{ ours: T; theirs: T }> = [];

  for (const [key, value] of oursByKey) {
    const theirCopy = theirsByKey.get(key);
    if (!theirCopy) {
      added.push(value);
    } else if (!deepEqual(value, theirCopy)) {
      changed.push({ ours: value, theirs: theirCopy });
    }
  }
  for (const [key, value] of theirsByKey) {
    if (!oursByKey.has(key)) removed.push(value);
  }

  return { added, removed, changed };
}

function diffSettings(
  theirs: Record<string, JsonValue>,
  ours: Record<string, JsonValue>,
): SettingsDiff {
  const added: Record<string, JsonValue> = {};
  const removed: string[] = [];
  const changed: SettingsDiff['changed'] = [];

  for (const [k, v] of Object.entries(ours)) {
    if (!(k in theirs)) {
      added[k] = v;
    } else if (!deepEqual(theirs[k], v)) {
      changed.push({ key: k, ours: v, theirs: theirs[k] });
    }
  }
  for (const k of Object.keys(theirs)) {
    if (!(k in ours)) removed.push(k);
  }

  return { added, removed, changed };
}

function diffPromptOverlay(theirs?: string, ours?: string): PromptOverlayDiff {
  if (theirs === ours) return { changed: false, from: theirs, to: ours };
  return { changed: true, from: theirs, to: ours };
}

function diffStringSets(
  theirs: readonly string[],
  ours: readonly string[],
): { added: string[]; removed: string[] } {
  const theirsSet = new Set(theirs);
  const oursSet = new Set(ours);
  const added: string[] = [];
  const removed: string[] = [];
  for (const item of oursSet) if (!theirsSet.has(item)) added.push(item);
  for (const item of theirsSet) if (!oursSet.has(item)) removed.push(item);
  return { added, removed };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keys = Object.keys(aObj);
  if (keys.length !== Object.keys(bObj).length) return false;
  for (const key of keys) {
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}
