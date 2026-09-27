/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A button whose only content is an icon (#5811).
 *
 * An icon has no text, so without help the button has no accessible name:
 * a screen reader announces "button" and nothing else. `title=` does not fix
 * that reliably and never shows on keyboard focus or touch, and a Radix
 * `Tooltip` alone does not either (it only sets `aria-describedby`, and only
 * while it is open). So `label` is REQUIRED here: it becomes the button's
 * `aria-label` and, unless `tooltip` overrides the visible text, the tooltip
 * shown on hover and on keyboard focus.
 *
 * Composes like `Button`: it forwards its ref and every other prop to the
 * underlying `<button>`, so it can sit inside a Radix `...Trigger asChild`.
 * Under the app-level `TooltipProvider` (`ViewerLayout`) neighbouring toolbar
 * tooltips share its skip-delay; rendered outside one (a tour card, a
 * standalone dialog, a unit test) it brings its own, because a Radix
 * `Tooltip` with no provider above it throws.
 */

import * as React from 'react';
import { Button, type ButtonProps } from './button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, useHasTooltipProvider } from './tooltip';

export interface IconButtonProps extends Omit<ButtonProps, 'aria-label' | 'title' | 'asChild'> {
  /** Accessible name, and the tooltip text unless `tooltip` is given. */
  label: string;
  /** Visible tooltip content when it should say more than `label` (a shortcut, a state). */
  tooltip?: React.ReactNode;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  /** The icon. */
  children: React.ReactNode;
}

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, tooltip, tooltipSide, variant = 'ghost', size = 'icon', type = 'button', children, ...props }, ref) => {
    const hasProvider = useHasTooltipProvider();
    const descriptionId = React.useId();
    // Text the tooltip adds beyond the name (a state, a consequence) would
    // otherwise exist only while the tooltip is open; keep it referenced as
    // the button's description. `hidden` content still counts for
    // aria-describedby and takes no layout.
    const description = typeof tooltip === 'string' && tooltip !== label ? tooltip : null;
    const button = (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={ref}
            variant={variant}
            size={size}
            type={type}
            aria-label={label}
            aria-describedby={description ? descriptionId : undefined}
            {...props}
          >
            {children}
            {description && <span id={descriptionId} hidden>{description}</span>}
          </Button>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>{tooltip || label}</TooltipContent>
      </Tooltip>
    );
    return hasProvider ? button : <TooltipProvider>{button}</TooltipProvider>;
  },
);
IconButton.displayName = 'IconButton';

export { IconButton };
