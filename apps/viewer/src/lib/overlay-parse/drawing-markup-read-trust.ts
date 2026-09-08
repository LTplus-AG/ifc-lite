/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Trust-vs-recompute policy for `drawing-markup-read.ts`'s per-kind readers,
 * split out to stay under the ~400-line house limit.
 *
 * A stored `Distance`/`Area`/`Perimeter` quantity is trusted verbatim (see
 * `drawing-markup-read.ts`'s module doc comment for why), with a mismatch
 * against the geometry-derived value only ever warned about, never
 * overridden — EXCEPT when the stored value is non-positive. Zero or
 * negative is never a legitimate `Distance`/`Area`/`Perimeter`, so a
 * non-positive stored value carries no information about whether it is
 * corrupted, hand-edited, or simply wrong; there is nothing to trust, and
 * the fallback is used instead.
 */

const RELATIVE_MISMATCH_TOLERANCE = 1e-3;
const ABSOLUTE_MISMATCH_TOLERANCE = 1e-6;

/** Warn (never throw — a mismatch is evidence, not a defect in the reader)
 *  when a trusted stored value disagrees with the geometry beyond
 *  tolerance. Exported so a caller can redirect/silence it in tests. */
export function warnOnDerivedValueMismatch(
  kind: string,
  expressId: number,
  quantityName: string,
  trusted: number,
  computed: number,
): void {
  const tolerance = Math.max(ABSOLUTE_MISMATCH_TOLERANCE, Math.abs(trusted) * RELATIVE_MISMATCH_TOLERANCE);
  if (Math.abs(trusted - computed) <= tolerance) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[drawing-markup-read] ${kind} #${expressId}: stored ${quantityName} (${trusted}) disagrees with the ` +
      `geometry-derived value (${computed}) beyond tolerance — using the stored value. The file may have been ` +
      'hand-edited or its geometry re-projected since the markup was saved.',
  );
}

/**
 * A `Distance`/`Area`/`Perimeter` of zero or less is never a legitimate
 * physical measurement to TRUST from a property/quantity set — unlike the
 * geometry-derived value it is compared against below (`Math.hypot` and
 * `shoelaceArea` are non-negative by construction), a stored non-positive
 * number carries no information about whether it is corrupted, hand-edited,
 * or simply wrong, so it must not reach the UI as fact. Warn (never throw —
 * same policy as {@link warnOnDerivedValueMismatch}) and exported so a
 * caller can redirect/silence it in tests.
 */
export function warnOnNonPositiveStoredValue(
  kind: string,
  expressId: number,
  quantityName: string,
  stored: number,
  computed: number,
): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[drawing-markup-read] ${kind} #${expressId}: stored ${quantityName} (${stored}) is not a physically valid ` +
      `positive measurement — using the geometry-derived value (${computed}) instead. The file may have been ` +
      'hand-edited or corrupted since the markup was saved.',
  );
}

/**
 * Resolve a length/area quantity to either the trusted stored value or the
 * geometry-derived fallback.
 *
 * Trust-vs-recompute still trusts a POSITIVE stored value even when it
 * disagrees with the geometry beyond tolerance — that mismatch is only ever
 * a warning, never an override. But a non-positive stored value is a
 * different case: it is not "the user's authored value disagreeing with a
 * re-projected recompute", it is a value that cannot be a real
 * Distance/Area/Perimeter at all (a corrupted or hand-edited file), so
 * there is nothing to trust and the fallback is used instead. The fallback
 * is always safe to show even when it is itself zero — `computed` comes
 * from real geometry (`Math.hypot`/`shoelaceArea`, both non-negative), so a
 * zero-length measure or zero-area polygon reaching the UI this way
 * reflects a genuinely degenerate annotation (e.g. coincident start/end
 * points), not a lie. Rejecting the entry outright (returning `null`) is
 * not needed: the geometry is already in hand for every caller of this
 * function, so there is always a real value to fall back to.
 */
export function resolveTrustedOrComputed(
  kind: string,
  expressId: number,
  quantityName: string,
  trusted: number,
  computed: number,
): number {
  if (trusted <= 0) {
    warnOnNonPositiveStoredValue(kind, expressId, quantityName, trusted, computed);
    return computed;
  }
  warnOnDerivedValueMismatch(kind, expressId, quantityName, trusted, computed);
  return trusted;
}
