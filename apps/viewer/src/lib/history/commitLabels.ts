/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How a commit reads in the UI: its short id, its row title, its stats line,
 * the display name a commit loaded alongside gets, and how a changed
 * component key becomes something a person recognises.
 *
 * Pure and string-only, so the panel, the element-history card and the
 * compare bar cannot describe the same commit three different ways.
 */

import type { SourceCommit, StoredChangeKind } from '@ifc-lite/plugin-api';
import { formatLocaleDate } from '@/i18n/intlFormat';

/** Characters of a commit id shown in a badge or a model name. */
const SHORT_ID_LENGTH = 7;

/**
 * A commit id shortened for display, never for comparison.
 *
 * Provider ids are opaque and are not all hex: a UUID, a monotonic integer
 * and a content hash all turn up. Truncation is therefore presentation only —
 * nothing may look a commit up by a short id, because two of them can collide
 * and the provider would have no way to disambiguate.
 */
export function shortCommitId(commitId: string): string {
  return commitId.length <= SHORT_ID_LENGTH ? commitId : commitId.slice(0, SHORT_ID_LENGTH);
}

/**
 * The row title: the first line of the commit message, falling back to the
 * artifact file name.
 *
 * A message's later lines are a body, not a title, and a row that rendered
 * them would grow to whatever height the author's paragraph happened to be.
 */
export function commitTitle(commit: SourceCommit): string {
  const firstLine = commit.message?.split('\n')[0]?.trim();
  if (firstLine) return firstLine;
  return commit.artifact.fileName;
}

/** `+12 ~48 −3`, or `null` when the provider computed no stats. */
export function commitStatsText(commit: SourceCommit): string | null {
  const stats = commit.stats;
  if (!stats) return null;
  // U+2212 MINUS SIGN, not a hyphen: it aligns with the digits at the same
  // optical weight as the plus and tilde beside it.
  return `+${stats.added} ~${stats.modified} −${stats.deleted}`;
}

/** Display name for a commit opened alongside: `Structural model @ 3f9a1c2 · 12 Sep 2026`. */
export function commitModelDisplayName(modelName: string, commit: SourceCommit, locale: string): string {
  const date = formatLocaleDate(locale, new Date(commit.createdAt), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${modelName} @ ${shortCommitId(commit.id)} · ${date}`;
}

/**
 * A component key made readable: `pset:Pset_WallCommon` → `Pset_WallCommon`,
 * `attr:core` → `core`.
 *
 * The prefix is the diff engine's namespace, meaningful to the engine and
 * noise to a reader who can already see they are looking at a property set.
 * The name itself is NOT translated or prettified — it is the authored IFC
 * name, and rewriting it would stop the user finding it in their model.
 */
export function readableComponentName(component: string): string {
  const separator = component.indexOf(':');
  return separator === -1 ? component : component.slice(separator + 1);
}

/** Stable order for change kinds, so two rows never list the same set differently. */
const CHANGE_KIND_ORDER: readonly StoredChangeKind[] = ['data', 'geometry', 'container'];

export function orderChangeKinds(kinds: readonly StoredChangeKind[]): StoredChangeKind[] {
  return CHANGE_KIND_ORDER.filter((kind) => kinds.includes(kind));
}

/**
 * Absolute timestamp for a row's `title` tooltip. The visible label is a
 * relative time ("2 hours ago"), which is unusable for anyone trying to match
 * a commit against an email or a meeting.
 */
export function absoluteCommitTime(commit: SourceCommit, locale: string): string {
  return formatLocaleDate(locale, new Date(commit.createdAt), { dateStyle: 'full', timeStyle: 'short' });
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Relative time via `Intl.RelativeTimeFormat`, falling back to an absolute
 * date past a month — "13 months ago" is a worse answer than "3 Mar 2026"
 * for a coordinator trying to place a delivery.
 */
export function relativeCommitTime(commit: SourceCommit, locale: string, now: number = Date.now()): string {
  const created = Date.parse(commit.createdAt);
  if (!Number.isFinite(created)) return commit.createdAt;
  const elapsed = created - now;
  const magnitude = Math.abs(elapsed);
  if (magnitude > 30 * DAY_MS) {
    return formatLocaleDate(locale, created, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (magnitude < HOUR_MS) return format.format(Math.round(elapsed / MINUTE_MS), 'minute');
  if (magnitude < DAY_MS) return format.format(Math.round(elapsed / HOUR_MS), 'hour');
  return format.format(Math.round(elapsed / DAY_MS), 'day');
}
