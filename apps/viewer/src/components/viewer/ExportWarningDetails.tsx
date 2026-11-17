/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';

/** The exporter's diagnostics, with an optional display cap for large STEP reports. */
export function ExportWarningDetails({ warnings, limit = warnings.length }: { warnings: readonly string[]; limit?: number }) {
  const { t } = useTranslation();
  const visible = warnings.slice(0, limit);
  const remaining = warnings.length - visible.length;
  return (
    <details className="text-xs text-muted-foreground border rounded p-2">
      <summary className="cursor-pointer select-none">
        {t('geometryExport.shell.warningsSummary', { count: warnings.length })}
      </summary>
      <ul className="list-disc pl-4 mt-1 space-y-0.5 break-words">
        {visible.map((warning, index) => <li key={index}>{warning}</li>)}
      </ul>
      {remaining > 0 && <p>{t('exportDialog.warningsMore', { count: remaining })}</p>}
    </details>
  );
}
