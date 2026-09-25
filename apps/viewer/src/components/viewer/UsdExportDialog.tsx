/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export Dialog for OpenUSD (`.usda` ASCII) — a real Z-up USD stage, distinct
 * from the IFCX export (which is USD-*flavored JSON*). The stage mirrors the
 * IFC spatial hierarchy as `Xform` prims with `UsdGeomMesh` geometry,
 * `UsdPreviewSurface` materials, and IFC metadata as custom attributes; it
 * opens in usdview / Blender / Omniverse.
 *
 * Like HBJSON, USD is rebuilt analytically from the IFC STEP bytes (not from
 * the tessellated viewer geometry), so when the model's mutation view carries
 * real edits (e.g. Space Sketch rooms) those bytes are regenerated through
 * `StepExporter` first — the same source resolution HBJSON/STEP export use —
 * so anything authored in the editor is reflected in the exported stage. The
 * common case (a mutation view with no pending edits) falls straight through
 * to the original file bytes. There are no per-export settings beyond the
 * model name, so the dialog is a picker + a short description.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Download, AlertCircle, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { downloadBlob, buildExportFilename, stripExtension } from '@/lib/export/download';
import { isUsdExportableModel, resolveUsdExportBytes } from './usd-export-source';
import { useTranslation } from '@/i18n';
import { useExportDialogOpenGuard } from '@/hooks/useExportDialogOpenGuard';

interface UsdExportDialogProps {
  trigger?: React.ReactNode;
}

export function UsdExportDialog({ trigger }: UsdExportDialogProps) {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const getMutationView = useViewerStore((s) => s.getMutationView);

  const [open, setOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ success: boolean; message: string } | null>(null);

  // Only STEP-backed IFC models can be exported — USD is rebuilt from the
  // source, not the tessellated geometry. `isUsdExportableModel` also excludes
  // cache-restored models (no `sourceFile`) and `.ifcx` (a separate exporter).
  const modelList = useMemo(
    () =>
      Array.from(models.values())
        .filter(isUsdExportableModel)
        .map((m) => ({
          id: m.id,
          name: m.name,
          sourceFile: m.sourceFile,
          ifcDataStore: m.ifcDataStore,
          schemaVersion: m.schemaVersion,
        })),
    [models],
  );

  useEffect(() => {
    if (modelList.length > 0 && !modelList.some((m) => m.id === selectedModelId)) {
      setSelectedModelId(modelList[0].id);
    }
  }, [modelList, selectedModelId]);

  const selectedModel = useMemo(
    () => modelList.find((m) => m.id === selectedModelId),
    [modelList, selectedModelId],
  );

  const handleExport = useCallback(async () => {
    if (!selectedModel?.sourceFile) return;

    setIsExporting(true);
    setExportResult(null);

    try {
      // Mutation-aware, format-safe source resolution shared with the command
      // palette (regenerate edited STEP bytes, else the unwrapped store bytes,
      // else the raw file).
      const bytes = await resolveUsdExportBytes(selectedModel, getMutationView);

      // A fresh processor is cheap: wasm-bindgen shares one module singleton, so
      // init() no-ops when the viewer already initialised the engine. It owns a
      // WASM `IfcLiteBridge` handle, so it must be freed on every path out of
      // this block, success or throw (mirrors the HBJSON dialog).
      const processor = new GeometryProcessor();
      let usd: Uint8Array;
      try {
        await processor.init();
        const result = processor.exportUsd(bytes);
        if (result === null) {
          throw new Error(t('geometryExport.shared.geometryEngineUnavailableError'));
        }
        usd = result;
      } finally {
        processor.dispose();
      }

      // USDA is UTF-8 ASCII text; download it as text (matches how STEP `.ifc`
      // text is downloaded — there is no registered USD mime in the codebase).
      const blob = new Blob([usd as BlobPart], { type: 'text/plain' });
      downloadBlob(blob, buildExportFilename(stripExtension(selectedModel.name), 'usda'));

      const msg = t('geometryExport.usd.exportedMessage', { sizeKb: (blob.size / 1024).toFixed(0) });
      setExportResult({ success: true, message: msg });
      toast.success(msg);
    } catch (err) {
      console.error('USD export failed:', err);
      const errMsg = t('geometryExport.usd.failedMessage', {
        reason: err instanceof Error ? err.message : t('geometryExport.shared.unknownError'),
      });
      setExportResult({ success: false, message: errMsg });
      toast.error(errMsg);
    } finally {
      setIsExporting(false);
    }
  }, [selectedModel, getMutationView, t]);

  const handleOpenChange = useExportDialogOpenGuard({
    busy: isExporting,
    setOpen,
    onOpen: () => setExportResult(null),
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4 mr-2" />
            {t('geometryExport.usd.triggerButton')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            {t('geometryExport.usd.dialogTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('geometryExport.usd.dialogDescription', { usdaExt: '.usda' })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4 max-h-[70vh] overflow-y-auto">
          {/* Model selector — only shown when multiple are loaded */}
          {modelList.length > 1 && (
            <div className="flex items-center gap-4">
              <Label className="w-32">{t('geometryExport.usd.modelLabel')}</Label>
              <Select value={selectedModelId} onValueChange={setSelectedModelId}>
                <SelectTrigger>
                  <SelectValue placeholder={t('geometryExport.usd.selectModelPlaceholder')} />
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

          {/* Output format indicator */}
          <div className="flex items-center gap-4">
            <Label className="w-32 text-muted-foreground">{t('geometryExport.usd.outputLabel')}</Label>
            <Badge variant="secondary">{t('geometryExport.usd.outputFormat')}</Badge>
            <span className="text-xs text-muted-foreground">{t('geometryExport.usd.fileExtension')}</span>
          </div>

          <p className="text-xs text-muted-foreground">
            {t('geometryExport.usd.blurb', {
              upAxis: 'upAxis = "Z"',
              metersPerUnit: 'metersPerUnit = 1',
              xform: 'Xform',
              usdGeomMesh: 'UsdGeomMesh',
              usdPreviewSurface: 'UsdPreviewSurface',
              purposeGuide: 'purpose = "guide"',
            })}
          </p>

          {!selectedModel && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('geometryExport.usd.noSourceTitle')}</AlertTitle>
              <AlertDescription>
                {t('geometryExport.usd.noSourceDescription')}
              </AlertDescription>
            </Alert>
          )}

          {exportResult && (
            <Alert variant={exportResult.success ? 'default' : 'destructive'}>
              {exportResult.success ? (
                <Check className="h-4 w-4" />
              ) : (
                <AlertCircle className="h-4 w-4" />
              )}
              <AlertTitle>{exportResult.success ? t('geometryExport.usd.successTitle') : t('geometryExport.usd.errorTitle')}</AlertTitle>
              <AlertDescription>{exportResult.message}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={isExporting} onClick={() => handleOpenChange(false)}>
            {t('geometryExport.usd.cancelButton')}
          </Button>
          <Button onClick={handleExport} disabled={isExporting || !selectedModel}>
            {isExporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('geometryExport.usd.exportingButton')}
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                {t('geometryExport.usd.exportButton')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
