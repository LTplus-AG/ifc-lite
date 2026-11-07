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
        // A two-state button, or one option of a mode or radio set (#8802 R4):
        // ghost at rest, the shared active state when `aria-pressed` or
        // `aria-checked` is true (tinted face, active ink, inset active edge,
        // as on a latched ribbon tool). The look comes from the attribute, so
        // the state a screen reader hears is the state the user sees.
        toggle: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground aria-pressed:bg-active-surface aria-pressed:text-active aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-active-border aria-pressed:hover:bg-active-surface-hover aria-pressed:hover:text-active aria-checked:bg-active-surface aria-checked:text-active aria-checked:ring-1 aria-checked:ring-inset aria-checked:ring-active-border aria-checked:hover:bg-active-surface-hover aria-checked:hover:text-active',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        // 36/32/28 px — all already at or above the WCAG 2.2 2.5.8 24x24 CSS
        // px minimum, so no hit-slop belongs HERE (#5826 review round): a
        // uniform pseudo-element on every icon button overlapped adjacent
        // toolbar buttons spaced by `gap-1` (measured — `elementFromPoint` at
        // the visual midpoint between two neighbouring icon buttons resolved
        // to the wrong one), a real click-stealing regression. A caller that
        // shrinks the visual box below 24px via a `className` override (a
        // real, shipped pattern: `size="icon-sm" className="h-5 w-5"`) needs
        // its OWN hit-slop, sized to reach 24px and no further, at its own
        // call site — see MeasurementList.tsx's `DELETE` for the pattern.
        icon: 'h-9 w-9',
        'icon-sm': 'h-8 w-8',
        'icon-xs': 'h-7 w-7',
        // One option of a compact inline mode switch inside a bordered
        // `p-0.5` track (#8802 R5), paired with `variant="toggle"`.
        segment: 'h-auto rounded px-2 py-0.5 text-2xs',
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
