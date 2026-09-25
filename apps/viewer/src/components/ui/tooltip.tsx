/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';
import { usePortalContainer } from './portal-container';

/** True below a `TooltipProvider`. Radix throws when a `Tooltip` has no
 *  provider above it, so a primitive that may be rendered outside the app
 *  shell's provider (a tour card, a standalone dialog) checks this and brings
 *  its own (`IconButton`). */
const TooltipProviderPresence = React.createContext(false);

function TooltipProvider(props: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipProviderPresence.Provider value={true}>
      <TooltipPrimitive.Provider {...props} />
    </TooltipProviderPresence.Provider>
  );
}

/** Whether a `TooltipProvider` is mounted above the caller. */
function useHasTooltipProvider(): boolean {
  return React.useContext(TooltipProviderPresence);
}
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal container={usePortalContainer()}>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, useHasTooltipProvider };
