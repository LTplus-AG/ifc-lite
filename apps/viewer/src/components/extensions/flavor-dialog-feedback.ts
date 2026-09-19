/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { UseTranslationResult } from '@/i18n';

type Translate = UseTranslationResult['t'];

export function flavorFailure(t: Translate, operation: string, err: unknown): string {
  return t('extensionsFlavors.flavorDialog.toast.failure', {
    operation,
    cause: err instanceof Error ? err.message : String(err),
  });
}

export function flavorSwitchPartial(
  t: Translate,
  id: string,
  unapplied: readonly { part: string; message: string }[],
): string {
  const labels: Record<string, string> = {
    lenses: t('extensionsFlavors.flavorDialog.part.lenses'),
    clash: t('extensionsFlavors.flavorDialog.part.clash'),
    layout: t('extensionsFlavors.flavorDialog.part.layout'),
  };
  const parts = unapplied.map(({ part }) => labels[part] ?? part).join(', ');
  const reasons = [...new Set(unapplied.map(({ message }) => message))].join(' ');
  return t('extensionsFlavors.flavorDialog.toast.switchedPartially', { id, parts, reasons });
}
