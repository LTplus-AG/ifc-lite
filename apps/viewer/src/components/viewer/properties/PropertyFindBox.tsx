/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Search, X } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';

/** Shared search control and empty state for all Properties sections (#5899). */
export function PropertyFindBox({ value, onChange, hasMatches }: {
  value: string;
  onChange: (value: string) => void;
  hasMatches: boolean;
}) {
  const { t } = useTranslation();
  return <>
    <div className="flex items-center gap-2 border-b px-3 py-2 text-muted-foreground">
      <Search className="size-4 shrink-0" aria-hidden="true" />
      <input type="text" role="searchbox" value={value} onChange={(event) => onChange(event.target.value)}
        aria-label={t('properties.panel.findLabel')} placeholder={t('properties.panel.findPlaceholder')}
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" />
      {value && <IconButton label={t('properties.panel.clearFindLabel')} size="icon-xs" className="size-6 shrink-0" onClick={() => onChange('')}><X className="size-3" /></IconButton>}
    </div>
    {value.trim() && !hasMatches && <output className="block border-b p-3 text-sm text-muted-foreground">{t('properties.panel.findEmpty')}</output>}
  </>;
}
