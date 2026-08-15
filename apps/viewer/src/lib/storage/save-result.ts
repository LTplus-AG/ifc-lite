/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The result channel for a localStorage write.
 *
 * A `void`-returning save that swallows its own failure lets the UI commit an
 * edit that is gone on the next reload. Every persisted store slice should hand
 * this back to its caller so a component can surface the message.
 *
 * The shape matches the one `lib/clash/persistence.ts` and
 * `lib/scripts/persistence.ts` grew independently; this module is the shared
 * home so new call sites do not add a fourth variant.
 */

export type SaveFailureReason =
  /** The store is present but out of room. */
  | 'quota'
  /** No usable localStorage at all (blocked cookies / site data, private mode). */
  | 'unavailable'
  /** The value could not be turned into JSON. */
  | 'serialize';

export type SaveResult =
  | { ok: true }
  | { ok: false; reason: SaveFailureReason; message: string };

/** Firefox's legacy quota error name; Chrome/Safari use `QuotaExceededError`. */
const QUOTA_ERROR_NAMES = new Set(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED']);

/**
 * Serialize `value` and write it to `key`, reporting rather than throwing.
 *
 * `subject` names what was being saved, in plural-verb form — it is spliced
 * into the user-facing message ("… — lens changes were not saved.").
 */
export function saveJson(key: string, value: unknown, subject: string): SaveResult {
  let payload: string | undefined;
  try {
    payload = JSON.stringify(value);
  } catch {
    return { ok: false, reason: 'serialize', message: `Could not save ${subject}.` };
  }
  // `JSON.stringify` does not throw for a top-level `undefined`, function, or
  // symbol — it returns `undefined` instead. Without this check, `setItem`
  // would stringify that `undefined` itself and store the literal string
  // "undefined", reporting `ok: true` for a value that never round-trips
  // (PR #2091 review) — the same failure-reported-as-success shape #2101
  // fixed one layer up, where the store committed a value storage refused.
  if (payload === undefined) {
    return { ok: false, reason: 'serialize', message: `Could not save ${subject}.` };
  }
  try {
    localStorage.setItem(key, payload);
    return { ok: true };
  } catch (err) {
    // A blocked or absent store throws from `setItem` exactly like a full one.
    // Telling a private-mode user their storage is "full" sends them deleting
    // data that would not help, so the two are separated by error name.
    const quota = err instanceof DOMException && QUOTA_ERROR_NAMES.has(err.name);
    return quota
      ? { ok: false, reason: 'quota', message: `Browser storage is full — ${subject} were not saved.` }
      : { ok: false, reason: 'unavailable', message: `Browser storage is unavailable — ${subject} were not saved.` };
  }
}
