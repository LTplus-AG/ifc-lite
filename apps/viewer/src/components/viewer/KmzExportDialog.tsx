/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export Dialog for KMZ (Google Earth) export. Embeds the model as COLLADA — the
 * only format Google Earth's KML <Model> loads — placed at the model's real-world
 * location (#1427). Requires a georeferenced model.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Globe2, AlertCircle, Check, Loader2 } from 'lucide-react';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { toast } from '@/components/ui/toast';
import { buildKmzForModel, type KmzBuildError } from '@/lib/geo/kmz-export';
import type { KmzAltitudeMode } from '@/lib/geo/kmz-exporter';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';

interface KmzExportDialogProps {
  trigger?: React.ReactNode;
}

const ERROR_MESSAGE: Record<KmzBuildError, string> = {
  'not-georeferenced':
    'This model has no georeferencing (IfcMapConversion / projected CRS), so it has no real-world location to place in Google Earth. Add a location in the Georeferencing panel first.',
  unprojectable:
    'The model is georeferenced but its coordinate system could not be projected to WGS84.',
  'no-geometry': 'This model has no geometry to export.',
};

export function KmzExportDialog({ trigger }: KmzExportDialogProps) {
  const models = useViewerStore((s) => s.models);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  const legacyGeometryResult = useViewerStore((s) => s.geometryResult);
  const legacyDataStore = useViewerStore((s) => s.ifcDataStore);

  const [open, setOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  // KML vertical placement. Default "Rest on ground" (clampToGround): the model
  // drapes on Google Earth's terrain and can never float, regardless of the
  // model's OrthogonalHeight (#1427). "True elevation" places it at MSL.
  const [altitudeMode, setAltitudeMode] = useState<KmzAltitudeMode>('clampToGround');
  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ success: boolean; message: string } | null>(null);

  // Models that have both geometry and a parsed store (georef is checked at export
  // time so we don't scan every store on every render). Falls back to the legacy
  // single-model slot when no federated model is registered (mirrors GLBExportDialog).
  const modelList = useMemo(() => {
    const list = Array.from(models.values())
      .filter((m) => m.geometryResult && m.ifcDataStore)
      .map((m) => ({ id: m.id, name: m.name, geometryResult: m.geometryResult!, dataStore: m.ifcDataStore! }));
    if (list.length === 0 && legacyGeometryResult && legacyDataStore) {
      list.push({ id: '__legacy__', name: 'Current Model', geometryResult: legacyGeometryResult, dataStore: legacyDataStore });
    }
    return list;
  }, [models, legacyGeometryResult, legacyDataStore]);

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

  const handleExport = useCallback(async () => {
    if (!selectedModel) return;
    setIsExporting(true);
    setExportResult(null);
    try {
      const baseName = sanitizeFilename(selectedModel.name.replace(/\.[^.]+$/, ''), { fallback: 'model' });
      const result = await buildKmzForModel({
        geometryResult: selectedModel.geometryResult,
        dataStore: selectedModel.dataStore,
        mutations: selectedModelId === '__legacy__' ? undefined : georefMutations.get(selectedModelId),
        name: baseName,
        altitudeMode,
      });

      if (typeof result === 'string') {
        setExportResult({ success: false, message: ERROR_MESSAGE[result] });
        toast.error('KMZ export failed');
        return;
      }

      const blob = new Blob([new Uint8Array(result)], { type: 'application/vnd.google-earth.kmz' });
      downloadBlob(blob, `${baseName}.kmz`);
      const msg = `Exported KMZ (${(blob.size / 1024).toFixed(0)} KB)`;
      setExportResult({ success: true, message: msg });
      toast.success(msg);
      posthog.capture('export_completed', { format: 'kmz', size_kb: Math.round(blob.size / 1024) });
    } catch (err) {
      console.error('KMZ export failed:', err);
      const errMsg = `KMZ export failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
      setExportResult({ success: false, message: errMsg });
      toast.error(errMsg);
    } finally {
      setIsExporting(false);
    }
  }, [selectedModel, selectedModelId, georefMutations, altitudeMode]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Globe2 className="h-4 w-4 mr-2" />
            Export KMZ
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe2 className="h-5 w-5" />
            Export KMZ for Google Earth Pro
          </DialogTitle>
          <DialogDescription>
            Places the model at its real-world location, embedded as COLLADA. Requires a
            georeferenced model.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Google Earth Web does not support KML <Model>, so it cannot render a KMZ 3D
              model — only Earth Pro (desktop) can. Web users should export GLB instead. */}
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Opens in Google Earth Pro (desktop)</AlertTitle>
            <AlertDescription>
              Google Earth on the web cannot show 3D models from a KMZ. For Earth on the web,
              use Export GLB and import it via the web app&apos;s Import 3D model option.
            </AlertDescription>
          </Alert>

          {modelList.length > 1 && (
            <div className="flex items-center gap-4">
              <Label className="w-32">Model</Label>
              <Select value={selectedModelId} onValueChange={setSelectedModelId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select model" />
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
            <Label className="w-32 text-muted-foreground">Output</Label>
            <Badge variant="secondary">Google Earth</Badge>
            <span className="text-xs text-muted-foreground">.kmz</span>
          </div>

          <div className="flex items-start gap-4">
            <Label className="w-32 pt-2" htmlFor="kmz-altitude-mode">
              Placement
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
                  <SelectItem value="clampToGround">Rest on ground</SelectItem>
                  <SelectItem value="absolute">True elevation (MSL)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {altitudeMode === 'clampToGround'
                  ? 'Drapes the model on the terrain so it never floats. Recommended.'
                  : "Places the model at its orthogonal height above sea level. Use only when the model's elevation is a true MSL value."}
              </p>
            </div>
          </div>

          {exportResult && (
            <Alert variant={exportResult.success ? 'default' : 'destructive'}>
              {exportResult.success ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
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
                <Globe2 className="h-4 w-4 mr-2" />
                Export
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
