/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export Dialog for KMZ (Google Earth) export. Embeds the model as COLLADA — the
 * only format Google Earth's KML <Model> loads — placed at the model's real-world
 * location (#1427). Requires a georeferenced model.
 *
 * Chrome (open/busy/result state, the Dialog shell, the result alert, the
 * guarded Cancel/Export footer) lives in `ExportDialogShell.tsx` (#5848);
 * this component keeps only its own options and export logic.
 */

import type { ExportSurface } from '@/lib/analytics-export-events';
import { useCallback, useMemo, useEffect, useState } from 'react';
import { Globe2, AlertCircle } from 'lucide-react';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useViewerStore } from '@/store';
import { trackExportCompleted } from '@/lib/analytics';
import { toast } from '@/components/ui/toast';
import { buildKmzForModel, kmzSuggestsAbsoluteAltitude, type KmzBuildError } from '@/lib/geo/kmz-export';
import type { InstancedModelRange } from '@/utils/instancedExport';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { KmzAltitudeMode } from '@/lib/geo/kmz-exporter';
import { downloadBlob, modelExportFilename, sanitizeFilename, stripExtension } from '@/lib/export/download';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { ExportDialogShell, type ExportDialogShellResult } from './ExportDialogShell';

interface KmzExportDialogProps {
  surface?: ExportSurface;
  trigger?: React.ReactNode;
}

const ERROR_MESSAGE_KEY: Record<KmzBuildError, TranslationKey> = {
  'not-georeferenced': 'geometryExport.kmz.notGeoreferencedError',
  unprojectable: 'geometryExport.kmz.unprojectableError',
  'no-geometry': 'geometryExport.kmz.noGeometryError',
};

export function KmzExportDialog({ surface = 'classic', trigger }: KmzExportDialogProps) {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  const legacyGeometryResult = useViewerStore((s) => s.geometryResult);
  const legacyDataStore = useViewerStore((s) => s.ifcDataStore);

  const [selectedModelId, setSelectedModelId] = useState<string>('');
  // KML vertical placement. Default "Rest on ground" (clampToGround): the model
  // drapes on Google Earth's terrain and can never float, regardless of the
  // model's OrthogonalHeight (#1427). "True elevation" places it at MSL.
  const [altitudeMode, setAltitudeMode] = useState<KmzAltitudeMode>('clampToGround');
  // Mirrors the shell's own open state (via `onOpenStateChange`) so
  // `suggestTrueElevation` below can stay a `useMemo` gated on "is the dialog
  // open", exactly like the pre-#5848 local `open` state did — without this,
  // the hint recomputes `kmzSuggestsAbsoluteAltitude` on every render while
  // the dialog is open, not just when the inputs it actually depends on
  // change.
  const [open, setOpenMirror] = useState(false);

  // Models that have both geometry and a parsed store (georef is checked at export
  // time so we don't scan every store on every render). Falls back to the legacy
  // single-model slot when no federated model is registered (mirrors GLBExportDialog).
  const modelList = useMemo(() => {
    const list: {
      id: string;
      name: string;
      geometryResult: GeometryResult;
      dataStore: IfcDataStore;
      instancedModelRange: InstancedModelRange | null;
    }[] = Array.from(models.values())
      .filter((m) => m.geometryResult && m.ifcDataStore)
      .map((m) => ({
        id: m.id,
        name: m.name,
        geometryResult: m.geometryResult!,
        dataStore: m.ifcDataStore!,
        // Every model can carry GPU-instanced occurrences since #2255
        // (2026-08-06) — scope `withInstancedMeshes` to THIS model's bracket so
        // a federation of N models doesn't splice every other model's instanced
        // entities into this one's KMZ (#2865/#2878 follow-up).
        instancedModelRange: { idOffset: m.idOffset ?? 0, maxExpressId: m.maxExpressId ?? 0 },
      }));
    if (list.length === 0 && legacyGeometryResult && legacyDataStore) {
      // The legacy single-model slot is provably the sole model loaded — nothing
      // else to wrongly include, so `null` (no filter) is correct.
      list.push({
        id: '__legacy__',
        name: t('geometryExport.shared.currentModelFallbackName'),
        geometryResult: legacyGeometryResult,
        dataStore: legacyDataStore,
        instancedModelRange: null,
      });
    }
    return list;
  }, [models, legacyGeometryResult, legacyDataStore, t]);

  // Pick a default AND repair a stale selection: when the loaded models change
  // (federated add/remove, model swap), an id that no longer matches any model
  // would otherwise export the fallback (`modelList[0]`) while passing the stale
  // id's mutations — a mismatch. Reset to the first model whenever the current
  // id is empty or absent from the list.
  useEffect(() => {
    if (modelList.length === 0) return;
    if (!selectedModelId || !modelList.some((m) => m.id === selectedModelId)) {
      setSelectedModelId(modelList[0].id);
    }
  }, [modelList, selectedModelId]);

  const selectedModel = useMemo(
    () => modelList.find((m) => m.id === selectedModelId) ?? modelList[0],
    [modelList, selectedModelId],
  );

  // True when the model's elevation appears baked into geometry Z (min Z >> 0
  // while the merged conversion's OrthogonalHeight is ~0): the clampToGround
  // default pins project zero to the terrain and would float the building by
  // that baked Z, so hint at "True elevation" instead (#1427 follow-up).
  const suggestTrueElevation = useMemo(() => {
    if (!open || !selectedModel) return false;
    try {
      return kmzSuggestsAbsoluteAltitude({
        geometryResult: selectedModel.geometryResult,
        dataStore: selectedModel.dataStore,
        mutations: selectedModel.id === '__legacy__' ? undefined : georefMutations.get(selectedModel.id),
      });
    } catch (err) {
      // A hint must never break the dialog — log and fall back to no hint.
      console.debug('[kmz] altitude hint evaluation failed:', err);
      return false;
    }
  }, [open, selectedModel, georefMutations]);

  const handleExport = useCallback(async (): Promise<ExportDialogShellResult> => {
    if (!selectedModel) {
      return { success: false, message: t('geometryExport.kmz.noGeometryError') };
    }
    try {
      const baseName = sanitizeFilename(stripExtension(selectedModel.name), { fallback: 'model' });
      const result = await buildKmzForModel({
        geometryResult: selectedModel.geometryResult,
        instancedModelRange: selectedModel.instancedModelRange,
        dataStore: selectedModel.dataStore,
        mutations: selectedModelId === '__legacy__' ? undefined : georefMutations.get(selectedModelId),
        name: baseName,
        altitudeMode,
      });

      if (typeof result === 'string') {
        toast.error(t('geometryExport.kmz.exportFailedToast'));
        return { success: false, message: t(ERROR_MESSAGE_KEY[result]) };
      }

      const blob = new Blob([new Uint8Array(result)], { type: 'application/vnd.google-earth.kmz' });
      downloadBlob(blob, modelExportFilename(selectedModel.name, 'kmz'));
      const msg = t('geometryExport.kmz.exportedMessage', { sizeKb: (blob.size / 1024).toFixed(0) });
      toast.success(msg);
      trackExportCompleted({ surface, format: 'kmz', size_kb: Math.round(blob.size / 1024) });
      return { success: true, message: msg };
    } catch (err) {
      console.error('KMZ export failed:', err);
      const errMsg = t('geometryExport.kmz.failedMessage', {
        reason: err instanceof Error ? err.message : t('geometryExport.shared.unknownError'),
      });
      toast.error(errMsg);
      return { success: false, message: errMsg };
    }
  }, [selectedModel, selectedModelId, georefMutations, altitudeMode, t, surface]);

  const filenamePreview = selectedModel ? modelExportFilename(selectedModel.name, 'kmz') : undefined;

  return (
    <ExportDialogShell
      trigger={
        trigger || (
          <Button variant="outline" size="sm">
            <Globe2 className="h-4 w-4 mr-2" />
            {t('geometryExport.kmz.triggerButton')}
          </Button>
        )
      }
      icon={<Globe2 className="h-5 w-5" />}
      title={t('geometryExport.kmz.dialogTitle')}
      description={t('geometryExport.kmz.dialogDescription')}
      contentClassName="sm:max-w-md overflow-hidden"
      cancelLabel={t('geometryExport.kmz.cancelButton')}
      exportLabel={t('geometryExport.kmz.exportButton')}
      exportingLabel={t('geometryExport.kmz.exportingButton')}
      exportIcon={<Globe2 className="h-4 w-4 mr-2" />}
      successTitle={t('geometryExport.kmz.successTitle')}
      errorTitle={t('geometryExport.kmz.errorTitle')}
      filenamePreview={filenamePreview}
      exportDisabled={!selectedModel}
      onExport={handleExport}
      onOpenStateChange={setOpenMirror}
    >
      <>
        {/* Google Earth Web does not support KML <Model>, so it cannot render a KMZ 3D
            model — only Earth Pro (desktop) can. Web users should export GLB instead. */}
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('geometryExport.kmz.webNoticeTitle')}</AlertTitle>
          <AlertDescription>
            {t('geometryExport.kmz.webNoticeDescription')}
          </AlertDescription>
        </Alert>

        {modelList.length > 1 && (
          <div className="flex items-center gap-4">
            <Label className="w-32">{t('geometryExport.kmz.modelLabel')}</Label>
            <Select value={selectedModelId} onValueChange={setSelectedModelId}>
              <SelectTrigger>
                <SelectValue placeholder={t('geometryExport.kmz.selectModelPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {modelList.map((m) => {
                  const displayName = m.name.length > 24 ? m.name.slice(0, 24) + '…' : m.name;
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

        <div className="flex items-center gap-4">
          <Label className="w-32 text-muted-foreground">{t('geometryExport.kmz.outputLabel')}</Label>
          <Badge variant="secondary">{t('geometryExport.kmz.outputFormat')}</Badge>
          <span className="text-xs text-muted-foreground">{t('geometryExport.kmz.fileExtension')}</span>
        </div>

        <div className="flex items-start gap-4">
          <Label className="w-32 pt-2" htmlFor="kmz-altitude-mode">
            {t('geometryExport.kmz.placementLabel')}
          </Label>
          <div className="flex flex-1 flex-col gap-1">
            <Select
              value={altitudeMode}
              onValueChange={(v) => setAltitudeMode(v as KmzAltitudeMode)}
            >
              <SelectTrigger id="kmz-altitude-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="clampToGround">{t('geometryExport.kmz.placementClampToGround')}</SelectItem>
                <SelectItem value="absolute">{t('geometryExport.kmz.placementAbsolute')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {altitudeMode === 'clampToGround'
                ? t('geometryExport.kmz.placementClampHint')
                : t('geometryExport.kmz.placementAbsoluteHint')}
            </p>
            {altitudeMode === 'clampToGround' && suggestTrueElevation && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t('geometryExport.kmz.suggestTrueElevationHint')}
              </p>
            )}
          </div>
        </div>
      </>
    </ExportDialogShell>
  );
}
