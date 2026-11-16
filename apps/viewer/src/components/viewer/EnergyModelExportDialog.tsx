/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Energy Model export dialog. Builds a Ladybug Tools model analytically from IFC bytes
 * (rooms from IfcSpace volumes). When the model's mutation overlay carries actual edits,
 * the bytes are the CURRENT model re-serialized through `StepExporter` — NOT the retained
 * source bytes — so spaces created in-app (e.g. by the Room tool) are included
 * (#1908). An unedited model falls straight through to its source bytes; see
 * `energy-export-source.ts` for why the gate is `hasPendingChanges()` and not merely
 * "a mutation view exists". Two targets, and BOTH go through that same gate — DFJSON
 * originally read the source bytes directly and silently dropped every in-app edit:
 *   - HBJSON (Honeybee): full energy + daylight model with apertures, doors, shades, and
 *     constructions.
 *   - DFJSON (Dragonfly): extruded Room2D floor plates + heights, the simpler target for
 *     mostly-vertical-wall models (recommended by Ladybug for that case).
 *
 * Chrome (open/busy/result state, the Dialog shell, the result alert, the
 * guarded Cancel/Export footer) lives in `ExportDialogShell.tsx` (#5848);
 * this component keeps only its own options and export logic.
 */

import type { ExportSurface } from '@/lib/analytics-export-events';
import { trackExportCompleted } from '@/lib/analytics';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { Download, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SegmentedControl } from '@/components/ui/segmented-control';
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
import { downloadBlob, modelExportFilename } from '@/lib/export/download';
import { produceNativeEnergy } from '@/lib/export/native-energy';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { ExportDialogShell, type ExportDialogShellResult } from './ExportDialogShell';

type EnergyFormat = 'hbjson' | 'dfjson';

const FORMATS: Record<EnergyFormat, {
  label: string;
  tool: string;
  ext: string;
  blurbKey: TranslationKey;
}> = {
  hbjson: {
    label: 'HBJSON',
    tool: 'Honeybee',
    ext: 'hbjson',
    blurbKey: 'geometryExport.energy.hbjsonBlurb',
  },
  dfjson: {
    label: 'DFJSON',
    tool: 'Dragonfly',
    ext: 'dfjson',
    blurbKey: 'geometryExport.energy.dfjsonBlurb',
  },
};

interface EnergyModelExportDialogProps {
  surface: ExportSurface;
  trigger?: React.ReactNode;
}

export function EnergyModelExportDialog({ surface, trigger }: EnergyModelExportDialogProps) {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);

  const [format, setFormat] = useState<EnergyFormat>('hbjson');
  const [selectedModelId, setSelectedModelId] = useState<string>('');

  // Any loaded IFC model can be exported — the energy model is rebuilt from the
  // model's analytic geometry (re-serialized with in-app edits applied), not the
  // tessellated mesh. Non-IFC sources (GLB / point clouds) are omitted.
  const modelList = useMemo(
    () =>
      Array.from(models.values())
        .filter((m) => m.ifcDataStore && (!m.sourceFile || /\.(ifc|ifcx|ifczip)$/i.test(m.sourceFile.name)))
        .map((m) => ({ id: m.id, name: m.name, schemaVersion: m.schemaVersion })),
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

  const spec = FORMATS[format];

  const handleExport = useCallback(async (): Promise<ExportDialogShellResult> => {
    // #8415: a dialog can stay open while a model switches kernels; recheck the live launch policy.
    if (hasRetainedGeometryModel(useViewerStore.getState().models)) {
      return { success: false, message: t(RETAINED_EXACT_ONLY_REASON) };
    }
    if (!selectedModel) {
      return { success: false, message: t('geometryExport.energy.noModelDescription') };
    }

    const spec = FORMATS[format];
    try {
      const { blob, hbjsonSkipNote } = await produceNativeEnergy(selectedModel, format);
      downloadBlob(blob, modelExportFilename(selectedModel.name, spec.ext));
      trackExportCompleted({ format, surface, size_kb: Math.round(blob.size / 1024) });

      const msg = t('geometryExport.energy.exportedMessage', {
        formatLabel: spec.label,
        sizeKb: (blob.size / 1024).toFixed(0),
        skipNote: hbjsonSkipNote,
      });
      toast.success(msg);
      return { success: true, message: msg };
    } catch (err) {
      console.error(`${spec.label} export failed:`, err);
      const errMsg = t('geometryExport.energy.failedMessage', {
        formatLabel: spec.label,
        reason: err instanceof Error ? err.message : t('geometryExport.shared.unknownError'),
      });
      toast.error(errMsg);
      return { success: false, message: errMsg };
    }
  }, [selectedModel, format, t, surface]);

  const filenamePreview = selectedModel ? modelExportFilename(selectedModel.name, spec.ext) : undefined;

  return (
    <ExportDialogShell
      trigger={
        trigger || (
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4 mr-2" />
            {t('geometryExport.energy.triggerButton')}
          </Button>
        )
      }
      icon={<Download className="h-5 w-5" />}
      title={t('geometryExport.energy.dialogTitle')}
      description={t('geometryExport.energy.dialogDescription')}
      contentClassName="sm:max-w-md overflow-hidden"
      cancelLabel={t('geometryExport.energy.cancelButton')}
      exportLabel={t('geometryExport.energy.exportButton', { formatLabel: spec.label })}
      exportingLabel={t('geometryExport.energy.exportingButton')}
      exportIcon={<Download className="h-4 w-4 mr-2" />}
      successTitle={t('geometryExport.energy.successTitle')}
      errorTitle={t('geometryExport.energy.errorTitle')}
      filenamePreview={filenamePreview}
      exportDisabled={!selectedModel}
      onExport={handleExport}
    >
      {(state) => (
        <>
          {/* Format selector — segmented control */}
          <div className="flex items-center gap-4">
            <span className="w-32">{t('geometryExport.energy.formatLabel')}</span>
            <SegmentedControl
              label={t('geometryExport.energy.formatLabel')}
              value={format}
              options={(Object.keys(FORMATS) as EnergyFormat[]).map((f) => ({ value: f, label: FORMATS[f].label }))}
              onValueChange={setFormat}
              disabled={state.isExporting}
            />
          </div>

          {/* Model selector — only shown when multiple are loaded */}
          {modelList.length > 1 && (
            <div className="flex items-center gap-4">
              <Label className="w-32">{t('geometryExport.energy.modelLabel')}</Label>
              <Select value={selectedModelId} onValueChange={setSelectedModelId} disabled={state.isExporting}>
                <SelectTrigger>
                  <SelectValue placeholder={t('geometryExport.energy.selectModelPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {modelList.map((m) => {
                    const maxLen = 24;
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

          {/* Output indicator + per-format description */}
          <div className="flex items-center gap-4">
            <Label className="w-32 text-muted-foreground">{t('geometryExport.energy.outputLabel')}</Label>
            <span className="text-sm">{t('geometryExport.energy.outputModel', { tool: spec.tool })}</span>
            <span className="text-xs text-muted-foreground">.{spec.ext}</span>
          </div>

          <p className="text-xs text-muted-foreground">{t(spec.blurbKey)}</p>

          {!selectedModel && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('geometryExport.energy.noModelTitle')}</AlertTitle>
              <AlertDescription>
                {t('geometryExport.energy.noModelDescription')}
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
    </ExportDialogShell>
  );
}
