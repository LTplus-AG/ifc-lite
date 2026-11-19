/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef } from 'react';

export interface ReplaceableTimeout {
  /** Run `fn` after `ms`, cancelling whatever this handle still had pending. */
  schedule: (fn: () => void, ms: number) => void;
  /** Drop the pending callback, if any. */
  cancel: () => void;
}

/**
 * One pending delayed callback per owner, e.g. "reset the export status after
 * 2 s". A bare `setTimeout(() => setStatus('idle'), 2000)` belongs to nobody:
 * a second run started inside the window has its own status cleared by the
 * first run's timer. Here the latest `schedule` (or `cancel`, which a new run
 * calls when it starts) supersedes the older timer, and unmount drops it.
 */
export function useReplaceableTimeout(): ReplaceableTimeout {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handle = useMemo<ReplaceableTimeout>(() => {
    const cancel = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    return {
      cancel,
      schedule: (fn, ms) => {
        cancel();
        timer.current = setTimeout(() => { timer.current = null; fn(); }, ms);
      },
    };
  }, []);
  useEffect(() => handle.cancel, [handle]);
  return handle;
}
