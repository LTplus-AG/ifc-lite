/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ClassificationInfo } from '@ifc-lite/parser';

/**
 * Project one resolved classification reference to the single string the
 * `@ifc-lite/diff` fingerprint hashes: `system:identification`, falling back
 * to `name` when the reference carries no identification code. Both blank is
 * "no label" — returning `''` lets the fingerprint's blank-filtering
 * (`sortedClassifications`) drop it, the same rule a blank material name
 * gets. Sibling to `lensMaterialNames`, split into its own module for the
 * same reason: `buildFingerprints.ts` is at its size budget.
 */
export function classificationLabel(info: ClassificationInfo): string {
  const system = info.system?.trim() ?? '';
  const code = (info.identification || info.name || '').trim();
  if (!system && !code) return '';
  return `${system}:${code}`;
}
