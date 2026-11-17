/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react';
import { forgetCommandPointer, replayCommandPointer } from '@/lib/commands/modeling/pointer-replay';
import { useViewerStore } from '@/store';

/**
 * While a command runs, Alt belongs to it (#9201). Alt alone would otherwise
 * move focus to the browser's menu on release on Windows and Linux, and the
 * next key (Escape, a typed length) would go there. A press or release re-reads
 * the still pointer, and losing the window lets go, since Alt+Tab never sends
 * the release here. Turning snapping on or off (S) re-reads it too, and a new
 * command forgets the last one's pointer. Only Alt itself: AltGr is `AltGraph`, and Alt chords are
 * separate key events.
 */
export function useAimKey(command: unknown): void {
  useEffect(() => {
    if (!command) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') return;
      event.preventDefault();
      if (!event.repeat) replayCommandPointer({ altKey: event.type === 'keydown', shiftKey: event.shiftKey });
    };
    const onBlur = () => replayCommandPointer({ altKey: false, shiftKey: false });
    const unsubscribe = useViewerStore.subscribe((s, prev) => { if (s.snapEnabled !== prev.snapEnabled) replayCommandPointer(); });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
      unsubscribe();
      // A new command starts from no pointer: the last one's position is not its click.
      forgetCommandPointer();
    };
  }, [command]);
}
