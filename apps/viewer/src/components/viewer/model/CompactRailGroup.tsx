/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Check, ChevronRight } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useTranslation, type TranslationKey } from '@/i18n';
import { shortcutLabel } from '@/lib/commands/shortcut-label';
import { tourAnchor, toolAnchor } from '@/lib/tours/anchors';
import { cn } from '@/lib/utils';
import type { RailTool } from './rail-tools';

const GROUP_LABELS: Record<Exclude<RailTool['group'], 'select'>, TranslationKey> = {
  build: 'ribbon.author.createGroup', host: 'modelWorkspace.rail.hosted',
  edit: 'ribbon.author.editGroup', circulation: 'modelWorkspace.rail.circulation',
};

/** The same commands and refusal reasons as the full rail, with native Radix keyboard navigation. */
export function CompactRailGroup({ group, tools }: {
  group: Exclude<RailTool['group'], 'select'>;
  tools: readonly { tool: RailTool; active: boolean; reason: string | null }[];
}) {
  const { t } = useTranslation();
  const current = tools.find(({ active }) => active) ?? tools[0];
  const { Icon } = current.tool;
  const active = tools.some((entry) => entry.active);
  const label = t(GROUP_LABELS[group]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={label}
          tooltip={`${label}: ${t(current.tool.labelKey)}`}
          tooltipSide="right"
          data-rail-group={group}
          className={cn('relative h-9 w-9 shrink-0', active && 'bg-overlay-accent-soft text-overlay-accent')}
        >
          <Icon className="h-4 w-4" />
          <ChevronRight aria-hidden className="absolute bottom-1 right-0.5 h-2 w-2" />
          {active && <span aria-hidden className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-r bg-overlay-accent" />}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" aria-label={label}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {tools.map(({ tool, active: selected, reason }) => (
          <DropdownMenuItem
            key={tool.id}
            {...tourAnchor(toolAnchor(tool.id))}
            data-rail-menu-tool={tool.id}
            disabled={reason !== null}
            onSelect={tool.run}
            className="gap-2"
          >
            <tool.Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1">
              {t(tool.labelKey)}
              {reason && <span className="block max-w-64 text-xs text-muted-foreground">{reason}</span>}
            </span>
            {selected && <Check aria-label={t('modelWorkspace.rail.active')} className="h-3 w-3" />}
            <span className="text-xs text-muted-foreground">{shortcutLabel(tool.shortcut)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
