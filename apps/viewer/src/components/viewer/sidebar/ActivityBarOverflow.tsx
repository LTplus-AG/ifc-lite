/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The activity rail's overflow menu (#8802 R1): the icons that do not fit
 * the rail's height (a bottom dock or a short window), listed by name under
 * the same task-group headings the rail and the ribbon's panel browser use.
 * Opening one goes through the same handler as its rail icon.
 */

import { Fragment } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { getPanelDef, panelGroupDefinition, type WorkspacePanelId } from '@/lib/panels/registry';

export function ActivityBarOverflow({ ids, isOpen, onSelect }: {
  ids: readonly WorkspacePanelId[];
  isOpen: (id: WorkspacePanelId) => boolean;
  onSelect: (id: WorkspacePanelId) => void;
}) {
  const { t } = useTranslation();
  const label = t('shellChrome.activityBar.morePanels', { count: ids.length });
  const anyOpen = ids.some(isOpen);
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-rail-overflow=""
              aria-label={label}
              className={cn(
                'relative h-9 w-9 shrink-0 inline-flex flex-col items-center justify-center rounded-md transition-colors',
                'text-muted-foreground hover:bg-muted hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
              <span className="text-2xs leading-none tabular-nums" aria-hidden>
                +{ids.length}
              </span>
              {anyOpen && (
                <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-primary ring-1 ring-background" aria-hidden />
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="left">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="left" align="end" className="w-56">
        {ids.map((id, index) => {
          const def = getPanelDef(id);
          if (!def) return null;
          const Icon = def.Icon;
          const previous = index > 0 ? getPanelDef(ids[index - 1])?.group : undefined;
          const group = def.group !== previous ? panelGroupDefinition(def.group) : null;
          return (
            <Fragment key={id}>
              {group && index > 0 && <DropdownMenuSeparator />}
              {group && (
                <DropdownMenuLabel data-panel-group={group.id} title={t(group.descriptionKey)} className="text-2xs font-medium text-muted-foreground">
                  {t(group.labelKey)}
                </DropdownMenuLabel>
              )}
              <DropdownMenuItem data-panel-id={id} onSelect={() => onSelect(id)} className="gap-2">
                <Icon className={cn('h-4 w-4', isOpen(id) ? 'text-primary' : 'text-muted-foreground')} />
                <span className="flex-1 truncate">{t(def.titleKey)}</span>
              </DropdownMenuItem>
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
