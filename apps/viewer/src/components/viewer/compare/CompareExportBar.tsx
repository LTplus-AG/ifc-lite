/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Compare panel's download strip: the change report (#1202) and, since
 * #4955, the two sidecars — the reviewed identity map and the lineage — plus
 * importing an identity map back. Extracted from `ComparePanel` for the
 * module-size house rule (AGENTS.md).
 *
 * Both sidecars are pinned to the two models' content digests
 * (`identitySidecar.ts`), so an export needs the file bytes and an import is
 * refused when it was written for other bytes. Either outcome is reported in
 * the strip, never swallowed.
 */

import { useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { posthog, trackExportCompleted } from '@/lib/analytics';
import type { CompareResult } from '@/store/slices/compareSlice';
import { acceptedForPair } from '@/lib/compare/acceptedIdentity';
import { downloadCompareReport } from '@/lib/compare/exportReport';
import { modelsAsCompared } from '@/lib/compare/comparedModels';
import {
  comparedModelIdentities,
  downloadIdentityMapSidecar,
  downloadLineageSidecar,
  readIdentityMapSidecar,
} from '@/lib/compare/identitySidecar';
import { compareExportPayload } from '@/lib/compare/runTelemetry';

interface CompareExportBarProps {
  result: CompareResult;
  /** Whether the report bar has rows to offer (`hasReportableChanges`). */
  reportable: boolean;
}

export function CompareExportBar({ result, reportable }: CompareExportBarProps) {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const excludedTypes = useViewerStore((s) => s.compareExcludedTypes);
  const acceptedAll = useViewerStore((s) => s.compareAcceptedIdentity);
  // Only this (A, B) pair's decisions go into its sidecars.
  const accepted = useMemo(() => acceptedForPair(acceptedAll, result), [acceptedAll, result]);
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const downloadReport = (format: 'csv' | 'json') => {
    // Pass the blacklist in its original IFC casing so the report reads
    // "IfcOpeningElement", not the engine's uppercase-normalized form (#1470).
    downloadCompareReport(format, result, modelsAsCompared(models, result.comparedStores), excludedTypes);
    posthog.capture('model_compare_export', compareExportPayload(format, result));
  };

  const downloadSidecar = async (format: 'identity-map' | 'lineage') => {
    setMessage(null);
    const identities = await comparedModelIdentities(result, models);
    if ('error' in identities) {
      setMessage(identities.error);
      return;
    }
    if (format === 'identity-map') downloadIdentityMapSidecar(result, identities, accepted);
    else downloadLineageSidecar(result, identities, accepted);
    trackExportCompleted({ format: 'json', surface: 'compare_panel' });
    posthog.capture('model_compare_export', compareExportPayload(format, result));
  };

  const importSidecar = async (file: File) => {
    setMessage(null);
    const identities = await comparedModelIdentities(result, models);
    if ('error' in identities) {
      setMessage(identities.error);
      return;
    }
    const read = readIdentityMapSidecar(await file.text(), identities, result.keyProperty);
    if ('error' in read) {
      setMessage(read.error);
      return;
    }
    const refused = useViewerStore.getState().acceptCompareIdentity(result, read.entries);
    setMessage(
      refused.length > 0
        ? t('comparePanel.exportBar.importedPartial', {
            imported: read.entries.length - refused.length,
            total: read.entries.length,
            refused: refused.length,
          })
        : t('comparePanel.exportBar.importedAll', { count: read.entries.length }),
    );
  };

  return (
    <div className="border-b border-border text-xs">
      {reportable && (
        <div className="flex items-center gap-2 px-3 py-2">
          <Download className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">{t('comparePanel.exportBar.downloadReportLabel')}</span>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => downloadReport('csv')}>
              CSV
            </Button>
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => downloadReport('json')}>
              JSON
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-muted-foreground" title={t('comparePanel.exportBar.identityTooltip')}>
          {t('comparePanel.exportBar.identityLabel')} {accepted.length > 0 ? `(${accepted.length})` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void downloadSidecar('identity-map')}>
            {t('comparePanel.exportBar.exportMapButton')}
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void downloadSidecar('lineage')}>
            {t('comparePanel.exportBar.exportLineageButton')}
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => fileInput.current?.click()}>
            {t('comparePanel.exportBar.importMapButton')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            aria-label={t('comparePanel.exportBar.importAriaLabel')}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importSidecar(file);
            }}
          />
        </div>
      </div>
      {message && (
        <output className="block px-3 pb-2 text-2xs text-[#e0af68] break-words">
          {message}
        </output>
      )}
    </div>
  );
}
