/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one `onOpenChange` for every export dialog (#5605).
 *
 * Radix calls `onOpenChange(false)` for Escape AND for an outside pointer
 * press, neither of which routes through the footer buttons an export disables.
 * Passing `setOpen` straight in therefore let either gesture unmount the dialog
 * mid-export while the export kept running, taking the progress spinner and the
 * success/failure result with it, so a failed export looked like one that never
 * happened. The returned handler refuses to close while `busy`; opening is
 * never gated. Wire the Cancel button through it too (and disable it while
 * `busy`), so there is one close path.
 *
 * `onOpen` runs as the dialog opens, which is where a dialog clears the
 * previous run's result so reopening never shows a stale success or error.
 */

import { useCallback } from 'react';

export interface ExportDialogOpenGuardOptions {
  /** True while an export is in flight. */
  busy: boolean;
  setOpen: (open: boolean) => void;
  /** Runs when the dialog opens: reset the last run's result here. */
  onOpen?: () => void;
}

export function useExportDialogOpenGuard({ busy, setOpen, onOpen }: ExportDialogOpenGuardOptions): (open: boolean) => void {
  return useCallback((next: boolean) => {
    if (!next && busy) return;
    if (next) onOpen?.();
    setOpen(next);
  }, [busy, setOpen, onOpen]);
}
