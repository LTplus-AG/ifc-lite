/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ClassificationInfo } from '@ifc-lite/parser';

/**
 * Project one resolved classification reference to the single string
 * `DataFingerprintInput.classifications` hashes: `system:identification`,
 * falling back to `name` when the reference carries no identification code.
 * Both blank is "no label" — `''` lets the fingerprint's blank filter drop
 * it, the same rule a blank material name gets. The CLI's
 * (`packages/cli/src/commands/diff-engine.ts`) twin — split into its own
 * module here only because `diff-fingerprints.ts` is at its size budget.
 */
export function classificationLabel(info: ClassificationInfo): string {
  const system = info.system?.trim() ?? '';
  const code = (info.identification || info.name || '').trim();
  if (!system && !code) return '';
  return `${system}:${code}`;
}
