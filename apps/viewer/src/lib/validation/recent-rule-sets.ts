/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Recent rule sets" — a localStorage-backed cache of the last few
 * `.rules.json` files opened or saved from `ValidationPanel`'s empty state
 * (#5138 plan §6). Path-less by design (a browser file picker never returns
 * a reusable path): it stores the file CONTENT, the same posture
 * `lib/search/saved-filters.ts` uses for saved filter presets, capped at 10
 * entries x 256 KB so a large rule set can't fill the origin's quota.
 */

import { optionalLocalStorage } from '../storage/unreadable-entry.js';

const STORAGE_KEY = 'ifc-lite:validation:recent-rule-sets';
const MAX_ENTRIES = 10;
const MAX_BYTES = 256 * 1024;

export interface RecentRuleSet {
  /** The rule set's own `name` field, for display — not a filename. */
  name: string;
  /** The full `.rules.json` text, re-parsed with `parseRuleSetFile` on open. */
  content: string;
  savedAt: number;
}

function isRecentRuleSet(v: unknown): v is RecentRuleSet {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === 'string' && typeof o.content === 'string' && typeof o.savedAt === 'number';
}

/** Every cached entry, most-recently-saved first. Never throws — a
 *  corrupt/oversized/blocked catalog reads back as empty. */
export function loadRecentRuleSets(): RecentRuleSet[] {
  const storage = optionalLocalStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentRuleSet).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/**
 * Cache `content` under `name`, replacing any existing entry with the same
 * name and evicting the oldest once the cap is reached. An entry over
 * `MAX_BYTES` is silently NOT cached (the rule set itself is still
 * saved/opened normally — this cache is a convenience, not the source of
 * truth) rather than failing the caller's save/open action.
 */
export function addRecentRuleSet(name: string, content: string): RecentRuleSet[] {
  const storage = optionalLocalStorage();
  const existing = loadRecentRuleSets();
  if (content.length > MAX_BYTES) return existing;
  const next = [
    { name, content, savedAt: Date.now() },
    ...existing.filter((e) => e.name !== name),
  ].slice(0, MAX_ENTRIES);
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      console.warn(`[ifc-lite] recent rule sets could not be written to "${STORAGE_KEY}".`, error);
      return existing;
    }
  }
  return next;
}

/** Drop the entry named `name` (a cached file that turned out to be
 *  unreadable — corrupt JSON, or JSON that fails `parseRuleSetFile`).
 *  Returns the resulting list so callers can refresh UI without a
 *  second read. */
export function removeRecentRuleSet(name: string): RecentRuleSet[] {
  const storage = optionalLocalStorage();
  const next = loadRecentRuleSets().filter((e) => e.name !== name);
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      console.warn(`[ifc-lite] recent rule sets could not be written to "${STORAGE_KEY}".`, error);
    }
  }
  return next;
}
