/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Failing to *read* a localStorage entry must never license destroying it.
 *
 * A loader that returns a default (or a partial result) on a parse error hands
 * the caller a state that looks empty; the next ordinary edit then serializes
 * that empty state straight over the entry, and whatever was there — custom
 * clash rules, triage decisions, saved filters — is gone for good. Deleting the
 * entry outright in the catch has the same effect, sooner.
 *
 * The remedy here is to *move the value aside* rather than keep it in place and
 * refuse to write: the app stays usable (the feature resets to defaults and
 * saves normally from then on), and the bytes we could not parse survive under
 * `<key>:unreadable` for the user to inspect or repair. Refusing all writes
 * instead would preserve the data but leave the feature permanently read-only
 * with no in-app way out, so it is kept only as the fallback for when the
 * value cannot be moved aside at all (a full quota) — in that case the caller
 * must skip the write, which is still better than destroying data.
 */

export interface UnreadableEntryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /**
   * Enumeration members of the real `Storage` interface. Optional because a
   * caller may pass a narrower double — `forgetEntryAndBackups` needs them to
   * find counter-suffixed copies and narrows on them at runtime. Declared here
   * rather than reached through a widening cast: the cast is what let this
   * interface stay wrong, and it made a faithful test double untypeable.
   */
  readonly length?: number;
  key?(i: number): string | null;
}

/** The key an unreadable `key` is preserved under. */
function unreadableKey(key: string): string {
  return `${key}:unreadable`;
}

/**
 * Preserve the value stored at `key` after a read of it failed, then clear it so
 * the feature can start fresh.
 *
 * @returns `true` when the caller may write `key` again — either the value is
 *   safely preserved, or there was nothing stored to lose. `false` when the
 *   value is still at `key` and unpreserved, in which case the caller MUST NOT
 *   overwrite it.
 */
export function preserveUnreadableEntry(
  storage: UnreadableEntryStorage | null,
  key: string,
  cause: unknown,
): boolean {
  // No storage at all: nothing is at risk, and a later write would fail anyway.
  if (!storage) return true;

  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch (err) {
    console.warn(`[ifc-lite] "${key}" is unreadable and could not be inspected; leaving it alone.`, err);
    return false;
  }
  if (raw === null) return true;

  let backup = unreadableKey(key);
  try {
    // Never clobber an earlier preserved copy — it may hold the older, better
    // data. A counter rather than Date.now(): two quarantines of the same key
    // inside one millisecond pick the same timestamp, so the second setItem
    // would overwrite the first — the exact thing this guard exists to stop.
    if (storage.getItem(backup) !== null) {
      let n = 2;
      while (storage.getItem(`${backup}:${n}`) !== null) n += 1;
      backup = `${backup}:${n}`;
    }
    storage.setItem(backup, raw);
    storage.removeItem(key);
  } catch (err) {
    console.warn(
      `[ifc-lite] "${key}" could not be parsed and could not be backed up; refusing to overwrite it.`,
      cause,
      err,
    );
    return false;
  }
  console.warn(
    `[ifc-lite] "${key}" could not be parsed; it was moved to "${backup}" and the feature reset to defaults. ` +
      'Nothing was deleted — recover the value from that key if it is needed.',
    cause,
  );
  return true;
}

/**
 * Drop both `key` and any preserved copy of it. For an explicit, user-initiated
 * wipe only — never as a reaction to a failed read.
 */
export function forgetEntryAndBackups(storage: UnreadableEntryStorage, key: string): void {
  storage.removeItem(key);
  const prefix = unreadableKey(key);
  storage.removeItem(prefix);
  // Counter-suffixed copies from repeated failures, when the host enumerates.
  const { length, key: keyAt } = storage;
  if (typeof length !== 'number' || typeof keyAt !== 'function') return;
  const stale: string[] = [];
  for (let i = 0; i < length; i += 1) {
    const k = keyAt.call(storage, i);
    if (k && k.startsWith(`${prefix}:`)) stale.push(k);
  }
  for (const k of stale) storage.removeItem(k);
}

/** The app's `localStorage`, or null when it is absent or blocked. */
export function optionalLocalStorage(): UnreadableEntryStorage | null {
  try {
    return (globalThis as typeof globalThis & { localStorage?: UnreadableEntryStorage }).localStorage ?? null;
  } catch {
    // Deliberately silent, and the one shape AGENTS.md:17's rule is not aimed
    // at: merely *reading* `globalThis.localStorage` throws under a blocking
    // cookie policy, there is nothing to report that `null` does not already
    // say, and every caller degrades on `null` anyway. Logging here would fire
    // on every call for a browser configuration the user chose. Left explicit
    // so a future silent-catch sweep does not re-flag it.
    return null;
  }
}
