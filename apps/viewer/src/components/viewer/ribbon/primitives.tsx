/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon building blocks (issue #1686), compacted for #8802 R1. A named
 * RibbonGroup holds headline commands (a 20px icon over a one-line label)
 * and stacks of small 24px icon+label rows that flow two to a column, all
 * inside one 48px band (two rows keep the 24px target floor, #5826). Groups are separated by hairline dividers and spacing; their
 * names stay on the ARIA group (and in tooltips) instead of a caption row.
 * Icons are one monochrome family (`.shell-ribbon-band` maps the house
 * icons' accent paint to the ink) and turn primary only when latched.
 */

import React, { Children, forwardRef, useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { shortcutLabel, type KeyCommandId } from '@/lib/commands/shortcut-label';

/** Subtle pressed-state tint shared by ribbon toggles (loud solid fills
 *  read as alarm at ribbon scale; Office-style tint + inset ring reads
 *  as "latched"). Per-tool accents (amber annotate, accent edit) pass
 *  their own class instead. */
export const RIBBON_ACTIVE_CLASS =
  'bg-primary/15 text-foreground ring-1 ring-inset ring-primary/40';

/** Icon tint of a latched command that uses the shared active state. */
const RIBBON_ACTIVE_ICON_CLASS = 'text-primary';

/** A control that is unavailable but must explain why (#8802 R1): it keeps
 *  `aria-disabled` instead of `disabled`, so it stays in the tab order and
 *  under the pointer and its tooltip opens on hover and on focus, while
 *  `ribbonActivate` drops the activation. Looks like `disabled:`. */
const RIBBON_ARIA_DISABLED_CLASS =
  'aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent';

function isAriaDisabled(value: React.AriaAttributes['aria-disabled']): boolean {
  return value === true || value === 'true';
}

/** Click handler shared by both button sizes: blur to close the tooltip
 *  after a click (house pattern); an aria-disabled control runs nothing. */
function ribbonActivate(
  e: React.MouseEvent<HTMLButtonElement>,
  ariaDisabled: React.AriaAttributes['aria-disabled'],
  onClick: React.MouseEventHandler<HTMLButtonElement> | undefined,
) {
  if (isAriaDisabled(ariaDisabled)) {
    e.preventDefault();
    return;
  }
  e.currentTarget.blur();
  onClick?.(e);
}

interface RibbonTooltipProps {
  label: string;
  /** Keyboard command whose keys the tooltip names (`lib/commands`). */
  shortcut?: KeyCommandId;
  tooltip?: string;
  children: React.ReactElement;
}

/** Tooltip wrapper — only mounts Radix when there is something beyond
 *  the visible label to say (shortcut or a longer description). */
function RibbonTooltip({ label, shortcut, tooltip, children }: RibbonTooltipProps) {
  if (!shortcut && !tooltip) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>
        {tooltip ?? label}
        {shortcut && <span className="ml-2 text-xs opacity-60">({shortcutLabel(shortcut)})</span>}
      </TooltipContent>
    </Tooltip>
  );
}

export interface RibbonContentButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: React.ElementType;
  /** Visible runtime content; static commands use RibbonCommand* and a registry id. */
  contentLabel: string;
  contentSource: 'registered' | 'export' | 'extension' | 'panel-browser';
  contentId: string;
  /** Latched/toggled state (aria-pressed). */
  active?: boolean;
  /** Tailwind classes for the latched state; defaults to the shared tint. */
  activeClassName?: string;
  /** Tooltip body when the visible label isn't the whole story. */
  tooltip?: string;
  /** Keyboard command whose keys the tooltip names (`lib/commands`). */
  shortcut?: KeyCommandId;
  /** Renders a small chevron: the button opens a menu. */
  hasMenu?: boolean;
  /** Corner count badge (e.g. peers in room, basket size). */
  badge?: React.ReactNode;
}

/**
 * Large ribbon button: the headline commands of each group, a 20px icon
 * over a one-line label. Forwards ref so it can serve as a DropdownMenu /
 * Dialog trigger via `asChild`.
 */
export const RibbonContentLargeButton = forwardRef<HTMLButtonElement, RibbonContentButtonProps>(
  function RibbonContentLargeButton(
    { icon: Icon, contentLabel: label, contentSource, contentId, active, activeClassName, tooltip, shortcut, hasMenu, badge, className, onClick, ...rest },
    ref,
  ) {
    const descriptionId = useId();
    // A caller-supplied name owns the accessible name; keep its longer
    // tooltip as a separate, permanently available description.
    const description = rest['aria-label'] ? tooltip : undefined;
    return (
      <RibbonTooltip label={label} shortcut={shortcut} tooltip={tooltip}>
        <button
          ref={ref}
          type="button"
          aria-label={tooltip ?? label}
          aria-describedby={description ? descriptionId : undefined}
          aria-pressed={active === undefined ? undefined : active}
          onClick={(e) => ribbonActivate(e, rest['aria-disabled'], onClick)}
          className={cn(
            // One line, never clipped: the label keeps its natural width
            // (#5395's "Orthographic" lesson) and the band scrolls instead.
            'relative flex h-11 min-w-12 shrink-0 select-none flex-col items-center justify-center gap-0.5 self-center rounded-md px-1.5',
            'text-2xs font-medium text-foreground/90 transition-colors',
            'hover:bg-muted disabled:pointer-events-none disabled:opacity-40',
            RIBBON_ARIA_DISABLED_CLASS,
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            active && (activeClassName ?? RIBBON_ACTIVE_CLASS),
            className,
          )}
          {...rest}
          data-ribbon-content-source={contentSource}
          data-ribbon-content-id={contentId}
        >
          <Icon className={cn('h-5 w-5 shrink-0', active && !activeClassName && RIBBON_ACTIVE_ICON_CLASS)} aria-hidden="true" />
          {/* `data-ribbon-label`: the e2e overflow check measures these (#5395). */}
          <span className="flex items-center gap-0.5">
            <span data-ribbon-label className="whitespace-nowrap leading-tight">{label}</span>
            {hasMenu && <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-60" aria-hidden="true" />}
          </span>
          {badge}
          {description && <span id={descriptionId} className="sr-only">{description}</span>}
        </button>
      </RibbonTooltip>
    );
  },
);

/**
 * Small ribbon button: one 24px icon+label row (the WCAG 2.5.8 floor, #5826);
 * a `RibbonSmallStack` flows them two to a column inside the band.
 */
export const RibbonContentSmallButton = forwardRef<HTMLButtonElement, RibbonContentButtonProps>(
  function RibbonContentSmallButton(
    { icon: Icon, contentLabel: label, contentSource, contentId, active, activeClassName, tooltip, shortcut, hasMenu, badge, className, onClick, ...rest },
    ref,
  ) {
    return (
      <RibbonTooltip label={label} shortcut={shortcut} tooltip={tooltip}>
        <button
          ref={ref}
          type="button"
          aria-label={tooltip ?? label}
          aria-pressed={active === undefined ? undefined : active}
          onClick={(e) => ribbonActivate(e, rest['aria-disabled'], onClick)}
          className={cn(
            'relative flex h-6 w-full min-w-0 select-none items-center gap-1.5 rounded px-1.5',
            'text-2xs leading-none text-foreground/90 transition-colors',
            'hover:bg-muted disabled:pointer-events-none disabled:opacity-40',
            RIBBON_ARIA_DISABLED_CLASS,
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            active && (activeClassName ?? RIBBON_ACTIVE_CLASS),
            className,
          )}
          {...rest}
          data-ribbon-content-source={contentSource}
          data-ribbon-content-id={contentId}
        >
          <Icon className={cn('h-4 w-4 shrink-0', active && !activeClassName && RIBBON_ACTIVE_ICON_CLASS)} aria-hidden="true" />
          <span className="truncate">{label}</span>
          {hasMenu && <ChevronDown className="ml-auto h-2.5 w-2.5 shrink-0 opacity-60" aria-hidden="true" />}
          {badge}
        </button>
      </RibbonTooltip>
    );
  },
);

/** Small buttons flowing two to a column, centred in the band. Width is
 *  natural (widest row of each column wins). A lone button sits on the
 *  band's centre line instead of the top row. */
export function RibbonSmallStack({ children, className }: { children: React.ReactNode; className?: string }) {
  // Two explicit rows make the column flow; a lone row stays auto-sized so
  // `content-center` can centre it.
  const rows = Children.toArray(children).length > 1 && 'grid-rows-2';
  return (
    <div className={cn('grid h-full w-max auto-cols-max grid-flow-col content-center gap-x-1', rows, className)}>
      {children}
    </div>
  );
}

/**
 * One named command cluster. The name is the ARIA group label (screen
 * readers and the e2e inventory read it); visually, groups are separated
 * by `RibbonGroupDivider` and spacing rather than a caption row, which kept
 * the band at 88px for seven buttons (#8802 R1).
 */
export function RibbonGroup({ label, children, className }: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      // Ribbon commands need a named ARIA group; a fieldset would add form semantics here.
      // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="group" aria-label={label} className={cn('flex h-full shrink-0 items-center gap-0.5 px-1', className)}>
      {children}
    </div>
  );
}

/** Hairline divider between ribbon groups. */
export function RibbonGroupDivider() {
  return <div aria-hidden="true" className="mx-1 my-2 w-px shrink-0 self-stretch bg-divider" />;
}
