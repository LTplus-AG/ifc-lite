/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Energy Model export dialog. Builds a Ladybug Tools model analytically from IFC bytes
 * (rooms from IfcSpace volumes). When the model's mutation overlay carries actual edits,
 * the bytes are the CURRENT model re-serialized through `StepExporter` — NOT the retained
 * source bytes — so spaces created in-app (e.g. by the Space Sketch tool) are included
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
import { toast } from '@/components/ui/toast';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { StepExporter } from '@ifc-lite/export';
import { ensureModelExportReady } from '@/services/desktop-export';
import { downloadBlob, modelExportFilename } from '@/lib/export/download';
import { resolveEnergyExportMutationSource } from './energy-export-source';
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
  surface?: ExportSurface;
  trigger?: React.ReactNode;
}

export function EnergyModelExportDialog({ surface = 'classic', trigger }: EnergyModelExportDialogProps) {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const getMutationView = useViewerStore((s) => s.getMutationView);

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
    if (!selectedModel) {
      return { success: false, message: t('geometryExport.energy.noModelDescription') };
    }

    const spec = FORMATS[format];
    try {
      const modelId = selectedModel.id;
      const exportDataStore = await ensureModelExportReady(modelId);
      if (!exportDataStore) {
        throw new Error(t('geometryExport.energy.modelDataUnavailableError'));
      }
      // Serialize the CURRENT model (with mutations applied) to IFC bytes so
      // in-app edits — e.g. spaces created by the Space Sketch tool — are in
      // the export; reading the retained source bytes alone would miss them.
      // Only when the overlay actually carries edits, though: a registered but
      // untouched view is the common case (the Properties panel,
      // `BulkPropertyEditor`, `DataConnector` and `ExportDialog` all construct
      // and register one just by being opened), and routing those through a
      // full STEP re-bake would make every export after opening any panel pay
      // for a regeneration that cannot change the output. See
      // `energy-export-source.ts`, and `energy-export.ts` for the CLI twin.
      const mutationSource = resolveEnergyExportMutationSource({
        mutationView: getMutationView(modelId),
        dataStore: exportDataStore,
        schemaVersion: selectedModel.schemaVersion,
      });
      // Strip only a real IFC source-file extension — a dotted display name
      // like `Tower.v2` must survive into the exported model name.
      const baseName = selectedModel.name.replace(/\.(ifc|ifcx|ifczip)$/i, '');

      // Set only for HBJSON when the export's `HbjsonStats.skipped > 0` (spaces dropped
      // as degenerate — malformed footprint / holes / non-extrusion): appended to the
      // success message below so a "successful" export that silently truncated the
      // model is never reported as a plain, unqualified success. Stays empty on a clean
      // export (nothing skipped) or for DFJSON (no stats contract).
      let hbjsonSkipNote = '';

      // HBJSON comes back as UTF-8 bytes (not capped by the V8 max-string
      // ceiling); DFJSON models are small 2D plates, so that exporter stays
      // a string.
      const runExport = async (content: Uint8Array): Promise<Uint8Array | string> => {
        // A fresh processor is cheap: wasm-bindgen shares one module singleton,
        // so init() no-ops when the viewer already initialised the engine. It
        // owns a WASM `IfcLiteBridge` handle, so it must be freed on every path
        // out of this block, success or throw (AGENTS.md "Free every WASM handle
        // deterministically") — mirrors the CLI-side `runEnergyExport` helper.
        const processor = new GeometryProcessor();
        try {
          await processor.init();
          if (format === 'hbjson') {
            const result = processor.exportHbjsonWithStats(content, baseName);
            if (result === null) {
              throw new Error(t('geometryExport.shared.geometryEngineUnavailableError'));
            }
            const { content: hbjson, stats } = result;
            // The HBJSON exporter returns empty output when the model has no
            // IfcSpace volumes.
            if (hbjson.length === 0) {
              throw new Error(t('geometryExport.energy.noIfcSpaceError'));
            }
            if (stats.skipped > 0) {
              hbjsonSkipNote = t('geometryExport.energy.skipNote', { skipped: stats.skipped, total: stats.spaces });
            }
            return hbjson;
          }
          const dfjson = processor.exportDfjson(content, baseName);
          if (dfjson === null) {
            throw new Error(t('geometryExport.shared.geometryEngineUnavailableError'));
          }
          // export_dfjson always returns a complete Model JSON, even with zero
          // spaces (empty `buildings`), so an emptiness check on the string can
          // never fire. Count the exported Room2Ds instead so a model without
          // IfcSpace volumes gets the same friendly error, not a useless file.
          const dfModel = JSON.parse(dfjson) as {
            buildings?: { unique_stories?: { room_2ds?: unknown[] }[] }[];
          };
          const roomCount = (dfModel.buildings ?? []).reduce(
            (n, b) => n + (b.unique_stories ?? []).reduce((m, s) => m + (s.room_2ds?.length ?? 0), 0),
            0,
          );
          if (roomCount === 0) {
            throw new Error(t('geometryExport.energy.noIfcSpaceError'));
          }
          return dfjson;
        } finally {
          processor.dispose();
        }
      };

      let out: Uint8Array | string;
      if (mutationSource) {
        const sv = selectedModel.schemaVersion || 'IFC4';
        const schema = sv.includes('2X3') ? 'IFC2X3' : sv.includes('4X3') ? 'IFC4X3' : 'IFC4';
        const exporter = new StepExporter(mutationSource.dataStore, mutationSource.mutationView);
        out = await runExport(
          exporter.export({
            schema: schema as 'IFC2X3' | 'IFC4' | 'IFC4X3',
            includeGeometry: true,
            applyMutations: true,
            deltaOnly: false,
            application: 'ifc-lite',
          }).content,
        );
      } else {
        // Unedited (or IFC5, or source-less) model: hand the analytic exporter
        // the retained STEP bytes verbatim. `StepExporter` re-serializes
        // un-mutated entities from these same bytes, so when they are absent
        // there is nothing either path could have produced — fail loudly
        // rather than emit a structurally valid but empty energy model.
        if (!exportDataStore.source || exportDataStore.source.byteLength === 0) {
          throw new Error(
            t('geometryExport.energy.sourceBytesMissingError', { formatLabel: FORMATS[format].label }),
          );
        }
        // `IfcDataStore.source` is an accessor that may be block-compressed
        // (#2183), and both energy exporters are whole-file consumers, so the
        // contiguous view is borrowed SCOPED rather than hoisted into a
        // variable that outlives the export.
        out = await exportDataStore.source.withMaterializedAsync(runExport);
      }

      const blob = new Blob([out as BlobPart], { type: 'application/json' });
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
  }, [selectedModel, format, getMutationView, t, surface]);

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
