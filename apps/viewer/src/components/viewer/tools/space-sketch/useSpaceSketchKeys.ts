/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keyboard ownership for the Space Sketch overlay.
 *
 * While the panel is open, three keys belong to the sketch rather than to the
 * app: Ctrl/Cmd+Z, Escape, and Enter. The global handler in
 * `useKeyboardShortcuts` registers `keydown` in the BUBBLE phase; all three
 * listeners here register with the capture flag, and Escape additionally calls
 * `stopImmediatePropagation()`. That is the whole mechanism:
 *
 * - without capture, Ctrl+Z would undo the 3D model's mutation stack instead of
 *   the sketch's plate history;
 * - without capture + `stopImmediatePropagation`, the first Escape would close
 *   the tool through the global handler and throw away every draft, instead of
 *   aborting the in-progress operation.
 *
 * Dropping the third `addEventListener` argument is a one-character regression
 * with no visible symptom until a user loses work, which is why this lives in
 * one place with `useSpaceSketchKeys.test.tsx` pinned to it.
 *
 * The modifier listener is deliberately NOT capture: it only repaints the hover
 * preview and must not shadow anything.
 */

import { useCallback, useEffect, useRef } from 'react';
import { eventKey, isTextEntryTarget } from '@/lib/keyboard-event';

/** Two Escapes within this window close the panel. */
export const DOUBLE_ESC_MS = 400;

export interface UseSpaceSketchKeysOptions {
  undo: () => void;
  redo: () => void;
  /** Close any open disclosure popover. Returns true if one was open. */
  closePopovers: () => boolean;
  /** Abort the in-progress op (rect / draw / cut / drag). Returns true if it did. */
  abortCurrentOp: () => boolean;
  /** Leave the tool without creating anything. */
  closeNow: () => void;
  /** There are unconfirmed drafts, so the double-tap prompt says so. */
  needsConfirm: boolean;
  setStatus: (status: string) => void;
  /** Close the drawn room on Enter; null when no draw is in progress. */
  commitDraw: (() => void) | null;
  /** A modifier key went down or up — repaint the hover preview in place. */
  onModifiers: (e: KeyboardEvent) => void;
}

export function useSpaceSketchKeys({
  undo,
  redo,
  closePopovers,
  abortCurrentOp,
  closeNow,
  needsConfirm,
  setStatus,
  commitDraw,
  onModifiers,
}: UseSpaceSketchKeysOptions): void {
  // Timestamp of the last bare Esc — a second within DOUBLE_ESC_MS closes.
  const escTimeRef = useRef(0);

  // Ctrl/Cmd+Z (Shift = redo) must drive THIS overlay's history, not the 3D
  // model behind the panel. The global handler routes Ctrl+Z to the active
  // model's mutation stack; a capture-phase listener here runs before it and
  // stopPropagation()s, so the sketch and the in-panel Undo/Redo buttons share
  // one history. Skip when a text input is focused so native field undo (and
  // the global handler, which also skips inputs) is untouched. The overlay only
  // mounts while the tool is active, so this listener's lifetime is exactly the
  // tool's.
  useEffect(() => {
    const onUndoRedo = (e: KeyboardEvent) => {
      if (eventKey(e) !== 'z' || !(e.ctrlKey || e.metaKey)) return;
      if (isTextEntryTarget(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', onUndoRedo, true);
    return () => window.removeEventListener('keydown', onUndoRedo, true);
  }, [undo, redo]);

  // Esc: close a popover → abort the current op → (double-tap) close, with an
  // unconfirmed-drafts prompt. Enter closes a drawn room.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation(); // own Esc; don't let the global handler close us
        if (closePopovers()) return;
        const now = Date.now();
        if (abortCurrentOp()) { escTimeRef.current = 0; return; }
        // Double-tap Esc cancels (close without creating); the Confirm button is
        // the only create path.
        if (now - escTimeRef.current <= DOUBLE_ESC_MS) { escTimeRef.current = 0; closeNow(); }
        else {
          escTimeRef.current = now;
          setStatus(needsConfirm
            ? 'Esc again to close without creating (use Confirm to create).'
            : 'Press Esc again to close.');
        }
      } else if (e.key === 'Enter' && commitDraw && !isTextEntryTarget(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        commitDraw();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [abortCurrentOp, closePopovers, closeNow, commitDraw, needsConfirm, setStatus]);

  // Pressing/releasing a modifier re-evaluates the hover preview at the current
  // cursor (so the action label + cues flip the instant you hold ⌥/Ctrl/Shift,
  // without having to move). Bubble phase: it shadows nothing.
  const onMod = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Alt' && e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'Shift') return;
    onModifiers(e);
  }, [onModifiers]);
  useEffect(() => {
    window.addEventListener('keydown', onMod);
    window.addEventListener('keyup', onMod);
    return () => {
      window.removeEventListener('keydown', onMod);
      window.removeEventListener('keyup', onMod);
    };
  }, [onMod]);
}
