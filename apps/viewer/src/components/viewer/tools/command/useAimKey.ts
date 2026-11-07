/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react';
import { replayCommandPointer } from '@/lib/commands/modeling/pointer-replay';

/**
 * While a command runs, Alt belongs to it (#9201). Alt alone would otherwise
 * move focus to the browser's menu on release on Windows and Linux, and the
 * next key (Escape, a typed length) would go there. A press or release re-reads
 * the still pointer, and losing the window lets go, since Alt+Tab never sends
 * the release here. Only Alt itself: AltGr is `AltGraph`, and Alt chords are
 * separate key events.
 */
export function useAimKey(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') return;
      event.preventDefault();
      if (!event.repeat) replayCommandPointer(event.type === 'keydown');
    };
    const onBlur = () => replayCommandPointer(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [active]);
}
