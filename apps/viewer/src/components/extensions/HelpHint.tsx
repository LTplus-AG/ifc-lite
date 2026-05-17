/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `HelpHint` — small info-icon button that pops a short explanation.
 *
 * Renders the popover into `document.body` via a portal so it escapes
 * the parent panel's overflow + width boundaries (the resizable dock
 * panel can be as narrow as ~250px; a 288px inline popover would
 * clip). The popover position is computed from the trigger's
 * bounding rect on each open + window resize.
 *
 * Closes on outside click and Escape. Open state is a controlled
 * `useState`, not a native `<details>`, because positioning the
 * portal needs access to the trigger ref and open flag.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

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
}

interface PopoverPosition {
  top: number;
  left: number;
  width: number;
}

const VIEWPORT_PADDING = 8;
const POPOVER_OFFSET = 6;

export function HelpHint({
  label,
  children,
  side = 'bottom-end',
}: HelpHintProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  const computePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    // Width target — w-72 = 288px (Tailwind v3 default). Cap at the
    // viewport width minus padding so we never overflow on narrow
    // mobile / dock-panel widths.
    const desiredWidth = Math.min(288, vw - VIEWPORT_PADDING * 2);
    let left: number;
    if (side === 'bottom-end') {
      left = rect.right - desiredWidth;
    } else {
      left = rect.left;
    }
    // Clamp to viewport.
    left = Math.max(VIEWPORT_PADDING, Math.min(left, vw - desiredWidth - VIEWPORT_PADDING));
    const top = rect.bottom + POPOVER_OFFSET;
    setPosition({ top, left, width: desiredWidth });
  }, [side]);

  useLayoutEffect(() => {
    if (!open) return;
    computePosition();
  }, [open, computePosition]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => computePosition();
    const onScroll = () => computePosition();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, computePosition]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        title={`Help: ${label}`}
        className={cn(
          'flex items-center justify-center h-6 w-6 rounded-full transition-colors',
          open
            ? 'text-foreground bg-muted'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>

      {open && position && typeof document !== 'undefined'
        && createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={label}
            style={{
              position: 'fixed',
              top: position.top,
              left: position.left,
              width: position.width,
              zIndex: 70,
            }}
            className={cn(
              'rounded-md border bg-popover p-3 shadow-lg text-xs text-popover-foreground space-y-1.5 leading-relaxed',
            )}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
