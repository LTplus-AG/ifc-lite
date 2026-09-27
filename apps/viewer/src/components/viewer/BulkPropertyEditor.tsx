/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bulk Property Editor - Query builder UI for mass property updates
 * Full integration with BulkQueryEngine
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Play, Eye, Filter, Tag } from 'lucide-react';

import { Spinner } from '@/components/ui/spinner';
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
import { Separator } from '@/components/ui/separator';
import { useViewerStore } from '@/store';
import { canMutate, mutationDenialKey, mutationPermissionForModels } from '@/store/mutation-permission';
import { useIfc } from '@/hooks/useIfc';
import { configureMutationView } from '@/utils/configureMutationView';
import { PropertyValueType } from '@ifc-lite/data';
import {
  BulkQueryEngine,
  MutablePropertyView,
  type BulkAction,
  type BulkQueryPreview,
  type BulkQueryResult,
} from '@ifc-lite/mutations';
import { extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { FilterGroupEditor, type FilterGroupEditorState } from './FilterGroupEditor';
import { emptyFilterGroup } from '@ifc-lite/rules';
import { resolveBulkQueryIds, useBulkQueryTargets } from './useBulkQueryTargets';

import { defaultAuthoringModelId } from '@/lib/model-placement/history';
import { parseBulkSetPropertyValue, type BulkParseResult } from './bulk-property-value';
import { BulkExecutionResult, type BulkRuntimeFailure } from './BulkExecutionResult';
import { BulkExecutionProgress } from './BulkExecutionProgress';
import { BulkActionConfig } from './bulk-property-editor-action-config';
import { Field } from '@/components/ui/field';
import { useBulkTargets } from './useBulkTargets';
import type { BulkTargetSource } from './bulk-targets';
import { runBulkTargetBatches } from './bulk-target-run';


export { parseBulkSetPropertyValue } from './bulk-property-value';

type ActionType = 'SET_PROPERTY' | 'DELETE_PROPERTY' | 'SET_ATTRIBUTE';

interface BulkPropertyEditorProps {
  trigger?: React.ReactNode;
}

export function BulkPropertyEditor({ trigger }: BulkPropertyEditorProps) {
  const { t, locale, revision } = useTranslation();
  const { models } = useIfc();
  const getMutationView = useViewerStore((s) => s.getMutationView);
  const registerMutationView = useViewerStore((s) => s.registerMutationView);
  // Subscribe to mutationViews directly to trigger re-render when views are registered
  const mutationViews = useViewerStore((s) => s.mutationViews);
  // The engine writes directly to a mutation view, so its live callback and
  // the Execute affordance both consult the same viewer permission policy.
  const editEnabled = useViewerStore((s) => s.editEnabled);
  const collabEditRole = useViewerStore((s) => s.collabRole);
  // Also get legacy single-model state for backward compatibility
  const legacyIfcDataStore = useViewerStore((s) => s.ifcDataStore);
  const legacyGeometryResult = useViewerStore((s) => s.geometryResult);

  const [open, setOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [targetSource, setTargetSource] = useState<BulkTargetSource>('query');
  const targetGroups = useBulkTargets(open, targetSource, models);
  const editDenialReason = useMemo(() => {
    const ids = targetSource === 'query' ? [selectedModelId] : targetGroups.keys();
    const result = mutationPermissionForModels(useViewerStore.getState(), ids);
    return result.allowed ? undefined : result.reason;
  }, [editEnabled, collabEditRole, selectedModelId, targetSource, targetGroups]);
  const canEditInSession = editDenialReason === undefined;

  const [queryFilterState, setQueryFilterState] = useState<FilterGroupEditorState>({
    groups: [emptyFilterGroup()], activeGroup: 0,
  });
  const queryGroups = queryFilterState.groups;

  // Action configuration
  const [actionType, setActionType] = useState<ActionType>('SET_PROPERTY');
  const [targetPset, setTargetPset] = useState('');
  const [targetProp, setTargetProp] = useState('');
  const [targetValue, setTargetValue] = useState('');
  const [valueType, setValueType] = useState<PropertyValueType>(PropertyValueType.String);

  // Execution state
  const [isExecuting, setIsExecuting] = useState(false);
  const [executeProgress, setExecuteProgress] = useState<{ done: number; total: number } | null>(null);
  const executeCancelRef = useRef(false);
  const executeAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { executeCancelRef.current = true; executeAbortRef.current?.abort(); }, []);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [previewResult, setPreviewResult] = useState<BulkQueryPreview | null>(null);
  const [executeResult, setExecuteResult] = useState<BulkQueryResult | null>(null);
  const [validationFailure, setValidationFailure] = useState<Extract<BulkParseResult, { ok: false }> | null>(null);
  const [runtimeFailures, setRuntimeFailures] = useState<BulkRuntimeFailure[]>([]);
  // Track whether config changed since last execute (disables button after success)
  const [executeDirty, setExecuteDirty] = useState(true);
  const prevProgressRef = useRef<{ done: number; total: number } | null>(null);

  // --- All expensive computation is gated behind `open` so IFC loading is never impacted ---

  // Get list of models - only when dialog is open
  const modelList = useMemo(() => {
    if (!open) return [];
    const list = Array.from(models.values()).map((m) => ({
      id: m.id,
      name: m.name,
      sourceFingerprint: m.sourceFingerprint,
    }));

    // If no models in Map but legacy data exists, add a synthetic entry
    if (list.length === 0 && legacyIfcDataStore) {
      list.push({
        id: '__legacy__',
        name: t('bulkPropertyEditor.currentModel'),
        sourceFingerprint: undefined,
      });
    }

    return list;
  }, [open, models, legacyIfcDataStore, t, locale, revision]);

  // Default to the active model: Undo replays the active model's history (#5958).
  useEffect(() => {
    if (open && modelList.length > 0 && !selectedModelId) {
      setSelectedModelId(defaultAuthoringModelId(modelList, useViewerStore.getState().activeModelId));
    }
  }, [open, modelList, selectedModelId]);

  // Get selected model's data - supports both federated and legacy mode
  const selectedModel = useMemo(() => {
    if (!open) return undefined;
    if (selectedModelId === '__legacy__' && legacyIfcDataStore && legacyGeometryResult) {
      // Return a synthetic FederatedModel-like object for legacy mode
      return {
        id: '__legacy__',
        name: t('bulkPropertyEditor.currentModel'),
        ifcDataStore: legacyIfcDataStore,
        geometryResult: legacyGeometryResult,
        visible: true,
        collapsed: false,
      };
    }
    return models.get(selectedModelId);
  }, [open, models, selectedModelId, legacyIfcDataStore, legacyGeometryResult, t, locale, revision]);

  // Ensure mutation view exists for selected model — only when dialog is open
  useEffect(() => {
    if (!open || !selectedModel?.ifcDataStore || !selectedModelId) return;

    // Check if mutation view already exists
    let mutationView = getMutationView(selectedModelId);
    if (mutationView) return;

    // Create new mutation view with on-demand property extractor
    const dataStore = selectedModel.ifcDataStore;
    mutationView = new MutablePropertyView(dataStore.properties || null, selectedModelId);

    configureMutationView(mutationView, dataStore as IfcDataStore);

    // Register the mutation view
    registerMutationView(selectedModelId, mutationView);
  }, [open, selectedModel, selectedModelId, getMutationView, registerMutationView]);

  // Create BulkQueryEngine instance — only when dialog is open
  const queryEngine = useMemo(() => {
    if (!open || !selectedModel?.ifcDataStore) return null;
    const mutationView = mutationViews.get(selectedModelId);
    if (!mutationView) return null;

    const dataStore = selectedModel.ifcDataStore;
    return new BulkQueryEngine(
      dataStore.entities,
      mutationView,
      dataStore.spatialHierarchy || null,
      dataStore.strings || null,
      () => canMutate(useViewerStore.getState(), selectedModelId),
      dataStore.schemaVersion,
    );
  }, [open, selectedModel, selectedModelId, mutationViews]);

  // Non-query sources can span models; each must write through its own overlay.
  useEffect(() => {
    if (!open || targetSource === 'query') return;
    for (const modelId of targetGroups.keys()) {
      const dataStore = models.get(modelId)?.ifcDataStore;
      if (!dataStore || getMutationView(modelId)) continue;
      const view = new MutablePropertyView(dataStore.properties || null, modelId);
      configureMutationView(view, dataStore);
      registerMutationView(modelId, view);
    }
  }, [open, targetSource, targetGroups, models, getMutationView, registerMutationView]);

  const targetEngines = useMemo(() => {
    const engines = new Map<string, BulkQueryEngine>();
    if (!open || targetSource === 'query') return engines;
    for (const modelId of targetGroups.keys()) {
      const dataStore = models.get(modelId)?.ifcDataStore;
      const view = mutationViews.get(modelId);
      if (!dataStore || !view) continue;
      engines.set(modelId, new BulkQueryEngine(dataStore.entities, view,
        dataStore.spatialHierarchy || null,
        dataStore.strings || null, () => canMutate(useViewerStore.getState(), modelId), dataStore.schemaVersion));
    }
    return engines;
  }, [open, targetSource, targetGroups, models, mutationViews]);

  const { ids: queryIds, computing: isComputing, error: queryError } = useBulkQueryTargets(
    open && targetSource === 'query', isExecuting, selectedModelId, queryGroups,
  );
  const [discoveredProperties, setDiscoveredProperties] = useState<{
    psets: Map<string, Set<string>>; allProps: Set<string>;
  }>({ psets: new Map(), allProps: new Set() });

  // Property suggestions are display-only; evaluate the query once via Rules,
  // then sample its matches without re-running the old property predicate.
  useEffect(() => {
    const psets = new Map<string, Set<string>>();
    const allProps = new Set<string>();
    const dataStore = selectedModel?.ifcDataStore;
    if (targetSource === 'query' && dataStore && queryIds.length > 0) {
      // Re-parsing the source is costly; use one sample for lazy stores and
      // the cached columnar table for the rest of the suggestions.
      let firstProperties: Array<{ name: string; properties: Array<{ name: string }> }> =
        dataStore.properties?.getForEntity(queryIds[0]) ?? [];
      if (dataStore.onDemandPropertyMap && dataStore.source?.length > 0) {
        try {
          firstProperties = extractPropertiesOnDemand(dataStore as IfcDataStore, queryIds[0]);
        } catch (error) {
          console.warn('[bulk-edit] property suggestions unavailable', error);
        }
      }
      for (const [index, entityId] of queryIds.slice(0, 100).entries()) {
        const properties = index === 0 ? firstProperties : dataStore.properties?.getForEntity(entityId) ?? [];
        for (const pset of properties) {
          const propSet = psets.get(pset.name) ?? new Set<string>();
          for (const prop of pset.properties) {
            propSet.add(prop.name);
            allProps.add(prop.name);
          }
          psets.set(pset.name, propSet);
        }
      }
    }
    setDiscoveredProperties({ psets, allProps });
  }, [targetSource, selectedModel, queryIds]);

  const liveMatchCount = targetSource === 'query' ? queryIds.length
    : [...targetGroups.values()].reduce((count, ids) => count + ids.length, 0);
  const targetsReady = targetSource === 'query' ? !!queryEngine && !isComputing && !queryError : targetEngines.size === targetGroups.size;

  // Flatten discovered properties for selectors
  const psetOptions = useMemo(() => {
    return Array.from(discoveredProperties.psets.keys()).sort();
  }, [discoveredProperties]);

  const propOptions = useMemo(() => {
    // If a property set is selected, show only properties from that set
    if (targetPset && discoveredProperties.psets.has(targetPset)) {
      return Array.from(discoveredProperties.psets.get(targetPset)!).sort();
    }
    // Otherwise show all properties
    return Array.from(discoveredProperties.allProps).sort();
  }, [discoveredProperties, targetPset]);

  // Build action for the query engine; returns a failure (parseBulkSetPropertyValue)
  // instead of a fabricated-value action — callers must refuse the whole operation.
  const buildAction = useCallback((): { ok: true; action: BulkAction } | Extract<BulkParseResult, { ok: false }> => {
    let action: BulkAction;
    if (actionType === 'SET_PROPERTY') {
      const parsed = parseBulkSetPropertyValue(targetValue, valueType, t);
      if (!parsed.ok) return parsed;
      action = { type: 'SET_PROPERTY', psetName: targetPset, propName: targetProp, value: parsed.value, valueType };
    } else if (actionType === 'DELETE_PROPERTY') {
      action = { type: 'DELETE_PROPERTY', psetName: targetPset, propName: targetProp };
    } else {
      action = { type: 'SET_ATTRIBUTE', attribute: targetProp, value: targetValue };
    }
    return { ok: true, action };
  }, [actionType, targetPset, targetProp, targetValue, valueType, t]);

  // Preview query
  const handlePreview = useCallback(() => {
    if (!targetsReady) return;

    setPreviewResult(null);
    setExecuteResult(null);
    setValidationFailure(null);
    setRuntimeFailures([]);

    const built = buildAction();
    // Refuse rather than build around a fabricated value; same Alert Execute uses.
    if (!built.ok) {
      setValidationFailure(built);
      setRuntimeFailures([]);
      return setExecuteResult({ mutations: [], affectedEntityCount: 0, success: false });
    }

    try {
      const result = { matchedEntityIds: targetSource === 'query' ? queryIds : [], matchedCount: liveMatchCount, estimatedMutations: liveMatchCount };
      setPreviewResult(result);
    } catch (error) {
      console.error('Preview failed:', error);
      setPreviewResult({ matchedEntityIds: [], matchedCount: 0, estimatedMutations: 0 });
    }
  }, [targetsReady, targetSource, liveMatchCount, queryIds, buildAction]);

  // Execute bulk update — chunked so the UI stays responsive with a live progress bar
  const handleExecute = useCallback(async () => {
    if (!targetsReady || liveMatchCount === 0 || !canEditInSession) return;

    const built = buildAction();
    // Refuse before touching a single entity — one bad value must not half-apply across the selection.
    if (!built.ok) {
      setValidationFailure(built);
      setRuntimeFailures([]);
      return setExecuteResult({ mutations: [], affectedEntityCount: 0, success: false });
    }
    const action = built.action;

    setIsExecuting(true);
    setExecuteResult(null);
    setValidationFailure(null);
    setRuntimeFailures([]);
    setExecuteProgress({ done: 0, total: 0 });
    executeCancelRef.current = false;
    const controller = new AbortController();
    executeAbortRef.current = controller;

    // Yield to paint the initial "Applying..." state
    await new Promise(r => setTimeout(r, 0));

    try {
      // Step 1: select matching IDs
      const ids = targetSource === 'query'
        ? await resolveBulkQueryIds(useViewerStore.getState(), selectedModelId, queryGroups, controller.signal)
        : null;
      const targets = ids
        ? ids.map((id) => ({ modelId: selectedModelId, id }))
        : [...targetGroups].flatMap(([modelId, group]) => group.map((id) => ({ modelId, id })));
      const total = targets.length;
      setExecuteProgress({ done: 0, total });

      const { result, failures } = await runBulkTargetBatches({
        targets,
        action,
        getEngine: (modelId) => targetSource === 'query' ? queryEngine : targetEngines.get(modelId),
        isCancelled: () => executeCancelRef.current,
        onProgress: (done, count) => setExecuteProgress({ done, total: count }),
        modelUnavailable: (modelId) => t('bulkPropertyEditor.modelUnavailable', { modelId }),
        entityError: (id, detail) => t('bulkPropertyEditor.entityError', {
          id, detail: detail ?? t('bulkPropertyEditor.unknownError'),
        }),
      });
      setExecuteResult(result);
      setRuntimeFailures(failures);
      if (result.success) setExecuteDirty(false);
    } catch (error) {
      if (controller.signal.aborted) {
        setExecuteResult({ mutations: [], affectedEntityCount: 0, success: false });
        setRuntimeFailures([{ kind: 'cancelled', done: 0, total: 0 }]);
        return;
      }
      console.error('Execute failed:', error);
      setExecuteResult({
        mutations: [],
        affectedEntityCount: 0,
        success: false,
        errors: [error instanceof Error ? error.message : t('bulkPropertyEditor.unknownError')],
      });
      setValidationFailure(null);
      setRuntimeFailures([{ kind: 'execute', detail: error instanceof Error ? error.message : undefined }]);
    } finally {
      if (executeAbortRef.current === controller) executeAbortRef.current = null;
      setIsExecuting(false);
      setExecuteProgress(null);
    }
  }, [queryEngine, targetEngines, targetGroups, targetSource, targetsReady,
    liveMatchCount, canEditInSession, queryGroups, buildAction, selectedModelId, t]);

  // Reset form
  const handleReset = useCallback(() => {
    setQueryFilterState({ groups: [emptyFilterGroup()], activeGroup: 0 });
    setTargetPset('');
    setTargetProp('');
    setTargetValue('');
    setPreviewResult(null);
    setExecuteResult(null);
    setValidationFailure(null);
    setRuntimeFailures([]);
    setExecuteDirty(true);
  }, []);

  // Scroll to bottom — double rAF ensures DOM is painted
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollAreaRef.current?.scrollTo({
          top: scrollAreaRef.current.scrollHeight,
          behavior: 'smooth',
        });
      });
    });
  }, []);

  // Auto-scroll when execute completes
  useEffect(() => {
    if (executeResult) scrollToBottom();
  }, [executeResult, scrollToBottom]);

  // Auto-scroll when progress first appears
  useEffect(() => {
    if (executeProgress && !prevProgressRef.current) scrollToBottom();
    prevProgressRef.current = executeProgress;
  }, [executeProgress, scrollToBottom]);

  // Mark config dirty when criteria or action settings change after a completed execute
  useEffect(() => {
    if (executeResult) { setExecuteDirty(true); setExecuteResult(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only fire on config changes
  }, [targetSource, targetGroups, selectedModelId, queryGroups, actionType, targetPset, targetProp, targetValue, valueType]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) { executeCancelRef.current = true; executeAbortRef.current?.abort(); }
      if (nextOpen) {
        const selection = useViewerStore.getState();
        setTargetSource(selection.models.size > 0
          && (selection.selectedEntityIds.size > 0 || selection.selectedEntityId !== null) ? 'selection' : 'query');
      }
    }}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Filter className="h-4 w-4 mr-2" />
            {t('bulkPropertyEditor.trigger')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0 border-b">
          <DialogTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            {t('bulkPropertyEditor.title')}
          </DialogTitle>
          <DialogDescription>
            {t('bulkPropertyEditor.description')}
          </DialogDescription>
        </DialogHeader>

        <div ref={scrollAreaRef} className="flex-1 overflow-y-auto px-6 py-4">
        <div className="space-y-6">
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('bulkPropertyEditor.targetSource')}</Label>
            <Select value={targetSource} onValueChange={(value) => setTargetSource(value as BulkTargetSource)}>
              <SelectTrigger aria-label={t('bulkPropertyEditor.targetSource')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="selection">{t('bulkPropertyEditor.sourceSelection')}</SelectItem>
                <SelectItem value="search">{t('bulkPropertyEditor.sourceSearch')}</SelectItem>
                <SelectItem value="query">{t('bulkPropertyEditor.sourceQuery')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Model selector */}
          {targetSource === 'query' && <Field label={t('bulkPropertyEditor.model')}>
            <Select value={selectedModelId} onValueChange={setSelectedModelId}>
              <SelectTrigger>
                <SelectValue placeholder={t('bulkPropertyEditor.selectModel')} />
              </SelectTrigger>
              <SelectContent>
                {modelList.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>}


          <Separator />

          {targetSource === 'query' && <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant={liveMatchCount ? 'default' : 'secondary'}>
                {isComputing && <Spinner size="xs" className="mr-1" />}
                {t('bulkPropertyEditor.matched', { count: liveMatchCount, countDisplay: formatLocaleNumber(locale, liveMatchCount) })}
              </Badge>
              {queryError && <span role="alert" className="text-sm text-destructive">{queryError}</span>}
            </div>
            {isExecuting ? <p className="text-xs text-muted-foreground">{t('bulkPropertyEditor.applying')}</p> : <FilterGroupEditor
              groups={queryGroups}
              activeGroup={queryFilterState.activeGroup}
              onChange={setQueryFilterState}
              models={modelList}
              optionModelId={selectedModelId === '__legacy__' ? undefined : selectedModelId}
              schemaVersion={selectedModel?.ifcDataStore?.schemaVersion}
            />}
          </div>}

          {targetSource !== 'query' && <Badge variant={liveMatchCount ? 'default' : 'secondary'}>
            {t('bulkPropertyEditor.matched', { count: liveMatchCount, countDisplay: formatLocaleNumber(locale, liveMatchCount) })}
          </Badge>}


          <Separator />

          {/* Action Configuration */}
          <div className="space-y-4">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Tag className="h-4 w-4" />
              {t('bulkPropertyEditor.action')}
            </Label>

            <BulkActionConfig
              actionType={actionType}
              onActionTypeChange={setActionType}
              targetPset={targetPset}
              onTargetPsetChange={setTargetPset}
              targetProp={targetProp}
              onTargetPropChange={setTargetProp}
              targetValue={targetValue}
              onTargetValueChange={setTargetValue}
              valueType={valueType}
              onValueTypeChange={setValueType}
              psetOptions={psetOptions}
              propOptions={propOptions}
            />
          </div>

          {/* Preview Result */}
          {previewResult && (
            <Alert variant={previewResult.matchedCount > 0 ? 'default' : 'destructive'}>
              <Eye className="h-4 w-4" />
              <AlertTitle>{t('bulkPropertyEditor.previewResult')}</AlertTitle>
              <AlertDescription>
                {previewResult.matchedCount > 0
                  ? t('bulkPropertyEditor.previewMatches', {
                      count: previewResult.matchedCount,
                      matches: formatLocaleNumber(locale, previewResult.matchedCount),
                      mutations: formatLocaleNumber(locale, previewResult.estimatedMutations),
                    })
                  : t('bulkPropertyEditor.previewNoMatches')}
              </AlertDescription>
            </Alert>
          )}

          {/* Execute Progress */}
          {isExecuting && executeProgress && <BulkExecutionProgress {...executeProgress} />}

          {/* Execute Result */}
          {executeResult && <BulkExecutionResult
            result={executeResult}
            validationFailure={validationFailure}
            runtimeFailures={runtimeFailures}
          />}
        </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 gap-2">
          {isExecuting ? (
            <Button variant="destructive" onClick={() => { executeCancelRef.current = true; executeAbortRef.current?.abort(); }}>
              {t('bulkPropertyEditor.cancel')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={handleReset}>
                {t('bulkPropertyEditor.reset')}
              </Button>
              <Button variant="secondary" onClick={handlePreview} disabled={!targetsReady}>
                <Eye className="h-4 w-4 mr-2" />
                {t('bulkPropertyEditor.preview')}
              </Button>
              <Button
                onClick={handleExecute}
                disabled={!canEditInSession || !targetsReady || liveMatchCount === 0 || !targetProp || (actionType !== 'SET_ATTRIBUTE' && !targetPset) || !executeDirty}
                title={editDenialReason ? t(mutationDenialKey(editDenialReason)) : undefined}
              >
                <Play className="h-4 w-4 mr-2" />
                {t('bulkPropertyEditor.apply', {
                  count: liveMatchCount,
                  countDisplay: formatLocaleNumber(locale, liveMatchCount),
                })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
