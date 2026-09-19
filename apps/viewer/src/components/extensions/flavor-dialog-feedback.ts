/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey, UseTranslationResult } from '@/i18n';
import type { UnappliedFlavorPart } from '@/services/extensions/host';

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
  unapplied: readonly UnappliedFlavorPart[],
): string {
  const labels: Record<string, string> = {
    lenses: t('extensionsFlavors.flavorDialog.part.lenses'),
    clash: t('extensionsFlavors.flavorDialog.part.clash'),
    layout: t('extensionsFlavors.flavorDialog.part.layout'),
  };
  const parts = unapplied.map(({ part }) => labels[part] ?? part).join(', ');
  const reasonKeys: Partial<Record<NonNullable<UnappliedFlavorPart['reason']>, TranslationKey>> = {
    quota: 'extensionsFlavors.flavorDialog.reason.storageQuota',
    unavailable: 'extensionsFlavors.flavorDialog.reason.storageUnavailable',
    serialize: 'extensionsFlavors.flavorDialog.reason.serialization',
    too_many: 'extensionsFlavors.flavorDialog.reason.tooManyClashRules',
    unreadable: 'extensionsFlavors.flavorDialog.reason.clashDataUnreadable',
    rollback_failed: 'extensionsFlavors.flavorDialog.reason.clashRollbackFailed',
  };
  const reasons = [...new Set(unapplied.map(({ reason, message }) => {
    const key = reason ? reasonKeys[reason] : undefined;
    return key ? t(key) : message;
  }))].join(' ');
  return t('extensionsFlavors.flavorDialog.toast.switchedPartially', { id, parts, reasons });
}
