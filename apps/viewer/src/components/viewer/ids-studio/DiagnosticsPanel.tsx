/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * All lint diagnostics of the open document (IDS-036), errors first. Clicking
 * a message focuses its node in the outline and inspector; fixes preview
 * before they apply. Errors block export (see the header).
 */

import { useTranslation } from '@/i18n';
import { sortDiagnostics } from '@/lib/ids-studio/diagnostics';
import { DiagnosticItem } from './DiagnosticItem';
import { useDiagnosticsContext } from './useStudio';

export function DiagnosticsPanel() {
  const { t } = useTranslation();
  const { diagnostics, ready } = useDiagnosticsContext();
  if (!ready) return <p className="px-2 py-2 text-xs text-muted-foreground">{t('idsStudio.loadingSchema')}</p>;
  if (!diagnostics.length) return <p className="px-2 py-2 text-xs text-muted-foreground">{t('idsStudio.diagnostics.clean')}</p>;
  return <ul aria-label={t('idsStudio.diagnostics.heading')} className="space-y-1 p-2">
    {sortDiagnostics(diagnostics).map((d) => <DiagnosticItem key={`${d.code}|${d.nodeId}|${d.field ?? ''}`} diagnostic={d} focusable />)}
  </ul>;
}
