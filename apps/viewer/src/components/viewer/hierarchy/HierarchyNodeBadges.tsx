/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';
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
          <span className="text-2xs font-mono bg-emerald-100 dark:bg-emerald-950 px-1.5 py-0.5 border border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400 rounded-none">
            {elevationLabel}
          </span>
        </TooltipTrigger>
        <TooltipContent><p className="text-xs">{elevationTitle}</p></TooltipContent>
      </Tooltip>
    )}
    {node.elementCount !== undefined && (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Yields first when the tree is narrow (#5394). */}
          <span data-hierarchy-count-badge className="hidden @2xs:inline text-2xs font-mono bg-zinc-100 dark:bg-zinc-950 px-1.5 py-0.5 border border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 rounded-none">
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
