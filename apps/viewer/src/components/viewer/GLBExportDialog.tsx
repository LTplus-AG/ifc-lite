/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export Dialog for GLB (binary glTF) export.
 *
 * v1 surface: model picker (single-model only — merged export deferred),
 * colour source (Rendering vs Shading), visible-only filter, include
 * metadata toggle. Other knobs Dion flagged (PBR reflectance, embed-
 * transparency, default material picker, coordinate origin, apply
 * mutations) are intentionally absent here and tracked separately.
 *
 * Chrome (open/busy/result state, the Dialog shell, the result alert, the
 * guarded Cancel/Export footer) lives in `ExportDialogShell.tsx` (#5848);
 * this component keeps only its own options and export logic.
 */

import type { ExportSurface } from '@/lib/analytics-export-events';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useViewerStore } from '@/store';
import { hasRetainedShapeOnlyModel, RETAINED_SHAPE_ONLY_REASON } from '@/store/retainedGeometry';
import { posthog, trackExportCompleted } from '@/lib/analytics';
import { toast } from '@/components/ui/toast';
import { isNoRenderGeometryError } from '@ifc-lite/geometry';
import { classifyLoadError } from '@/lib/load-errors';
import { formatLoadError } from '@/lib/load-error-message';
import { produceNativeGlb } from '@/lib/export/native-glb';
import { downloadBlob, modelExportFilename } from '@/lib/export/download';
import { exportableModels } from '@/lib/export/capture-export';
import { useTranslation } from '@/i18n';
import { ExportDialogShell, type ExportDialogShellResult } from './ExportDialogShell';
type ColorSource = 'rendering' | 'shading';

interface GLBExportDialogProps {
  surface: ExportSurface;
  trigger?: React.ReactNode;
}

export function GLBExportDialog({ surface, trigger }: GLBExportDialogProps) {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  // Legacy single-model fallback so this dialog works before any
  // FederatedModel is registered (the common case for v1 users). Only
  // the geometryResult is needed — GLB export doesn't read the parsed
  // STEP store.
  const legacyGeometryResult = useViewerStore((s) => s.geometryResult);

  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [colorSource, setColorSource] = useState<ColorSource>('rendering');
  const [visibleOnly, setVisibleOnly] = useState(false);
  const [includeMetadata, setIncludeMetadata] = useState(true);
  // Lit materials shade from normals in external viewers; unlit (#1321) renders
  // the flat apparent base colour. Default lit — most users expect shading.
  const [lit, setLit] = useState(true);

  // Federated models except captures (#8568), else the legacy single model. Mirrors ExportDialog.
  const modelList = useMemo(() => {
    const list = exportableModels(models).map((m) => ({
      id: m.id,
      name: m.name,
      geometryResult: m.geometryResult,
    }));

    if (list.length === 0 && legacyGeometryResult) {
      list.push({
        id: '__legacy__',
        name: t('geometryExport.shared.currentModelFallbackName'),
        geometryResult: legacyGeometryResult,
      });
    }

    return list;
  }, [models, legacyGeometryResult, t]);

  // Default to the first model in the list whenever the menu opens.
  useEffect(() => {
    if (modelList.length > 0 && !selectedModelId) {
      setSelectedModelId(modelList[0].id);
    }
  }, [modelList, selectedModelId]);

  const selectedModel = useMemo(() => {
    if (selectedModelId === '__legacy__' && legacyGeometryResult) {
      return {
        id: '__legacy__',
        name: t('geometryExport.shared.currentModelFallbackName'),
        geometryResult: legacyGeometryResult,
      };
    }
    return modelList.find((m) => m.id === selectedModelId);
  }, [modelList, selectedModelId, legacyGeometryResult, t]);

  const handleExport = useCallback(async (): Promise<ExportDialogShellResult> => {
    // #8415: the dialog can stay open while the selected model changes kernels.
    const live = useViewerStore.getState().models.get(selectedModelId);
    if (live && hasRetainedShapeOnlyModel(new Map([[selectedModelId, live]]))) {
      return { success: false, message: t(RETAINED_SHAPE_ONLY_REASON) };
    }
    if (!selectedModel?.geometryResult) {
      return { success: false, message: t('geometryExport.glb.failedMessage', { reason: t('geometryExport.shared.unknownError') }) };
    }

    // Which of the two assemblers ran, recorded outside the try so a failure
    // report can say which one trapped (they have very different memory
    // profiles: from-bytes re-meshes the whole model in wasm, from-meshes
    // copies what the GPU already holds).
    let fromSourceBytes = false;

    try {
      const produced = await produceNativeGlb(selectedModelId, { geometryResult: selectedModel.geometryResult }, { visibleOnly, includeMetadata, lit, colorSource }, undefined, fromSource => { fromSourceBytes = fromSource; });
      fromSourceBytes = produced.fromSourceBytes;
      const blob = produced.blob;
      downloadBlob(blob, modelExportFilename(selectedModel.name, 'glb', visibleOnly ? '_visible' : ''));
      const msg = t('geometryExport.glb.exportedMessage', { sizeKb: (blob.size / 1024).toFixed(0) });
      toast.success(msg);
      trackExportCompleted({
        surface,
        format: 'glb',
        visible_only: visibleOnly,
        include_metadata: includeMetadata,
        color_source: colorSource,
        lit,
        size_kb: Math.round(blob.size / 1024),
      });
      return { success: true, message: msg };
    } catch (err) {
      if (!isNoRenderGeometryError(err)) console.error('Export failed:', err); // a typed refusal is expected (#7766)
      const kind = classifyLoadError(err);
      // The Rust boundary fails closed on an empty visible set; translate the
      // typed error into the operator-friendly message.
      const errMsg = isNoRenderGeometryError(err)
        ? t('geometryExport.glb.noRenderGeometryError')
        // A wasm trap here used to reach the user as raw engine text (or, once
        // it had poisoned the module, as an internal sentence about recreating
        // a worker process). Hand it to the shared humaniser instead, which
        // explains the crash and offers a reload when the engine can't restart
        // (#1898).
        : kind === 'wasm_runtime_crashed'
          ? formatLoadError(err, selectedModel.name)
          : t('geometryExport.glb.failedMessage', { reason: err instanceof Error ? err.message : t('geometryExport.shared.unknownError') });
      toast.error(errMsg);
      // This export failed silently in production: the catch only logged +
      // toasted, so PostHog saw nothing and the trap that started the whole
      // chain was never recorded anywhere but the user's console (#1898).
      posthog.capture('export_failed', {
        format: 'glb',
        error_kind: kind,
        from_source_bytes: fromSourceBytes,
      });
      // …but only the *unexpected* failures belong in error tracking. An empty
      // visible set is a typed, expected outcome of the user's own filters, and
      // it classifies as `unknown`, so capturing it would mint a fresh PostHog
      // issue per filter mistake and bury the trap signal this capture exists
      // to surface.
      if (!isNoRenderGeometryError(err)) {
        posthog.captureException(err, { context: 'export_glb', error_kind: kind });
      }
      return { success: false, message: errMsg };
    }
  }, [
    selectedModel,
    selectedModelId,
    models,
    includeMetadata,
    lit,
    colorSource,
    visibleOnly,
    surface,
    t,
  ]);

  const filenamePreview = selectedModel
    ? modelExportFilename(selectedModel.name, 'glb', visibleOnly ? '_visible' : '')
    : undefined;

  return (
    <ExportDialogShell
      trigger={
        trigger || (
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4 mr-2" />
            {t('geometryExport.glb.triggerButton')}
          </Button>
        )
      }
      icon={<Download className="h-5 w-5" />}
      title={t('geometryExport.glb.dialogTitle')}
      description={t('geometryExport.glb.dialogDescription')}
      cancelLabel={t('geometryExport.glb.cancelButton')}
      exportLabel={t('geometryExport.glb.exportButton')}
      exportingLabel={t('geometryExport.glb.exportingButton')}
      exportIcon={<Download className="h-4 w-4 mr-2" />}
      successTitle={t('geometryExport.glb.successTitle')}
      errorTitle={t('geometryExport.glb.errorTitle')}
      filenamePreview={filenamePreview}
      exportDisabled={!selectedModel?.geometryResult}
      onExport={handleExport}
    >
      {/* Model selector — only shown when multiple are loaded */}
      {modelList.length > 1 && (
        <div className="flex items-center gap-4">
          <Label className="w-32">{t('geometryExport.glb.modelLabel')}</Label>
          <Select value={selectedModelId} onValueChange={setSelectedModelId}>
            <SelectTrigger>
              <SelectValue placeholder={t('geometryExport.glb.selectModelPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {modelList.map((m) => {
                const maxLen = 32;
                const displayName =
                  m.name.length > maxLen ? m.name.slice(0, maxLen) + '…' : m.name;
                return (
                  <SelectItem key={m.id} value={m.id} title={m.name}>
                    {displayName}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Colour source */}
      <div className="flex items-start gap-4">
        <div className="w-32 pt-2">
          <Label>{t('geometryExport.glb.colorSourceLabel')}</Label>
        </div>
        <div className="flex-1 space-y-2">
          <Select
            value={colorSource}
            onValueChange={(v) => setColorSource(v as ColorSource)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rendering">{t('geometryExport.glb.colorSourceRendering')}</SelectItem>
              <SelectItem value="shading">{t('geometryExport.glb.colorSourceShading')}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {colorSource === 'rendering'
              ? t('geometryExport.glb.colorSourceRenderingHint')
              : t('geometryExport.glb.colorSourceShadingHint')}
          </p>
        </div>
      </div>

      {/* Output format indicator */}
      <div className="flex items-center gap-4">
        <Label className="w-32 text-muted-foreground">{t('geometryExport.glb.outputLabel')}</Label>
        <Badge variant="secondary">{t('geometryExport.glb.outputFormat')}</Badge>
        <span className="text-xs text-muted-foreground">{t('geometryExport.glb.fileExtension')}</span>
      </div>

      {/* Visible only */}
      <div className="flex items-center justify-between">
        <div>
          <Label>{t('geometryExport.glb.visibleOnlyLabel')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('geometryExport.glb.visibleOnlyHint')}
          </p>
        </div>
        <Switch checked={visibleOnly} onCheckedChange={setVisibleOnly} />
      </div>

      {/* Include metadata */}
      <div className="flex items-center justify-between">
        <div>
          <Label>{t('geometryExport.glb.includeMetadataLabel')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('geometryExport.glb.includeMetadataHint')}
          </p>
        </div>
        <Switch checked={includeMetadata} onCheckedChange={setIncludeMetadata} />
      </div>

      {/* Lit materials */}
      <div className="flex items-center justify-between">
        <div>
          <Label>{t('geometryExport.glb.litLabel')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('geometryExport.glb.litHint')}
          </p>
        </div>
        <Switch checked={lit} onCheckedChange={setLit} />
      </div>
    </ExportDialogShell>
  );
}
