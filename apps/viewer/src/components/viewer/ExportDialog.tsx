/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { modelDisplayLabels } from '@/lib/model-labels.js';
import { stepExportProgress } from '@/lib/export/step-progress.js';
import { prepareAppearanceSerialization } from '@/lib/appearance/serialization.js';
import { packagePortableIfcAsync, assertPortableMergeSupported } from '@/lib/export/portable-ifc';
import { modelAppearanceAssets } from '@/lib/appearance/model-assets';

/**
 * Export Dialog for IFC export with property mutations
 *
 * Schema drives the output format automatically:
 * - IFC2X3 / IFC4 / IFC4X3 → .ifc (STEP), or .ifczip with image resources
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
import { useViewerStore, countGeneratedTasks } from '@/store';
import { useTranslation } from '@/i18n';
import { resolveExportVisibility } from '@/store/exportVisibility';
import { posthog } from '@/lib/analytics';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { configureMutationView } from '@/utils/configureMutationView';
import { toast } from '@/components/ui/toast';
import { ensureModelExportReady } from '@/services/desktop-export';
import { StepExporter, MergedExporter, Ifc5Exporter, IFC5_KNOWN_PROP_NAMES, type MergeModelInput, type ExportProgress } from '@ifc-lite/export';
import { withInstancedMeshes } from '../../utils/instancedExport.js';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { spliceScheduleIntoExport } from '@/sdk/adapters/export-schedule-splice';
import { downloadFile, sanitizeFilename, stripExtension } from '@/lib/export/download';
import { roomExportPathPrefix } from '@/lib/collab/room-export-paths';
import { ExtensionExportSlot } from '@/components/extensions/ExtensionExportSlot';
import { preferredExportModelId } from './export-model-default';
import { canExportRoomAsStep, roomStepExportSource } from '@/lib/collab/room-step-export';
import { roomMergeInput, roomMergeVisibility } from '@/lib/collab/room-merged-export';
import { roomSymbolicSource } from '@/lib/collab/room-symbolic-source';
import { listExportModels, resolveExportModel } from './export-model-selection';

type ExportScope = 'single' | 'merged';
type SchemaVersion = 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';

interface ExportDialogProps {
  trigger?: React.ReactNode;
}
export function ExportDialog({ trigger }: ExportDialogProps) {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const dirtyModels = useViewerStore((s) => s.dirtyModels);
  const getMutationView = useViewerStore((s) => s.getMutationView);
  const registerMutationView = useViewerStore((s) => s.registerMutationView);
  const getModifiedEntityCount = useViewerStore((s) => s.getModifiedEntityCount);
  // Subscribed so the pending-changes count refreshes while the dialog is open
  // (getModifiedEntityCount / getMutationView are stable action refs). Schedule
  // edits don't bump mutationVersion, so the schedule fields are subscribed too.
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const scheduleData = useViewerStore((s) => s.scheduleData);
  const scheduleIsEdited = useViewerStore((s) => s.scheduleIsEdited);
  const scheduleSourceModelId = useViewerStore((s) => s.scheduleSourceModelId);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const hiddenEntitiesByModel = useViewerStore((s) => s.hiddenEntitiesByModel);
  const isolatedEntitiesByModel = useViewerStore((s) => s.isolatedEntitiesByModel);
  // Not read directly below — `resolveExportVisibility` reads the live store
  // snapshot at export time — but subscribed so the dialog re-renders (and the
  // memoized visibility getters below get fresh identities) when the Class
  // tab filter, storey selection, or a type-visibility toggle changes while
  // the dialog is open (#4328).
  const classFilter = useViewerStore((s) => s.classFilter);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const lensHiddenIds = useViewerStore((s) => s.lensHiddenIds);
  // Also get legacy single-model state for backward compatibility
  const legacyIfcDataStore = useViewerStore((s) => s.ifcDataStore);
  const legacyGeometryResult = useViewerStore((s) => s.geometryResult);
  // Optional extension host — emits the export.run action when present
  // so the local pattern miner can spot load → export workflows.
  const extensionHost = useOptionalExtensionHost();

  const [open, setOpen] = useState(false);
  const [schema, setSchema] = useState<SchemaVersion | ''>('');
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [exportScope, setExportScope] = useState<ExportScope>('single');
  const [includeGeometry, setIncludeGeometry] = useState(true);
  const [applyMutations, setApplyMutations] = useState(true);
  const [changesOnly, setChangesOnly] = useState(false);
  const [visibleOnly, setVisibleOnly] = useState(false);
  // How a merged export reconciles models with different length units.
  const [unitReconciliation, setUnitReconciliation] = useState<'auto' | 'normalize' | 'assume-shared'>('auto');
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

  const exportModelLabels = useMemo(() => modelDisplayLabels(models, 32), [models]);
  const modelList = useMemo(
    () => listExportModels(models, dirtyModels, legacyIfcDataStore),
    [models, dirtyModels, legacyIfcDataStore],
  );

  // Keep a removed selection from stranding the dialog. The open handler below
  // deliberately re-seeds from the active model each time: authoring commands
  // select their destination, so Export follows the object the user just made.
  useEffect(() => {
    if (selectedModelId && !modelList.some(model => model.id === selectedModelId)) {
      setSelectedModelId(modelList[0]?.id ?? '');
    }
  }, [modelList, selectedModelId]);

  const handleOpenChange = useCallback((next: boolean) => {
    if (next) setSelectedModelId(preferredExportModelId(modelList.map(model => model.id), activeModelId));
    setOpen(next);
  }, [modelList, activeModelId]);

  const selectedModel = useMemo(
    () => resolveExportModel(models, selectedModelId, legacyIfcDataStore, legacyGeometryResult),
    [models, selectedModelId, legacyIfcDataStore, legacyGeometryResult],
  );
  const selectedRoomView = selectedModelId ? getMutationView(selectedModelId) ?? undefined : undefined;
  const selectedLandXml = selectedModel?.sourceSchema === 'LandXML-1.2';
  const mergedLandXml = exportScope === 'merged'
    && Array.from(models.values()).some((model) => model.sourceSchema === 'LandXML-1.2');
  const canExportIfc = !selectedLandXml && !mergedLandXml;
  const portableRoomStore = selectedModel?.ifcDataStore
    && canExportRoomAsStep(selectedModel.ifcDataStore, selectedRoomView)
    ? roomSymbolicSource(selectedModel.ifcDataStore)?.dataStore
    : undefined;

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
    const modelSchema = (portableRoomStore?.schemaVersion ?? selectedModel.schemaVersion) as SchemaVersion;
    if (modelSchema) {
      setSchema(modelSchema);
    }
  }, [selectedModel?.schemaVersion, portableRoomStore?.schemaVersion]);

  // Determine schema conversion direction
  const sourceSchema = ((portableRoomStore?.schemaVersion ?? selectedModel?.schemaVersion) as SchemaVersion) || '';
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
    // A single-model export writes only the selected model, so the pending
    // changes banner and the "N modifications" file header must reflect that
    // one model's count — not every loaded model's (getModifiedEntityCount).
    // A merged export writes all models, so it keeps the aggregate count.
    if (exportScope === 'single') {
      let count = getMutationView(selectedModelId)?.getModifiedEntityCount() ?? 0;
      // The single-model STEP export also applies the selected model's
      // georeferencing edits, so count them (+1) when present.
      const gm = georefMutations.get(selectedModelId);
      const hasGeoref = !!gm && (
        (gm.projectedCRS && Object.keys(gm.projectedCRS).length > 0) ||
        (gm.mapConversion && Object.keys(gm.mapConversion).length > 0)
      );
      if (hasGeoref) count += 1;
      // ...and it splices the schedule when the selected model owns it (or it's
      // unattributed with pending tasks) — the same gate spliceScheduleIntoExport
      // uses — so count those tasks too, matching what actually gets written.
      const ownsSchedule = scheduleSourceModelId === selectedModelId
        || (scheduleSourceModelId === null && (scheduleData?.tasks.length ?? 0) > 0);
      if (ownsSchedule) {
        const generated = countGeneratedTasks(scheduleData);
        if (generated > 0) count += generated;
        else if (scheduleIsEdited) count += 1;
      }
      return count;
    }
    return getModifiedEntityCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportScope, selectedModelId, getModifiedEntityCount, getMutationView, mutationVersion, scheduleData, scheduleIsEdited, scheduleSourceModelId, georefMutations]);

  /**
   * Resolve local (per-model) hidden/isolated expressIds for `modelId` from
   * EVERY active visibility channel — hidden/isolated entities, the Class
   * tab filter, storey selection, and type-visibility toggles — through the
   * single shared resolver (`resolveExportVisibility`) every export path
   * routes through, not a per-dialog restatement of a subset of them
   * (#4328: the class filter and storey isolation used to be invisible to
   * every exporter). Reads `useViewerStore.getState()` directly so the
   * export always sees the state at click time, not a stale render.
   */
  const getExportVisibility = useCallback(
    (modelId: string) => resolveExportVisibility(useViewerStore.getState(), modelId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models, hiddenEntities, isolatedEntities, hiddenEntitiesByModel, isolatedEntitiesByModel, classFilter, selectedStoreys, typeVisibility, lensHiddenIds],
  );

  const getLocalHiddenIds = useCallback(
    (modelId: string): Set<number> => getExportVisibility(modelId).hiddenLocalIds,
    [getExportVisibility],
  );

  const getLocalIsolatedIds = useCallback(
    (modelId: string): Set<number> | null => getExportVisibility(modelId).isolatedLocalIds,
    [getExportVisibility],
  );

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

  const packagesImages = exportScope === 'single' && modelAppearanceAssets.hasResources(selectedModelId);
  const outputInfo = useMemo(() => {
    if (changesOnly) {
      return isIfc5
        ? { ext: '.ifcx', label: 'IFCX (JSON)' }
        : { ext: '.json', label: 'JSON' };
    }
    return isIfc5
      ? { ext: '.ifcx', label: 'IFCX (JSON + USD geometry)' }
      : packagesImages ? { ext: '.ifczip', label: 'IFC + images' }
      : { ext: '.ifc', label: 'IFC (STEP)' };
  }, [isIfc5, changesOnly, packagesImages]);

  const handleExport = useCallback(async () => {
    if (!schema) return;
    if (exportScope === 'single' && !selectedModel) return;
    if (selectedLandXml || mergedLandXml) {
      const message = 'LandXML is source geometry, not IFC. Export the original LandXML file instead.';
      setExportResult({ success: false, message });
      toast.error(message);
      return;
    }

    // Action log: content-free emit so the miner can spot
    // "load → export" patterns. Format label only — no path / data.
    extensionHost?.emitAction('export.run', { format: outputInfo.ext.replace(/^\./, '') });

    setIsExporting(true);
    setExportResult(null);
    setExportProgress(null);

    // Set per success branch; captured once in `finally` so a thrown export
    // never counts. Format reflects what was actually written (the IFC5 vs
    // STEP vs changes-JSON branch), not just the schema-derived extension.
    let exportedFormat: string | null = null;
    try {
      // Handle merged export of all models (STEP only, not IFC5)
      if (!isIfc5 && exportScope === 'merged' && !changesOnly) {
        assertPortableMergeSupported(models.keys());
        const hydratedModels = await Promise.all(Array.from(models.values()).map(async (model) => ({
          model,
          dataStore: await ensureModelExportReady(model.id),
        })));
        const mergeInputs: MergeModelInput[] = [];
        const portableByModel = new Map<string, NonNullable<ReturnType<typeof roomStepExportSource>>>();
        for (const entry of hydratedModels) {
          if (!entry.dataStore) {
            continue;
          }
          const roomView = applyMutations ? (getMutationView(entry.model.id) ?? undefined) : undefined;
          const { input, portable } = roomMergeInput({
            id: entry.model.id, name: entry.model.name, store: entry.dataStore, roomView, applyMutations,
          });
          if (portable) portableByModel.set(entry.model.id, portable);
          mergeInputs.push(input);
        }

        const mergedExporter = new MergedExporter(mergeInputs);

        const visibility = visibleOnly
          ? roomMergeVisibility(models.keys(), portableByModel, getLocalHiddenIds, getLocalIsolatedIds)
          : { hidden: new Map<string, Set<number>>(), isolated: new Map<string, Set<number> | null>() };

        // Assemble the merged download off-heap so it does not materialise as
        // one contiguous Uint8Array on the JS heap.
        const result = await mergedExporter.exportBlobAsync({
          schema,
          projectStrategy: 'keep-first',
          unitReconciliation,
          visibleOnly,
          hiddenEntityIdsByModel: visibility.hidden,
          isolatedEntityIdsByModel: visibility.isolated,
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

        downloadFile(result.content, 'merged_export.ifc', 'text/plain');

        const msg = `Merged ${result.stats.modelCount} models, ${result.stats.totalEntityCount.toLocaleString()} entities`
          + (result.stats.normalizedModelCount > 0
            ? ` (${result.stats.normalizedModelCount} rescaled into the first model's unit)`
            : '');
        setExportResult({ success: true, message: msg });
        toast.success(msg);
        exportedFormat = 'ifc';
        return;
      }

      if (!selectedModel) return;
      // IFC5 export needs a parsed data store + geometry. Native-metadata
      // models don't carry these, so bail with a descriptive error rather
      // than passing nulls through.
      if (!selectedModel.ifcDataStore) {
        throw new Error('Selected model has no parsed IFC data store available for export');
      }
      const mutationView = getMutationView(selectedModelId);
      const baseName = sanitizeFilename(stripExtension(selectedModel.name), { fallback: 'model' });

      // ── IFC5 → always IFCX ──────────────────────────────────────────
      if (isIfc5) {
        const federatedModel = models.get(selectedModelId);
        const idOffset = federatedModel?.idOffset ?? 0;

        // Include GPU-instanced occurrences (absent from geometryResult.meshes) so
        // the USD/IFC5 export isn't missing them. GPU instancing stopped being
        // primary-only on 2026-08-06 (#2255) — a federated model can carry
        // instanced occurrences too — so scope by THIS model's
        // `{ idOffset, maxExpressId }` bracket rather than an `idOffset === 0`
        // gate, or a federation of N models would splice every other model's
        // instanced entities into this one's export. `federatedModel` is
        // undefined only for the legacy slot, which is provably the sole model
        // loaded, so `null` (no filter) is correct there (#2865/#2878 follow-up).
        const exportGeometry = selectedModel.geometryResult
          ? withInstancedMeshes(
              selectedModel.geometryResult,
              federatedModel
                ? { modelId: federatedModel.id, idOffset: federatedModel.idOffset ?? 0, maxExpressId: federatedModel.maxExpressId ?? 0 }
                : null,
            )
          : selectedModel.geometryResult;

        const exporter = new Ifc5Exporter(
          selectedModel.ifcDataStore,
          exportGeometry,
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
          stripPathPrefix: roomExportPathPrefix(useViewerStore.getState(), selectedModelId), // room path -> file path, #4444
        });

        const suffix = changesOnly ? '_changes' : (visibleOnly ? '_visible' : '_export');
        downloadFile(result.content, `${baseName}${suffix}.ifcx`, 'application/json');

        const ifcxMsg = `Exported IFCX: ${result.stats.nodeCount} nodes, ${result.stats.meshCount} meshes, ${result.stats.propertyCount} properties`;
        setExportResult({ success: true, message: ifcxMsg });
        toast.success(ifcxMsg);
        exportedFormat = 'ifcx';

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

        downloadFile(JSON.stringify(data, null, 2), `${baseName}_changes.json`, 'application/json');

        const jsonMsg = `Exported ${mutations.length} changes as JSON`;
        setExportResult({ success: true, message: jsonMsg });
        toast.success(jsonMsg);
        exportedFormat = 'json';

      // ── Pre-IFC5 full export → STEP ──────────────────────────────────
      } else {
        const portable = roomStepExportSource(selectedModel.ifcDataStore, mutationView || undefined, selectedModelId);
        const exportDataStore = portable?.dataStore ?? await ensureModelExportReady(selectedModelId);
        if (!exportDataStore) {
          throw new Error('Model data is unavailable for export');
        }

        const exportView = portable ? portable.mutationView : mutationView ?? undefined;
        const serialized = prepareAppearanceSerialization(selectedModelId, exportDataStore, applyMutations ? exportView : undefined);
        const exporter = new StepExporter(exportDataStore, serialized.view);

        const roomHidden = visibleOnly ? getLocalHiddenIds(selectedModelId) : undefined;
        const mappedHidden = portable?.toSourceIds(roomHidden);
        const localHidden = portable ? mappedHidden ?? undefined : roomHidden;
        const roomIsolated = visibleOnly ? getLocalIsolatedIds(selectedModelId) : undefined;
        const localIsolated = portable ? portable.toSourceIds(roomIsolated) : roomIsolated;

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
          onProgress: p => setExportProgress(stepExportProgress(p)),
        });

        setExportProgress(null);

        // Shared schedule splice and texture packaging keep all export surfaces consistent.
        const state = useViewerStore.getState();
        const spliced = spliceScheduleIntoExport(result, selectedModelId, exportDataStore, {
          scheduleData: state.scheduleData ?? null,
          scheduleIsEdited: state.scheduleIsEdited === true,
          scheduleSourceModelId: state.scheduleSourceModelId ?? null,
        });

        const suffix = visibleOnly ? '_visible' : '_export';
        const artifact = await packagePortableIfcAsync(selectedModelId, spliced.content, serialized.resources);
        downloadFile(artifact.content, `${baseName}${suffix}.${artifact.ext}`, artifact.mime);

        const stepMsg = `Exported ${result.stats.entityCount} entities (${result.stats.modifiedEntityCount} modified)`;
        setExportResult({ success: true, message: stepMsg });
        toast.success(stepMsg);
        exportedFormat = artifact.ext;
      }
    } catch (error) {
      console.error('Export failed:', error);
      const errMsg = `Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      setExportResult({ success: false, message: errMsg });
      toast.error(errMsg);
    } finally {
      setIsExporting(false);
      if (exportedFormat) {
        posthog.capture('export_completed', {
          format: exportedFormat,
          scope: exportScope,
          changes_only: changesOnly,
          visible_only: visibleOnly,
          include_geometry: includeGeometry,
        });
      }
    }
  }, [selectedModel, selectedModelId, schema, isIfc5, exportScope, includeGeometry, applyMutations, changesOnly, visibleOnly, unitReconciliation, onlyKnownProperties, getMutationView, getLocalHiddenIds, getLocalIsolatedIds, modifiedCount, models, extensionHost, outputInfo, selectedLandXml, mergedLandXml]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4 mr-2" />
            {t('exportDialog.trigger')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            {t('exportDialog.title')}
          </DialogTitle>
          <DialogDescription>
            {isIfc5 && !changesOnly ? t('exportDialog.description.ifc5') : t('exportDialog.description.default')}
          </DialogDescription>
        </DialogHeader>

        <div ref={scrollAreaRef} className="grid gap-4 py-4 max-h-[70vh] overflow-y-auto">
          {/* Scope selector (only for STEP schemas with multiple models) */}
          {!isIfc5 && !changesOnly && modelList.length > 1 && (
            <div className="flex items-center gap-4">
              <Label className="w-32">{t('exportDialog.scopeLabel')}</Label>
              <Select value={exportScope} onValueChange={(v) => setExportScope(v as ExportScope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">{t('exportDialog.scope.single')}</SelectItem>
                  <SelectItem value="merged">{t('exportDialog.scope.merged')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Mixed-unit handling — only meaningful for a merged export */}
          {!isIfc5 && !changesOnly && exportScope === 'merged' && modelList.length > 1 && (
            <div className="flex items-center gap-4">
              <Label className="w-32">{t('exportDialog.mixedUnitsLabel')}</Label>
              <Select value={unitReconciliation} onValueChange={(v) => setUnitReconciliation(v as typeof unitReconciliation)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('exportDialog.unitReconciliation.auto')}</SelectItem>
                  <SelectItem value="normalize">{t('exportDialog.unitReconciliation.normalize')}</SelectItem>
                  <SelectItem value="assume-shared">{t('exportDialog.unitReconciliation.assumeShared')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Model selector (only for single-model export) */}
          {exportScope === 'single' && (
          <div className="flex items-center gap-4">
            <Label className="w-32">{t('exportDialog.modelLabel')}</Label>
            <Select value={selectedModelId} onValueChange={setSelectedModelId}>
              <SelectTrigger>
                <SelectValue placeholder={t('exportDialog.selectModelPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {modelList.map((m) => {
                  const displayName = exportModelLabels.get(m.id) ?? m.name;
                  return (
                  <SelectItem key={m.id} value={m.id} title={m.name}>
                    {displayName}{m.isDirty ? ' *' : ''}{m.sourceSchema ? ` (${m.sourceSchema})` : m.schemaVersion ? ` (${m.schemaVersion})` : ''}
                  </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          )}

          {/* Schema selector — this drives the output format */}
          {!canExportIfc && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>LandXML cannot be exported as IFC</AlertTitle>
              <AlertDescription>Its terrain records remain in their original source format; no IFC entities are synthesized for export.</AlertDescription>
            </Alert>
          )}
          <div className="flex items-center gap-4">
            <Label className="w-32">{t('exportDialog.schemaLabel')}</Label>
            <Select value={schema} onValueChange={(v) => setSchema(v as SchemaVersion)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['IFC2X3', 'IFC4', 'IFC4X3', 'IFC5'] as const).map((v) => (
                  <SelectItem key={v} value={v}>
                    {v === 'IFC5' ? t('exportDialog.schemaOption.ifc5Alpha') : v}
                    {v === sourceSchema ? t('exportDialog.currentSchemaSuffix') : ''}
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
                {schemaConversion === 'upgrade' ? t('exportDialog.schemaUpgradeTitle') : t('exportDialog.schemaDowngradeTitle')}
              </AlertTitle>
              <AlertDescription>
                {t('exportDialog.conversionSummary', { source: sourceSchema, target: schema })}{' '}
                {schemaConversion === 'downgrade' ? t('exportDialog.schemaDowngradeNote') : t('exportDialog.schemaUpgradeNote')}
              </AlertDescription>
            </Alert>
          )}

          {/* Output format indicator */}
          <div className="flex items-center gap-4">
            <Label className="w-32 text-muted-foreground">{t('exportDialog.outputLabel')}</Label>
            <Badge variant="secondary">{outputInfo.label}</Badge>
            <span className="text-xs text-muted-foreground">{outputInfo.ext}</span>
          </div>

          {/* Options */}
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('exportDialog.visibleOnlyLabel')}</Label>
              <p className="text-xs text-muted-foreground">{t('exportDialog.visibleOnlyHint')}</p>
            </div>
            <Switch checked={visibleOnly} onCheckedChange={setVisibleOnly} />
          </div>

          {!changesOnly && exportScope === 'single' && (
            <div className="flex items-center justify-between">
              <Label>{t('exportDialog.includeGeometryLabel')}</Label>
              <Switch checked={includeGeometry} onCheckedChange={setIncludeGeometry} />
            </div>
          )}

          {(exportScope === 'single' || exportScope === 'merged') && (
            <div className="flex items-center justify-between">
              <Label>{t('exportDialog.applyMutationsLabel')}</Label>
              <Switch checked={applyMutations} onCheckedChange={setApplyMutations} />
            </div>
          )}

          {exportScope === 'single' && (
            <div className="flex items-center justify-between">
              <div>
                <Label>{t('exportDialog.changesOnlyLabel')}</Label>
                <p className="text-xs text-muted-foreground">
                  {isIfc5 ? t('exportDialog.changesOnlyHint.ifc5') : t('exportDialog.changesOnlyHint.default')}
                </p>
              </div>
              <Switch checked={changesOnly} onCheckedChange={setChangesOnly} />
            </div>
          )}

          {/* IFC5: strict property schema filtering */}
          {isIfc5 && hasFilterableProperties && (
            <div className="flex items-center justify-between">
              <div>
                <Label>{t('exportDialog.onlyKnownPropertiesLabel')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('exportDialog.onlyKnownPropertiesHint')}
                </p>
              </div>
              <Switch checked={onlyKnownProperties} onCheckedChange={setOnlyKnownProperties} />
            </div>
          )}

          {/* Stats */}
          {modifiedCount > 0 && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('exportDialog.pendingChangesTitle')}</AlertTitle>
              <AlertDescription>
                {t('exportDialog.pendingChangesDescription', { count: modifiedCount, countDisplay: modifiedCount })}
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
                  {t('exportDialog.progressCount', { processed: exportProgress.entitiesProcessed.toLocaleString(), total: exportProgress.entitiesTotal.toLocaleString() })}
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
              <AlertTitle>{exportResult.success ? t('exportDialog.resultSuccessTitle') : t('exportDialog.resultErrorTitle')}</AlertTitle>
              <AlertDescription>{exportResult.message}</AlertDescription>
            </Alert>
          )}

          {/* Extension-contributed exporters (#1907). Rendered alongside the
              built-in formats so a third-party exporter is actually reachable. */}
          <ExtensionExportSlot
            baseName={
              selectedModel
                ? sanitizeFilename(stripExtension(selectedModel.name), { fallback: 'model' })
                : 'model'
            }
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('exportDialog.cancelButton')}
          </Button>
          <Button onClick={handleExport} disabled={isExporting || !selectedModel || !schema || !canExportIfc}>
            {isExporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('exportDialog.exportingLabel')}
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                {t('exportDialog.exportButton')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
