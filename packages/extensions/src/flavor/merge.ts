/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Three-way flavor merger.
 *
 * Given a common ancestor (`base`) and two derived flavors (`ours`,
 * `theirs`), produce a merged result plus a list of conflicts that
 * need human resolution.
 *
 * Merge rules (mirror `05-flavors-and-sharing.md §5`):
 *   - Extensions: union by id. Version conflicts default to the
 *     higher semver; conflict is recorded for review.
 *   - Capabilities: per-extension intersection by default
 *     (more restrictive wins). Caller can opt up via post-processing.
 *   - Lenses, saved queries, keybindings: union by stable key.
 *     Same-key value conflicts surface in the conflict list.
 *   - Layout: theirs wins by default (newer import overrides).
 *   - Settings: per-key. Unknown keys take theirs; known-key
 *     conflicts surface for review.
 *   - Prompt overlay: appended with a separator; never silently
 *     overwritten.
 *
 * Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md §5.
 */

import type { Flavor, FlavorExtension, KeybindingOverride, SavedLens, SavedQuery } from './types.js';
import type { JsonValue } from '../types.js';

export interface MergeConflict {
  kind:
    | 'extension_version'
    | 'extension_capabilities'
    | 'lens'
    | 'saved_query'
    | 'keybinding'
    | 'setting';
  /** Stable identifier within the conflict kind (extension id, setting key, etc.). */
  key: string;
  /** Display-only labels. */
  ours: JsonValue;
  theirs: JsonValue;
  base?: JsonValue;
}

export interface MergeResult {
  merged: Flavor;
  conflicts: MergeConflict[];
}

/**
 * Merge two flavors derived from a common ancestor. Always produces a
 * result + conflict list, never throws on data shape (assumes inputs
 * have already passed `validateFlavor`).
 */
export function mergeFlavors(base: Flavor, theirs: Flavor, ours: Flavor): MergeResult {
  const conflicts: MergeConflict[] = [];

  const extensions = mergeExtensions(base, theirs, ours, conflicts);
  const lenses = mergeListById(theirs.lenses, ours.lenses, (l) => l.id, (key, t, o) => {
    conflicts.push({ kind: 'lens', key, ours: o as unknown as JsonValue, theirs: t as unknown as JsonValue });
  });
  const savedQueries = mergeListById(theirs.savedQueries, ours.savedQueries, (q) => q.id, (key, t, o) => {
    conflicts.push({ kind: 'saved_query', key, ours: o as unknown as JsonValue, theirs: t as unknown as JsonValue });
  });
  const keybindings = mergeListById(theirs.keybindings, ours.keybindings, (k) => `${k.command}@${k.key}`, (key, t, o) => {
    conflicts.push({ kind: 'keybinding', key, ours: o as unknown as JsonValue, theirs: t as unknown as JsonValue });
  });

  const settings = mergeSettings(base, theirs, ours, conflicts);
  const promptOverlay = mergePromptOverlay(theirs, ours);

  const merged: Flavor = {
    schemaVersion: 1,
    id: ours.id,
    name: ours.name,
    description: ours.description,
    createdAt: ours.createdAt,
    updatedAt: new Date().toISOString(),
    extensions,
    lenses,
    savedQueries,
    keybindings,
    layout: theirs.layout, // theirs wins
    settings,
    promptOverlay,
    author: ours.author,
  };

  return { merged, conflicts };
}

function mergeExtensions(
  base: Flavor,
  theirs: Flavor,
  ours: Flavor,
  conflicts: MergeConflict[],
): FlavorExtension[] {
  const byId = new Map<string, FlavorExtension>();
  const baseById = new Map(base.extensions.map((e) => [e.id, e]));
  const theirById = new Map(theirs.extensions.map((e) => [e.id, e]));
  const ourById = new Map(ours.extensions.map((e) => [e.id, e]));

  for (const id of unionKeys(theirById, ourById)) {
    const t = theirById.get(id);
    const o = ourById.get(id);
    const b = baseById.get(id);

    if (t && o) {
      // Both have it. Pick the higher version; record conflict if they
      // differ from base in incompatible ways.
      if (t.version !== o.version) {
        const winner = compareSemver(t.version, o.version) >= 0 ? t : o;
        const merged: FlavorExtension = {
          ...winner,
          grantedCapabilities: intersectCaps(t.grantedCapabilities, o.grantedCapabilities),
        };
        byId.set(id, merged);
        conflicts.push({
          kind: 'extension_version',
          key: id,
          ours: { version: o.version } as JsonValue,
          theirs: { version: t.version } as JsonValue,
          base: b ? { version: b.version } as JsonValue : undefined,
        });
      } else {
        const intersected = intersectCaps(t.grantedCapabilities, o.grantedCapabilities);
        if (!arraysEqual(intersected, t.grantedCapabilities) || !arraysEqual(intersected, o.grantedCapabilities)) {
          conflicts.push({
            kind: 'extension_capabilities',
            key: id,
            ours: o.grantedCapabilities as unknown as JsonValue,
            theirs: t.grantedCapabilities as unknown as JsonValue,
            base: b ? (b.grantedCapabilities as unknown as JsonValue) : undefined,
          });
        }
        byId.set(id, { ...o, grantedCapabilities: intersected });
      }
    } else if (t) {
      byId.set(id, t);
    } else if (o) {
      byId.set(id, o);
    }
  }

  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function mergeListById<T>(
  theirs: readonly T[],
  ours: readonly T[],
  keyOf: (item: T) => string,
  onConflict: (key: string, theirs: T, ours: T) => void,
): T[] {
  const byKey = new Map<string, T>();
  const theirsByKey = new Map(theirs.map((item) => [keyOf(item), item]));
  const oursByKey = new Map(ours.map((item) => [keyOf(item), item]));

  for (const key of unionKeys(theirsByKey, oursByKey)) {
    const t = theirsByKey.get(key);
    const o = oursByKey.get(key);
    if (t && o) {
      if (!deepEqual(t, o)) {
        onConflict(key, t, o);
        byKey.set(key, o); // ours wins by default; UI can override
      } else {
        byKey.set(key, o);
      }
    } else if (t) {
      byKey.set(key, t);
    } else if (o) {
      byKey.set(key, o);
    }
  }
  return Array.from(byKey.values());
}

function mergeSettings(
  base: Flavor,
  theirs: Flavor,
  ours: Flavor,
  conflicts: MergeConflict[],
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  const allKeys = new Set<string>([
    ...Object.keys(base.settings),
    ...Object.keys(theirs.settings),
    ...Object.keys(ours.settings),
  ]);
  for (const key of allKeys) {
    const t = theirs.settings[key];
    const o = ours.settings[key];
    const b = base.settings[key];
    const tPresent = key in theirs.settings;
    const oPresent = key in ours.settings;

    if (tPresent && oPresent) {
      if (deepEqual(t, o)) {
        out[key] = o;
      } else if (key in base.settings && deepEqual(b, o)) {
        // Ours unchanged from base; take theirs.
        out[key] = t;
      } else if (key in base.settings && deepEqual(b, t)) {
        // Theirs unchanged from base; take ours.
        out[key] = o;
      } else {
        // Both diverged from base differently — conflict.
        conflicts.push({ kind: 'setting', key, ours: o, theirs: t, base: b });
        out[key] = o; // ours wins by default
      }
    } else if (tPresent) {
      out[key] = t;
    } else if (oPresent) {
      out[key] = o;
    }
  }
  return out;
}

function mergePromptOverlay(theirs: Flavor, ours: Flavor): Flavor['promptOverlay'] {
  const t = theirs.promptOverlay?.content;
  const o = ours.promptOverlay?.content;
  if (!t && !o) return undefined;
  if (!t) return ours.promptOverlay;
  if (!o) return theirs.promptOverlay;
  if (t === o) return ours.promptOverlay;
  return {
    content: `${o}\n\n<!-- imported -->\n${t}`,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function unionKeys<V>(a: Map<string, V>, b: Map<string, V>): string[] {
  return Array.from(new Set([...a.keys(), ...b.keys()])).sort();
}

function intersectCaps(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((cap) => set.has(cap)).sort();
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Returns 1 if a > b, -1 if a < b, 0 if equal. Pre-release tags are ignored. */
function compareSemver(a: string, b: string): number {
  const [ap, ar = ''] = a.split('-', 2);
  const [bp, br = ''] = b.split('-', 2);
  const ax = ap.split('.').map(Number);
  const bx = bp.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const av = ax[i] ?? 0;
    const bv = bx[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  // Equal main version. Empty pre-release sorts higher than any.
  if (ar === '' && br !== '') return 1;
  if (br === '' && ar !== '') return -1;
  if (ar > br) return 1;
  if (ar < br) return -1;
  return 0;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((key) => deepEqual(ao[key], bo[key]));
}
