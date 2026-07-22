/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon building blocks (issue #1686). Office/IFCFlux-style grammar:
 * a labeled RibbonGroup holds either large one-command buttons (icon
 * over a two-line label) or a stack of small icon+label rows, and the
 * group name sits beneath in drafting-annotation caps. All colors ride
 * the existing shadcn tokens so light/dark/colorful themes just work.
 */

import React, { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Subtle pressed-state tint shared by ribbon toggles (loud solid fills
 *  read as alarm at ribbon scale; Office-style tint + inset ring reads
 *  as "latched"). Per-tool accents (amber annotate, purple edit) pass
 *  their own class instead. */
export const RIBBON_ACTIVE_CLASS =
  'bg-primary/15 text-foreground ring-1 ring-inset ring-primary/40';

interface RibbonTooltipProps {
  label: string;
  /** Extra tooltip line (keyboard shortcut or state hint). */
  shortcut?: string;
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
        {shortcut && <span className="ml-2 text-xs opacity-60">({shortcut})</span>}
      </TooltipContent>
    </Tooltip>
  );
}

export interface RibbonButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: React.ElementType;
  label: string;
  /** Latched/toggled state (aria-pressed). */
  active?: boolean;
  /** Tailwind classes for the latched state; defaults to the shared tint. */
  activeClassName?: string;
  /** Tooltip body when the visible label isn't the whole story. */
  tooltip?: string;
  /** Keyboard shortcut shown in the tooltip. */
  shortcut?: string;
  /** Renders a small chevron: the button opens a menu. */
  hasMenu?: boolean;
  /** Corner count badge (e.g. peers in room, basket size). */
  badge?: React.ReactNode;
}

/**
 * Large ribbon button: icon over a (wrappable) two-line label. The
 * headline commands of each group. Forwards ref so it can serve as a
 * DropdownMenu / Dialog trigger via `asChild`.
 */
export const RibbonLargeButton = forwardRef<HTMLButtonElement, RibbonButtonProps>(
  function RibbonLargeButton(
    { icon: Icon, label, active, activeClassName, tooltip, shortcut, hasMenu, badge, className, onClick, ...rest },
    ref,
  ) {
    return (
      <RibbonTooltip label={label} shortcut={shortcut} tooltip={tooltip}>
        <button
          ref={ref}
          type="button"
          aria-label={tooltip ?? label}
          aria-pressed={active === undefined ? undefined : active}
          onClick={(e) => {
            // Blur to close the tooltip after click (house pattern).
            (e.currentTarget as HTMLButtonElement).blur();
            onClick?.(e);
          }}
          className={cn(
            'relative flex h-full w-14 shrink-0 select-none flex-col items-center justify-start gap-1 rounded-md px-1 py-1',
            'text-[10px] font-medium leading-[1.15] text-foreground/90 transition-colors',
            'hover:bg-muted/70 disabled:pointer-events-none disabled:opacity-40',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            active && (activeClassName ?? RIBBON_ACTIVE_CLASS),
            className,
          )}
          {...rest}
        >
          <Icon className="h-8 w-8 shrink-0" aria-hidden="true" />
          <span className="flex h-[2.3em] w-full items-start justify-center gap-0.5">
            <span className="line-clamp-2 min-w-0 text-center">{label}</span>
            {hasMenu && <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-60" aria-hidden="true" />}
          </span>
          {badge}
        </button>
      </RibbonTooltip>
    );
  },
);

/**
 * Small ribbon button: one icon+label row, stacked up to three per
 * column inside a group (wrap in `RibbonSmallStack`).
 */
export const RibbonSmallButton = forwardRef<HTMLButtonElement, RibbonButtonProps>(
  function RibbonSmallButton(
    { icon: Icon, label, active, activeClassName, tooltip, shortcut, hasMenu, badge, className, onClick, ...rest },
    ref,
  ) {
    return (
      <RibbonTooltip label={label} shortcut={shortcut} tooltip={tooltip}>
        <button
          ref={ref}
          type="button"
          aria-label={tooltip ?? label}
          aria-pressed={active === undefined ? undefined : active}
          onClick={(e) => {
            (e.currentTarget as HTMLButtonElement).blur();
            onClick?.(e);
          }}
          className={cn(
            'relative flex h-[20px] w-full min-w-0 select-none items-center gap-1.5 rounded px-1.5',
            'text-[11px] leading-none text-foreground/90 transition-colors',
            'hover:bg-muted/70 disabled:pointer-events-none disabled:opacity-40',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            active && (activeClassName ?? RIBBON_ACTIVE_CLASS),
            className,
          )}
          {...rest}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
          {hasMenu && <ChevronDown className="ml-auto h-2.5 w-2.5 shrink-0 opacity-60" aria-hidden="true" />}
          {badge}
        </button>
      </RibbonTooltip>
    );
  },
);

/** Column of up to three small buttons, vertically centered in the band.
 *  Width is natural (widest row wins) so group labels center on the
 *  actual content instead of padded air. */
export function RibbonSmallStack({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-full w-max flex-col justify-center gap-px', className)}>
      {children}
    </div>
  );
}

/**
 * One labeled command cluster. Content row on top, the group name in
 * tiny drafting caps beneath — the plan-sheet annotation register.
 * Content is centered over the label (and vice versa) so a one-button
 * group whose label is wider than the button still reads as one axis.
 */
export function RibbonGroup({ label, children, className }: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex h-full shrink-0 flex-col px-1.5', className)}>
      <div className="flex min-h-0 flex-1 items-stretch justify-center gap-0.5 pt-1">
        {children}
      </div>
      <div className="pb-1 pt-0.5 text-center text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
        {label}
      </div>
    </div>
  );
}

/** Hairline divider between ribbon groups. */
export function RibbonGroupDivider() {
  return <div aria-hidden="true" className="my-2 w-px shrink-0 self-stretch bg-border/70" />;
}
