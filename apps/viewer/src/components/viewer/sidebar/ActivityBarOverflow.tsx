/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The activity rail's overflow menu (#8802 R1): the icons that do not fit
 * the rail's height (a bottom dock or a short window), listed by name under
 * the same task-group headings the rail and the ribbon's panel browser use.
 * Opening one goes through the same handler as its rail icon. On the empty
 * start screen it also holds the panels that need a model, each saying so.
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
import type { PanelLocation } from '@/hooks/usePanelControls';
import { getPanelDef, panelGroupDefinition, type WorkspacePanelId } from '@/lib/panels/registry';

type T = ReturnType<typeof useTranslation>['t'];

/** Where an open panel is, in words: the menu's stand-in for the rail's
 *  `aria-pressed` and corner dots, so state never rides on colour alone. */
function locationText(t: T, location: PanelLocation, title: string): { name: string; hint: string | null } {
  switch (location) {
    case 'docked':
      return { name: t('shellChrome.activityBar.iconAriaLabelOpen', { title }), hint: t('shellChrome.activityBar.openHint') };
    case 'floating':
      return { name: t('shellChrome.activityBar.iconAriaLabelFloating', { title }), hint: t('shellChrome.activityBar.floatingHint') };
    case 'popped':
      return { name: t('shellChrome.activityBar.iconAriaLabelPopped', { title }), hint: t('shellChrome.activityBar.poppedHint') };
    default:
      return { name: title, hint: null };
  }
}

export function ActivityBarOverflow({ ids, locationOf, onSelect, waiting = [] }: {
  ids: readonly WorkspacePanelId[];
  locationOf: (id: WorkspacePanelId) => PanelLocation;
  onSelect: (id: WorkspacePanelId) => void;
  /** Panels here because no model is loaded yet (`foldModelPanels`), marked as such. */
  waiting?: readonly WorkspacePanelId[];
}) {
  const { t } = useTranslation();
  const anyOpen = ids.some((id) => locationOf(id) !== 'closed');
  const label = t(anyOpen ? 'shellChrome.activityBar.morePanelsSomeOpen' : 'shellChrome.activityBar.morePanels', { count: ids.length });
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            {/* Same 36px row as a rail icon (`RAIL_ITEM_PX`), 4px wider for
                the caption: the dots and the count over a visible "More",
                so the 16-24 panels it holds are announced on sight. */}
            <button
              type="button"
              data-rail-overflow=""
              aria-label={label}
              className={cn(
                'relative h-9 w-10 shrink-0 inline-flex flex-col items-center justify-center gap-0.5 rounded-md transition-colors',
                'text-muted-foreground hover:bg-muted hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
            >
              <span className="flex items-center gap-0.5 text-2xs leading-none tabular-nums" aria-hidden>
                <MoreHorizontal className="h-4 w-4" />
                +{ids.length}
              </span>
              <span data-rail-overflow-caption="" className="max-w-full truncate text-2xs font-medium leading-none" aria-hidden>
                {t('shellChrome.activityBar.moreCaption')}
              </span>
              {/* Top-left, unlike a rail icon's corner dot: the count owns the right. */}
              {anyOpen && (
                <span className="absolute left-0 top-0 h-1.5 w-1.5 rounded-full bg-primary ring-1 ring-background" aria-hidden />
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="left">
          {label}
          <span className="block text-muted-foreground">
            {t(waiting.length > 0 ? 'shellChrome.activityBar.morePanelsWaitingHint' : 'shellChrome.activityBar.morePanelsHint')}
          </span>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="left" align="end" className="w-56">
        {ids.map((id, index) => {
          const def = getPanelDef(id);
          if (!def) return null;
          const Icon = def.Icon;
          const previous = index > 0 ? getPanelDef(ids[index - 1])?.group : undefined;
          const group = def.group !== previous ? panelGroupDefinition(def.group) : null;
          const location = locationOf(id);
          const title = t(def.titleKey);
          const located = locationText(t, location, title);
          const needsModel = waiting.includes(id);
          const name = located.name;
          const hint = needsModel ? t('shellChrome.activityBar.needsModelHint') : located.hint;
          return (
            <Fragment key={id}>
              {group && index > 0 && <DropdownMenuSeparator />}
              {group && (
                <DropdownMenuLabel data-panel-group={group.id} title={t(group.descriptionKey)} className="text-2xs font-medium text-muted-foreground">
                  {t(group.labelKey)}
                </DropdownMenuLabel>
              )}
              <DropdownMenuItem
                data-panel-id={id}
                data-panel-location={location}
                aria-label={located.hint ? name : needsModel ? `${title} · ${hint}` : undefined}
                data-needs-model={needsModel ? '' : undefined}
                onSelect={() => onSelect(id)}
                className="gap-2"
              >
                <Icon className={cn('h-4 w-4', location !== 'closed' ? 'text-primary' : 'text-muted-foreground')} />
                <span className="flex-1 truncate">{title}</span>
                {hint && <span className="text-2xs text-muted-foreground" aria-hidden>{hint}</span>}
              </DropdownMenuItem>
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
