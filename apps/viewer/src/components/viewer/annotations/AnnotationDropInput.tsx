/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The inline note input that appears at the click site when the user
 * drops a fresh pin with the Annotate tool. Shape mirrors the popover's
 * edit mode so muscle memory carries over, but the chrome is lighter
 * (a guiding label, no entity-context header) since this is a
 * commit-or-cancel surface.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HudSurface } from '@/components/viewport-ui/hud';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';

const MAX_NOTE_LEN = 2000;
const SOFT_NOTE_LIMIT = 200;
const INPUT_WIDTH = 280;
const INPUT_OFFSET_X = 16;

export interface AnnotationDropInputProps {
  anchorX: number;
  anchorY: number;
  canvasWidth: number;
  canvasHeight: number;
  /** Resolved entity type when the drop landed on a known mesh. */
  entityType?: string | null;
  entityExpressId?: number | null;
  onSave: (note: string) => void;
  onCancel: () => void;
}

export function AnnotationDropInput({
  anchorX,
  anchorY,
  canvasWidth,
  canvasHeight,
  entityType,
  entityExpressId,
  onSave,
  onCancel,
}: AnnotationDropInputProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Cancel on outside click, but defer registration so the click that
  // dropped the pin doesn't immediately close the input.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const node = containerRef.current;
      if (!node) return;
      if (node.contains(e.target as Node)) return;
      // Empty draft on outside-click → silent cancel; non-empty
      // → commit the draft (matches "blur to save" feel without
      // destroying typed content). An over-limit draft is rejected
      // consistently with the disabled save button.
      if (draft.trim().length === 0 || draft.length > MAX_NOTE_LEN) {
        onCancel();
      } else {
        onSave(draft);
      }
    };
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', handler);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
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
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    },
    [draft, onSave, onCancel],
  );

  const wantsLeft = anchorX + INPUT_OFFSET_X + INPUT_WIDTH > canvasWidth;
  const left = wantsLeft
    ? Math.max(8, anchorX - INPUT_OFFSET_X - INPUT_WIDTH)
    : Math.min(anchorX + INPUT_OFFSET_X, canvasWidth - INPUT_WIDTH - 8);
  const top = Math.min(Math.max(8, anchorY - 8), canvasHeight - 140);

  const charCountVisible = draft.length >= SOFT_NOTE_LIMIT;
  const overSoftLimit = draft.length > SOFT_NOTE_LIMIT;
  const overHardLimit = draft.length > MAX_NOTE_LEN;

  return (
    // HudSurface owns the shared HUD div; this annotation form adds dialog semantics.
    // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
    <HudSurface role="dialog"
      ref={containerRef}
      aria-label={t('annotations.dropInput.ariaLabel')}
      style={{ left, top, width: INPUT_WIDTH }}
      className={cn(
        // The shared viewport card (#5491): no bespoke hue, border or shadow.
        'absolute z-[60] overflow-hidden',
        'animate-in fade-in-0 zoom-in-95 duration-150',
      )}
    >
      {/* Guiding label — explicit so the user knows what to type and
          establishes "this is for capturing intent, not chat". */}
      <div className="px-3 py-1.5 border-b border-border">
        <span className="font-mono text-xs uppercase tracking-wider text-popover-foreground">
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
            'w-full resize-none font-mono text-xs leading-relaxed',
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
        <div className="mt-1.5 flex items-center justify-between gap-2 text-xs font-mono">
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
            className="h-7 px-2 text-xs"
            onClick={onCancel}
          >
            <X className="h-3 w-3 mr-1" />
            {t('annotations.dropInput.cancelButton')}
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-xs border border-overlay-accent bg-overlay-accent-soft text-popover-foreground hover:bg-overlay-accent/25"
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
  );
}
