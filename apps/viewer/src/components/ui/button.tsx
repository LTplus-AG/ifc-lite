/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        // The icon sizes below all keep a >=24x24 CSS px HIT AREA (WCAG 2.2
        // 2.5.8) via the `after:` hit-slop pseudo-element, independent of
        // their visual box. `relative` gives the pseudo-element something to
        // position against; `after:-inset-2` (8px a side) pulls its invisible
        // box outward from the actual rendered button, so a caller that
        // shrinks the visual size with a `className` override (a real,
        // shipped pattern: `size="icon-sm" className="h-5 w-5"`, see #5826)
        // still gets >=24px of clickable area — the pseudo has no border or
        // background, so the VISUAL footprint in a dense toolbar is
        // untouched. -8px covers every icon-only override down to ~8px
        // visually (8 + 2*8 = 24); nothing in this codebase goes smaller.
        icon: 'relative h-9 w-9 after:absolute after:-inset-2 after:content-[""]',
        'icon-sm': 'relative h-8 w-8 after:absolute after:-inset-2 after:content-[""]',
        'icon-xs': 'relative h-7 w-7 after:absolute after:-inset-2 after:content-[""]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
