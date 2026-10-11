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
import type { TranslatableMessage } from '@/i18n';
import type { ReviewFinding, RunGap } from './types';

const english = (message: TranslatableMessage) => resolveEnglish(message.labelKey, message.params);

/** Notes come first: callers cap the lines they print, and the explanation must survive that cap. */
export function findingLines(finding: Pick<ReviewFinding, 'detail' | 'notes'>): string[] {
  return [...(finding.notes ?? []).map(english), ...finding.detail];
}

/**
 * Lines for exports that print no run gaps of their own (report text, BCF descriptions).
 * A finding without its own explanation carries its run's catalogued sentences instead,
 * e.g. why saved failures were not checked again (no current run, edited checks).
 */
export function exportLines(finding: Pick<ReviewFinding, 'detail' | 'notes' | 'run'>): string[] {
  const own = finding.notes?.length ? [] : finding.run.incomplete.flatMap(gap => gap.message ? [english(gap.message)] : []);
  return [...own, ...findingLines(finding)];
}

export function gapLine(gap: RunGap): string {
  const detail = gap.message ? english(gap.message) : gap.detail;
  return detail ? `${gap.code}: ${detail}` : gap.code;
}
