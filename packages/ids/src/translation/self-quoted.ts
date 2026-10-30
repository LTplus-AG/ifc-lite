/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The service's own view of a locale catalogue (#8306). The exported
 * catalogues quote their name slots (`Attribute "{name}" must exist`),
 * which is right for a caller passing a raw name. The service passes
 * constraint descriptions that carry their own quotes (`"Name"`,
 * `pattern "N.*"`), so it renders from a copy with those slots unquoted
 * and the property path joined into one `{path}`. The exported
 * catalogues and `t()` stay as they were.
 */

import type { en } from './locales/en.js';

type Translations = typeof en;

/** Name slots the service fills with a self-quoted description, by key; `*` covers a group. */
export const SELF_QUOTED_SLOTS: Record<string, readonly string[]> = {
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

/** Groups whose `"{pset}.{property}"` becomes one `{path}`. */
export const PATH_GROUPS = ['applicability.property', 'requirements.property'];

function slotsFor(key: string): readonly string[] {
  const group = key.slice(0, key.lastIndexOf('.'));
  return SELF_QUOTED_SLOTS[key] ?? SELF_QUOTED_SLOTS[`${group}.*`] ?? [];
}

function adjust(key: string, template: string): string {
  let out = template;
  for (const slot of slotsFor(key)) out = out.split(`"{${slot}}"`).join(`{${slot}}`);
  if (PATH_GROUPS.includes(key.slice(0, key.lastIndexOf('.')))) {
    out = out.split('"{pset}.{property}"').join('{path}');
  }
  return out;
}

function copy(node: unknown, prefix: string): unknown {
  if (typeof node === 'string') return adjust(prefix, node);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [k, copy(v, prefix ? `${prefix}.${k}` : k)])
  );
}

const CACHE = new WeakMap<Translations, Translations>();

/** The catalogue the service renders from. */
export function selfQuotedCatalogue(catalogue: Translations): Translations {
  let adjusted = CACHE.get(catalogue);
  if (adjusted === undefined) {
    adjusted = copy(catalogue, '') as Translations;
    CACHE.set(catalogue, adjusted);
  }
  return adjusted;
}
