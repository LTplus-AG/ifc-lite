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
import { cn } from '@/lib/utils';

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
      // destroying typed content).
      if (draft.trim().length > 0) {
        onSave(draft);
      } else {
        onCancel();
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
        if (draft.trim().length === 0) {
          onCancel();
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
    <div
      ref={containerRef}
      role="dialog"
      aria-label="New annotation"
      style={{ left, top, width: INPUT_WIDTH }}
      className={cn(
        'absolute z-[60] pointer-events-auto',
        'rounded-md border border-amber-400/70 dark:border-amber-600/40',
        'bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md',
        'shadow-[0_8px_32px_rgba(0,0,0,0.18)]',
        'overflow-hidden',
        'animate-in fade-in-0 zoom-in-95 duration-150',
      )}
    >
      {/* Guiding label — explicit so the user knows what to type and
          establishes "this is for capturing intent, not chat". */}
      <div className="px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 bg-amber-50/40 dark:bg-amber-950/20">
        <span className="font-mono text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-300">
          What's worth noting?
          {entityType && (
            <span className="ml-1.5 text-zinc-500 dark:text-zinc-400">
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
          placeholder="A short note — flag a defect, ask a question, leave context…"
          rows={3}
          maxLength={MAX_NOTE_LEN + 100}
          className={cn(
            'w-full resize-none font-mono text-[11px] leading-relaxed',
            'bg-zinc-50 dark:bg-zinc-900/60 text-zinc-800 dark:text-zinc-200',
            'border border-zinc-200 dark:border-zinc-800 rounded-sm',
            'px-2 py-1.5 outline-none focus:ring-1',
            overHardLimit
              ? 'focus:ring-red-400 border-red-300 dark:border-red-700/60'
              : 'focus:ring-amber-400/50 focus:border-amber-300/60',
          )}
          spellCheck
          autoCorrect="on"
        />
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] font-mono">
          <span className="text-zinc-400 dark:text-zinc-500">
            ⏎ save · ⇧⏎ newline · esc cancel
          </span>
          {charCountVisible && (
            <span
              className={cn(
                'tabular-nums',
                overHardLimit
                  ? 'text-red-500'
                  : overSoftLimit
                    ? 'text-amber-600 dark:text-amber-400'
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
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-[11px] bg-amber-500 hover:bg-amber-500/90 text-white"
            onClick={() => (draft.trim().length === 0 ? onCancel() : onSave(draft))}
            disabled={overHardLimit}
          >
            <Check className="h-3 w-3 mr-1" />
            Drop pin
          </Button>
        </div>
      </div>
    </div>
  );
}
