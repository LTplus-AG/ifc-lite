/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LoadReportPanel — per-model load report with actionable geometry warnings
 * (issue #3927).
 *
 * Presents EXISTING evidence only (`buildLoadReports` in `lib/loadReport.ts`,
 * the GeometryDiagnostics contract already captured on `FederatedModel`):
 * source/schema, load path, diagnostics, approximation settings, and
 * affected entities where the diagnostic contract supplies an identity. A
 * model whose diagnostics were never captured for its current load (a cache
 * hit, server render, GLB/IFCX) reads as "unavailable", never as clean; a
 * model with nothing diagnostic-worthy reads as a quiet "clean" line, not a
 * spurious warning. JSON export mirrors `idsExportService`'s pattern.
 */

import { useCallback, useMemo } from 'react';
import { FileWarning, Download, Focus, X } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { buildLoadReports, downloadLoadReportJSON, type LoadReportAffectedEntity, type LoadReportSummary } from '@/lib/loadReport';
import { cn } from '@/lib/utils';

interface LoadReportPanelProps {
  onClose?: () => void;
}

function statusLabel(report: LoadReportSummary): { labelKey: TranslationKey; className: string } {
  if (!report.diagnosticsAvailable) {
    return { labelKey: 'loadReportPanel.status.unavailable', className: 'text-muted-foreground' };
  }
  if (report.isClean) {
    return { labelKey: 'loadReportPanel.status.clean', className: 'text-emerald-600 dark:text-emerald-400' };
  }
  return { labelKey: 'loadReportPanel.status.issuesFound', className: 'text-amber-600 dark:text-amber-400' };
}

function AffectedEntityRow({
  entity,
  onSelect,
}: {
  entity: LoadReportAffectedEntity;
  onSelect: (entity: LoadReportAffectedEntity) => void;
}) {
  const { t } = useTranslation();
  const label = t('loadReportPanel.entitySummary', {
    productId: entity.productId,
    ifcType: entity.ifcType,
    csgFailures: entity.csgFailures,
    openings: entity.openings,
  });
  if (!entity.renderable) {
    // No captured bbox: nothing to frame in 3D. Show the source identity
    // only, per the issue's boundary — never invent a selection target.
    return <div className="pl-2 text-[11px] text-muted-foreground">{label}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(entity)}
      className="flex w-full items-center gap-1.5 rounded pl-2 py-0.5 text-left text-[11px] hover:bg-accent"
      title={t('loadReportPanel.selectAndFrameTitle')}
    >
      <Focus className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function ModelReportCard({
  report,
  onSelectEntity,
}: {
  report: LoadReportSummary;
  onSelectEntity: (modelId: string, entity: LoadReportAffectedEntity) => void;
}) {
  const { t } = useTranslation();
  const status = statusLabel(report);
  return (
    <div className="border-b p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{report.name}</span>
        <span className={cn('shrink-0 text-[11px] font-medium', status.className)}>{t(status.labelKey)}</span>
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        {report.schemaVersion}
        {report.loadFormat ? ` · ${report.loadFormat}` : ''}
        {report.loadPath ? ` · ${report.loadPath}` : ''}
        {report.tessellationTier ? t('loadReportPanel.tierSuffix', { tier: report.tessellationTier }) : ''}
        {report.skipSmallCuts ? t('loadReportPanel.fastModeSuffix') : ''}
      </div>
      {report.actions.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px]">
          {report.actions.map((action, i) => (
            // Actions are a fixed, stable-order list built from this report's
            // own counters — no reorderable/keyed identity beyond position.
            <li key={i}>{action}</li>
          ))}
        </ul>
      )}
      {report.affectedEntities.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('loadReportPanel.affectedEntitiesLabel')}</div>
          {report.affectedEntities.map((entity) => (
            <AffectedEntityRow
              key={entity.productId}
              entity={entity}
              onSelect={(e) => onSelectEntity(report.modelId, e)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function LoadReportPanel({ onClose }: LoadReportPanelProps) {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const setSelectedEntity = useViewerStore((s) => s.setSelectedEntity);
  const setSelectedEntityIds = useViewerStore((s) => s.setSelectedEntityIds);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);

  const reports = useMemo(() => buildLoadReports(models), [models]);

  const handleSelectEntity = useCallback(
    (modelId: string, entity: LoadReportAffectedEntity) => {
      // Two-channel selection (see AGENTS.md): the global id drives 3D
      // highlight/pick, the {modelId, expressId} ref drives the properties
      // panel — both must be set or highlighting silently breaks.
      setSelectedEntityIds([]);
      setSelectedEntityId(entity.globalId);
      setSelectedEntity({ modelId, expressId: entity.productId });
      if (cameraCallbacks.frameSelection) {
        window.setTimeout(() => cameraCallbacks.frameSelection?.(), 50);
      }
    },
    [setSelectedEntityIds, setSelectedEntityId, setSelectedEntity, cameraCallbacks],
  );

  const handleExport = useCallback(() => downloadLoadReportJSON(reports), [reports]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <FileWarning className="h-4 w-4 text-amber-600" />
        <span className="flex-1 text-sm font-medium">{t('loadReportPanel.title')}</span>
        <IconButton
          label={t('loadReportPanel.exportJsonTitle')}
          className="h-6 w-6"
          onClick={handleExport}
          disabled={reports.length === 0}
        >
          <Download className="h-3.5 w-3.5" />
        </IconButton>
        {onClose && (
          <IconButton label={t('loadReportPanel.closeTitle')} className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {reports.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">{t('loadReportPanel.noModelsLoaded')}</div>
        ) : (
          reports.map((report) => (
            <ModelReportCard key={report.modelId} report={report} onSelectEntity={handleSelectEntity} />
          ))
        )}
      </div>
    </div>
  );
}
