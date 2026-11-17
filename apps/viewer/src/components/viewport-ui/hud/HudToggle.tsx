/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MouseEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface HudToggleProps {
  pressed: boolean;
  onPressedChange: () => void;
  icon?: ReactNode;
  children?: ReactNode;
  /** Hover tooltip; translated by the caller. */
  title?: string;
  /** Overrides the visible text as the accessible name (icon-only toggles). */
  'aria-label'?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A pressed/unpressed control on a tool bar — Snap, Geo XYZ, the Section
 * bar's ◉ Cut (#5478 §6). The pressed state is the same `accent-soft` wash a
 * `HudSegmented` option uses, so a bar reads as one control family rather
 * than a segmented control beside differently-styled buttons.
 */
export function HudToggle({ pressed, onPressedChange, icon, children, title, disabled, className, ...rest }: HudToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={rest['aria-label']}
      title={title}
      disabled={disabled}
      onClick={(event) => { releasePointerFocus(event); onPressedChange(); }}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        pressed
          ? 'bg-overlay-accent-soft text-overlay-accent'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * A pointer click hands focus back, so Enter still commits the running
 * command after a bar toggle is clicked mid-gesture (#9233): the dispatcher
 * lets a focused control keep Enter, and Chromium leaves focus on a clicked
 * button. Keyboard activation (`detail === 0`) keeps focus where it is. The
 * ribbon blurs on click for the same reason.
 */
export function releasePointerFocus(event: MouseEvent<HTMLElement>): void {
  if (event.detail > 0) event.currentTarget.blur();
}

/** A thin vertical rule between control groups on a `HudToolbar`. Purely visual. */
export function HudDivider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />;
}
