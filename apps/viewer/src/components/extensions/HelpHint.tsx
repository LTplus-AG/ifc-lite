/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `HelpHint` — small info-icon button that pops open a short
 * explanation of the panel it sits next to.
 *
 * Persistent, dismissable, lightweight. The user explicitly didn't
 * want a guided tour, but the customization surface is large enough
 * that each panel needs a "what is this?" entry point. The hint pops
 * inline below the icon and stays open until clicked again or
 * something else on the page absorbs focus.
 *
 * Use a native `<details>` element so the open/closed state is
 * keyboard- and screen-reader-accessible without extra JS.
 */

import { HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface HelpHintProps {
  /** A short label describing what the hint is for. Used for aria + visually hidden text. */
  label: string;
  /** Hint body content. Rendered as React children so callers can include emphasis, code, links. */
  children: React.ReactNode;
  /** Tailwind class for positioning the popover. Default `right-0`. */
  popoverClass?: string;
}

export function HelpHint({ label, children, popoverClass = 'right-0' }: HelpHintProps) {
  return (
    <details className="relative inline-block">
      <summary
        className="flex items-center justify-center h-6 w-6 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer list-none"
        aria-label={`Help: ${label}`}
        title={`Help: ${label}`}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </summary>
      <div
        className={cn(
          'absolute z-30 mt-1 w-72 rounded-md border bg-popover p-3 shadow-lg text-xs text-popover-foreground space-y-1.5 leading-relaxed',
          popoverClass,
        )}
        role="region"
        aria-label={label}
      >
        {children}
      </div>
    </details>
  );
}
