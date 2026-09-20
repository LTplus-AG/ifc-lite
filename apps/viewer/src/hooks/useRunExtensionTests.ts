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
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

export interface RunExtensionTestsApi {
  runTests(id: string): void;
  isRunning(id: string): boolean;
}

export function useRunExtensionTests(): RunExtensionTestsApi {
  const host = useExtensionHost();
  const { t, locale } = useTranslation();
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());

  const runTests = useCallback(
    (id: string) => {
      if (running.has(id)) return;
      setRunning((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      toast.info(t('extensionsFlavors.extensionsPanel.toast.testsRunning', { id }));
      host.runTests(id)
        .then((summary) => {
          if (summary.results.length === 0) {
            toast.info(t('extensionsFlavors.extensionsPanel.toast.testsNotDeclared', { id }));
          } else if (summary.failed === 0) {
            toast.success(t('extensionsFlavors.extensionsPanel.toast.testsPassed', {
              id,
              count: summary.results.length,
              passed: formatLocaleNumber(locale, summary.passed),
              total: formatLocaleNumber(locale, summary.results.length),
            }));
          } else {
            const firstError = summary.results.find((r) => !r.passed)?.error ?? 'see console';
            toast.error(t('extensionsFlavors.extensionsPanel.toast.testsFailed', {
              id,
              count: summary.failed,
              failed: formatLocaleNumber(locale, summary.failed),
              error: firstError,
            }));
            console.warn('[ext-host] test failures:', summary);
          }
        })
        .catch((err) => {
          toast.error(t('extensionsFlavors.extensionsPanel.toast.testsRunFailed', {
            id,
            error: err instanceof Error ? err.message : String(err),
          }));
        })
        .finally(() => {
          setRunning((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        });
    },
    [host, locale, running, t],
  );

  const isRunning = useCallback((id: string) => running.has(id), [running]);

  return { runTests, isRunning };
}
