/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { CountBadgeTooltip } from './CountBadgeTooltip';
import type { TreeNode } from './types';

export function HierarchyNodeBadges({ node }: { node: TreeNode }) {
  const { t, locale } = useTranslation();
  const elevation = node.storeyDisplayElevation;
  const elevationLabel = elevation === undefined ? null : t('hierarchy.node.elevationBadge', {
    sign: elevation >= 0 ? '+' : '',
    value: formatLocaleNumber(locale, elevation, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  });
  const elevationTitle = elevation === undefined ? null : t('hierarchy.node.elevationTooltip', {
    sign: elevation >= 0 ? '+' : '',
    value: formatLocaleNumber(locale, elevation, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  });

  return <>
    {elevation !== undefined && (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 text-2xs font-mono tabular-nums text-muted-foreground">
            {elevationLabel}
          </span>
        </TooltipTrigger>
        <TooltipContent><p className="text-xs">{elevationTitle}</p></TooltipContent>
      </Tooltip>
    )}
    {node.elementCount !== undefined && (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* One muted, right-aligned count style in every tree (#8802). Next
              to a storey's elevation it still yields first when the tree is
              narrow (#5394); a group row keeps it, it has nothing else. */}
          <span data-hierarchy-count-badge className={cn('shrink-0 pl-1 text-2xs tabular-nums text-muted-foreground', elevation !== undefined && 'hidden @2xs:inline')}>
            {formatLocaleNumber(locale, node.elementCount)}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <CountBadgeTooltip elementCount={node.elementCount} summary={node.countSummary} />
        </TooltipContent>
      </Tooltip>
    )}
  </>;
}
