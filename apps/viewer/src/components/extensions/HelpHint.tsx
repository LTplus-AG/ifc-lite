/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `HelpHint` — small info-icon button that pops a short explanation.
 *
 * The popover shell is Radix (`ui/popover.tsx`, #5817): it used to be a
 * hand-rolled `createPortal` into `document.body` with its own manual
 * `getBoundingClientRect`-based positioning, its own `mousedown`/`keydown`
 * document listeners for outside-click/Escape, and its own `role="dialog"`
 * on a plain `<div>`. `PopoverPortal` (still portalling to `document.body`,
 * via `usePortalContainer()` so it still escapes a popped-out panel
 * window's own document, #1208) plus `PopoverContent` now supply all of
 * that — positioning (via `align`, matching the old `side` prop's
 * `bottom-start`/`bottom-end`), collision-aware viewport clamping (via
 * `collisionPadding` and the `--radix-popper-available-width` cap, replacing
 * the old `Math.min(288, vw - 16)` math), outside-click/Escape dismissal,
 * and focus return to the trigger.
 */

import { type ReactNode, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '@/components/ui/popover';
import { usePortalContainer } from '@/components/ui/portal-container';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';

interface HelpHintProps {
  /** Accessible label describing what the hint is for. */
  label: string;
  /** Hint body content. */
  children: ReactNode;
  /**
   * Preferred horizontal anchor. `bottom-end` aligns the right edge
   * of the popover with the right edge of the trigger; `bottom-start`
   * mirrors. Both clamp inside the viewport regardless.
   */
  side?: 'bottom-start' | 'bottom-end';
  /**
   * Optional "Learn more" link rendered at the bottom of the popover.
   * Useful for pointing at the full doc page in
   * `docs/guide/extensions.md` or the authoring guide.
   */
  docLink?: { href: string; label?: string };
}

const VIEWPORT_PADDING = 8;
const POPOVER_OFFSET = 6;

export function HelpHint({
  label,
  children,
  side = 'bottom-end',
  docLink,
}: HelpHintProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const portalContainer = usePortalContainer();
  const align = side === 'bottom-end' ? 'end' : 'start';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('extensionsFlavors.helpHint.ariaLabel', { label })}
          aria-expanded={open}
          title={t('extensionsFlavors.helpHint.ariaLabel', { label })}
          className={cn(
            'flex items-center justify-center h-6 w-6 rounded-full transition-colors',
            open
              ? 'text-foreground bg-muted'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverPortal container={portalContainer}>
        <PopoverContent
          align={align}
          sideOffset={POPOVER_OFFSET}
          collisionPadding={VIEWPORT_PADDING}
          aria-label={label}
          style={{ maxWidth: 'var(--radix-popper-available-width)' }}
          className="z-[70] w-72 rounded-md border bg-popover p-3 shadow-lg text-xs text-popover-foreground space-y-1.5 leading-relaxed"
        >
          {children}
          {docLink && (
            <a
              href={docLink.href}
              target="_blank"
              rel="noreferrer"
              className="block pt-1 mt-1 border-t text-primary hover:underline"
            >
              {docLink.label ?? t('extensionsFlavors.helpHint.learnMoreDefault')}
            </a>
          )}
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
