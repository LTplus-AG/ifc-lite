/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Literal English lines for what Review writes out of the panel (report text,
 * BCF draft descriptions, assistant evidence). Catalogued notes and gap
 * messages are resolved from the English catalogue here, so a stable reason
 * code never reaches the output in place of its sentence (#7371 follow-up).
 */
import '@/i18n/catalogues/review-workspace.register';
import { resolveEnglish } from '@/i18n/registry';
import type { ReviewFinding, RunGap } from './types';

/** Notes come first: callers cap the lines they print, and the explanation must survive that cap. */
export function findingLines(finding: Pick<ReviewFinding, 'detail' | 'notes'>): string[] {
  return [...(finding.notes ?? []).map(note => resolveEnglish(note.labelKey, note.params)), ...finding.detail];
}

export function gapLine(gap: RunGap): string {
  const detail = gap.message ? resolveEnglish(gap.message.labelKey, gap.message.params) : gap.detail;
  return detail ? `${gap.code}: ${detail}` : gap.code;
}
