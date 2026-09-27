/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The Drawing toolbar's controls (#5494): a segmented tool option, a display
 *  toggle chip with a state dot, a labelled toggle, and a tooltipped icon
 *  action. Labels collapse to icons when the host is narrow; every control
 *  keeps an accessible name and a tooltip either way. */

import type { ComponentType, ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type IconType = ComponentType<{ className?: string }>;

function Tipped({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** One option of the markup tool segmented control (a radio in a radiogroup). */
export function ToolSegment({ icon: Icon, label, active, showLabel, onSelect }: {
  icon: IconType; label: string; active: boolean; showLabel: boolean; onSelect: () => void;
}) {
  return (
    <Tipped tip={label}>
      <button
        type="button"
        role="radio"
        aria-checked={active}
        aria-label={label}
        onClick={onSelect}
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          active ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        {showLabel && <span>{label}</span>}
      </button>
    </Tipped>
  );
}

/** A display toggle: a state dot, an icon, and (when there is room) its label. */
export function ToggleChip({ icon: Icon, label, tip, on, disabled, showLabel, onToggle }: {
  icon: IconType; label: string; tip: string; on: boolean; disabled?: boolean; showLabel: boolean; onToggle: () => void;
}) {
  return (
    <Tipped tip={tip}>
      <button
        type="button"
        aria-pressed={on}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
        className={cn(
          'inline-flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
          on ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', on ? 'bg-primary' : 'bg-muted-foreground/40')} />
        <Icon className="h-3.5 w-3.5 shrink-0" />
        {showLabel && <span>{label}</span>}
      </button>
    </Tipped>
  );
}

/** A labelled toggle for one of the settings drawers; `dot` marks a drawer whose feature is active while it is closed. */
export function DrawerToggle({ icon: Icon, label, open, dot, showLabel, onToggle }: {
  icon: IconType; label: string; open: boolean; dot: boolean; showLabel: boolean; onToggle: () => void;
}) {
  return (
    <Tipped tip={label}>
      <button
        type="button"
        aria-pressed={open}
        aria-label={label}
        onClick={onToggle}
        className={cn(
          'relative inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          open ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        {showLabel && <span>{label}</span>}
        {dot && !open && <span aria-hidden="true" className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />}
      </button>
    </Tipped>
  );
}

/** A small tooltipped icon button (zoom, fit, pin, clear). */
export function IconAction({ icon: Icon, label, onClick, pressed, disabled, className }: {
  icon: IconType; label: string; onClick: () => void; pressed?: boolean; disabled?: boolean; className?: string;
}) {
  return (
    <Tipped tip={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
          pressed && 'bg-accent text-foreground',
          className,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
    </Tipped>
  );
}

export function ToolbarDivider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />;
}
