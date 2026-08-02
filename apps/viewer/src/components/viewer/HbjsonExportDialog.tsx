/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export Dialog for HBJSON (Honeybee / Ladybug Tools energy & daylight model).
 *
 * HBJSON is built analytically from IFC STEP bytes (rooms from IfcSpace
 * volumes, windows/doors as apertures/doors, railings as shades, and material
 * layer sets as opaque constructions). When the model's mutation view carries
 * actual edits (e.g. spaces drawn with the Space Sketch tool), those bytes
 * are regenerated through `StepExporter` first — the same mutation-view
 * application STEP export already uses (see `ExportDialog.tsx`) — so
 * anything authored in the editor is visible to the analytic exporter. Falls
 * back to the model's `sourceFile` bytes verbatim otherwise, which is the
 * common case: a mutation view with zero edits is register-on-open, not
 * edit-on-open (the Properties panel, `BulkPropertyEditor`, `DataConnector`,
 * and `ExportDialog` all construct and register one just by being opened),
 * so gating on mere existence would route every export through a redundant
 * regeneration the moment any of those panels had been touched. There are no
 * per-export settings beyond the model name, so the dialog is just a picker
 * + a short description.
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
import { StepExporter } from '@ifc-lite/export';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';
import { resolveHbjsonMutationSource } from './hbjson-export-source';

interface HbjsonExportDialogProps {
  trigger?: React.ReactNode;
}

export function HbjsonExportDialog({ trigger }: HbjsonExportDialogProps) {
  const models = useViewerStore((s) => s.models);
  const getMutationView = useViewerStore((s) => s.getMutationView);

  const [open, setOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ success: boolean; message: string } | null>(null);

  // Only models that still carry their original IFC bytes can be exported —
  // HBJSON is rebuilt from the source, not the tessellated geometry. Cache-
  // restored models (no `sourceFile`) and non-IFC sources (e.g. GLB / point clouds, which
  // can also be loaded) are omitted — HBJSON is rebuilt from the IFC source.
  const modelList = useMemo(
    () =>
      Array.from(models.values())
        .filter((m) => m.sourceFile && /\.(ifc|ifcx|ifczip)$/i.test(m.sourceFile.name))
        .map((m) => ({
          id: m.id,
          name: m.name,
          sourceFile: m.sourceFile as File,
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
      // Regenerate STEP bytes through the mutation view when it carries actual
      // edits, so anything authored in-editor (e.g. Space Sketch rooms) is
      // visible to the analytic exporter — mirrors how full STEP export
      // applies `getMutationView` (see ExportDialog.tsx). IFC5/IFCX models
      // have no STEP representation to regenerate, and a mutation view with
      // no pending changes (the common case — see the module doc comment)
      // falls straight through to the original file bytes, unchanged from
      // before this fix.
      const mutationView = getMutationView(selectedModel.id);
      const dataStore = selectedModel.ifcDataStore;
      const mutationSource = resolveHbjsonMutationSource({
        mutationView,
        dataStore,
        schemaVersion: selectedModel.schemaVersion,
      });
      let bytes: Uint8Array;
      if (mutationSource) {
        const exporter = new StepExporter(mutationSource.dataStore, mutationSource.mutationView);
        bytes = exporter.export({ schema: mutationSource.dataStore.schemaVersion }).content;
      } else {
        bytes = new Uint8Array(await selectedModel.sourceFile.arrayBuffer());
      }
      const baseName = selectedModel.name.replace(/\.[^.]+$/, '');

      // A fresh processor is cheap: wasm-bindgen shares one module singleton,
      // so init() no-ops when the viewer already initialised the engine. It
      // owns a WASM `IfcLiteBridge` handle, so it must be freed on every
      // path out of this block, success or throw — mirrors the CLI-side fix
      // in `packages/cli/src/hbjson-export.ts` (#1956 review fix). Scoped to
      // its own try/finally (not merged into the outer one) so disposal runs
      // exactly when the processor's lifetime ends, independent of
      // `setIsExporting(false)` in the outer `finally` below.
      const processor = new GeometryProcessor();
      let hbjson: Uint8Array;
      try {
        await processor.init();
        const result = processor.exportHbjson(bytes, baseName);
        if (result === null) {
          throw new Error('Geometry engine unavailable');
        }
        hbjson = result;
      } finally {
        processor.dispose();
      }

      const blob = new Blob([hbjson as BlobPart], { type: 'application/json' });
      downloadBlob(blob, `${sanitizeFilename(baseName, { fallback: 'model' })}.hbjson`);

      const msg = `Exported HBJSON (${(blob.size / 1024).toFixed(0)} KB)`;
      setExportResult({ success: true, message: msg });
      toast.success(msg);
    } catch (err) {
      console.error('HBJSON export failed:', err);
      const errMsg = `HBJSON export failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
      setExportResult({ success: false, message: errMsg });
      toast.error(errMsg);
    } finally {
      setIsExporting(false);
    }
  }, [selectedModel, getMutationView]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4 mr-2" />
            Export HBJSON
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Export HBJSON (Energy Model)
          </DialogTitle>
          <DialogDescription>
            Honeybee / Ladybug Tools model for energy &amp; daylight analysis
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4 max-h-[70vh] overflow-y-auto">
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
            <Label className="w-32 text-muted-foreground">Output</Label>
            <Badge variant="secondary">Honeybee Model</Badge>
            <span className="text-xs text-muted-foreground">.hbjson</span>
          </div>

          <p className="text-xs text-muted-foreground">
            Builds watertight rooms from <code>IfcSpace</code> volumes, places windows and doors
            as apertures, emits railings as shades, and maps material layer sets to opaque
            constructions. Loads directly in Honeybee / Pollination. Thermal properties are
            defaulted by material name and meant to be refined downstream.
          </p>

          {!selectedModel && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>No source available</AlertTitle>
              <AlertDescription>
                HBJSON export needs the original IFC file. Re-open the model from disk to enable it.
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
                Export
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
