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

interface UsdExportDialogProps {
  trigger?: React.ReactNode;
}

export function UsdExportDialog({ trigger }: UsdExportDialogProps) {
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
          throw new Error('Geometry engine unavailable');
        }
        usd = result;
      } finally {
        processor.dispose();
      }

      // USDA is UTF-8 ASCII text; download it as text (matches how STEP `.ifc`
      // text is downloaded — there is no registered USD mime in the codebase).
      const blob = new Blob([usd as BlobPart], { type: 'text/plain' });
      downloadBlob(blob, buildExportFilename(stripExtension(selectedModel.name), 'usda'));

      const msg = `Exported USD (${(blob.size / 1024).toFixed(0)} KB)`;
      setExportResult({ success: true, message: msg });
      toast.success(msg);
    } catch (err) {
      console.error('USD export failed:', err);
      const errMsg = `USD export failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
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
            Export USD
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Export USD (OpenUSD)
          </DialogTitle>
          <DialogDescription>
            A real Z-up OpenUSD ASCII (<code>.usda</code>) stage for usdview / Blender / Omniverse
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
            <Badge variant="secondary">OpenUSD Stage</Badge>
            <span className="text-xs text-muted-foreground">.usda</span>
          </div>

          <p className="text-xs text-muted-foreground">
            Emits a Z-up USD stage (<code>upAxis = "Z"</code>, <code>metersPerUnit = 1</code>)
            mirroring the IFC spatial hierarchy as <code>Xform</code> prims, with
            <code>UsdGeomMesh</code> geometry, <code>UsdPreviewSurface</code> materials, and IFC
            metadata as custom attributes. Repeated mapped geometry is authored once as a
            referenced prototype; openings and spaces are tagged <code>purpose = "guide"</code>.
            Distinct from IFCX, which is USD-flavored JSON rather than a USD file.
          </p>

          {!selectedModel && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>No source available</AlertTitle>
              <AlertDescription>
                USD export needs the original IFC file. Re-open the model from disk to enable it.
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
