/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Annotation popover — appears next to a pin when the user clicks
 * an existing annotation. Read mode shows the note + relative time
 * + entity context; edit mode swaps in a textarea with Enter-to-save
 * / Shift+Enter-newline / Esc-cancel semantics.
 *
 * The shell moved onto Radix (`ui/popover.tsx`, #5817): it used to be a
 * hand-rolled `HudSurface` with `role="dialog"` and its own
 * `document`-level `mousedown`/no dedicated Escape-for-dismissal listener
 * (Escape only cancelled an in-progress edit; nothing closed the popover
 * itself on Escape before). There's no real DOM trigger to anchor to — the
 * pin is a projected SVG point, re-anchored every camera tick by the shared
 * `SceneProjector` (`AnnotationLayer.tsx`) — so this builds a *virtual*
 * Radix anchor: a zero-size rect at the `anchorX`/`anchorY` canvas-relative
 * point, resolved against a hidden 0×0 probe planted at the canvas's own
 * viewport origin. `updatePositionStrategy="always"` on `PopoverContent`
 * re-reads it every animation frame, matching how the pin itself moves.
 * Radix's own flip/shift collision avoidance (`side="right"`,
 * `collisionPadding`) replaces the old manual `wantsLeft`/clamp math —
 * equivalent in effect (flips toward the side with room, stays on-screen),
 * not pixel-identical to the old formula. `collisionBoundary` is set to
 * `boundaryEl` (`AnnotationLayer`'s own canvas-sized layer element, #5817
 * review) rather than left at Radix's default (the viewport): without it,
 * a pin near the canvas edge with a side panel docked gets positioned past
 * the layer and clipped, since the layer is smaller than the window.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Trash2, X, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { HudSurface } from '@/components/viewport-ui/hud';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
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
  /** `AnnotationLayer`'s own canvas-sized layer element, passed as Radix's
   *  `collisionBoundary` so the popover clamps to the canvas rather than
   *  the whole window (edge clamping — the popover never falls off the
   *  canvas even with a side panel docked). */
  boundaryEl: HTMLElement | null;
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
  boundaryEl,
  entityType,
  onSave,
  onDelete,
  onClose,
}: AnnotationPopoverProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(annotation.note.length === 0);
  const [draft, setDraft] = useState(annotation.note);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The canvas-relative anchor point, read fresh on every
  // `virtualAnchorRef.getBoundingClientRect()` call (Radix/floating-ui
  // calls this repeatedly, including from `updatePositionStrategy="always"`'s
  // per-frame re-measure) — a plain closure over `anchorX`/`anchorY` would
  // go stale between renders, since `virtualAnchorRef` itself is never
  // reassigned.
  const anchorPointRef = useRef({ x: anchorX, y: anchorY });
  anchorPointRef.current = { x: anchorX, y: anchorY };
  // 0×0 probe at the canvas's own top-left (this component renders as a
  // child of `AnnotationLayer`'s canvas-aligned `absolute inset-0`
  // container), so its `getBoundingClientRect()` gives the viewport offset
  // `anchorX`/`anchorY` are relative to.
  const originRef = useRef<HTMLDivElement>(null);
  const virtualAnchorRef = useRef({
    getBoundingClientRect: () => {
      const origin = originRef.current?.getBoundingClientRect();
      const left = (origin?.left ?? 0) + anchorPointRef.current.x;
      const top = (origin?.top ?? 0) + anchorPointRef.current.y;
      return new DOMRect(left, top, 0, 0);
    },
  });

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

  const charCountVisible = editing && draft.length >= SOFT_NOTE_LIMIT;
  const overSoftLimit = draft.length > SOFT_NOTE_LIMIT;
  const overHardLimit = draft.length > MAX_NOTE_LEN;

  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/aria-hidden-on-focusable -- pure 0x0 measurement probe, never focusable */}
      <div ref={originRef} aria-hidden style={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0 }} />
      <PopoverAnchor virtualRef={virtualAnchorRef} />
      <PopoverContent
        updatePositionStrategy="always"
        side="right"
        align="start"
        sideOffset={POPOVER_OFFSET_X}
        collisionPadding={8}
        collisionBoundary={boundaryEl}
        avoidCollisions
        // Editing keeps the textarea's own Escape (cancel-the-edit, not
        // close) in charge; read mode defers to Radix's default (closes via
        // `onOpenChange` above).
        onEscapeKeyDown={(e) => {
          if (editing) {
            e.preventDefault();
            handleCancel();
          }
        }}
        // The pin's own `onClick` toggles selection itself — without this,
        // clicking it while its popover is open would both re-toggle
        // selection AND have Radix dismiss the popover as an "outside"
        // click, double-handling the same gesture.
        onPointerDownOutside={(e) => {
          // `e.target` is the CustomEvent's own dispatch target (the
          // Content node), not the click's real target — that's
          // `e.detail.originalEvent.target`.
          const realTarget = e.detail.originalEvent.target as HTMLElement | null;
          const closestPin = realTarget?.closest?.('[data-annotation-pin-id]');
          if (closestPin?.getAttribute('data-annotation-pin-id') === annotation.id) e.preventDefault();
        }}
        onOpenAutoFocus={(e) => {
          if (!editing) e.preventDefault();
        }}
        asChild
      >
        <HudSurface
          role="dialog"
          aria-label={t('annotations.popover.ariaLabel')}
          style={{ width: POPOVER_WIDTH }}
          className={cn(
            // The shared viewport card (#5491): no bespoke hue, border or shadow.
            'z-[60] overflow-hidden p-0',
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
      </PopoverContent>
    </Popover>
  );
}
