/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One activity-rail icon (#1208), split out of `ActivityBar` for #8802 R1.
 *
 * Three visual states, so exactly one item ever reads as "the" active one:
 *  - `active`: the panel shown in the right pane. Primary-tinted tile,
 *    primary icon, and a 2px accent bar on the rail's leading edge.
 *  - `open`: docked in another region (Hierarchy on the left, a bottom-dock
 *    panel, the lower half of a split). Full-ink icon, no tile; the panel is
 *    already on screen, so a second accent would only compete.
 *  - rest: muted ink; `quiet` (a model-dependent panel with no model loaded)
 *    dims it further, while it stays clickable and keeps its name.
 * Floating / popped-out panels keep their corner dot.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { getPanelDef, type WorkspacePanelId } from '@/lib/panels/registry';
import { activityAnchor, tourAnchor } from '@/lib/tours/anchors';

type PanelLocation = 'docked' | 'floating' | 'popped' | 'closed';

export interface ActivityBarItemProps {
  id: WorkspacePanelId;
  location: PanelLocation;
  open: boolean;
  /** The right pane's displayed panel: the rail's single active item. */
  active: boolean;
  quiet: boolean;
  customizing: boolean;
  altKey?: string;
  badge?: number;
  dragging: boolean;
  dropTarget: boolean;
  onActivate: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: () => void;
}

export function ActivityBarItem({
  id, location, open, active, quiet, customizing, altKey, badge, dragging, dropTarget,
  onActivate, onDragStart, onDragEnd, onDragOver, onDrop,
}: ActivityBarItemProps) {
  const { t } = useTranslation();
  const def = getPanelDef(id);
  if (!def) return null;
  const title = t(def.titleKey);
  const Icon = def.Icon;
  const showActive = active && !customizing;
  const showOpen = !showActive && location === 'docked' && !customizing;

  // Accessible name: the Radix tooltip is NOT the button's name, and
  // tooltips don't fire on touch / for many SR users, so set it explicitly.
  // In customize mode the action is "hide" (only shown panels render, #1263).
  const ariaLabel = customizing
    ? t('shellChrome.activityBar.iconAriaLabelHide', { title })
    : location === 'floating'
      ? t('shellChrome.activityBar.iconAriaLabelFloating', { title })
      : location === 'popped'
        ? t('shellChrome.activityBar.iconAriaLabelPopped', { title })
        : title;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          {...tourAnchor(activityAnchor(id))}
          aria-label={ariaLabel}
          aria-pressed={location === 'docked'}
          aria-current={showActive ? 'page' : undefined}
          data-rail-state={showActive ? 'active' : showOpen ? 'open' : quiet ? 'quiet' : 'rest'}
          draggable={customizing && id !== 'properties'}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onClick={onActivate}
          className={cn(
            // `shrink-0`: the rail is a `flex flex-col` with more icons than
            // fit some viewports. Without it flexbox squeezed every icon's
            // height well under its own `h-9`, to ~16px (#5826).
            'relative h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-md transition-colors',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            showActive
              ? 'bg-primary/15 text-primary'
              : showOpen
                ? 'text-foreground hover:bg-muted'
                : quiet
                  ? 'text-muted-foreground/50 hover:bg-muted hover:text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            customizing && 'cursor-grab active:cursor-grabbing',
            dragging && 'opacity-40',
            dropTarget && 'ring-1 ring-primary/60',
          )}
        >
          {/* Active accent bar on the rail's leading edge (VS Code idiom). */}
          {showActive && (
            <span className="absolute -left-1.5 top-1.5 bottom-1.5 w-0.5 rounded-r bg-primary" aria-hidden />
          )}
          <Icon className="h-4 w-4" />
          {!customizing && badge !== undefined && badge > 0 && (
            <span
              className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warn-solid px-1 text-2xs font-medium text-solid-foreground ring-1 ring-background"
              aria-hidden
            >
              {badge > 99 ? '99+' : badge}
            </span>
          )}
          {/* Detached indicator dot: floating (primary) vs popped out (neutral ink). */}
          {!customizing && open && location !== 'docked' && (
            <span
              className={cn(
                'absolute right-0 top-0 h-1.5 w-1.5 rounded-full ring-1 ring-background',
                location === 'popped' ? 'bg-muted-foreground' : 'bg-primary',
              )}
              aria-hidden
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">
        {title}
        <span className="text-muted-foreground">
          {customizing ? (
            ` · ${t('shellChrome.activityBar.clickToHideHint')}`
          ) : (
            <>
              {altKey ? ` · ${t('shellChrome.activityBar.altShortcutHint', { key: altKey })}` : ''}
              {location === 'floating'
                ? ` · ${t('shellChrome.activityBar.floatingHint')}`
                : location === 'popped'
                  ? ` · ${t('shellChrome.activityBar.poppedHint')}`
                  : ''}
              {quiet ? ` · ${t('shellChrome.activityBar.needsModelHint')}` : ''}
            </>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
