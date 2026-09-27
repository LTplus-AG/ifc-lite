/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CommandPalette search — fuzzy scoring, ranking, and "recent commands"
 * persistence. Split out of `CommandPalette.tsx`: these are pure functions
 * (no React, no store) that the palette component composes.
 */

import type { TranslationKey, TranslationParameters } from '@/i18n';

export type Category =
  | 'Recent'
  | 'File'
  | 'View'
  | 'Tools'
  | 'Visibility'
  | 'Panels'
  | 'Export'
  | 'Automation'
  | 'Preferences'
  | 'Extensions'
  | 'Learn';

export interface Command {
  id: string;
  /**
   * English text used ONLY for search ranking (`rankCommand` below) — never
   * rendered. Commands with a `labelKey` are DISPLAYED via `t(labelKey, …)`
   * instead (#4918 slice 3); this stays because search matches by the
   * literal typed query, independent of the active locale.
   */
  label: string;
  /** When set, the row's display text — `t(labelKey, labelKeyParams)`. Data
   *  rows built from runtime content (recent files, tour titles, extension
   *  contributions, script templates) have none and render `label` as-is. */
  labelKey?: TranslationKey;
  labelKeyParams?: TranslationParameters;
  keywords: string;           // extra search tokens (no UI display)
  category: Exclude<Category, 'Recent'>;
  icon: React.ElementType;
  shortcut?: string;
  detail?: string;            // subtle secondary text (e.g. file size)
  /** Translated counterpart of `detail` — e.g. a tour's "{minutes} min". */
  detailKey?: TranslationKey;
  detailKeyParams?: TranslationParameters;
  action: () => void;
  /**
   * Run the action synchronously in the click handler instead of deferring to the
   * next animation frame — needed for a file dialog: Chrome only honours
   * `input.click()` / `showOpenFilePicker()` while transient user activation is
   * live, which a `requestAnimationFrame` hop would discard.
   */
  immediate?: boolean;
}

export interface FlatItem {
  cmd: Command;
  flatIdx: number;
}

// ── Constants ──────────────────────────────────────────────────────────

export const RECENT_KEY = 'ifc-lite:cmd-palette:recent';
export const MAX_RECENT = 5;
const CATEGORY_POSITION = {
  Recent: 0,
  File: 1,
  View: 2,
  Tools: 3,
  Visibility: 4,
  Panels: 5,
  Export: 6,
  Automation: 7,
  Preferences: 8,
  Extensions: 9,
  Learn: 10,
} satisfies Record<Category, number>;

/** Every category must have a browse position, including extension rows. */
export const CATEGORY_ORDER = (Object.keys(CATEGORY_POSITION) as Category[])
  .sort((a, b) => CATEGORY_POSITION[a] - CATEGORY_POSITION[b]);

/** Group browse rows, including extension and Learn commands, in one place. */
export function browseCommands(commands: readonly Command[], recentIds: readonly string[]) {
  const grouped: { category: Category; items: FlatItem[] }[] = [];
  const flatItems: FlatItem[] = [];
  const addGroup = (category: Category, rows: readonly Command[]) => {
    if (rows.length === 0) return;
    const items = rows.map((cmd) => {
      const item = { cmd, flatIdx: flatItems.length };
      flatItems.push(item);
      return item;
    });
    grouped.push({ category, items });
  };

  addGroup('Recent', recentIds.slice(0, MAX_RECENT)
    .map((id) => commands.find((command) => command.id === id))
    .filter((command): command is Command => command !== undefined));
  for (const category of CATEGORY_ORDER) {
    if (category !== 'Recent') addGroup(category, commands.filter((command) => command.category === category));
  }
  return { grouped, flatItems };
}

// ── Search scoring ─────────────────────────────────────────────────────

/**
 * Score how well `query` matches `text`.
 *   0   = no match
 *   100 = exact substring
 *   50  = word-start initials
 *   1-25 = tight fuzzy (avg gap ≤ 5)
 */
export function score(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact substring
  if (t.includes(q)) return 100;

  // Word-start initials (e.g. "cs" → "Color Spaces")
  const words = t.split(/[\s_:,\u002F-]+/);
  let wi = 0, qi = 0;
  while (wi < words.length && qi < q.length) {
    if (words[wi].length > 0 && words[wi][0] === q[qi]) qi++;
    wi++;
  }
  if (qi === q.length) return 50;

  // Tight fuzzy — reject if chars are scattered
  let lastIdx = -1, totalGap = 0;
  qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      if (lastIdx >= 0) totalGap += i - lastIdx - 1;
      lastIdx = i;
      qi++;
    }
  }
  if (qi < q.length) return 0;
  const avgGap = q.length > 1 ? totalGap / (q.length - 1) : 0;
  if (avgGap > 5) return 0;
  return Math.max(1, 25 - Math.round(avgGap * 3));
}

/** Rank a command against the search query. Label dominates. `displayLabel`
 *  is the rendered (translated) text, so a localized name matches too. */
export function rankCommand(cmd: Command, query: string, displayLabel?: string): number {
  const l = Math.max(score(query, cmd.label), displayLabel ? score(query, displayLabel) : 0);
  const k = score(query, cmd.keywords) * 0.9;
  const c = score(query, cmd.category) * 0.5;
  return Math.max(l, k, c);
}

// ── Recent usage ───────────────────────────────────────────────────────

export function getRecentIds(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); }
  catch { return []; }
}
export function recordUsage(id: string) {
  try {
    const r = getRecentIds().filter(x => x !== id);
    r.unshift(id);
    localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 30)));
  } catch { /* noop */ }
}
