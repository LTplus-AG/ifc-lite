/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared id-generation helpers.
 *
 * Several call sites used to roll their own id formats:
 *   - flavor reset: `flv.default`
 *   - flavor import-as-new: `<original>.imported-<ts>`
 *   - flavor merge: `<theirs>.merge-<ts>`
 *   - plan stub: `ext.suggested.<slug>.run`
 *
 * Centralising keeps the conventions visible in one file so the next
 * call site doesn't drift. Pure functions, deterministic for a given
 * input.
 */

/** Stable id for the baseline default flavor. */
export const DEFAULT_FLAVOR_ID = 'flv.default';

/** Append a timestamp suffix to a flavor id to mark it as a copy. */
export function flavorImportedId(
  originalId: string,
  now: number = Date.now(),
): string {
  return `${originalId}.imported-${now}`;
}

/** Append a merge-timestamp suffix to a flavor id. */
export function flavorMergedId(
  theirId: string,
  now: number = Date.now(),
): string {
  return `${theirId}.merge-${now}`;
}

/** Build the command id for an AI-suggested extension. */
export function suggestedCommandId(slug: string): string {
  return `ext.suggested.${slug}.run`;
}
