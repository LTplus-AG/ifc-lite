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
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Download, AlertCircle, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
import { StepExporter } from '@ifc-lite/export';
import { ensureModelExportReady } from '@/services/desktop-export';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';
import { resolveEnergyExportMutationSource } from './energy-export-source';

type EnergyFormat = 'hbjson' | 'dfjson';

const FORMATS: Record<EnergyFormat, {
  label: string;
  tool: string;
  ext: string;
  blurb: string;
}> = {
  hbjson: {
    label: 'HBJSON',
    tool: 'Honeybee',
    ext: 'hbjson',
    blurb:
      'Full energy and daylight model. Builds watertight rooms from IfcSpace volumes, places windows and doors as apertures, emits railings as shades, and maps material layer sets to constructions.',
  },
  dfjson: {
    label: 'DFJSON',
    tool: 'Dragonfly',
    ext: 'dfjson',
    blurb:
      'Extruded Room2D floor plates plus floor-to-ceiling heights, grouped into stories. The simpler target for models with mostly vertical walls (recommended by Ladybug Tools for that case).',
  },
};

interface EnergyModelExportDialogProps {
  trigger?: React.ReactNode;
}

export function EnergyModelExportDialog({ trigger }: EnergyModelExportDialogProps) {
  const models = useViewerStore((s) => s.models);
  const getMutationView = useViewerStore((s) => s.getMutationView);

  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<EnergyFormat>('hbjson');
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ success: boolean; message: string } | null>(null);

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

  const handleExport = useCallback(async () => {
    if (!selectedModel) return;

    setIsExporting(true);
    setExportResult(null);

    const spec = FORMATS[format];
    try {
      const modelId = selectedModel.id;
      const exportDataStore = await ensureModelExportReady(modelId);
      if (!exportDataStore) {
        throw new Error('Model data is unavailable for export');
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
      let content: Uint8Array;
      if (mutationSource) {
        const sv = selectedModel.schemaVersion || 'IFC4';
        const schema = sv.includes('2X3') ? 'IFC2X3' : sv.includes('4X3') ? 'IFC4X3' : 'IFC4';
        const exporter = new StepExporter(mutationSource.dataStore, mutationSource.mutationView);
        content = exporter.export({
          schema: schema as 'IFC2X3' | 'IFC4' | 'IFC4X3',
          includeGeometry: true,
          applyMutations: true,
          deltaOnly: false,
          application: 'ifc-lite',
        }).content;
      } else {
        // Unedited (or IFC5, or source-less) model: hand the analytic exporter
        // the retained STEP bytes verbatim. `StepExporter` re-serializes
        // un-mutated entities from these same bytes, so when they are absent
        // there is nothing either path could have produced — fail loudly
        // rather than emit a structurally valid but empty energy model.
        if (!exportDataStore.source || exportDataStore.source.length === 0) {
          throw new Error(
            `${FORMATS[format].label} export needs the source IFC bytes, which this model did not retain.`,
          );
        }
        content = exportDataStore.source;
      }

      // Strip only a real IFC source-file extension — a dotted display name
      // like `Tower.v2` must survive into the exported model name.
      const baseName = selectedModel.name.replace(/\.(ifc|ifcx|ifczip)$/i, '');
      // A fresh processor is cheap: wasm-bindgen shares one module singleton,
      // so init() no-ops when the viewer already initialised the engine. It
      // owns a WASM `IfcLiteBridge` handle, so it must be freed on every path
      // out of this block, success or throw (AGENTS.md "Free every WASM handle
      // deterministically") — mirrors the CLI-side `withProcessor` helper.
      const processor = new GeometryProcessor();
      // HBJSON comes back as UTF-8 bytes (not capped by the V8 max-string
      // ceiling); DFJSON models are small 2D plates, so that exporter stays
      // a string.
      let out: Uint8Array | string;
      try {
        await processor.init();
        if (format === 'hbjson') {
          const hbjson = processor.exportHbjson(content, baseName);
          if (hbjson === null) {
            throw new Error('Geometry engine unavailable');
          }
          // The HBJSON exporter returns empty output when the model has no
          // IfcSpace volumes.
          if (hbjson.length === 0) {
            throw new Error('No IfcSpace volumes found in the model to export');
          }
          out = hbjson;
        } else {
          const dfjson = processor.exportDfjson(content, baseName);
          if (dfjson === null) {
            throw new Error('Geometry engine unavailable');
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
            throw new Error('No IfcSpace volumes found in the model to export');
          }
          out = dfjson;
        }
      } finally {
        processor.dispose();
      }

      const blob = new Blob([out as BlobPart], { type: 'application/json' });
      downloadBlob(blob, `${sanitizeFilename(baseName, { fallback: 'model' })}.${spec.ext}`);

      const msg = `Exported ${spec.label} (${(blob.size / 1024).toFixed(0)} KB)`;
      setExportResult({ success: true, message: msg });
      toast.success(msg);
    } catch (err) {
      console.error(`${spec.label} export failed:`, err);
      const errMsg = `${spec.label} export failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
      setExportResult({ success: false, message: errMsg });
      toast.error(errMsg);
    } finally {
      setIsExporting(false);
    }
  }, [selectedModel, format, getMutationView]);

  const spec = FORMATS[format];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4 mr-2" />
            Energy Model
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Export Energy Model
          </DialogTitle>
          <DialogDescription>
            Ladybug Tools model for energy and daylight analysis
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4 max-h-[60vh] overflow-y-auto">
          {/* Format selector — segmented control */}
          <div className="flex items-center gap-4">
            <Label className="w-32">Format</Label>
            <div className="inline-flex rounded-md border p-0.5">
              {(Object.keys(FORMATS) as EnergyFormat[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormat(f)}
                  className={`rounded px-3 py-1 text-sm transition-colors ${
                    format === f ? 'bg-primary text-primary-foreground' : 'hover:text-foreground text-muted-foreground'
                  }`}
                >
                  {FORMATS[f].label}
                </button>
              ))}
            </div>
          </div>

          {/* Model selector — only shown when multiple are loaded */}
          {modelList.length > 1 && (
            <div className="flex items-center gap-4">
              <Label className="w-32">Model</Label>
              <Select value={selectedModelId} onValueChange={setSelectedModelId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select model" />
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
            <Label className="w-32 text-muted-foreground">Output</Label>
            <span className="text-sm">{spec.tool} model</span>
            <span className="text-xs text-muted-foreground">.{spec.ext}</span>
          </div>

          <p className="text-xs text-muted-foreground">{spec.blurb}</p>

          {!selectedModel && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>No model loaded</AlertTitle>
              <AlertDescription>
                Load an IFC model to export an energy model.
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
              <AlertTitle>{exportResult.success ? 'Success' : 'Error'}</AlertTitle>
              <AlertDescription>{exportResult.message}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={isExporting || !selectedModel}>
            {isExporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Export {spec.label}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
