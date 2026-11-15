/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Says, next to the CRS name in the Georeference panel, that the EPSG code
 * federation uses was taken from a well-known name ("CH1903+ / LV95" →
 * EPSG:2056) rather than stated as `EPSG:nnnn`. Nothing shows for a literal
 * code or a name that does not resolve.
 */

import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';
import { crsAssumedFromName } from '@/lib/geo/ifc-spatial-reference';

export function CrsAssumedBadge({ crsName }: { crsName: string | undefined }) {
  const { t } = useTranslation();
  const assumed = crsAssumedFromName(crsName);
  if (!assumed) return null;
  const text = t('siteContext.section.crsAssumed', { crs: assumed });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs text-muted-foreground" data-testid="crs-assumed-badge" aria-label={text}>
          <Info className="h-2.5 w-2.5" />{assumed}
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
