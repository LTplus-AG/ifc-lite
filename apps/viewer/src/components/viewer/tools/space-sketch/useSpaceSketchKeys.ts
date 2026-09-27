/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keyboard ownership for the Space Sketch overlay.
 *
 * The shared dispatcher gives the sketch's tool commands priority over global
 * model undo and selection Escape. A popover gets the first Escape; otherwise
 * the sketch aborts the in-progress operation before offering a two-press exit.
 * Modifier events repaint hover cues without consuming browser behavior.
 */

import { useCallback, useEffect, useRef } from 'react';
import { registerKeyboardBinding, registerKeyboardCommand, registerKeyboardKeyUp } from '@/lib/commands/dispatcher';

/** Two Escapes within this window close the panel. */
export const DOUBLE_ESC_MS = 400;

export interface UseSpaceSketchKeysOptions {
  undo: () => void;
  redo: () => void;
  /** Close any open disclosure popover. Returns true if one was open. */
  closePopovers: () => boolean;
  /** Abort the in-progress op (rect / draw / cut / drag). Returns true if it did. */
  abortCurrentOp: () => boolean;
  /** Leave the tool without creating anything; `esc` names the exit route (#5618). */
  closeNow: (via: 'esc') => void;
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

  const onMod = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Alt' && e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'Shift') return;
    onModifiers(e);
  }, [onModifiers]);

  useEffect(() => {
    const removeUndo = registerKeyboardCommand('spaceSketch.undo', () => { undo(); });
    const removeRedo = registerKeyboardCommand('spaceSketch.redo', () => { redo(); });
    const removePopoverEscape = registerKeyboardCommand('spaceSketch.cancel', () => {
      if (!closePopovers()) return false;
      escTimeRef.current = 0;
    }, { layer: 'popover', allowInTextEntry: true, ignoreModifiers: true });
    const removeToolEscape = registerKeyboardCommand('spaceSketch.cancel', () => {
      const now = Date.now();
      if (abortCurrentOp()) { escTimeRef.current = 0; return; }
      if (now - escTimeRef.current <= DOUBLE_ESC_MS) { escTimeRef.current = 0; closeNow('esc'); }
      else {
        escTimeRef.current = now;
        setStatus(needsConfirm
          ? 'Esc again to close without creating (use Confirm to create).'
          : 'Press Esc again to close.');
      }
    }, { allowInTextEntry: true, ignoreModifiers: true });
    const removeCommit = registerKeyboardCommand('spaceSketch.commit', () => {
      if (!commitDraw) return false;
      commitDraw();
    }, { ignoreModifiers: true });
    const removeModifierDown = registerKeyboardBinding({
      id: 'spaceSketch.modifiers', when: 'tool.spaceSketch', layer: 'popover',
      keys: [{ key: 'shift' }, { key: 'alt' }, { key: 'control' }, { key: 'meta' }],
      ignoreModifiers: true, allowInTextEntry: true,
      run: (event) => { onMod(event); return false; },
    });
    const removeModifierUp = registerKeyboardKeyUp(onMod);
    return () => {
      removeUndo(); removeRedo(); removePopoverEscape(); removeToolEscape();
      removeCommit(); removeModifierDown(); removeModifierUp();
    };
  }, [undo, redo, closePopovers, abortCurrentOp, closeNow, needsConfirm, setStatus, commitDraw, onMod]);
}
