/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseLocaleNumber } from '@/i18n';
import { degreesToRadians } from '@/lib/model-placement/rotation';

/**
 * Locale-aware wrapper around `parseRotationDegrees` (`lib/model-placement/rotation.ts`):
 * that parser only accepts ASCII digits plus `.`/`,` as the decimal separator,
 * so an Arabic-locale reading (e.g. `١٢٫٥`, which `AngleRow` now also
 * *displays* in Arabic digits) was silently rejected. Parse the numeric
 * portion with `parseLocaleNumber` first -- which understands the active
 * locale's digits, decimal separator AND group separator -- then hand the
 * plain-ASCII degrees value to `degreesToRadians` for the actual conversion
 * (skipping `parseRotationDegrees`'s own, ASCII-only, number parsing).
 */
export function parseLocalizedRotationDegrees(locale: string, text: string): number {
  const withoutUnit = text.trim().replace(/\s*(?:°|deg|degrees)\s*$/i, '');
  const degrees = parseLocaleNumber(locale, withoutUnit);
  if (degrees === null) throw new Error('Enter a rotation in degrees, for example 90 or -22.5.');
  return degreesToRadians(degrees);
}
