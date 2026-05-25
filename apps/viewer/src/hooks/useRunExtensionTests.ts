/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useRunExtensionTests` — wraps the per-extension test run.
 *
 * Tracks a per-id "running" set so repeated clicks don't queue
 * concurrent runs. The UI uses `isRunning(id)` to gate the trigger
 * button + show a pulsing icon.
 *
 * Returns `{ runTests, isRunning }`.
 */

import { useCallback, useState } from 'react';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { toast } from '@/components/ui/toast';
import * as toastText from '@/components/extensions/toast-helpers';

export interface RunExtensionTestsApi {
  runTests(id: string): void;
  isRunning(id: string): boolean;
}

export function useRunExtensionTests(): RunExtensionTestsApi {
  const host = useExtensionHost();
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());

  const runTests = useCallback(
    (id: string) => {
      if (running.has(id)) return;
      setRunning((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      toast.info(`Running tests for ${id}…`);
      host.runTests(id)
        .then((summary) => {
          if (summary.results.length === 0) {
            toast.info(toastText.testsNotDeclared(id));
          } else if (summary.failed === 0) {
            toast.success(toastText.testsPassed(id, summary.passed, summary.results.length));
          } else {
            const firstError = summary.results.find((r) => !r.passed)?.error ?? 'see console';
            toast.error(toastText.testsFailed(id, summary.failed, firstError));
            console.warn('[ext-host] test failures:', summary);
          }
        })
        .catch((err) => {
          toast.error(toastText.failed(`Tests for ${id}`, err));
        })
        .finally(() => {
          setRunning((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        });
    },
    [host, running],
  );

  const isRunning = useCallback((id: string) => running.has(id), [running]);

  return { runTests, isRunning };
}
