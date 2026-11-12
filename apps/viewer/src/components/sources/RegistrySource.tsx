/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useId, useState } from 'react';
import { ChevronDown, ChevronRight, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { registerEnglish, useTranslation } from '@/i18n';
import { registryEn } from '@/i18n/catalogues/registry.en';
import { OciPushTo } from './OciPushTo';
registerEnglish(registryEn);
interface RegistrySourceProps { expanded: boolean; navigationDisabled: boolean; onToggle: () => void; onBusyChange: (busy: boolean) => void }
/** Browsing belongs to the file service; the viewer publishes directly to the chosen OCI registry. */
export function RegistrySource({ expanded, navigationDisabled, onToggle, onBusyChange }: RegistrySourceProps) {
  const id = useId(), { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const busyChange = useCallback((value: boolean) => { setBusy(value); onBusyChange(value); }, [onBusyChange]);
  return <li className="rounded-lg border bg-background">
    <Button type="button" variant="ghost" className="w-full justify-start gap-2" disabled={navigationDisabled || busy} onClick={onToggle} aria-expanded={expanded} aria-controls={`${id}-content`}>
      <Upload className="size-4" aria-hidden="true" />{t('registry.push.action')}{expanded ? <ChevronDown className="ml-auto size-4" aria-hidden="true" /> : <ChevronRight className="ml-auto size-4" aria-hidden="true" />}
    </Button>
    {expanded && <fieldset id={`${id}-content`} className="min-w-0 space-y-3 border-t p-3"><OciPushTo disabled={navigationDisabled} onBusyChange={busyChange} /></fieldset>}
  </li>;
}
