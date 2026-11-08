/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export dialog for Rhino `.3dm` (spec: `docs/architecture/rhino-3dm-export.md`).
 *
 * Like USD, the scene is rebuilt from the IFC STEP bytes, so it shares USD's
 * source resolution (`step-export-source.ts`): pending edits are regenerated
 * through `StepExporter`, `.ifczip` exports its unwrapped STEP, and only
 * `.ifc` / `.ifczip` models are offered.
 *
 * The scene build and the rhino3dm write both run in a Web Worker
 * (`lib/export/rhino-export-client.ts`); this component only resolves the
 * bytes and the visibility on the main thread, where the store lives.
 */

import type { ExportSurface } from '@/lib/analytics-export-events';
import { trackExportCompleted } from '@/lib/analytics';
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Download, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useViewerStore } from '@/store';
import { hasRetainedGeometryModel, RETAINED_EXACT_ONLY_REASON } from '@/store/retainedGeometry';
import { toast } from '@/components/ui/toast';
import { isNoRenderGeometryError } from '@ifc-lite/geometry';
import { downloadBlob, buildExportFilename, stripExtension } from '@/lib/export/download';
import { exportRhino3dmInWorker, type RhinoExportProgress } from '@/lib/export/rhino-export-client';
import { isStepSourceModel, resolveStepExportBytes } from './step-export-source';
import {
  DEFAULT_RHINO_EXPORT_SETTINGS,
  resolveRhinoVisibility,
  rhinoSceneOptions,
  type RhinoExportSettings,
} from './rhino-export-options';
import { RhinoExportFields, RhinoExportProgressRow } from './RhinoExportFields';
import { useTranslation } from '@/i18n';
import { isAbortError } from '@/lib/runs/abort';
import { ExportDialogShell, type ExportDialogShellActivity, type ExportDialogShellResult } from './ExportDialogShell';

interface RhinoExportDialogProps {
  surface: ExportSurface;
  trigger?: React.ReactNode;
}

export function RhinoExportDialog({ surface, trigger }: RhinoExportDialogProps) {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const getMutationView = useViewerStore((s) => s.getMutationView);

  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [settings, setSettings] = useState<RhinoExportSettings>(DEFAULT_RHINO_EXPORT_SETTINGS);
  const [progress, setProgress] = useState<RhinoExportProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const modelList = useMemo(() => Array.from(models.values()).filter(isStepSourceModel), [models]);

  useEffect(() => {
    if (modelList.length > 0 && !modelList.some((m) => m.id === selectedModelId)) {
      setSelectedModelId(modelList[0].id);
    }
  }, [modelList, selectedModelId]);

  const selectedModel = useMemo(
    () => modelList.find((m) => m.id === selectedModelId),
    [modelList, selectedModelId],
  );

  const updateSettings = useCallback(
    (patch: Partial<RhinoExportSettings>) => setSettings((prev) => ({ ...prev, ...patch })),
    [],
  );

  const handleExport = useCallback(async (activity: ExportDialogShellActivity): Promise<ExportDialogShellResult> => {
    // #8415: a dialog can stay open while a model switches kernels; recheck the live launch policy.
    if (hasRetainedGeometryModel(useViewerStore.getState().models)) {
      return { success: false, message: t(RETAINED_EXACT_ONLY_REASON) };
    }
    if (!selectedModel) {
      return { success: false, message: t('rhinoExport.noSourceDescription') };
    }

    const controller = new AbortController();
    abortRef.current = controller;
    activity.registerCancellation(controller);
    setProgress({ phase: 'scene' });
    try {
      const bytes = await resolveStepExportBytes(selectedModel, getMutationView);
      // Read at click time, so the export matches what is on screen now.
      const visibility = settings.visibleOnly
        ? resolveRhinoVisibility(useViewerStore.getState(), selectedModel.id)
        : undefined;
      const result = await exportRhino3dmInWorker(
        { content: bytes, options: rhinoSceneOptions(settings, visibility), version: settings.version },
        setProgress,
        controller.signal,
      );

      const blob = new Blob([result.bytes as BlobPart], { type: 'application/octet-stream' });
      downloadBlob(blob, buildExportFilename(stripExtension(selectedModel.name), '3dm'));
      const sizeKb = Math.round(blob.size / 1024);
      trackExportCompleted({ format: '3dm', surface, size_kb: sizeKb, visible_only: settings.visibleOnly });

      const msg = t('rhinoExport.exportedMessage', { sizeKb: String(sizeKb) });
      toast.success(msg);
      return { success: true, message: msg, warnings: result.warnings };
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) {
        return { success: false, cancelled: true, message: t('rhinoExport.cancelledMessage') };
      }
      let errMsg: string;
      if (isNoRenderGeometryError(err)) {
        errMsg = t('rhinoExport.noRenderGeometryError'); // a typed refusal is expected (#7766)
      } else {
        console.error('Rhino export failed:', err);
        errMsg = t('rhinoExport.failedMessage', {
          reason: err instanceof Error ? err.message : t('geometryExport.shared.unknownError'),
        });
      }
      toast.error(errMsg);
      return { success: false, message: errMsg };
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  }, [selectedModel, getMutationView, settings, t, surface]);

  const filenamePreview = selectedModel
    ? buildExportFilename(stripExtension(selectedModel.name), '3dm')
    : undefined;

  return (
    <ExportDialogShell
      trigger={
        trigger || (
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4 mr-2" />
            {t('rhinoExport.triggerButton')}
          </Button>
        )
      }
      icon={<Download className="h-5 w-5" />}
      title={t('rhinoExport.dialogTitle')}
      description={t('rhinoExport.dialogDescription')}
      cancelLabel={t('rhinoExport.cancelButton')}
      exportLabel={t('rhinoExport.exportButton')}
      exportingLabel={t('rhinoExport.exportingButton')}
      exportIcon={<Download className="h-4 w-4 mr-2" />}
      successTitle={t('rhinoExport.successTitle')}
      errorTitle={t('rhinoExport.errorTitle')}
      filenamePreview={filenamePreview}
      exportDisabled={!selectedModel}
      onExport={handleExport}
    >
      {({ isExporting }) => (
        <>
          {modelList.length > 1 && (
            <div className="flex items-center gap-4">
              <Label className="w-32">{t('rhinoExport.modelLabel')}</Label>
              <Select value={selectedModelId} onValueChange={setSelectedModelId} disabled={isExporting}>
                <SelectTrigger>
                  <SelectValue placeholder={t('rhinoExport.selectModelPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {modelList.map((m) => (
                    <SelectItem key={m.id} value={m.id} title={m.name}>
                      {m.name.length > 32 ? m.name.slice(0, 32) + '…' : m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <RhinoExportFields settings={settings} onChange={updateSettings} disabled={isExporting} />

          {progress && <RhinoExportProgressRow progress={progress} onStop={() => abortRef.current?.abort()} />}

          {!selectedModel && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('rhinoExport.noSourceTitle')}</AlertTitle>
              <AlertDescription>{t('rhinoExport.noSourceDescription')}</AlertDescription>
            </Alert>
          )}
        </>
      )}
    </ExportDialogShell>
  );
}
