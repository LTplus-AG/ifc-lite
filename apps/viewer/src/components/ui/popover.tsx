/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Radix Popover wrapper (#5817).
 *
 * The hand-rolled popovers this issue replaces (SearchInline's results
 * dropdown, SearchableSelect, LocationMap, the annotation popovers) each grew
 * their own `window`/`document` `mousedown` listener for outside-click and
 * their own Esc handling — none of them return focus to the opener, and none
 * carry dialog/listbox semantics beyond what the caller bothers to add.
 * Radix's `DismissableLayer` (outside click, Esc) and `FocusScope`
 * (open/close focus management) already do this correctly; this wrapper is
 * the shared entry point so every migrated popover gets it the same way.
 *
 * Unlike `ui/dialog.tsx` and `ui/dropdown-menu.tsx`, `PopoverContent` here
 * does NOT portal by default: several callers (`SearchInline`'s combobox
 * listbox) are asserted against by tests that query the rendered popover as
 * a DOM descendant of the component's own container, which a portal to
 * `document.body` would break. A caller that needs to escape a clipping
 * ancestor composes `PopoverPrimitive.Portal` (re-exported below) itself.
 *
 * `z-50` matches the overlay layer `ui/dialog.tsx` already uses (#5483 will
 * introduce a shared z-scale token; until then this is the existing value).
 */

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;
const PopoverClose = PopoverPrimitive.Close;
const PopoverPortal = PopoverPrimitive.Portal;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Content
    ref={ref}
    align={align}
    sideOffset={sideOffset}
    className={cn(
      'z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
      className
    )}
    {...props}
  />
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent, PopoverClose, PopoverPortal };
