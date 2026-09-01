/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Represent a non-finite number (`NaN`/`Infinity`/`-Infinity`) as a distinct
 * string token instead of letting it reach `JSON.stringify`.
 *
 * `fingerprint.ts`'s `normalizeValue` feeds its result into `JSON.stringify`
 * (via `buildDataFingerprint`/`buildComponentFingerprints`), and `JSON` (RFC
 * 8259) has no non-finite numeric literal: `JSON.stringify` silently maps
 * `NaN`/`Infinity`/`-Infinity` to `null` — the same token an absent property
 * serializes to. An `Infinity` property value (reachable from a STEP
 * `IfcReal` with an extreme exponent, e.g. `1.0E400`) would then hash
 * identically to that property being entirely absent, and
 * `matchUnpairedByContent` treats equal `dataHash` as content identity — so
 * the collision can retire a genuine `added`/`deleted` pair as "unchanged".
 * Mirrors `finite_json_number` (`rust/export/src/json.rs`, #3596) and
 * `packages/mutations`' `encodeNonFiniteNumbers` — this repo's recurring
 * non-finite-value shape, applied to the diff content hash.
 */
export function stringifyIfNonFinite(value: number): string | number {
  return Number.isFinite(value) ? value : String(value);
}
