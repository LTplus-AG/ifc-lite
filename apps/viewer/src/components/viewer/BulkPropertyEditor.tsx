/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bulk Property Editor - Query builder UI for mass property updates
 * Full integration with BulkQueryEngine
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  Search,
  Play,
  Eye,
  Filter,
  Plus,
  Trash2,
  Check,
  AlertCircle,
  Loader2,
  Building2,
  Layers,
  Tag,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { configureMutationView } from '@/utils/configureMutationView';
import { PropertyValueType } from '@ifc-lite/data';
import {
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

// Common IFC type enum IDs (from IFC schema)
// These correspond to the typeEnum values in EntityTable
const IFC_TYPE_MAP: Record<string, { label: string; pattern: string }> = {
  'IfcWall': { label: 'Wall', pattern: 'Wall' },
  'IfcWallStandardCase': { label: 'Wall (Standard)', pattern: 'WallStandardCase' },
  'IfcDoor': { label: 'Door', pattern: 'Door' },
  'IfcWindow': { label: 'Window', pattern: 'Window' },
  'IfcSlab': { label: 'Slab', pattern: 'Slab' },
  'IfcColumn': { label: 'Column', pattern: 'Column' },
  'IfcBeam': { label: 'Beam', pattern: 'Beam' },
  'IfcRoof': { label: 'Roof', pattern: 'Roof' },
  'IfcStair': { label: 'Stair', pattern: 'Stair' },
  'IfcRailing': { label: 'Railing', pattern: 'Railing' },
  'IfcCurtainWall': { label: 'Curtain Wall', pattern: 'CurtainWall' },
  'IfcCovering': { label: 'Covering', pattern: 'Covering' },
  'IfcPlate': { label: 'Plate', pattern: 'Plate' },
  'IfcMember': { label: 'Member', pattern: 'Member' },
  'IfcFurnishingElement': { label: 'Furniture', pattern: 'Furnishing' },
  'IfcBuildingElementProxy': { label: 'Proxy', pattern: 'BuildingElementProxy' },
  'IfcSpace': { label: 'Space', pattern: 'Space' },
  'IfcOpeningElement': { label: 'Opening', pattern: 'Opening' },
};

const FILTER_OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: '=', label: 'Equals' },
  { value: '!=', label: 'Not equals' },
  { value: '>', label: 'Greater than' },
  { value: '<', label: 'Less than' },
  { value: '>=', label: 'Greater or equal' },
  { value: '<=', label: 'Less or equal' },
  { value: 'CONTAINS', label: 'Contains' },
  { value: 'STARTS_WITH', label: 'Starts with' },
  { value: 'IS_NULL', label: 'Is empty' },
  { value: 'IS_NOT_NULL', label: 'Is not empty' },
];

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
  const { models } = useIfc();
  const getMutationView = useViewerStore((s) => s.getMutationView);
  const registerMutationView = useViewerStore((s) => s.registerMutationView);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);
  // Subscribe to mutationViews directly to trigger re-render when views are registered
  const mutationViews = useViewerStore((s) => s.mutationViews);
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
        name: 'Current Model',
      });
    }

    return list;
  }, [open, models, legacyIfcDataStore]);

  // Auto-select first model when dialog opens
  useEffect(() => {
    if (open && modelList.length > 0 && !selectedModelId) {
      setSelectedModelId(modelList[0].id);
    }
  }, [open, modelList, selectedModelId]);

  // Get selected model's data - supports both federated and legacy mode
  const selectedModel = useMemo(() => {
    if (!open) return undefined;
    if (selectedModelId === '__legacy__' && legacyIfcDataStore && legacyGeometryResult) {
      // Return a synthetic FederatedModel-like object for legacy mode
      return {
        id: '__legacy__',
        name: 'Current Model',
        ifcDataStore: legacyIfcDataStore,
        geometryResult: legacyGeometryResult,
        visible: true,
        collapsed: false,
      };
    }
    return models.get(selectedModelId);
  }, [open, models, selectedModelId, legacyIfcDataStore, legacyGeometryResult]);

  // Loading state for initial dialog open computation
  const [isInitializing, setIsInitializing] = useState(false);

  // Get storeys, available types, and typeEnum mapping — computed once on dialog open,
  // deferred via setTimeout so the dialog shell renders instantly with a spinner.
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
          const name = entities.getName(storeyId) || `Storey #${storeyId}`;
          const elevation = hierarchy.storeyElevations.get(storeyId);
          storeys.push({ id: storeyId, name, elevation });
        }
        storeys.sort((a, b) => (b.elevation ?? 0) - (a.elevation ?? 0));
      }

      // Type enum mapping — single pass
      const enumToTypeName = new Map<number, string>();
      for (let i = 0; i < entities.count; i++) {
        const typeEnum = entities.typeEnum[i];
        if (enumToTypeName.has(typeEnum)) continue;
        const expressId = entities.expressId[i];
        const typeName = entities.getTypeName(expressId);
        if (typeName) {
          enumToTypeName.set(typeEnum, typeName);
        }
      }

      const nameToEnums = new Map<string, number[]>();
      const presentTypes: { ifcType: string; label: string }[] = [];
      for (const [ifcType, { label, pattern }] of Object.entries(IFC_TYPE_MAP)) {
        const enums: number[] = [];
        for (const [typeEnum, typeName] of enumToTypeName) {
          if (typeName.includes(pattern)) {
            enums.push(typeEnum);
          }
        }
        if (enums.length > 0) {
          nameToEnums.set(ifcType, enums);
          presentTypes.push({ ifcType, label });
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
  }, [open, selectedModel]);

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
      dataStore.strings || null
    );
  }, [open, selectedModel, selectedModelId, mutationViews]);

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

  // Deferred computation: all expensive work (select + property discovery) yields to the
  // browser first so pill toggles paint instantly, then runs via setTimeout(0).
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
      } catch {
        // leave at 0
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

  // Build action for the query engine
  const buildAction = useCallback((): BulkAction => {
    if (actionType === 'SET_PROPERTY') {
      // Parse value based on type
      let parsedValue: string | number | boolean = targetValue;
      if (valueType === PropertyValueType.Real) {
        parsedValue = parseFloat(targetValue) || 0;
      } else if (valueType === PropertyValueType.Integer) {
        parsedValue = parseInt(targetValue, 10) || 0;
      } else if (valueType === PropertyValueType.Boolean) {
        parsedValue = targetValue.toLowerCase() === 'true' || targetValue === '1';
      }

      return {
        type: 'SET_PROPERTY',
        psetName: targetPset,
        propName: targetProp,
        value: parsedValue,
        valueType,
      };
    } else if (actionType === 'DELETE_PROPERTY') {
      return {
        type: 'DELETE_PROPERTY',
        psetName: targetPset,
        propName: targetProp,
      };
    } else {
      return {
        type: 'SET_ATTRIBUTE',
        attribute: targetProp as 'name' | 'description' | 'objectType',
        value: targetValue,
      };
    }
  }, [actionType, targetPset, targetProp, targetValue, valueType]);

  // Preview query
  const handlePreview = useCallback(() => {
    if (!queryEngine) return;

    setPreviewResult(null);
    setExecuteResult(null);

    try {
      const action = buildAction();
      const result = queryEngine.preview({ select: currentCriteria, action });
      setPreviewResult(result);
    } catch (error) {
      console.error('Preview failed:', error);
      setPreviewResult({ matchedEntityIds: [], matchedCount: 0, estimatedMutations: 0 });
    }
  }, [queryEngine, currentCriteria, buildAction]);

  // Execute bulk update — chunked so the UI stays responsive with a live progress bar
  const handleExecute = useCallback(async () => {
    if (!queryEngine || liveMatchCount === 0) return;

    setIsExecuting(true);
    setExecuteResult(null);
    setExecuteProgress({ done: 0, total: 0 });
    executeCancelRef.current = false;

    // Yield to paint the initial "Applying..." state
    await new Promise(r => setTimeout(r, 0));

    try {
      const action = buildAction();

      // Step 1: select matching IDs
      const entityIds = queryEngine.select(currentCriteria);
      const total = entityIds.length;
      setExecuteProgress({ done: 0, total });

      // Step 2: chunked mutation — process CHUNK_SIZE entities then yield to browser
      const CHUNK_SIZE = 500;
      const mutations: import('@ifc-lite/mutations').BulkQueryResult['mutations'] = [];
      const errors: string[] = [];

      for (let i = 0; i < total; i += CHUNK_SIZE) {
        if (executeCancelRef.current) break;

        const end = Math.min(i + CHUNK_SIZE, total);
        for (let j = i; j < end; j++) {
          try {
            const mutation = queryEngine.applyAction(entityIds[j], action);
            if (mutation) mutations.push(mutation);
          } catch (error) {
            errors.push(`Entity ${entityIds[j]}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }

        setExecuteProgress({ done: end, total });
        // Yield to browser so progress bar and spinner update
        await new Promise(r => setTimeout(r, 0));
      }

      const result: BulkQueryResult = {
        mutations,
        affectedEntityCount: mutations.length,
        success: errors.length === 0 && !executeCancelRef.current,
        errors: errors.length > 0 ? errors : undefined,
      };
      setExecuteResult(result);
      if (result.success) setExecuteDirty(false);

      if (result.mutations.length > 0) {
        bumpMutationVersion();
      }
    } catch (error) {
      console.error('Execute failed:', error);
      setExecuteResult({
        mutations: [],
        affectedEntityCount: 0,
        success: false,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
      });
    } finally {
      setIsExecuting(false);
      setExecuteProgress(null);
    }
  }, [queryEngine, liveMatchCount, currentCriteria, buildAction, bumpMutationVersion]);

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
    if (executeResult) setExecuteDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only fire on config changes
  }, [selectedTypes, selectedStoreys, namePattern, filters, actionType, targetPset, targetProp, targetValue, valueType]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Filter className="h-4 w-4 mr-2" />
            Bulk Edit
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0 border-b">
          <DialogTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Bulk Property Editor
          </DialogTitle>
          <DialogDescription>
            Select entities by type, storey, or property values, then apply changes to all matching elements
          </DialogDescription>
        </DialogHeader>

        <div ref={scrollAreaRef} className="flex-1 overflow-y-auto px-6 py-4">
        {isInitializing ? (
          <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading model data...</span>
          </div>
        ) : (
        <div className="space-y-6">
          {/* Model selector */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Model</Label>
            <Select value={selectedModelId} onValueChange={setSelectedModelId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a model" />
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
                Selection Criteria
              </Label>
              <Badge variant={liveMatchCount > 0 ? 'default' : 'secondary'} className="text-xs">
                {isComputing && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                {liveMatchCount} {liveMatchCount === 1 ? 'entity' : 'entities'} matched
              </Badge>
            </div>

            {/* Entity type filter */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Entity Types</Label>
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
                  <span className="text-xs text-muted-foreground">Load a model to see available types</span>
                )}
              </div>
            </div>

            {/* Storey filter */}
            {availableStoreys.length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Storeys</Label>
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
                          ({storey.elevation >= 0 ? '+' : ''}{storey.elevation.toFixed(1)}m)
                        </span>
                      )}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Name pattern filter */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Name Pattern (Regex)</Label>
              <Input
                placeholder="e.g., Wall-.*-Exterior"
                value={namePattern}
                onChange={(e) => setNamePattern(e.target.value)}
                className="h-8 text-sm"
              />
            </div>

            {/* Property filters */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Property Filters</Label>
                <Button variant="ghost" size="sm" onClick={addFilter}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add Filter
                </Button>
              </div>
              {filters.map((filter) => (
                <div key={filter.id} className="flex items-center gap-2 p-2 border rounded-md bg-muted/30">
                  <Input
                    placeholder="Pset (optional)"
                    value={filter.psetName}
                    onChange={(e) => updateFilter(filter.id, 'psetName', e.target.value)}
                    className="h-8 text-xs w-28"
                  />
                  <Input
                    placeholder="Property name"
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
                        <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {filter.operator !== 'IS_NULL' && filter.operator !== 'IS_NOT_NULL' && (
                    <Input
                      placeholder="Value"
                      value={filter.value}
                      onChange={(e) => updateFilter(filter.id, 'value', e.target.value)}
                      className="h-8 text-xs w-20"
                    />
                  )}
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeFilter(filter.id)}>
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* Action Configuration */}
          <div className="space-y-4">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Tag className="h-4 w-4" />
              Action
            </Label>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Action Type</Label>
                <Select value={actionType} onValueChange={(v) => setActionType(v as ActionType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SET_PROPERTY">Set Property</SelectItem>
                    <SelectItem value="DELETE_PROPERTY">Delete Property</SelectItem>
                    <SelectItem value="SET_ATTRIBUTE">Set Attribute</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {actionType !== 'SET_ATTRIBUTE' && (
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    Property Set
                    {psetOptions.length > 0 && (
                      <span className="ml-1 text-muted-foreground/60">
                        ({psetOptions.length} found)
                      </span>
                    )}
                  </Label>
                  <Input
                    list="pset-options"
                    placeholder="e.g., Pset_WallCommon"
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
                  {actionType === 'SET_ATTRIBUTE' ? 'Attribute' : 'Property Name'}
                  {actionType !== 'SET_ATTRIBUTE' && propOptions.length > 0 && (
                    <span className="ml-1 text-muted-foreground/60">
                      ({propOptions.length} found)
                    </span>
                  )}
                </Label>
                {actionType === 'SET_ATTRIBUTE' ? (
                  <Select value={targetProp} onValueChange={setTargetProp}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select attribute" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="name">Name</SelectItem>
                      <SelectItem value="description">Description</SelectItem>
                      <SelectItem value="objectType">ObjectType</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <>
                    <Input
                      list="prop-options"
                      placeholder="e.g., FireRating"
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
                  <Label className="text-xs text-muted-foreground">New Value</Label>
                  <Input
                    placeholder="Value"
                    value={targetValue}
                    onChange={(e) => setTargetValue(e.target.value)}
                  />
                </div>
              )}
            </div>

            {actionType === 'SET_PROPERTY' && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Value Type</Label>
                <Select
                  value={valueType.toString()}
                  onValueChange={(v) => setValueType(parseInt(v) as PropertyValueType)}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={PropertyValueType.String.toString()}>String</SelectItem>
                    <SelectItem value={PropertyValueType.Real.toString()}>Real</SelectItem>
                    <SelectItem value={PropertyValueType.Integer.toString()}>Integer</SelectItem>
                    <SelectItem value={PropertyValueType.Boolean.toString()}>Boolean</SelectItem>
                    <SelectItem value={PropertyValueType.Label.toString()}>Label</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Preview Result */}
          {previewResult && (
            <Alert variant={previewResult.matchedCount > 0 ? 'default' : 'destructive'}>
              <Eye className="h-4 w-4" />
              <AlertTitle>Preview Result</AlertTitle>
              <AlertDescription>
                {previewResult.matchedCount > 0
                  ? `${previewResult.matchedCount} entities match your criteria (${previewResult.estimatedMutations} mutations)`
                  : 'No entities match your criteria'}
              </AlertDescription>
            </Alert>
          )}

          {/* Execute Progress */}
          {isExecuting && executeProgress && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Applying changes...
                </span>
                <span>
                  {executeProgress.done.toLocaleString()} / {executeProgress.total.toLocaleString()} entities
                </span>
              </div>
              <Progress value={executeProgress.total > 0 ? (executeProgress.done / executeProgress.total) * 100 : 0} />
            </div>
          )}

          {/* Execute Result */}
          {executeResult && (
            <Alert variant={executeResult.success ? 'default' : 'destructive'}>
              {executeResult.success ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
              <AlertTitle>{executeResult.success ? 'Success' : 'Error'}</AlertTitle>
              <AlertDescription>
                {executeResult.success
                  ? `Applied ${executeResult.mutations.length.toLocaleString()} mutations to ${executeResult.affectedEntityCount.toLocaleString()} entities`
                  : executeResult.errors?.join(', ') || 'Unknown error'}
              </AlertDescription>
            </Alert>
          )}
        </div>
        )}
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 gap-2">
          {isExecuting ? (
            <Button variant="destructive" onClick={() => { executeCancelRef.current = true; }}>
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={handleReset}>
                Reset
              </Button>
              <Button variant="secondary" onClick={handlePreview} disabled={!queryEngine}>
                <Eye className="h-4 w-4 mr-2" />
                Preview
              </Button>
              <Button
                onClick={handleExecute}
                disabled={liveMatchCount === 0 || !targetProp || (actionType !== 'SET_ATTRIBUTE' && !targetPset) || !executeDirty}
              >
                <Play className="h-4 w-4 mr-2" />
                Apply to {liveMatchCount} entities
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
