/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CommandPalette search — fuzzy scoring, ranking, and "recent commands"
 * persistence. Split out of `CommandPalette.tsx`: these are pure functions
 * (no React, no store) that the palette component composes.
 */

import type { TranslationKey, TranslationParameters } from '@/i18n';
import type { KeyCommandId } from '@/lib/commands/keyboard-commands';

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

interface CommandBase {
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
  keywords: string;           // extra search tokens (no UI display)
  category: Exclude<Category, 'Recent'>;
  icon: React.ElementType;
  /** Keyboard command whose keys the row shows (`lib/commands`). */
  shortcut?: KeyCommandId;
  detail?: string;            // subtle secondary text (e.g. file size)
  /** Translated counterpart of `detail` — e.g. a tour's "{minutes} min". */
  detailKey?: TranslationKey;
  detailKeyParams?: TranslationParameters;
  availability?: import('./palette-availability').PaletteAvailability;
  /** Reads current prerequisites again at activation, including deferred frames. */
  checkAvailability?: () => import('./palette-availability').PaletteAvailability;
  stateKey?: TranslationKey;
  action: () => void;
  /**
   * Run the action synchronously in the click handler instead of deferring to the
   * next animation frame — needed for a file dialog: Chrome only honours
   * `input.click()` / `showOpenFilePicker()` while transient user activation is
   * live, which a `requestAnimationFrame` hop would discard.
   */
  immediate?: boolean;
}

/**
 * A static command has a registry id/name; runtime content declares its owner.
 * A registered row renders only its registry label (`RegisteredPaletteOption`),
 * while projected detail, toggle state and availability remain palette-owned.
 */
export type Command = CommandBase & (
  | { registryOwned: true; labelKey: TranslationKey; runtimeSource?: never;
      labelKeyParams?: never }
  | { registryOwned?: never; runtimeSource: 'recent-file' | 'script-template' | 'tour' | 'extension-command' | 'extension-export' | 'extension-widget';
      labelKey?: TranslationKey; labelKeyParams?: TranslationParameters }
);

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

/** Semantic tiers leave recency to break ties, never to outrank a better match. */
export function score(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t === q) return 800;
  if (t.startsWith(q)) return 700;
  const words = t.split(/[\s_:,\u002F-]+/).filter(Boolean);
  if (words.some(word => word.startsWith(q))) return 600;

  // Ordered word initials: "cs" finds "Color Spaces".
  let qi = 0;
  for (const word of words) {
    if (word[0] === q[qi]) qi++;
    if (qi === q.length) return 500;
  }
  if (t.includes(q)) return 400;

  // Tight subsequence fallback, below every direct metadata match.
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
  return avgGap > 5 ? 0 : Math.max(1, 25 - Math.round(avgGap * 3));
}

/** Localized and English labels share tiers. Metadata cannot outrank a label. */
export function rankCommand(cmd: Command, query: string, displayLabel?: string, displayCategory?: string): number {
  const label = Math.max(score(query, cmd.label), score(query, displayLabel ?? ''));
  const keywords = score(query, cmd.keywords);
  const category = Math.max(score(query, cmd.category), score(query, displayCategory ?? ''));
  return Math.max(label, keywords >= 400 ? 300 : keywords, category >= 400 ? 200 : category);
}

/** Equal matches use most-recent usage, then the original registry order. */
export function searchCommands(
  commands: readonly Command[], query: string, recentIds: readonly string[],
  displayLabel: (command: Command) => string = command => command.label,
  displayCategory: (command: Command) => string = command => command.category,
): Command[] {
  const recent = new Map(recentIds.map((id, index) => [id, index]));
  const ranked = commands.map((cmd, index) => ({
    cmd, index, rank: rankCommand(cmd, query, displayLabel(cmd), displayCategory(cmd)),
  }));
  // Direct label/metadata hits answer the query; loose subsequences only help
  // recover a typo when there are no direct hits (#8946). Category hits start at 200.
  const minimumRank = ranked.some(item => item.rank >= 200) ? 200 : 1;
  return ranked.filter(item => item.rank >= minimumRank).sort((a, b) =>
    b.rank - a.rank
    || (recent.get(a.cmd.id) ?? Infinity) - (recent.get(b.cmd.id) ?? Infinity)
    || a.index - b.index,
  ).map(item => item.cmd);
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
