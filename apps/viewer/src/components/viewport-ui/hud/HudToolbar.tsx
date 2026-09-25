/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { HudSurface } from './HudSurface';

/**
 * A tool's HUD bar: one row of controls (segmented axis choice, a value
 * field, a Cap popover trigger, …) on the shared `HudSurface`. This is the
 * "at most one tool bar" the HUD's top-center region holds (#5478 §2).
 * Wraps when the region caps its width (`ViewportHud`'s top-center lane),
 * so a long bar in a narrow viewport becomes two rows, never an overlap.
 */
export const HudToolbar = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <HudSurface
      ref={ref}
      className={cn('flex flex-wrap items-center justify-center gap-1 px-1.5 py-1 text-xs', className)}
      {...props}
    />
  ),
);
HudToolbar.displayName = 'HudToolbar';
