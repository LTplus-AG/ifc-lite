/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/i18n/catalogues/sources-panel.en';
import { useTranslation } from '@/i18n';

export function RegistrationFailureMessage({ provider, reason }: { provider: string; reason: string }) {
  const { t } = useTranslation();
  let marker = '\uE000provider\uE001';
  while (reason.includes(marker)) marker += '\uE002';
  const message = t('sources.sourcesPanel.failedToRegister', { provider: marker, reason });
  const segments = message.split(marker);
  if (segments.length === 1) return message;
  return segments.flatMap((segment, index) => index === segments.length - 1
    ? [segment]
    : [segment, <span key={index} className="font-medium">{provider}</span>]);
}
