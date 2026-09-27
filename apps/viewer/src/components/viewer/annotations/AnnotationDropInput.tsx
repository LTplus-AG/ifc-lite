/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The inline note input that appears at the click site when the user
 * drops a fresh pin with the Annotate tool. Shape mirrors the popover's
 * edit mode so muscle memory carries over, but the chrome is lighter
 * (a guiding label, no entity-context header) since this is a
 * commit-or-cancel surface.
 *
 * The shell moved onto Radix (`ui/popover.tsx`, #5817) — see
 * `AnnotationPopover.tsx`'s header comment for the virtual-anchor
 * mechanics (there's no real DOM trigger to anchor to here either, just
 * the drop-site's canvas-relative point), the Radix-collision-avoidance
 * vs. old manual-clamp trade-off, and `collisionBoundary={boundaryEl}`
 * (`AnnotationLayer`'s own canvas-sized layer element, #5817 review — a
 * pin near the canvas edge with a side panel docked must clamp to the
 * canvas, not the whole window), all identical here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HudSurface } from '@/components/viewport-ui/hud';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';

const MAX_NOTE_LEN = 2000;
const SOFT_NOTE_LIMIT = 200;
const INPUT_WIDTH = 280;
const INPUT_OFFSET_X = 16;

export interface AnnotationDropInputProps {
  anchorX: number;
  anchorY: number;
  /** `AnnotationLayer`'s own canvas-sized layer element, passed as Radix's
   *  `collisionBoundary` so the input clamps to the canvas rather than
   *  the whole window. */
  boundaryEl: HTMLElement | null;
  /** Resolved entity type when the drop landed on a known mesh. */
  entityType?: string | null;
  entityExpressId?: number | null;
  onSave: (note: string) => void;
  onCancel: () => void;
}

export function AnnotationDropInput({
  anchorX,
  anchorY,
  boundaryEl,
  entityType,
  entityExpressId,
  onSave,
  onCancel,
}: AnnotationDropInputProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const anchorPointRef = useRef({ x: anchorX, y: anchorY });
  anchorPointRef.current = { x: anchorX, y: anchorY };
  const originRef = useRef<HTMLDivElement>(null);
  const virtualAnchorRef = useRef({
    getBoundingClientRect: () => {
      const origin = originRef.current?.getBoundingClientRect();
      const left = (origin?.left ?? 0) + anchorPointRef.current.x;
      const top = (origin?.top ?? 0) + anchorPointRef.current.y;
      return new DOMRect(left, top, 0, 0);
    },
  });

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Commit-or-cancel, shared by outside-click (`onOpenChange` below) and
  // the Cancel/Drop pin buttons' own handlers: empty draft → silent
  // cancel; non-empty → commit (matches "blur to save" feel without
  // destroying typed content). An over-limit draft is rejected
  // consistently with the disabled Drop-pin button.
  const commitOrCancel = useCallback(() => {
    if (draft.trim().length === 0 || draft.length > MAX_NOTE_LEN) {
      onCancel();
    } else {
      onSave(draft);
    }
  }, [draft, onSave, onCancel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (draft.trim().length === 0 || draft.length > MAX_NOTE_LEN) {
          // Over-limit Enter does nothing — match the disabled button.
          if (draft.trim().length === 0) onCancel();
        } else {
          onSave(draft);
        }
      }
      // Escape is handled by the popover below so a typed draft is cancelled
      // rather than committed by the outside-click path.
    },
    [draft, onSave, onCancel],
  );

  const charCountVisible = draft.length >= SOFT_NOTE_LIMIT;
  const overSoftLimit = draft.length > SOFT_NOTE_LIMIT;
  const overHardLimit = draft.length > MAX_NOTE_LEN;

  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) commitOrCancel();
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/aria-hidden-on-focusable -- pure 0x0 measurement probe, never focusable */}
      <div ref={originRef} aria-hidden style={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0 }} />
      <PopoverAnchor virtualRef={virtualAnchorRef} />
      <PopoverContent
        updatePositionStrategy="always"
        side="right"
        align="start"
        sideOffset={INPUT_OFFSET_X}
        collisionPadding={8}
        collisionBoundary={boundaryEl}
        avoidCollisions
        onOpenAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => { e.preventDefault(); onCancel(); }}
        asChild
      >
        <HudSurface
          role="dialog"
          aria-label={t('annotations.dropInput.ariaLabel')}
          style={{ width: INPUT_WIDTH }}
          className={cn(
            // The shared viewport card (#5491): no bespoke hue, border or shadow.
            'z-[60] overflow-hidden p-0',
            'animate-in fade-in-0 zoom-in-95 duration-150',
          )}
        >
          {/* Guiding label — explicit so the user knows what to type and
              establishes "this is for capturing intent, not chat". */}
          <div className="px-3 py-1.5 border-b border-border">
            <span className="font-mono text-[10px] uppercase tracking-wider text-popover-foreground">
              {t('annotations.dropInput.promptLabel')}
              {entityType && (
                <span className="ml-1.5 text-muted-foreground">
                  · {entityType}
                  {entityExpressId !== null && entityExpressId !== undefined && ` #${entityExpressId}`}
                </span>
              )}
            </span>
          </div>

          <div className="px-3 py-2.5">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('annotations.dropInput.placeholder')}
              rows={3}
              maxLength={MAX_NOTE_LEN + 100}
              className={cn(
                'w-full resize-none font-mono text-[11px] leading-relaxed',
                'bg-background/60 text-popover-foreground',
                'border border-border rounded-sm',
                'px-2 py-1.5 outline-none focus:ring-1',
                overHardLimit
                  ? 'focus:ring-red-400 border-red-300 dark:border-red-700/60'
                  : 'focus:ring-overlay-accent/50 focus:border-overlay-accent',
              )}
              spellCheck
              autoCorrect="on"
            />
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] font-mono">
              <span className="text-zinc-400 dark:text-zinc-500">
                {t('annotations.dropInput.keyHints')}
              </span>
              {charCountVisible && (
                <span
                  className={cn(
                    'tabular-nums',
                    overHardLimit
                      ? 'text-red-500'
                      : overSoftLimit
                        ? 'text-status-warn'
                        : 'text-zinc-400',
                  )}
                >
                  {draft.length}/{MAX_NOTE_LEN}
                </span>
              )}
            </div>
            <div className="mt-2 flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={onCancel}
              >
                <X className="h-3 w-3 mr-1" />
                {t('annotations.dropInput.cancelButton')}
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-[11px] border border-overlay-accent bg-overlay-accent-soft text-popover-foreground hover:bg-overlay-accent/25"
                onClick={() => {
                  if (overHardLimit) return;
                  if (draft.trim().length === 0) onCancel();
                  else onSave(draft);
                }}
                disabled={overHardLimit}
              >
                <Check className="h-3 w-3 mr-1" />
                {t('annotations.dropInput.dropPinButton')}
              </Button>
            </div>
          </div>
        </HudSurface>
      </PopoverContent>
    </Popover>
  );
}
