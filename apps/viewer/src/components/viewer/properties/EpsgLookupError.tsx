/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation, type TranslationKey } from '@/i18n';

export function EpsgLookupError({ errorKey }: { errorKey: TranslationKey | null }) {
  const { t } = useTranslation();
  return errorKey ? <p className="text-2xs text-muted-foreground px-4 pb-2">{t(errorKey)}</p> : null;
}
