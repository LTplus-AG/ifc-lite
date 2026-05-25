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
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Download, AlertCircle, Check, Loader2 } from 'lucide-react';
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
import { GLTFExporter } from '@ifc-lite/export';

type ColorSource = 'rendering' | 'shading';

/**
 * Translate the viewer's `typeVisibility` toggles into the set of IFC class
 * names the GLB exporter should drop on a visible-only export. Mirrors the
 * gating in `basketVisibleSet.ts` and `ViewportContainer.tsx` so the export
 * matches what the user sees in the viewport.
 */
function buildHiddenIfcTypes(
  typeVisibility: { spaces: boolean; openings: boolean; site: boolean },
): Set<string> {
  const out = new Set<string>();
  if (!typeVisibility.spaces) out.add('IfcSpace');
  if (!typeVisibility.openings) out.add('IfcOpeningElement');
  if (!typeVisibility.site) out.add('IfcSite');
  return out;
}

interface GLBExportDialogProps {
  trigger?: React.ReactNode;
}

export function GLBExportDialog({ trigger }: GLBExportDialogProps) {
  const models = useViewerStore((s) => s.models);
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const hiddenEntitiesByModel = useViewerStore((s) => s.hiddenEntitiesByModel);
  const isolatedEntitiesByModel = useViewerStore((s) => s.isolatedEntitiesByModel);
  // Class-level visibility (IfcSpace / IfcOpeningElement / IfcSite) — these
  // are off by default and live OUTSIDE the per-entity hidden set, so a
  // visible-only export that only checks `hiddenEntities` would still ship
  // openings the user never rendered (issue surfaced on the Revit door
  // fixture where IfcOpeningElement #2438 leaked through).
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  // Legacy single-model fallback so this dialog works before any
  // FederatedModel is registered (the common case for v1 users). Only
  // the geometryResult is needed — GLB export doesn't read the parsed
  // STEP store.
  const legacyGeometryResult = useViewerStore((s) => s.geometryResult);

  const [open, setOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [colorSource, setColorSource] = useState<ColorSource>('rendering');
  const [visibleOnly, setVisibleOnly] = useState(false);
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ success: boolean; message: string } | null>(null);

  // Model list: federated models first, falling back to the legacy single
  // model when nothing is registered. Mirrors ExportDialog.
  const modelList = useMemo(() => {
    const list = Array.from(models.values()).map((m) => ({
      id: m.id,
      name: m.name,
      geometryResult: m.geometryResult,
    }));

    if (list.length === 0 && legacyGeometryResult) {
      list.push({
        id: '__legacy__',
        name: 'Current Model',
        geometryResult: legacyGeometryResult,
      });
    }

    return list;
  }, [models, legacyGeometryResult]);

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
        name: 'Current Model',
        geometryResult: legacyGeometryResult,
      };
    }
    return modelList.find((m) => m.id === selectedModelId);
  }, [modelList, selectedModelId, legacyGeometryResult]);

  /**
   * Build the hidden / isolation sets in **global** ID space.
   *
   * `MeshData.expressId` carries the federated global ID (`local +
   * idOffset`, see `store/types.ts:365`), and the legacy / global store
   * sets (`hiddenEntities`, `isolatedEntities`) are also global —
   * `basketVisibleSet.ts:405-412` is the canonical reference for which
   * set lives in which space. Only the per-model `*ByModel` Maps store
   * raw local IDs, so those need an offset added before they can match
   * a mesh expressId. This is the opposite shape from the STEP exporter
   * (which works in local entity space), so don't reuse ExportDialog's
   * helpers here.
   */
  const getGlobalHiddenIds = useCallback((modelId: string): Set<number> => {
    if (modelId === '__legacy__') return hiddenEntities;

    const model = models.get(modelId);
    if (!model) return new Set();
    const offset = model.idOffset ?? 0;

    const out = new Set<number>();
    // Global IDs from the legacy / global store — already global, just
    // restrict to this model's range so we don't carry over hidden IDs
    // that belong to sibling federated models.
    for (const globalId of hiddenEntities) {
      const localId = globalId - offset;
      if (localId > 0 && localId <= model.maxExpressId) {
        out.add(globalId);
      }
    }
    // Per-model entries are LOCAL IDs — convert to global.
    const modelHidden = hiddenEntitiesByModel.get(modelId);
    if (modelHidden) {
      for (const localId of modelHidden) {
        out.add(localId + offset);
      }
    }
    return out;
  }, [models, hiddenEntities, hiddenEntitiesByModel]);

  const getGlobalIsolatedIds = useCallback((modelId: string): Set<number> | null => {
    if (modelId === '__legacy__') return isolatedEntities;

    const model = models.get(modelId);
    if (!model) return null;
    const offset = model.idOffset ?? 0;

    const out = new Set<number>();
    if (isolatedEntities) {
      for (const globalId of isolatedEntities) {
        const localId = globalId - offset;
        if (localId > 0 && localId <= model.maxExpressId) {
          out.add(globalId);
        }
      }
    }
    const modelIsolated = isolatedEntitiesByModel.get(modelId);
    if (modelIsolated) {
      for (const localId of modelIsolated) {
        out.add(localId + offset);
      }
    }
    return out.size > 0 ? out : null;
  }, [models, isolatedEntities, isolatedEntitiesByModel]);

  const handleExport = useCallback(() => {
    if (!selectedModel?.geometryResult) return;

    setIsExporting(true);
    setExportResult(null);

    try {
      const exporter = new GLTFExporter(selectedModel.geometryResult);
      const globalHidden = visibleOnly ? getGlobalHiddenIds(selectedModelId) : undefined;
      const globalIsolated = visibleOnly ? getGlobalIsolatedIds(selectedModelId) : undefined;
      const hiddenIfcTypes = visibleOnly ? buildHiddenIfcTypes(typeVisibility) : undefined;

      const glb = exporter.exportGLB({
        includeMetadata,
        colorSource,
        visibleOnly,
        hiddenEntityIds: globalHidden,
        isolatedEntityIds: globalIsolated,
        hiddenIfcTypes,
      });

      const blob = new Blob([new Uint8Array(glb)], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const baseName = selectedModel.name.replace(/\.[^.]+$/, '');
      const suffix = visibleOnly ? '_visible' : '';
      a.download = `${baseName}${suffix}.glb`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const msg = `Exported GLB (${(blob.size / 1024).toFixed(0)} KB)`;
      setExportResult({ success: true, message: msg });
      toast.success(msg);
    } catch (err) {
      console.error('Export failed:', err);
      const errMsg = `GLB export failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
      setExportResult({ success: false, message: errMsg });
      toast.error(errMsg);
    } finally {
      setIsExporting(false);
    }
  }, [
    selectedModel,
    selectedModelId,
    includeMetadata,
    colorSource,
    visibleOnly,
    getGlobalHiddenIds,
    getGlobalIsolatedIds,
  ]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4 mr-2" />
            Export GLB
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Export GLB File
          </DialogTitle>
          <DialogDescription>
            Export the 3D model as binary glTF for use in other viewers and renderers
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4 max-h-[60vh] overflow-y-auto">
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

          {/* Colour source */}
          <div className="flex items-start gap-4">
            <div className="w-32 pt-2">
              <Label>Colour Source</Label>
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
                  <SelectItem value="rendering">Rendering (apparent colour)</SelectItem>
                  <SelectItem value="shading">Shading (SurfaceColour)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {colorSource === 'rendering'
                  ? 'Uses IfcSurfaceStyleRendering.DiffuseColour when authored, otherwise SurfaceColour. Matches most IFC viewers.'
                  : 'Uses the base SurfaceColour. Falls back to the rendering colour when no distinct DiffuseColour was authored.'}
              </p>
            </div>
          </div>

          {/* Output format indicator */}
          <div className="flex items-center gap-4">
            <Label className="w-32 text-muted-foreground">Output</Label>
            <Badge variant="secondary">glTF Binary</Badge>
            <span className="text-xs text-muted-foreground">.glb</span>
          </div>

          {/* Visible only */}
          <div className="flex items-center justify-between">
            <div>
              <Label>Export Visible Only</Label>
              <p className="text-xs text-muted-foreground">
                Skip entities currently hidden or outside the isolation set
              </p>
            </div>
            <Switch checked={visibleOnly} onCheckedChange={setVisibleOnly} />
          </div>

          {/* Include metadata */}
          <div className="flex items-center justify-between">
            <div>
              <Label>Include Metadata</Label>
              <p className="text-xs text-muted-foreground">
                Embed expressId / modelIndex on each node and totals on the asset
              </p>
            </div>
            <Switch checked={includeMetadata} onCheckedChange={setIncludeMetadata} />
          </div>

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
          <Button
            onClick={handleExport}
            disabled={isExporting || !selectedModel?.geometryResult}
          >
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
