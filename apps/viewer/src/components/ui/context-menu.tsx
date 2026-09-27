/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as React from 'react';
import * as Primitive from '@radix-ui/react-context-menu';
import { cn } from '@/lib/utils';

export const ContextMenu = Primitive.Root;
export const ContextMenuTrigger = Primitive.Trigger;
export const ContextMenuSub = Primitive.Sub;

export const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, ...props }, ref) => (
  <Primitive.Content
    ref={ref}
    collisionPadding={4}
    className={cn('z-50 min-w-48 rounded-lg border bg-popover py-1 shadow-lg outline-none', className)}
    {...props}
  />
));
ContextMenuContent.displayName = 'ContextMenuContent';

export const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item>
>(({ className, ...props }, ref) => (
  <Primitive.Item
    ref={ref}
    className={cn('cursor-default outline-none focus:bg-muted data-[disabled]:opacity-50', className)}
    {...props}
  />
));
ContextMenuItem.displayName = 'ContextMenuItem';

export const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof Primitive.Separator>,
  React.ComponentPropsWithoutRef<typeof Primitive.Separator>
>(({ className, ...props }, ref) => (
  <Primitive.Separator ref={ref} className={cn('my-1 h-px bg-border', className)} {...props} />
));
ContextMenuSeparator.displayName = 'ContextMenuSeparator';

export const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof Primitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof Primitive.SubTrigger>
>(({ className, ...props }, ref) => (
  <Primitive.SubTrigger
    ref={ref}
    className={cn('flex w-full cursor-default items-center px-3 py-1.5 text-sm outline-none focus:bg-muted data-[state=open]:bg-muted', className)}
    {...props}
  />
));
ContextMenuSubTrigger.displayName = 'ContextMenuSubTrigger';

export const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof Primitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof Primitive.SubContent>
>(({ className, ...props }, ref) => (
  <Primitive.SubContent
    ref={ref}
    collisionPadding={4}
    className={cn('z-50 min-w-36 rounded-lg border bg-popover py-1 shadow-lg outline-none', className)}
    {...props}
  />
));
ContextMenuSubContent.displayName = 'ContextMenuSubContent';
