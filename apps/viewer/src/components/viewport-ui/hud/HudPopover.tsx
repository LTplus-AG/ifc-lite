/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';
import { usePortalContainer } from '@/components/ui/portal-container';

/**
 * The HUD's one popover — e.g. the Section bar's Cap ▾ (Surfaces/Lines,
 * hatch, fill, spacing), the roadmap's "**Cap ▾** is the only popover"
 * (#5478 §6). Radix `Popover`, same shape as `components/ui/dropdown-menu`:
 * `usePortalContainer()` so it portals into a popped-out panel window
 * instead of always the main document (#1208), and the shared card surface
 * instead of the generic `bg-popover` shadow-lg dropdown styling.
 */
const HudPopover = PopoverPrimitive.Root;
const HudPopoverTrigger = PopoverPrimitive.Trigger;
const HudPopoverAnchor = PopoverPrimitive.Anchor;
const HudPopoverClose = PopoverPrimitive.Close;

const HudPopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal container={usePortalContainer()}>
    <PopoverPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-(--z-hud-popover) pointer-events-auto min-w-[10rem] rounded-md border border-border bg-popover/[.94] p-2 text-xs text-popover-foreground backdrop-blur-md shadow-md outline-none',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
HudPopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { HudPopover, HudPopoverTrigger, HudPopoverAnchor, HudPopoverClose, HudPopoverContent };
