/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export Dialog for IFC export with property mutations
 *
 * Schema drives the output format automatically:
 * - IFC2X3 / IFC4 / IFC4X3 → .ifc (STEP)
 * - IFC5 → .ifcx (JSON + USD geometry)
 *
 * "Changes Only" exports just mutations:
 * - Below IFC5 → .json
 * - IFC5 → .ifcx
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  Download,
  AlertCircle,
  Check,
  Loader2,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
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
import { Progress } from '@/components/ui/progress';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { toast } from '@/components/ui/toast';
import { ensureModelExportReady } from '@/services/desktop-export';
import { StepExporter, MergedExporter, Ifc5Exporter, IFC5_KNOWN_PROP_NAMES, type MergeModelInput, type ExportProgress, type StepExportProgress } from '@ifc-lite/export';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { spliceScheduleIntoExport } from '@/sdk/adapters/export-schedule-splice';

type ExportScope = 'single' | 'merged';
type SchemaVersion = 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';

interface ExportDialogProps {
  trigger?: React.ReactNode;
}

function toBlobPart(content: string | Uint8Array): BlobPart {
  if (typeof content === 'string') return content;
  const bytes = new Uint8Array(content.byteLength);
  bytes.set(content);
  return bytes;
}

export function ExportDialog({ trigger }: ExportDialogProps) {
  const models = useViewerStore((s) => s.models);
  const dirtyModels = useViewerStore((s) => s.dirtyModels);
  const getMutationView = useViewerStore((s) => s.getMutationView);
  const registerMutationView = useViewerStore((s) => s.registerMutationView);
  const getModifiedEntityCount = useViewerStore((s) => s.getModifiedEntityCount);
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const hiddenEntitiesByModel = useViewerStore((s) => s.hiddenEntitiesByModel);
  const isolatedEntitiesByModel = useViewerStore((s) => s.isolatedEntitiesByModel);
  // Also get legacy single-model state for backward compatibility
  const legacyIfcDataStore = useViewerStore((s) => s.ifcDataStore);
  const legacyGeometryResult = useViewerStore((s) => s.geometryResult);

  const [open, setOpen] = useState(false);
  const [schema, setSchema] = useState<SchemaVersion | ''>('');
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [exportScope, setExportScope] = useState<ExportScope>('single');
  const [includeGeometry, setIncludeGeometry] = useState(true);
  const [applyMutations, setApplyMutations] = useState(true);
  const [changesOnly, setChangesOnly] = useState(false);
  const [visibleOnly, setVisibleOnly] = useState(false);
  const [onlyKnownProperties, setOnlyKnownProperties] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ success: boolean; message: string } | null>(null);
  const [exportProgress, setExportProgress] = useState<{
    phase: string;
    percent: number;
    entitiesProcessed: number;
    entitiesTotal: number;
    currentModel?: string;
  } | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const prevProgressRef = useRef<typeof exportProgress>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  }, []);

  // Auto-scroll when progress first appears
  useEffect(() => {
    if (exportProgress && !prevProgressRef.current) scrollToBottom();
    prevProgressRef.current = exportProgress;
  }, [exportProgress, scrollToBottom]);

  // Derived: is this an IFC5/IFCX export?
  const isIfc5 = schema === 'IFC5';

  // Get list of models with data stores - includes both federated models and legacy single-model
  const modelList = useMemo(() => {
    const list = Array.from(models.values()).map((m) => ({
      id: m.id,
      name: m.name,
      isDirty: dirtyModels.has(m.id),
      schemaVersion: m.schemaVersion,
    }));

    // If no models in Map but legacy data exists, add a synthetic entry
    if (list.length === 0 && legacyIfcDataStore) {
      list.push({
        id: '__legacy__',
        name: 'Current Model',
        isDirty: false,
        schemaVersion: legacyIfcDataStore.schemaVersion,
      });
    }

    return list;
  }, [models, dirtyModels, legacyIfcDataStore]);

  // Select first model by default
  useMemo(() => {
    if (modelList.length > 0 && !selectedModelId) {
      setSelectedModelId(modelList[0].id);
    }
  }, [modelList, selectedModelId]);

  // Get selected model's data - supports both federated and legacy mode
  const selectedModel = useMemo(() => {
    if (selectedModelId === '__legacy__' && legacyIfcDataStore && legacyGeometryResult) {
      // Return a synthetic FederatedModel-like object for legacy mode
      return {
        id: '__legacy__',
        name: 'Current Model',
        ifcDataStore: legacyIfcDataStore,
        geometryResult: legacyGeometryResult,
        visible: true,
        collapsed: false,
        schemaVersion: legacyIfcDataStore.schemaVersion,
      };
    }
    return models.get(selectedModelId);
  }, [models, selectedModelId, legacyIfcDataStore, legacyGeometryResult]);

  // Ensure mutation view exists for selected model
  useEffect(() => {
    if (!selectedModel?.ifcDataStore || !selectedModelId) return;

    // Check if mutation view already exists
    let mutationView = getMutationView(selectedModelId);
    if (mutationView) return;

    // Create new mutation view with on-demand property extractor
    const dataStore = selectedModel.ifcDataStore;
    mutationView = new MutablePropertyView(dataStore.properties || null, selectedModelId);

    configureMutationView(mutationView, dataStore as IfcDataStore);

    // Register the mutation view
    registerMutationView(selectedModelId, mutationView);
  }, [selectedModel, selectedModelId, getMutationView, registerMutationView]);

  // Default schema to selected model's schema version
  useEffect(() => {
    if (!selectedModel) return;
    const modelSchema = selectedModel.schemaVersion as SchemaVersion;
    if (modelSchema) {
      setSchema(modelSchema);
    }
  }, [selectedModel?.schemaVersion]);

  // Determine schema conversion direction
  const sourceSchema = (selectedModel?.schemaVersion as SchemaVersion) || '';
  const schemaConversion = useMemo(() => {
    if (!sourceSchema || !schema) return null;
    const order: Record<string, number> = { IFC2X3: 1, IFC4: 2, IFC4X3: 3, IFC5: 4 };
    const src = order[sourceSchema] ?? 0;
    const dst = order[schema] ?? 0;
    if (src === dst) return null;
    return src < dst ? 'upgrade' as const : 'downgrade' as const;
  }, [sourceSchema, schema]);

  // Reset scope to single when switching to IFC5 (merged not supported)
  useEffect(() => {
    if (isIfc5) {
      setExportScope('single');
    }
  }, [isIfc5]);

  const modifiedCount = useMemo(() => {
    return getModifiedEntityCount();
  }, [getModifiedEntityCount]);

  /**
   * Convert global visibility state IDs to local expressIds for a given model.
   * The store uses global IDs (localId + idOffset), but the exporter needs local IDs.
   */
  const getLocalHiddenIds = useCallback((modelId: string): Set<number> => {
    // Legacy single-model path: no federation offset, global IDs = local IDs
    if (modelId === '__legacy__') {
      return hiddenEntities;
    }

    const model = models.get(modelId);
    if (!model) return new Set();
    const offset = model.idOffset ?? 0;

    // Prefer per-model visibility state, fall back to legacy global state
    const modelHidden = hiddenEntitiesByModel.get(modelId);
    if (modelHidden && modelHidden.size > 0) {
      return modelHidden; // Already local expressIds
    }

    // Federated model: convert global IDs to local
    const localIds = new Set<number>();
    for (const globalId of hiddenEntities) {
      const localId = globalId - offset;
      if (localId > 0 && localId <= model.maxExpressId) {
        localIds.add(localId);
      }
    }
    return localIds;
  }, [models, hiddenEntities, hiddenEntitiesByModel]);

  const getLocalIsolatedIds = useCallback((modelId: string): Set<number> | null => {
    // Legacy single-model path: no federation offset, global IDs = local IDs
    if (modelId === '__legacy__') {
      return isolatedEntities;
    }

    const model = models.get(modelId);
    if (!model) return null;
    const offset = model.idOffset ?? 0;

    // Prefer per-model isolation state
    const modelIsolated = isolatedEntitiesByModel.get(modelId);
    if (modelIsolated && modelIsolated.size > 0) {
      return modelIsolated; // Already local expressIds
    }

    // Federated model: convert global IDs to local
    if (!isolatedEntities) return null;
    const localIds = new Set<number>();
    for (const globalId of isolatedEntities) {
      const localId = globalId - offset;
      if (localId > 0 && localId <= model.maxExpressId) {
        localIds.add(localId);
      }
    }
    return localIds.size > 0 ? localIds : null;
  }, [models, isolatedEntities, isolatedEntitiesByModel]);

  // Detect if the model has properties that would be filtered by onlyKnownProperties.
  // Only relevant for IFC5 exports — show the toggle only when there's something to filter.
  const hasFilterableProperties = useMemo(() => {
    if (!isIfc5 || !selectedModel?.ifcDataStore) return false;
    const mutationView = getMutationView(selectedModelId);
    const propSource = mutationView || selectedModel.ifcDataStore.properties;
    if (!propSource) return false;

    // Sample a few entities to check for unknown property names
    const entities = selectedModel.ifcDataStore.entities;
    const limit = Math.min(entities.count, 50);
    for (let i = 0; i < limit; i++) {
      const id = entities.expressId[i];
      const psets = propSource.getForEntity(id);
      for (const pset of psets) {
        for (const prop of pset.properties) {
          if (!IFC5_KNOWN_PROP_NAMES.has(prop.name)) return true;
        }
      }
    }
    return false;
  }, [isIfc5, selectedModel, selectedModelId, getMutationView]);

  // Compute output format description for UI
  const outputInfo = useMemo(() => {
    if (changesOnly) {
      return isIfc5
        ? { ext: '.ifcx', label: 'IFCX (JSON)' }
        : { ext: '.json', label: 'JSON' };
    }
    return isIfc5
      ? { ext: '.ifcx', label: 'IFCX (JSON + USD geometry)' }
      : { ext: '.ifc', label: 'IFC (STEP)' };
  }, [isIfc5, changesOnly]);

  const handleExport = useCallback(async () => {
    if (!schema) return;
    if (exportScope === 'single' && !selectedModel) return;

    setIsExporting(true);
    setExportResult(null);
    setExportProgress(null);

    try {
      // Handle merged export of all models (STEP only, not IFC5)
      if (!isIfc5 && exportScope === 'merged' && !changesOnly) {
        const hydratedModels = await Promise.all(Array.from(models.values()).map(async (model) => ({
          model,
          dataStore: await ensureModelExportReady(model.id),
        })));
        const mergeInputs: MergeModelInput[] = [];
        for (const entry of hydratedModels) {
          if (!entry.dataStore) {
            continue;
          }
          mergeInputs.push({
            id: entry.model.id,
            name: entry.model.name,
            dataStore: entry.dataStore,
          });
        }

        const mergedExporter = new MergedExporter(mergeInputs);

        // Build per-model visibility maps if visible-only export
        const hiddenByModel = new Map<string, Set<number>>();
        const isolatedByModel = new Map<string, Set<number> | null>();
        if (visibleOnly) {
          for (const m of models.values()) {
            hiddenByModel.set(m.id, getLocalHiddenIds(m.id));
            isolatedByModel.set(m.id, getLocalIsolatedIds(m.id));
          }
        }

        const result = await mergedExporter.exportAsync({
          schema,
          projectStrategy: 'keep-first',
          visibleOnly,
          hiddenEntityIdsByModel: hiddenByModel,
          isolatedEntityIdsByModel: isolatedByModel,
          description: `Merged export of ${mergeInputs.length} models from ifc-lite`,
          application: 'ifc-lite',
          onProgress: (p: ExportProgress) => setExportProgress({
            phase: p.phase === 'preparing' ? 'Preparing models...'
              : p.phase === 'entities' ? `Processing entities${p.currentModel ? ` (${p.currentModel})` : ''}...`
              : 'Assembling file...',
            percent: p.percent,
            entitiesProcessed: p.entitiesProcessed,
            entitiesTotal: p.entitiesTotal,
            currentModel: p.currentModel,
          }),
        });

        setExportProgress(null);

        const blob = new Blob([toBlobPart(result.content)], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'merged_export.ifc';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        const msg = `Merged ${result.stats.modelCount} models, ${result.stats.totalEntityCount.toLocaleString()} entities`;
        setExportResult({ success: true, message: msg });
        toast.success(msg);
        return;
      }

      if (!selectedModel) return;
      const mutationView = getMutationView(selectedModelId);
      const baseName = selectedModel.name.replace(/\.[^.]+$/, '');

      // ── IFC5 → always IFCX ──────────────────────────────────────────
      if (isIfc5) {
        const federatedModel = models.get(selectedModelId);
        const idOffset = federatedModel?.idOffset ?? 0;

        const exporter = new Ifc5Exporter(
          selectedModel.ifcDataStore,
          selectedModel.geometryResult,
          mutationView || undefined,
          idOffset,
        );

        // When changesOnly, restrict to mutated entities and force applyMutations
        let localHidden: Set<number> | undefined;
        let localIsolated: Set<number> | undefined;
        let effectiveVisibleOnly = visibleOnly;
        let effectiveApplyMutations = applyMutations;

        if (changesOnly && mutationView) {
          // Compute the set of entity IDs that have mutations
          const mutations = mutationView.getMutations();
          const mutatedEntityIds = new Set<number>();
          for (const m of mutations) {
            mutatedEntityIds.add(m.entityId);
          }
          // Use isolatedEntityIds as an allowlist to export only mutated entities
          localIsolated = mutatedEntityIds;
          effectiveVisibleOnly = true;
          effectiveApplyMutations = true;
        } else if (visibleOnly) {
          localHidden = getLocalHiddenIds(selectedModelId);
          localIsolated = getLocalIsolatedIds(selectedModelId) ?? undefined;
          effectiveVisibleOnly = true;
        }

        const result = exporter.export({
          includeGeometry: changesOnly ? false : includeGeometry,
          includeProperties: true,
          applyMutations: effectiveApplyMutations,
          visibleOnly: effectiveVisibleOnly,
          hiddenEntityIds: localHidden,
          isolatedEntityIds: localIsolated,
          onlyKnownProperties,
          author: 'ifc-lite',
        });

        const blob = new Blob([toBlobPart(result.content)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const suffix = changesOnly ? '_changes' : (visibleOnly ? '_visible' : '_export');
        a.download = `${baseName}${suffix}.ifcx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        const ifcxMsg = `Exported IFCX: ${result.stats.nodeCount} nodes, ${result.stats.meshCount} meshes, ${result.stats.propertyCount} properties`;
        setExportResult({ success: true, message: ifcxMsg });
        toast.success(ifcxMsg);

      // ── Changes only (pre-IFC5) → JSON ───────────────────────────────
      } else if (changesOnly) {
        const mutations = mutationView?.getMutations() || [];
        const data = {
          version: 1,
          modelId: selectedModelId,
          modelName: selectedModel.name,
          mutations,
          exportedAt: new Date().toISOString(),
        };

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseName}_changes.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        const jsonMsg = `Exported ${mutations.length} changes as JSON`;
        setExportResult({ success: true, message: jsonMsg });
        toast.success(jsonMsg);

      // ── Pre-IFC5 full export → STEP ──────────────────────────────────
      } else {
        const exportDataStore = await ensureModelExportReady(selectedModelId);
        if (!exportDataStore) {
          throw new Error('Model data is unavailable for export');
        }

        const exporter = new StepExporter(exportDataStore, mutationView || undefined);

        const localHidden = visibleOnly ? getLocalHiddenIds(selectedModelId) : undefined;
        const localIsolated = visibleOnly ? getLocalIsolatedIds(selectedModelId) : undefined;

        // Include georeferencing mutations if applying mutations
        const georefMutations = applyMutations
          ? useViewerStore.getState().georefMutations?.get(selectedModelId) ?? undefined
          : undefined;

        const result = await exporter.exportAsync({
          schema,
          includeGeometry,
          applyMutations,
          visibleOnly,
          hiddenEntityIds: localHidden,
          isolatedEntityIds: localIsolated,
          georefMutations,
          description: `Exported from ifc-lite with ${modifiedCount} modifications`,
          application: 'ifc-lite',
          onProgress: (p: StepExportProgress) => setExportProgress({
            phase: p.phase === 'preparing' ? 'Preparing export...'
              : p.phase === 'entities' ? 'Processing entities...'
              : 'Assembling file...',
            percent: p.percent,
            entitiesProcessed: p.entitiesProcessed,
            entitiesTotal: p.entitiesTotal,
          }),
        });

        setExportProgress(null);

        // Splice pending schedule tasks into the STEP via the shared
        // helper. Same contract every export surface uses so bugs
        // can't differ between the dialog, the quick button, and the
        // SDK adapter.
        const state = useViewerStore.getState();
        const spliced = spliceScheduleIntoExport(result, selectedModelId, selectedModel.ifcDataStore as IfcDataStore, {
          scheduleData: state.scheduleData ?? null,
          scheduleIsEdited: state.scheduleIsEdited === true,
          scheduleSourceModelId: state.scheduleSourceModelId ?? null,
        });

        const blob = new Blob([toBlobPart(spliced.content)], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const suffix = visibleOnly ? '_visible' : '_export';
        a.download = `${baseName}${suffix}.ifc`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        const stepMsg = `Exported ${result.stats.entityCount} entities (${result.stats.modifiedEntityCount} modified)`;
        setExportResult({ success: true, message: stepMsg });
        toast.success(stepMsg);
      }
    } catch (error) {
      console.error('Export failed:', error);
      const errMsg = `Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      setExportResult({ success: false, message: errMsg });
      toast.error(errMsg);
    } finally {
      setIsExporting(false);
    }
  }, [selectedModel, selectedModelId, schema, isIfc5, exportScope, includeGeometry, applyMutations, changesOnly, visibleOnly, onlyKnownProperties, getMutationView, getLocalHiddenIds, getLocalIsolatedIds, modifiedCount, models]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4 mr-2" />
            Export IFC
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Export IFC File
          </DialogTitle>
          <DialogDescription>
            Export your model with property modifications applied
          </DialogDescription>
        </DialogHeader>

        <div ref={scrollAreaRef} className="grid gap-4 py-4 max-h-[60vh] overflow-y-auto">
          {/* Scope selector (only for STEP schemas with multiple models) */}
          {!isIfc5 && !changesOnly && modelList.length > 1 && (
            <div className="flex items-center gap-4">
              <Label className="w-32">Scope</Label>
              <Select value={exportScope} onValueChange={(v) => setExportScope(v as ExportScope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">Single Model</SelectItem>
                  <SelectItem value="merged">Merged (All Models)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Model selector (only for single-model export) */}
          {exportScope === 'single' && (
          <div className="flex items-center gap-4">
            <Label className="w-32">Model</Label>
            <Select value={selectedModelId} onValueChange={setSelectedModelId}>
              <SelectTrigger>
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {modelList.map((m) => {
                  const maxLen = 24;
                  const displayName = m.name.length > maxLen ? m.name.slice(0, maxLen) + '\u2026' : m.name;
                  return (
                  <SelectItem key={m.id} value={m.id} title={m.name}>
                    {displayName}{m.isDirty ? ' *' : ''}{m.schemaVersion ? ` (${m.schemaVersion})` : ''}
                  </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          )}

          {/* Schema selector — this drives the output format */}
          <div className="flex items-center gap-4">
            <Label className="w-32">Schema</Label>
            <Select value={schema} onValueChange={(v) => setSchema(v as SchemaVersion)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['IFC2X3', 'IFC4', 'IFC4X3', 'IFC5'] as const).map((v) => (
                  <SelectItem key={v} value={v}>
                    {v === 'IFC5' ? 'IFC5 (Alpha)' : v}
                    {v === sourceSchema ? ' (current)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Schema conversion warning */}
          {schemaConversion && (
            <Alert variant={schemaConversion === 'downgrade' ? 'destructive' : 'default'}>
              {schemaConversion === 'upgrade' ? (
                <ArrowUp className="h-4 w-4" />
              ) : (
                <ArrowDown className="h-4 w-4" />
              )}
              <AlertTitle>
                Schema {schemaConversion === 'upgrade' ? 'Upgrade' : 'Downgrade'}
              </AlertTitle>
              <AlertDescription>
                Converting from {sourceSchema} to {schema}.
                {schemaConversion === 'downgrade'
                  ? ' Some data may be lost in the conversion to an older schema.'
                  : ' Entity types will be mapped to the newer schema.'}
              </AlertDescription>
            </Alert>
          )}

          {/* Output format indicator */}
          <div className="flex items-center gap-4">
            <Label className="w-32 text-muted-foreground">Output</Label>
            <Badge variant="secondary">{outputInfo.label}</Badge>
            <span className="text-xs text-muted-foreground">{outputInfo.ext}</span>
          </div>

          {/* Options */}
          <div className="flex items-center justify-between">
            <div>
              <Label>Export Visible Only</Label>
              <p className="text-xs text-muted-foreground">Only include entities currently visible in the 3D view</p>
            </div>
            <Switch checked={visibleOnly} onCheckedChange={setVisibleOnly} />
          </div>

          {!changesOnly && exportScope === 'single' && (
            <div className="flex items-center justify-between">
              <Label>Include Geometry</Label>
              <Switch checked={includeGeometry} onCheckedChange={setIncludeGeometry} />
            </div>
          )}

          {exportScope === 'single' && (
            <div className="flex items-center justify-between">
              <Label>Apply Property Changes</Label>
              <Switch checked={applyMutations} onCheckedChange={setApplyMutations} />
            </div>
          )}

          {exportScope === 'single' && (
            <div className="flex items-center justify-between">
              <div>
                <Label>Changes Only</Label>
                <p className="text-xs text-muted-foreground">
                  {isIfc5 ? 'Export as IFCX overlay with mutations only' : 'Export mutations as JSON delta'}
                </p>
              </div>
              <Switch checked={changesOnly} onCheckedChange={setChangesOnly} />
            </div>
          )}

          {/* IFC5: strict property schema filtering */}
          {isIfc5 && hasFilterableProperties && (
            <div className="flex items-center justify-between">
              <div>
                <Label>Only Known IFC5 Properties</Label>
                <p className="text-xs text-muted-foreground">
                  Skip properties without an official IFC5 schema (avoids viewer warnings)
                </p>
              </div>
              <Switch checked={onlyKnownProperties} onCheckedChange={setOnlyKnownProperties} />
            </div>
          )}

          {/* Stats */}
          {modifiedCount > 0 && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Pending Changes</AlertTitle>
              <AlertDescription>
                {modifiedCount} entities have been modified
              </AlertDescription>
            </Alert>
          )}

          {/* Export Progress */}
          {isExporting && exportProgress && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {exportProgress.phase}
                </span>
                <span>
                  {exportProgress.entitiesProcessed.toLocaleString()} / {exportProgress.entitiesTotal.toLocaleString()} entities
                </span>
              </div>
              <Progress value={exportProgress.percent * 100} />
            </div>
          )}

          {/* Export result */}
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
          <Button onClick={handleExport} disabled={isExporting || !selectedModel || !schema}>
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
