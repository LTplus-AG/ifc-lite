/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bulk Property Editor - Query builder UI for mass property updates
 * Full integration with BulkQueryEngine
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Search, Play, Eye, Filter, Plus, Trash2, Building2, Layers, Tag } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
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
import { roleCanEdit } from '@/store/slices/collabSlice';
import { useIfc } from '@/hooks/useIfc';
import { configureMutationView } from '@/utils/configureMutationView';
import { PropertyValueType } from '@ifc-lite/data';
import {
  BULK_WRITABLE_ATTRIBUTES,
  BulkQueryEngine,
  MutablePropertyView,
  type SelectionCriteria,
  type BulkAction,
  type FilterOperator,
  type PropertyFilter as BulkPropertyFilter,
  type BulkQueryPreview,
  type BulkQueryResult,
} from '@ifc-lite/mutations';
import { extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { FILTER_OPERATORS, IFC_TYPE_MAP, classTargetEnums, presentTypeEnums } from './bulk-property-editor-options';
import { defaultAuthoringModelId, recordRun } from '@/lib/model-placement/history';
import { parseBulkSetPropertyValue, type BulkParseResult } from './bulk-property-value';
import { BulkExecutionResult, type BulkRuntimeFailure } from './BulkExecutionResult';
import { BulkExecutionProgress } from './BulkExecutionProgress';

export { parseBulkSetPropertyValue } from './bulk-property-value';

interface PropertyFilterUI {
  id: string;
  psetName: string;
  propName: string;
  operator: FilterOperator;
  value: string;
}

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
  // Collab role gate, two layers deep. (1) canCollabEdit is injected into
  // BulkQueryEngine's constructor (mutation-guard.ts): bulk edits bypass the
  // store's own setProperty (and its check) via applyAction, so the engine
  // itself refuses a viewer/commenter write as containment. (2) canEditInSession
  // mirrors that check here, like MainToolbar/AuthorTab gate Edit mode, so
  // Execute stays disabled. Both read the shared `roleCanEdit` rule
  // canCollabEdit() is built from. null role = single-user, always editable.
  const canCollabEdit = useViewerStore((s) => s.canCollabEdit);
  const collabEditRole = useViewerStore((s) => s.collabRole);
  const canEditInSession = roleCanEdit(collabEditRole);
  // Also get legacy single-model state for backward compatibility
  const legacyIfcDataStore = useViewerStore((s) => s.ifcDataStore);
  const legacyGeometryResult = useViewerStore((s) => s.geometryResult);

  const [open, setOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>('');

  // Selection criteria
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [selectedStoreys, setSelectedStoreys] = useState<number[]>([]);
  const [namePattern, setNamePattern] = useState<string>('');
  const [filters, setFilters] = useState<PropertyFilterUI[]>([]);

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
    }));

    // If no models in Map but legacy data exists, add a synthetic entry
    if (list.length === 0 && legacyIfcDataStore) {
      list.push({
        id: '__legacy__',
        name: t('bulkPropertyEditor.currentModel'),
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

  // Loading state for initial dialog open computation
  const [isInitializing, setIsInitializing] = useState(false);

  // Storeys/types/typeEnum mapping — computed once on open, deferred so the dialog renders instantly.
  const [availableStoreys, setAvailableStoreys] = useState<{ id: number; name: string; elevation?: number }[]>([]);
  const [availableTypes, setAvailableTypes] = useState<{ ifcType: string; label: string }[]>([]);
  const typeNameToEnumsRef = useRef<Map<string, number[]>>(new Map());
  const [typeNameToEnums, setTypeNameToEnums] = useState<Map<string, number[]>>(new Map());
  const initTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (initTimerRef.current) clearTimeout(initTimerRef.current);

    if (!open || !selectedModel?.ifcDataStore) {
      setAvailableStoreys([]);
      setAvailableTypes([]);
      typeNameToEnumsRef.current = new Map();
      setTypeNameToEnums(new Map());
      return;
    }

    setIsInitializing(true);

    // Yield to browser so dialog shell + spinner paint first
    initTimerRef.current = setTimeout(() => {
      const dataStore = selectedModel.ifcDataStore;
      // The early return above already gates on `selectedModel?.ifcDataStore`,
      // but the closure-captured `selectedModel` reference is union-typed,
      // so re-narrow here for the timeout callback.
      if (!dataStore) {
        setIsInitializing(false);
        return;
      }
      const entities = dataStore.entities;

      // Storeys
      const storeys: { id: number; name: string; elevation?: number }[] = [];
      if (dataStore.spatialHierarchy) {
        const hierarchy = dataStore.spatialHierarchy;
        for (const [storeyId] of hierarchy.byStorey) {
          const name = entities.getName(storeyId) || t('bulkPropertyEditor.storeyFallback', { id: storeyId });
          const elevation = hierarchy.storeyElevations.get(storeyId);
          storeys.push({ id: storeyId, name, elevation });
        }
        storeys.sort((a, b) => (b.elevation ?? 0) - (a.elevation ?? 0));
      }

      // The classes present in the model as edited (#5249).
      const enumToTypeName = presentTypeEnums(entities, getMutationView(selectedModelId));

      const nameToEnums = new Map<string, number[]>();
      const presentTypes: { ifcType: string; label: string }[] = [];
      for (const [ifcType, { labelKey }] of Object.entries(IFC_TYPE_MAP)) {
        const enums = classTargetEnums(ifcType, enumToTypeName);
        if (enums.length > 0) {
          nameToEnums.set(ifcType, enums);
          presentTypes.push({ ifcType, label: t(labelKey) });
        }
      }

      setAvailableStoreys(storeys);
      setAvailableTypes(presentTypes);
      typeNameToEnumsRef.current = nameToEnums;
      setTypeNameToEnums(nameToEnums);
      setIsInitializing(false);
    }, 0);

    return () => {
      if (initTimerRef.current) clearTimeout(initTimerRef.current);
    };
  }, [open, selectedModel, selectedModelId, getMutationView, mutationViews, t, locale, revision]);

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
      dataStore.properties || null,
      dataStore.strings || null,
      canCollabEdit,
      dataStore.schemaVersion,
    );
  }, [open, selectedModel, selectedModelId, mutationViews, canCollabEdit]);

  // Build selection criteria using pre-computed typeEnum mapping (no entity scan needed)
  const currentCriteria = useMemo((): SelectionCriteria => {
    const criteria: SelectionCriteria = {};

    // Use pre-computed typeNameToEnums map instead of scanning all entities
    if (selectedTypes.length > 0) {
      const typeEnums: number[] = [];
      for (const selectedType of selectedTypes) {
        const enums = typeNameToEnums.get(selectedType);
        if (enums) {
          typeEnums.push(...enums);
        }
      }
      if (typeEnums.length > 0) {
        criteria.entityTypes = typeEnums;
      }
    }

    // Filter by storeys
    if (selectedStoreys.length > 0) {
      criteria.storeys = selectedStoreys;
    }

    // Filter by name pattern
    if (namePattern.trim()) {
      criteria.namePattern = namePattern;
    }

    // Add property filters
    const validFilters = filters.filter(f => f.propName);
    if (validFilters.length > 0) {
      criteria.propertyFilters = validFilters.map(f => {
        const filter: BulkPropertyFilter = {
          propName: f.propName,
          operator: f.operator,
        };
        if (f.psetName) {
          filter.psetName = f.psetName;
        }
        if (f.operator !== 'IS_NULL' && f.operator !== 'IS_NOT_NULL') {
          // Try to parse as number if it looks like one
          const numVal = parseFloat(f.value);
          filter.value = !isNaN(numVal) ? numVal : f.value;
        }
        return filter;
      });
    }

    return criteria;
  }, [selectedTypes, selectedStoreys, namePattern, filters, typeNameToEnums]);

  // Deferred: select + property discovery yield to the browser first so pill toggles paint instantly.
  const [isComputing, setIsComputing] = useState(false);
  const [matchResult, setMatchResult] = useState<{
    count: number;
    psets: Map<string, Set<string>>;
    allProps: Set<string>;
  }>({ count: 0, psets: new Map(), allProps: new Set() });

  // Timers for deferred work
  const selectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const discoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Cancel any in-flight work
    if (selectTimerRef.current) clearTimeout(selectTimerRef.current);
    if (discoveryTimerRef.current) clearTimeout(discoveryTimerRef.current);

    if (!queryEngine) {
      setIsComputing(false);
      setMatchResult({ count: 0, psets: new Map(), allProps: new Set() });
      return;
    }

    // Show spinner immediately — before any expensive work
    setIsComputing(true);

    // Yield to browser so the pill toggle paints, then run select()
    selectTimerRef.current = setTimeout(() => {
      let count = 0;
      let matchedIds: number[] = [];
      try {
        matchedIds = queryEngine.select(currentCriteria);
        count = matchedIds.length;
      } catch (err) {
        // A count of 0 must not be silently indistinguishable from a query
        // that FAILED — log it. Debounced per edit, not a hot path.
        console.warn('[bulk-edit] criteria query failed; showing 0 matches', err);
      }

      // Update count right away, keep old psets until discovery finishes
      setMatchResult(prev => ({ ...prev, count }));

      // Debounce property discovery (most expensive) by another 200ms
      const capturedIds = matchedIds;
      discoveryTimerRef.current = setTimeout(() => {
        const psets = new Map<string, Set<string>>();
        const allProps = new Set<string>();

        if (selectedModel?.ifcDataStore && capturedIds.length > 0) {
          const dataStore = selectedModel.ifcDataStore;
          const sampleIds = capturedIds.length > 100 ? capturedIds.slice(0, 100) : capturedIds;

          try {
            for (const entityId of sampleIds) {
              let properties: Array<{ name: string; properties: Array<{ name: string }> }> = [];

              if (dataStore.onDemandPropertyMap && dataStore.source?.length > 0) {
                properties = extractPropertiesOnDemand(dataStore as IfcDataStore, entityId);
              } else if (dataStore.properties) {
                properties = dataStore.properties.getForEntity(entityId);
              }

              for (const pset of properties) {
                if (!psets.has(pset.name)) {
                  psets.set(pset.name, new Set());
                }
                const propSet = psets.get(pset.name)!;
                for (const prop of pset.properties) {
                  propSet.add(prop.name);
                  allProps.add(prop.name);
                }
              }
            }
          } catch (e) {
            console.error('Error discovering properties:', e);
          }
        }

        setMatchResult({ count, psets, allProps });
        setIsComputing(false);
      }, 200);
    }, 0);

    return () => {
      if (selectTimerRef.current) clearTimeout(selectTimerRef.current);
      if (discoveryTimerRef.current) clearTimeout(discoveryTimerRef.current);
    };
  }, [queryEngine, currentCriteria, selectedModel]);

  const liveMatchCount = matchResult.count;
  const discoveredProperties = { psets: matchResult.psets, allProps: matchResult.allProps };

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

  // Add a new filter
  const addFilter = useCallback(() => {
    setFilters(prev => [...prev, {
      id: `filter_${Date.now()}`,
      psetName: '',
      propName: '',
      operator: '=' as FilterOperator,
      value: '',
    }]);
  }, []);

  // Remove a filter
  const removeFilter = useCallback((id: string) => {
    setFilters(prev => prev.filter(f => f.id !== id));
  }, []);

  // Update a filter
  const updateFilter = useCallback((id: string, field: keyof PropertyFilterUI, value: string) => {
    setFilters(prev => prev.map(f =>
      f.id === id ? { ...f, [field]: value } : f
    ));
  }, []);

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
    if (!queryEngine) return;

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
      const result = queryEngine.preview({ select: currentCriteria, action: built.action });
      setPreviewResult(result);
    } catch (error) {
      console.error('Preview failed:', error);
      setPreviewResult({ matchedEntityIds: [], matchedCount: 0, estimatedMutations: 0 });
    }
  }, [queryEngine, currentCriteria, buildAction]);

  // Execute bulk update — chunked so the UI stays responsive with a live progress bar
  const handleExecute = useCallback(async () => {
    if (!queryEngine || liveMatchCount === 0 || !canEditInSession) return;

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

    // Yield to paint the initial "Applying..." state
    await new Promise(r => setTimeout(r, 0));

    try {
      // Step 1: select matching IDs
      const entityIds = queryEngine.select(currentCriteria);
      const total = entityIds.length;
      setExecuteProgress({ done: 0, total });

      // Step 2: chunked mutation — process CHUNK_SIZE entities then yield to browser
      const CHUNK_SIZE = 500;
      const mutations: import('@ifc-lite/mutations').BulkQueryResult['mutations'] = [];
      const errors: string[] = [];
      const failures: BulkRuntimeFailure[] = [];

      let processed = 0;
      // The engine writes straight to the view: record each chunk as it lands (#5861, #5958).
      const record = recordRun(useViewerStore.getState, selectedModelId);
      for (let i = 0; i < total; i += CHUNK_SIZE) {
        if (executeCancelRef.current) break;

        const end = Math.min(i + CHUNK_SIZE, total);
        const chunk: typeof mutations = [];
        for (let j = i; j < end; j++) {
          try {
            const mutation = queryEngine.applyAction(entityIds[j], action);
            if (mutation) chunk.push(mutation);
          } catch (error) {
            const detail = error instanceof Error ? error.message : undefined;
            errors.push(t('bulkPropertyEditor.entityError', {
              id: entityIds[j],
              detail: detail ?? t('bulkPropertyEditor.unknownError'),
            }));
            failures.push({ kind: 'entity', id: entityIds[j], detail });
          }
        }

        mutations.push(...chunk);
        record(chunk);

        processed = end;
        setExecuteProgress({ done: end, total });
        // Yield to browser so progress bar and spinner update
        await new Promise(r => setTimeout(r, 0));
      }

      const cancelled = executeCancelRef.current && processed < total; // a cancel in the last yield stopped nothing (#5958)
      if (cancelled) failures.push({ kind: 'cancelled', done: processed, total });
      const result: BulkQueryResult = {
        mutations,
        affectedEntityCount: mutations.length,
        success: errors.length === 0 && !cancelled,
        errors: errors.length > 0 ? errors : undefined,
      };
      setExecuteResult(result);
      setRuntimeFailures(failures);
      if (result.success) setExecuteDirty(false);
    } catch (error) {
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
      setIsExecuting(false);
      setExecuteProgress(null);
    }
  }, [queryEngine, liveMatchCount, canEditInSession, currentCriteria, buildAction, selectedModelId, t]);

  // Reset form
  const handleReset = useCallback(() => {
    setSelectedTypes([]);
    setSelectedStoreys([]);
    setNamePattern('');
    setFilters([]);
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
  }, [selectedTypes, selectedStoreys, namePattern, filters, actionType, targetPset, targetProp, targetValue, valueType]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
        {isInitializing ? (
          <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
            <Spinner size="lg" />
            <span className="text-sm">{t('bulkPropertyEditor.loading')}</span>
          </div>
        ) : (
        <div className="space-y-6">
          {/* Model selector */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('bulkPropertyEditor.model')}</Label>
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
          </div>

          <Separator />

          {/* Selection Criteria */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium flex items-center gap-2">
                <Search className="h-4 w-4" />
                {t('bulkPropertyEditor.selectionCriteria')}
              </Label>
              <Badge variant={liveMatchCount > 0 ? 'default' : 'secondary'} className="text-xs">
                {isComputing && <Spinner size="xs" className="mr-1" />}
                {t('bulkPropertyEditor.matched', {
                  count: liveMatchCount,
                  countDisplay: formatLocaleNumber(locale, liveMatchCount),
                })}
              </Badge>
            </div>

            {/* Entity type filter */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t('bulkPropertyEditor.entityTypes')}</Label>
              <div className="flex flex-wrap gap-1">
                {availableTypes.length > 0 ? (
                  availableTypes.map(({ ifcType, label }) => (
                    <Badge
                      key={ifcType}
                      variant={selectedTypes.includes(ifcType) ? 'default' : 'outline'}
                      className="cursor-pointer text-xs"
                      onClick={() => {
                        setSelectedTypes(prev =>
                          prev.includes(ifcType)
                            ? prev.filter(t => t !== ifcType)
                            : [...prev, ifcType]
                        );
                      }}
                    >
                      <Building2 className="h-3 w-3 mr-1" />
                      {label}
                    </Badge>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">{t('bulkPropertyEditor.noTypes')}</span>
                )}
              </div>
            </div>

            {/* Storey filter */}
            {availableStoreys.length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">{t('bulkPropertyEditor.storeys')}</Label>
                <div className="flex flex-wrap gap-1">
                  {availableStoreys.map((storey) => (
                    <Badge
                      key={storey.id}
                      variant={selectedStoreys.includes(storey.id) ? 'default' : 'outline'}
                      className="cursor-pointer text-xs"
                      onClick={() => {
                        setSelectedStoreys(prev =>
                          prev.includes(storey.id)
                            ? prev.filter(s => s !== storey.id)
                            : [...prev, storey.id]
                        );
                      }}
                    >
                      <Layers className="h-3 w-3 mr-1" />
                      {storey.name}
                      {storey.elevation !== undefined && (
                        <span className="ml-1 opacity-60">
                          {t('bulkPropertyEditor.storeyElevation', {
                            sign: storey.elevation >= 0 ? '+' : '',
                            value: formatLocaleNumber(locale, storey.elevation, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
                          })}
                        </span>
                      )}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Name pattern filter */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t('bulkPropertyEditor.namePattern')}</Label>
              <Input
                placeholder={t('bulkPropertyEditor.namePatternPlaceholder')}
                value={namePattern}
                onChange={(e) => setNamePattern(e.target.value)}
                className="h-8 text-sm"
              />
            </div>

            {/* Property filters */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">{t('bulkPropertyEditor.propertyFilters')}</Label>
                <Button variant="ghost" size="sm" onClick={addFilter}>
                  <Plus className="h-3 w-3 mr-1" />
                  {t('bulkPropertyEditor.addFilter')}
                </Button>
              </div>
              {filters.map((filter) => (
                <div key={filter.id} className="flex items-center gap-2 p-2 border rounded-md bg-muted/30">
                  <Input
                    placeholder={t('bulkPropertyEditor.psetOptional')}
                    value={filter.psetName}
                    onChange={(e) => updateFilter(filter.id, 'psetName', e.target.value)}
                    className="h-8 text-xs w-28"
                  />
                  <Input
                    placeholder={t('bulkPropertyEditor.propertyName')}
                    value={filter.propName}
                    onChange={(e) => updateFilter(filter.id, 'propName', e.target.value)}
                    className="h-8 text-xs flex-1"
                  />
                  <Select
                    value={filter.operator}
                    onValueChange={(v) => updateFilter(filter.id, 'operator', v)}
                  >
                    <SelectTrigger className="h-8 w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FILTER_OPERATORS.map((op) => (
                        <SelectItem key={op.value} value={op.value}>{t(op.labelKey)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {filter.operator !== 'IS_NULL' && filter.operator !== 'IS_NOT_NULL' && (
                    <Input
                      placeholder={t('bulkPropertyEditor.value')}
                      value={filter.value}
                      onChange={(e) => updateFilter(filter.id, 'value', e.target.value)}
                      className="h-8 text-xs w-20"
                    />
                  )}
                  <IconButton label={t('bulkPropertyEditor.removeFilter')} className="h-8 w-8" onClick={() => removeFilter(filter.id)}>
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </IconButton>
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* Action Configuration */}
          <div className="space-y-4">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Tag className="h-4 w-4" />
              {t('bulkPropertyEditor.action')}
            </Label>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">{t('bulkPropertyEditor.actionType')}</Label>
                <Select value={actionType} onValueChange={(v) => { if ((v === 'SET_ATTRIBUTE') !== (actionType === 'SET_ATTRIBUTE')) setTargetProp(''); setActionType(v as ActionType); }}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SET_PROPERTY">{t('bulkPropertyEditor.setProperty')}</SelectItem>
                    <SelectItem value="DELETE_PROPERTY">{t('bulkPropertyEditor.deleteProperty')}</SelectItem>
                    <SelectItem value="SET_ATTRIBUTE">{t('bulkPropertyEditor.setAttribute')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {actionType !== 'SET_ATTRIBUTE' && (
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    {t('bulkPropertyEditor.propertySet')}
                    {psetOptions.length > 0 && (
                      <span className="ml-1 text-muted-foreground">
                        {t('bulkPropertyEditor.found', { count: psetOptions.length, countDisplay: formatLocaleNumber(locale, psetOptions.length) })}
                      </span>
                    )}
                  </Label>
                  <Input
                    list="pset-options"
                    placeholder={t('bulkPropertyEditor.psetPlaceholder')}
                    value={targetPset}
                    onChange={(e) => setTargetPset(e.target.value)}
                  />
                  <datalist id="pset-options">
                    {psetOptions.map((pset) => (
                      <option key={pset} value={pset} />
                    ))}
                  </datalist>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  {actionType === 'SET_ATTRIBUTE' ? t('bulkPropertyEditor.attribute') : t('bulkPropertyEditor.propertyNameLabel')}
                  {actionType !== 'SET_ATTRIBUTE' && propOptions.length > 0 && (
                    <span className="ml-1 text-muted-foreground">
                      {t('bulkPropertyEditor.found', { count: propOptions.length, countDisplay: formatLocaleNumber(locale, propOptions.length) })}
                    </span>
                  )}
                </Label>
                {actionType === 'SET_ATTRIBUTE' ? (
                  <Select value={targetProp} onValueChange={setTargetProp}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('bulkPropertyEditor.selectAttribute')} />
                    </SelectTrigger>
                    <SelectContent>
                      {/* Exact EXPRESS names, never translated or aliased; the engine's own list (#5867). */}
                      {BULK_WRITABLE_ATTRIBUTES.map((attribute) => (
                        <SelectItem key={attribute} value={attribute}>{attribute}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <>
                    <Input
                      list="prop-options"
                      placeholder={t('bulkPropertyEditor.propertyPlaceholder')}
                      value={targetProp}
                      onChange={(e) => setTargetProp(e.target.value)}
                    />
                    <datalist id="prop-options">
                      {propOptions.map((prop) => (
                        <option key={prop} value={prop} />
                      ))}
                    </datalist>
                  </>
                )}
              </div>

              {actionType !== 'DELETE_PROPERTY' && (
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">{t('bulkPropertyEditor.newValue')}</Label>
                  <Input
                    placeholder={t('bulkPropertyEditor.value')}
                    value={targetValue}
                    onChange={(e) => setTargetValue(e.target.value)}
                  />
                </div>
              )}
            </div>

            {actionType === 'SET_PROPERTY' && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">{t('bulkPropertyEditor.valueType')}</Label>
                <Select
                  value={valueType.toString()}
                  onValueChange={(v) => setValueType(parseInt(v) as PropertyValueType)}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={PropertyValueType.String.toString()}>{t('bulkPropertyEditor.string')}</SelectItem>
                    <SelectItem value={PropertyValueType.Real.toString()}>{t('bulkPropertyEditor.real')}</SelectItem>
                    <SelectItem value={PropertyValueType.Integer.toString()}>{t('bulkPropertyEditor.integer')}</SelectItem>
                    <SelectItem value={PropertyValueType.Boolean.toString()}>{t('bulkPropertyEditor.boolean')}</SelectItem>
                    <SelectItem value={PropertyValueType.Label.toString()}>{t('bulkPropertyEditor.label')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
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
        )}
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 gap-2">
          {isExecuting ? (
            <Button variant="destructive" onClick={() => { executeCancelRef.current = true; }}>
              {t('bulkPropertyEditor.cancel')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={handleReset}>
                {t('bulkPropertyEditor.reset')}
              </Button>
              <Button variant="secondary" onClick={handlePreview} disabled={!queryEngine}>
                <Eye className="h-4 w-4 mr-2" />
                {t('bulkPropertyEditor.preview')}
              </Button>
              <Button
                onClick={handleExecute}
                disabled={!canEditInSession || liveMatchCount === 0 || !targetProp || (actionType !== 'SET_ATTRIBUTE' && !targetPset) || !executeDirty}
                title={canEditInSession ? undefined : t('bulkPropertyEditor.editorAccessRequired')}
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
