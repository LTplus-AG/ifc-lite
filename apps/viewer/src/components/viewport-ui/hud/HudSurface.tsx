/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * The one floating-card surface every HUD control shares (#5478 §3.3): the
 * `popover` token at 94% opacity, `backdrop-blur-md`, a 1px `border`,
 * `radius-md`, and one soft shadow (`shadow-md`) — never a hard offset
 * shadow, never a bespoke opacity/radius/border weight. `HudToolbar`,
 * `HudChip` and `HudNotice` all build on this instead of styling their own
 * card, which is the point: seven card opacities and six radii on the
 * viewport today become one.
 *
 * Every HUD region is `pointer-events-none` (`ViewportHud`), so this is
 * where controls opt back into pointer events — set here, once, rather than
 * by every consumer.
 */
export const HudSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'pointer-events-auto rounded-md border border-border bg-popover/[.94] text-popover-foreground backdrop-blur-md shadow-md',
        className,
      )}
      {...props}
    />
  ),
);
HudSurface.displayName = 'HudSurface';
