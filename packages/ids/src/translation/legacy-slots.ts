/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keeps the public `TranslationService.t()` rendering what it rendered
 * before #8306. The catalogue's constraint slots stopped quoting their
 * value, because the service now passes self-quoted constraint
 * descriptions. Direct `t()` callers pass raw names, as they always did,
 * so `t()` puts back the quotes those slots used to carry.
 */

/** Slots that were quoted, by catalogue key; a `*` key covers a whole group. */
const QUOTED_SLOTS: Record<string, readonly string[]> = {
  'applicability.attribute.*': ['name'],
  'applicability.property.exists': ['property', 'pset'],
  'applicability.classification.*': ['system', 'value'],
  'applicability.material.value': ['value'],
  'requirements.attribute.*': ['name'],
  'requirements.classification.*': ['system', 'value'],
  'requirements.material.mustBe': ['value'],
  'failures.attributeMissing': ['name'],
  'failures.psetMissing': ['pset'],
  'failures.psetMissingAvailable': ['pset'],
  'failures.propertyMissing': ['property'],
  'failures.propertyMissingAvailable': ['property'],
  'failures.classificationSystemMismatch': ['expected'],
  'failures.classificationSystemMissingAvailable': ['expected'],
};

function quotedSlots(key: string): readonly string[] {
  return QUOTED_SLOTS[key] ?? QUOTED_SLOTS[`${key.slice(0, key.lastIndexOf('.'))}.*`] ?? [];
}

/** Params as a pre-#8306 `t()` caller meant them. */
export function legacyParams(
  key: string,
  params: Record<string, string | number>
): Record<string, string | number> {
  const out = { ...params };
  for (const slot of quotedSlots(key)) {
    if (out[slot] !== undefined) out[slot] = `"${out[slot]}"`;
  }
  // Property templates name one `{path}`; they used to read "{pset}.{property}".
  if (out.path === undefined && params.pset !== undefined && params.property !== undefined) {
    out.path = `"${params.pset}.${params.property}"`;
  }
  return out;
}
