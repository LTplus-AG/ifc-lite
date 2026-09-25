/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Annotation popover — appears next to a pin when the user clicks
 * an existing annotation. Read mode shows the note + relative time
 * + entity context; edit mode swaps in a textarea with Enter-to-save
 * / Shift+Enter-newline / Esc-cancel semantics.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Trash2, X, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { HudSurface } from '@/components/viewport-ui/hud';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import type { TranslationKey, TranslationParameters } from '@/i18n';
import type { Annotation } from '@/store/slices/annotationsSlice';

const MAX_NOTE_LEN = 2000;
const SOFT_NOTE_LIMIT = 200;

export interface AnnotationPopoverProps {
  annotation: Annotation;
  /** Anchor in canvas-relative pixel coordinates. */
  anchorX: number;
  anchorY: number;
  /** Canvas dimensions for edge clamping (so the popover never falls off-screen). */
  canvasWidth: number;
  canvasHeight: number;
  /** Resolved entity type, when the pin is anchored to a known IfcRoot. */
  entityType?: string | null;
  onSave: (note: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

const POPOVER_WIDTH = 280;
const POPOVER_OFFSET_X = 16;

function formatRelativeTime(timestamp: number, t: (key: TranslationKey, params?: TranslationParameters) => string): string {
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (diff < minute) return t('annotations.popover.relativeJustNow');
  if (diff < hour) return t('annotations.popover.relativeMinutesAgo', { count: Math.floor(diff / minute) });
  if (diff < day) return t('annotations.popover.relativeHoursAgo', { count: Math.floor(diff / hour) });
  if (diff < week) return t('annotations.popover.relativeDaysAgo', { count: Math.floor(diff / day) });
  return new Date(timestamp).toLocaleDateString();
}

export function AnnotationPopover({
  annotation,
  anchorX,
  anchorY,
  canvasWidth,
  canvasHeight,
  entityType,
  onSave,
  onDelete,
  onClose,
}: AnnotationPopoverProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(annotation.note.length === 0);
  const [draft, setDraft] = useState(annotation.note);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset editor state when the popover is reused for a different
  // annotation. Without this, switching pins would carry the previous
  // pin's draft into the new popover.
  useEffect(() => {
    setEditing(annotation.note.length === 0);
    setDraft(annotation.note);
  }, [annotation.id, annotation.note]);

  // When the user enters edit mode, focus + select the textarea so
  // typing replaces the existing body cleanly.
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [editing]);

  // Close on outside click. Listening at the document level keeps
  // the popover predictable when the user mouses anywhere else.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const node = containerRef.current;
      if (!node) return;
      if (node.contains(e.target as Node)) return;
      // Don't close when the click landed on the same pin — the
      // pin's onClick handler controls open/close itself.
      const closestPin = (e.target as HTMLElement).closest?.('[data-annotation-pin-id]');
      if (closestPin?.getAttribute('data-annotation-pin-id') === annotation.id) return;
      onClose();
    };
    // Defer registration to next tick so the click that opened the
    // popover doesn't immediately close it.
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', handler);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [annotation.id, onClose]);

  const handleSave = useCallback(() => {
    onSave(draft);
    setEditing(false);
  }, [draft, onSave]);

  const handleCancel = useCallback(() => {
    setDraft(annotation.note);
    setEditing(false);
    if (annotation.note.length === 0) {
      // No saved body — user backed out of an edit on a freshly
      // committed pin with no body. Close the popover entirely.
      onClose();
    }
  }, [annotation.note, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    },
    [handleSave, handleCancel],
  );

  // Edge clamp the popover. Default: anchor to the right of the pin
  // with a 16px gap; flip left when the right edge would clip.
  const wantsLeft = anchorX + POPOVER_OFFSET_X + POPOVER_WIDTH > canvasWidth;
  const left = wantsLeft
    ? Math.max(8, anchorX - POPOVER_OFFSET_X - POPOVER_WIDTH)
    : Math.min(anchorX + POPOVER_OFFSET_X, canvasWidth - POPOVER_WIDTH - 8);
  const top = Math.min(Math.max(8, anchorY - 12), canvasHeight - 100);

  const charCountVisible = editing && draft.length >= SOFT_NOTE_LIMIT;
  const overSoftLimit = draft.length > SOFT_NOTE_LIMIT;
  const overHardLimit = draft.length > MAX_NOTE_LEN;

  return (
    <HudSurface
      ref={containerRef}
      role="dialog"
      aria-label={t('annotations.popover.ariaLabel')}
      style={{ left, top, width: POPOVER_WIDTH }}
      className={cn(
        // The shared viewport card (#5491): no bespoke hue, border or shadow.
        'absolute z-[60] overflow-hidden',
        'animate-in fade-in-0 zoom-in-95 duration-150',
      )}
    >
      {/* Header — entity context + close. The ink dot echoes the pin this
          popover belongs to. */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-2 w-2 rounded-full bg-overlay-ink shrink-0" aria-hidden />
          <span className="font-mono text-[10px] uppercase tracking-wider text-popover-foreground truncate">
            {entityType ? entityType : t('annotations.popover.headerFallbackLabel')}
            {annotation.entityExpressId !== null && (
              <span className="ml-1 text-muted-foreground">
                #{annotation.entityExpressId}
              </span>
            )}
          </span>
        </div>
        <IconButton
          label={t('annotations.popover.closeButtonTitle')}
          className="h-5 w-5 p-0 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          onClick={onClose}
        >
          <X className="h-3 w-3" />
        </IconButton>
      </div>

      {/* Body */}
      <div className="px-3 py-2.5">
        {editing ? (
          <>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('annotations.popover.placeholder')}
              rows={4}
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
                {t('annotations.popover.keyHints')}
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
                onClick={handleCancel}
              >
                {t('annotations.popover.cancelButton')}
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-[11px] border border-overlay-accent bg-overlay-accent-soft text-popover-foreground hover:bg-overlay-accent/25"
                onClick={handleSave}
                disabled={overHardLimit}
              >
                <Check className="h-3 w-3 mr-1" />
                {t('annotations.popover.saveButton')}
              </Button>
            </div>
          </>
        ) : (
          <>
            {annotation.note ? (
              <p className="font-mono text-[11px] leading-relaxed text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                {annotation.note}
              </p>
            ) : (
              <p className="font-mono text-[11px] italic text-zinc-400 dark:text-zinc-500">
                {t('annotations.popover.emptyNoteHint')}
              </p>
            )}
            <div className="mt-2 pt-2 border-t border-zinc-200/60 dark:border-zinc-800/60 flex items-center justify-between gap-2">
              <span className="text-[9.5px] font-mono uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                {formatRelativeTime(annotation.updatedAt, t)}
                {annotation.updatedAt !== annotation.createdAt && (
                  <span className="ml-1">{t('annotations.popover.editedSuffix')}</span>
                )}
              </span>
              <div className="flex items-center gap-0.5">
                <IconButton
                  label={t('annotations.popover.editButtonTitle')}
                  className="h-6 w-6 p-0 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="h-3 w-3" />
                </IconButton>
                <IconButton
                  label={t('annotations.popover.deleteButtonTitle')}
                  className="h-6 w-6 p-0 text-zinc-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                  onClick={onDelete}
                >
                  <Trash2 className="h-3 w-3" />
                </IconButton>
              </div>
            </div>
          </>
        )}
      </div>
    </HudSurface>
  );
}
