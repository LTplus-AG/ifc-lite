/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Visible failure banner for the Lists panel (issue #4317).
 *
 * `ListPanel.handleExecuteList` / `handleImport` used to swallow a run or
 * import failure into `console.error` with no on-screen consequence — a
 * rejected name-pattern column (`compileNameMatcher`'s ReDoS guard,
 * #4262/#4292) or a malformed import file read identically to a genuine
 * empty result. This mirrors `SearchModal.filter.tsx`'s `FilterErrorBox`,
 * which already surfaces the same `compileNameMatcher` throw for the
 * advanced filter's "matches" chip.
 */

import { AlertCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ListErrorBox({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="border-b bg-red-50/50 px-4 py-3 dark:bg-red-950/20">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
        <div className="min-w-0 flex-1 text-xs">
          <div className="font-semibold text-red-900 dark:text-red-200">List failed</div>
          <div className="mt-1 break-words text-red-800 dark:text-red-300">{message}</div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss error"
          className="-mt-1 -mr-1 h-5 w-5 shrink-0"
          onClick={onDismiss}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
