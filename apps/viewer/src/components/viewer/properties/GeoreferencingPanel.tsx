/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Georeferencing panel - displays and allows editing of IfcProjectedCRS
 * and IfcMapConversion entities with field-specific editing assistance.
 */

import { useState, useCallback, useMemo } from 'react';
import { Globe, MapPin, PenLine, Check, X, Search, ChevronRight, Mountain } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { computeAngleToGridNorth, type GeoreferenceInfo, type MapConversion, type ProjectedCRS } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { EpsgLookupDialog, type EpsgResult } from './EpsgLookupDialog';
import { LocationMap, type PickedPosition } from './LocationMap';
import { mergeMapConversion, mergeProjectedCRS } from '@/lib/geo/effective-georef';
import { useIfc } from '@/hooks/useIfc';
import { toast } from '@/components/ui/toast';

// ── Field-specific assistance data ─────────────────────────────────────

const COMMON_DATUMS = ['WGS84', 'ETRS89', 'NAD83', 'NAD27', 'GRS80', 'Bessel 1841', 'Clarke 1866'];
const COMMON_PROJECTIONS = ['Transverse Mercator', 'UTM', 'Lambert Conformal Conic', 'Mercator', 'Stereographic', 'Oblique Mercator'];
const MAP_UNITS = ['METRE', 'FOOT', 'US SURVEY FOOT'];
const COMMON_VERTICAL_DATUMS = ['MSL', 'NAVD88', 'EVRF2007', 'EVRF2019', 'AHD', 'ODN', 'LN02'];

type FieldHint = {
  placeholder?: string;
  suggestions?: string[];
  isSelect?: boolean;
  helpText?: string;
};

function getFieldHint(entity: string, field: string): FieldHint {
  if (entity === 'projectedCRS') {
    switch (field) {
      case 'name': return { placeholder: 'e.g. EPSG:4326', helpText: 'Use EPSG lookup to search' };
      case 'description': return { placeholder: 'e.g. WGS 84 / UTM zone 32N' };
      case 'geodeticDatum': return { placeholder: 'e.g. WGS84', suggestions: COMMON_DATUMS };
      case 'verticalDatum': return { placeholder: 'e.g. MSL', suggestions: COMMON_VERTICAL_DATUMS };
      case 'mapProjection': return { placeholder: 'e.g. Transverse Mercator', suggestions: COMMON_PROJECTIONS };
      case 'mapZone': return { placeholder: 'e.g. 32N' };
      case 'mapUnit': return { isSelect: true, suggestions: MAP_UNITS };
      default: return {};
    }
  }
  if (entity === 'mapConversion') {
    switch (field) {
      case 'eastings': return { placeholder: '0.0', helpText: 'X offset in map units' };
      case 'northings': return { placeholder: '0.0', helpText: 'Y offset in map units' };
      case 'orthogonalHeight': return { placeholder: '0.0', helpText: 'Z offset in metres' };
      case 'xAxisAbscissa': return { placeholder: '1.0', helpText: 'cos(angle to grid north)' };
      case 'xAxisOrdinate': return { placeholder: '0.0', helpText: 'sin(angle to grid north)' };
      case 'scale': return { placeholder: '1.0', helpText: 'Usually 1.0 or close to it' };
      default: return {};
    }
  }
  return {};
}

// ── GeorefRow: a single editable field ─────────────────────────────────

interface GeorefRowProps {
  label: string;
  value: string | number | undefined | null;
  suffix?: string;
  isComputed?: boolean;
  isNumber?: boolean;
  editable?: boolean;
  isMutated?: boolean;
  fieldEntity?: string;
  fieldName?: string;
  onSave?: (value: string | number) => void;
  /** Extra inline content rendered after the value (e.g. terrain height button) */
  children?: React.ReactNode;
}

function GeorefRow({ label, value, suffix, isComputed, isNumber, editable, isMutated, fieldEntity, fieldName, onSave, children }: GeorefRowProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const hint = useMemo(() => getFieldHint(fieldEntity ?? '', fieldName ?? ''), [fieldEntity, fieldName]);

  const startEdit = useCallback(() => {
    if (!editable || isComputed) return;
    setEditValue(value != null ? String(value) : '');
    setEditing(true);
  }, [value, editable, isComputed]);

  const commitEdit = useCallback((overrideValue?: string) => {
    if (!onSave) { setEditing(false); return; }
    const trimmed = (overrideValue ?? editValue).trim();
    if (!trimmed && !hint.isSelect) { setEditing(false); return; }
    if (isNumber) {
      const num = parseFloat(trimmed);
      if (!Number.isFinite(num)) { setEditing(false); return; }
      onSave(num);
    } else {
      onSave(trimmed);
    }
    setEditing(false);
  }, [editValue, isNumber, onSave, hint.isSelect]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') cancelEdit();
  }, [commitEdit, cancelEdit]);

  const selectSuggestion = useCallback((s: string) => {
    if (!onSave) return;
    if (isNumber) {
      const num = parseFloat(s);
      if (Number.isFinite(num)) onSave(num);
    } else {
      onSave(s);
    }
    setEditing(false);
  }, [onSave, isNumber]);

  const displayValue = value != null ? String(value) : '-';

  return (
    <div
      className={`flex items-start gap-2 px-3 py-1.5 min-w-0 ${
        isMutated ? 'bg-purple-50/50 dark:bg-purple-950/30' : ''
      } ${editable && !isComputed ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/50 group/row' : ''}`}
      onClick={!editing ? startEdit : undefined}
    >
      <span className="text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0 pt-0.5 flex items-center gap-0.5 min-w-[110px]">
        {isComputed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[10px] text-teal-500">*</span>
            </TooltipTrigger>
            <TooltipContent>Computed from XAxisAbscissa and XAxisOrdinate</TooltipContent>
          </Tooltip>
        )}
        {label}
      </span>
      <div className="flex-1 flex flex-col items-end gap-0.5 min-w-0">
        <div className="flex items-start gap-1 w-full justify-end">
          {isMutated && !editing && (
            <Badge variant="secondary" className="h-4 px-1 text-[9px] bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-700 shrink-0 mt-0.5">
              edited
            </Badge>
          )}
          {editing ? (
            <div className="flex flex-col gap-1 w-full" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-1">
                {hint.isSelect ? (
                  <select
                    value={editValue}
                    onChange={e => { setEditValue(e.target.value); }}
                    className="flex-1 text-[11px] font-mono px-1.5 py-1 border border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400"
                    autoFocus
                  >
                    <option value="">-- select --</option>
                    {hint.suggestions?.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                ) : (
                  <input
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={hint.placeholder}
                    className="flex-1 min-w-0 text-[11px] font-mono px-1.5 py-0.5 border border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400 placeholder:text-zinc-400/50"
                    autoFocus
                  />
                )}
                <button onClick={() => commitEdit()} className="p-0.5 text-green-600 hover:text-green-700 dark:text-green-400 shrink-0">
                  <Check className="h-3 w-3" />
                </button>
                <button onClick={cancelEdit} className="p-0.5 text-red-500 hover:text-red-600 dark:text-red-400 shrink-0">
                  <X className="h-3 w-3" />
                </button>
              </div>
              {/* Suggestion chips for fields with common values */}
              {hint.suggestions && !hint.isSelect && (
                <div className="flex flex-wrap gap-1">
                  {hint.suggestions.map(s => (
                    <button
                      key={s}
                      onClick={() => selectSuggestion(s)}
                      className="text-[9px] font-mono px-1.5 py-0.5 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-teal-400 hover:text-teal-700 dark:hover:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/50 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {/* Help text */}
              {hint.helpText && (
                <span className="text-[9px] text-zinc-400 dark:text-zinc-500">{hint.helpText}</span>
              )}
            </div>
          ) : (
            <>
              <span
                className={`text-[11px] font-mono tabular-nums break-all text-right ${
                  isMutated
                    ? 'text-purple-700 dark:text-purple-300 font-semibold'
                    : 'text-teal-700 dark:text-teal-400'
                }`}
                title={displayValue}
              >
                {displayValue}
                {suffix && <span className="text-zinc-400 dark:text-zinc-500 ml-0.5">{suffix}</span>}
              </span>
              {editable && !isComputed && (
                <PenLine className="h-3 w-3 opacity-0 group-hover/row:opacity-100 transition-opacity text-zinc-400 shrink-0 mt-0.5" />
              )}
            </>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

// ── AngleRow: edit angle and auto-compute XAxisAbscissa/XAxisOrdinate ───

interface AngleRowProps {
  angle: number | null;
  editable?: boolean;
  onAngleChange?: (abscissa: number, ordinate: number) => void;
}

function AngleRow({ angle, editable, onAngleChange }: AngleRowProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const startEdit = useCallback(() => {
    if (!editable) return;
    setEditValue(angle != null ? angle.toFixed(6) : '');
    setEditing(true);
  }, [angle, editable]);

  const commitEdit = useCallback(() => {
    if (!onAngleChange) return;
    const deg = parseFloat(editValue.trim());
    if (!Number.isFinite(deg)) return;
    const rad = deg * (Math.PI / 180);
    onAngleChange(Math.cos(rad), Math.sin(rad));
    setEditing(false);
  }, [editValue, onAngleChange]);

  const cancelEdit = useCallback(() => setEditing(false), []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') cancelEdit();
  }, [commitEdit, cancelEdit]);

  return (
    <div
      className={`flex items-start gap-2 px-3 py-1.5 min-w-0 ${editable ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/50 group/row' : ''}`}
      onClick={!editing ? startEdit : undefined}
    >
      <span className="text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0 pt-0.5 flex items-center gap-0.5 min-w-[110px]">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-[10px] text-teal-500">*</span>
          </TooltipTrigger>
          <TooltipContent>{editable ? 'Edit angle to auto-compute XAxisAbscissa/XAxisOrdinate' : 'Computed from XAxisAbscissa and XAxisOrdinate'}</TooltipContent>
        </Tooltip>
        Angle to Grid North
      </span>
      <div className="flex-1 flex items-start gap-1 min-w-0 justify-end">
        {editing ? (
          <div className="flex flex-col gap-1" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-1">
              <input
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="0.0"
                className="w-28 text-[11px] font-mono px-1.5 py-0.5 border border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400 placeholder:text-zinc-400/50"
                autoFocus
              />
              <span className="text-[10px] text-zinc-400">deg</span>
              <button onClick={commitEdit} className="p-0.5 text-green-600 hover:text-green-700 dark:text-green-400 shrink-0">
                <Check className="h-3 w-3" />
              </button>
              <button onClick={cancelEdit} className="p-0.5 text-red-500 hover:text-red-600 dark:text-red-400 shrink-0">
                <X className="h-3 w-3" />
              </button>
            </div>
            <span className="text-[9px] text-zinc-400 dark:text-zinc-500">Sets XAxisAbscissa = cos(angle), XAxisOrdinate = sin(angle)</span>
          </div>
        ) : (
          <>
            <span className="text-[11px] font-mono tabular-nums text-teal-700 dark:text-teal-400">
              {angle != null ? parseFloat(angle.toFixed(6)) : '-'}
              <span className="text-zinc-400 dark:text-zinc-500 ml-0.5">deg</span>
            </span>
            {editable && (
              <PenLine className="h-3 w-3 opacity-0 group-hover/row:opacity-100 transition-opacity text-zinc-400 shrink-0 mt-0.5" />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main Panel ─────────────────────────────────────────────────────────

export interface GeoreferencingPanelProps {
  georef: GeoreferenceInfo | null;
  modelId?: string;
  enableEditing?: boolean;
  schemaVersion?: string;
  /** CoordinateInfo from the model's geometry (for map position calculation) */
  coordinateInfo?: CoordinateInfo;
  /** GeometryResult for KMZ export */
  geometryResult?: GeometryResult | null;
  /** IFC project length unit → metres (e.g. 0.001 for mm models). Default 1. */
  lengthUnitScale?: number;
}

export function GeoreferencingPanel({ georef, modelId, enableEditing, schemaVersion, coordinateInfo, geometryResult, lengthUnitScale }: GeoreferencingPanelProps) {
  const georefMutations = useViewerStore(s => s.georefMutations);
  const setGeorefField = useViewerStore(s => s.setGeorefField);
  const setGeorefFields = useViewerStore(s => s.setGeorefFields);
  const cesiumEnabled = useViewerStore(s => s.cesiumEnabled);
  const terrainClamp = useViewerStore(s => s.cesiumTerrainClamp);
  const setCesiumTerrainClamp = useViewerStore(s => s.setCesiumTerrainClamp);
  const cesiumTerrainHeight = useViewerStore(s => s.cesiumTerrainHeight);
  const cesiumSourceModelId = useViewerStore(s => s.cesiumSourceModelId);
  const models = useViewerStore(s => s.models);
  const loading = useViewerStore(s => s.loading);
  const { addModel, clearAllModels } = useIfc();
  // Only show terrain actions when this panel's model is the one backing the Cesium overlay
  const isActiveCesiumModel = !!modelId && modelId === cesiumSourceModelId;
  const [crsOpen, setCrsOpen] = useState(false);
  const [conversionOpen, setConversionOpen] = useState(false);
  const [showReloadPrompt, setShowReloadPrompt] = useState(false);

  useViewerStore(s => s.mutationVersion);

  const mutations = modelId ? georefMutations?.get(modelId) : undefined;
  const supportsStandardGeoreferencing = !schemaVersion?.toUpperCase().includes('2X3');

  const mergedCRS = useMemo((): ProjectedCRS | undefined => {
    return mergeProjectedCRS(georef?.projectedCRS, mutations?.projectedCRS, lengthUnitScale ?? 1);
  }, [georef?.projectedCRS, mutations?.projectedCRS, lengthUnitScale]);

  const mergedConversion = useMemo((): MapConversion | undefined => {
    return mergeMapConversion(georef?.mapConversion, mutations?.mapConversion);
  }, [georef?.mapConversion, mutations?.mapConversion]);

  const angleToGridNorth = useMemo(() => {
    return computeAngleToGridNorth(mergedConversion?.xAxisAbscissa, mergedConversion?.xAxisOrdinate);
  }, [mergedConversion]);

  const mapUnitSuffix = useMemo(() => {
    const mapUnit = mergedCRS?.mapUnit?.toUpperCase();
    if (!mapUnit) return 'm';
    if (mapUnit.includes('US') && mapUnit.includes('FOOT')) return 'ftUS';
    if (mapUnit.includes('FOOT') || mapUnit.includes('FEET')) return 'ft';
    return 'm';
  }, [mergedCRS?.mapUnit]);

  // Convert meters to map units (Cesium always returns meters)
  const metersToMapUnit = useCallback((meters: number): number => {
    if (mapUnitSuffix === 'ftUS') return meters / 0.3048006096;
    if (mapUnitSuffix === 'ft') return meters / 0.3048;
    return meters; // already meters
  }, [mapUnitSuffix]);

  const isMutated = useCallback((entity: 'projectedCRS' | 'mapConversion', field: string): boolean => {
    if (!mutations) return false;
    const entityMuts = mutations[entity];
    if (!entityMuts) return false;
    return field in entityMuts;
  }, [mutations]);

  const requestAlignmentReload = useCallback(() => {
    if (models.size > 1) {
      setShowReloadPrompt(true);
    }
  }, [models.size]);

  const reloadModelsForAlignment = useCallback(async () => {
    const state = useViewerStore.getState();
    const snapshot = Array.from(state.models.values()).sort((a, b) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0));
    const missingSource = snapshot.find(model => !model.sourceFile);
    if (snapshot.length < 2) {
      setShowReloadPrompt(false);
      return;
    }
    if (missingSource) {
      toast.error(`Cannot reload ${missingSource.name}: source file is not available`);
      return;
    }

    try {
      clearAllModels();
      for (const model of snapshot) {
        const sourceFile = model.sourceFile;
        if (!sourceFile) continue;
        const reloadedModelId = await addModel(sourceFile, {
          name: model.name,
          modelId: model.id,
          loadedAt: model.loadedAt,
          visible: model.visible,
          collapsed: model.collapsed,
        });
        if (!reloadedModelId) {
          throw new Error(`Failed to reload ${model.name}`);
        }
        if (model.visible === false) {
          useViewerStore.getState().setModelVisibility(model.id, false);
        }
      }
      setShowReloadPrompt(false);
      toast.success('Reloaded models for edited georeferencing');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Reload failed');
    }
  }, [addModel, clearAllModels]);

  const handleSave = useCallback((entity: 'projectedCRS' | 'mapConversion', field: string, value: string | number) => {
    if (!modelId || !setGeorefField) return;
    const oldValue = entity === 'projectedCRS'
      ? mergedCRS?.[field as keyof ProjectedCRS]
      : mergedConversion?.[field as keyof MapConversion];
    setGeorefField(modelId, entity, field, value, oldValue as string | number | undefined);
    requestAlignmentReload();
  }, [modelId, setGeorefField, mergedCRS, mergedConversion, requestAlignmentReload]);

  // Handle angle edit: compute and set both XAxisAbscissa and XAxisOrdinate
  const handleAngleChange = useCallback((abscissa: number, ordinate: number) => {
    if (!modelId || !setGeorefFields) return;
    setGeorefFields(modelId, 'mapConversion', [
      { field: 'xAxisAbscissa', value: abscissa, oldValue: mergedConversion?.xAxisAbscissa },
      { field: 'xAxisOrdinate', value: ordinate, oldValue: mergedConversion?.xAxisOrdinate },
    ]);
    requestAlignmentReload();
  }, [modelId, setGeorefFields, mergedConversion, requestAlignmentReload]);

  // Handle position picked from the map (reverse-projected easting/northing + optional terrain height)
  const handleApplyPosition = useCallback((position: PickedPosition) => {
    if (!modelId || !setGeorefFields) return;
    const fields: Array<{ field: string; value: number; oldValue?: number }> = [
      { field: 'eastings', value: position.easting, oldValue: mergedConversion?.eastings },
      { field: 'northings', value: position.northing, oldValue: mergedConversion?.northings },
    ];
    if (position.terrainHeight !== null) {
      fields.push({
        field: 'orthogonalHeight',
        value: Math.round(position.terrainHeight * 10) / 10,
        oldValue: mergedConversion?.orthogonalHeight,
      });
    }
    setGeorefFields(modelId, 'mapConversion', fields);
    setConversionOpen(true);
    requestAlignmentReload();
  }, [modelId, setGeorefFields, mergedConversion, requestAlignmentReload]);

  const initializeMapConversionDefaults = useCallback(() => {
    if (!modelId || !setGeorefFields) return;
    setGeorefFields(modelId, 'mapConversion', [
      { field: 'eastings', value: mergedConversion?.eastings ?? 0, oldValue: mergedConversion?.eastings },
      { field: 'northings', value: mergedConversion?.northings ?? 0, oldValue: mergedConversion?.northings },
      { field: 'orthogonalHeight', value: mergedConversion?.orthogonalHeight ?? 0, oldValue: mergedConversion?.orthogonalHeight },
      { field: 'xAxisAbscissa', value: mergedConversion?.xAxisAbscissa ?? 1, oldValue: mergedConversion?.xAxisAbscissa },
      { field: 'xAxisOrdinate', value: mergedConversion?.xAxisOrdinate ?? 0, oldValue: mergedConversion?.xAxisOrdinate },
      { field: 'scale', value: mergedConversion?.scale ?? 1, oldValue: mergedConversion?.scale },
    ]);
    setConversionOpen(true);
    requestAlignmentReload();
  }, [modelId, setGeorefFields, mergedConversion, requestAlignmentReload]);

  const handleEpsgSelect = useCallback((result: EpsgResult) => {
    if (!modelId || !setGeorefFields) return;
    const epsgName = `EPSG:${result.code}`;
    const fieldUpdates: Array<{ field: string; value: string | number; oldValue?: string | number }> = [
      { field: 'name', value: epsgName, oldValue: mergedCRS?.name },
    ];
    if (result.name) {
      fieldUpdates.push({ field: 'description', value: result.name, oldValue: mergedCRS?.description });
    }
    if (result.datum) {
      fieldUpdates.push({ field: 'geodeticDatum', value: result.datum, oldValue: mergedCRS?.geodeticDatum });
    }
    if (result.projection) {
      fieldUpdates.push({ field: 'mapProjection', value: result.projection, oldValue: mergedCRS?.mapProjection });
    }
    if (result.unit) {
      const unitUpper = result.unit.toUpperCase();
      const mapUnit = unitUpper.includes('US') && (unitUpper.includes('SURVEY') || unitUpper.includes('FTUS'))
        ? 'US SURVEY FOOT'
        : unitUpper.includes('METRE') || unitUpper.includes('METER')
          ? 'METRE'
          : unitUpper.includes('FOOT') || unitUpper.includes('FEET')
            ? 'FOOT'
            : result.unit;
      fieldUpdates.push({ field: 'mapUnit', value: mapUnit, oldValue: mergedCRS?.mapUnit });
    }
    setGeorefFields(modelId, 'projectedCRS', fieldUpdates);
    if (!mergedConversion && !mutations?.mapConversion) {
      initializeMapConversionDefaults();
    }
    setCrsOpen(true);
    requestAlignmentReload();
  }, [modelId, setGeorefFields, mergedCRS, mergedConversion, mutations, initializeMapConversionDefaults, requestAlignmentReload]);

  const hasData = mergedCRS || mergedConversion;
  const editable = enableEditing && !!modelId && supportsStandardGeoreferencing;

  if (enableEditing && !supportsStandardGeoreferencing) {
    return (
      <div className="px-2 py-1.5 flex items-center gap-2">
        <Globe className="h-3 w-3 text-zinc-400" />
        <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
          Georeferencing editing requires IFC4 or newer. IFC2X3 does not support IfcProjectedCRS or IfcMapConversion.
        </span>
      </div>
    );
  }

  // When no georef data exists, show "Add Georeferencing" in edit mode
  if (!hasData && !georef?.hasGeoreference) {
    if (!editable) return null;
    return (
      <div className="px-2 py-1.5 flex items-center gap-2">
        <Globe className="h-3 w-3 text-teal-500" />
        <span className="text-[10px] text-zinc-500 dark:text-zinc-400 flex-1">No georeferencing</span>
        <EpsgLookupDialog onSelect={handleEpsgSelect}>
          <button className="flex items-center gap-1 text-[10px] text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 transition-colors px-1.5 py-0.5 border border-teal-300/50 dark:border-teal-700/50 hover:bg-teal-50 dark:hover:bg-teal-950/50">
            <Globe className="h-2.5 w-2.5" />
            Add Georeferencing
          </button>
        </EpsgLookupDialog>
      </div>
    );
  }

  return (
    <div>
      {showReloadPrompt && (
        <div className="mx-2 my-2 border border-teal-300 dark:border-teal-700 bg-teal-50 dark:bg-teal-950/40 px-2.5 py-2">
          <div className="flex items-start gap-2">
            <MapPin className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] text-zinc-700 dark:text-zinc-300">
                Georeference saved. Reload loaded models to recompute 3D alignment?
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={reloadModelsForAlignment}
                  disabled={loading}
                  className="px-2 py-0.5 text-[10px] font-medium text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Reload models
                </button>
                <button
                  onClick={() => setShowReloadPrompt(false)}
                  className="px-2 py-0.5 text-[10px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
                >
                  Later
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* CRS summary — always visible */}
      <div className="px-2 py-1.5 flex items-center gap-2">
        <Globe className="h-3 w-3 text-teal-500 shrink-0" />
        {mergedCRS?.name && (
          <span className="text-[10px] font-mono font-semibold text-teal-600 dark:text-teal-400">{mergedCRS.name}</span>
        )}
        {!mergedCRS?.name && (
          <span className="text-[10px] text-zinc-500 dark:text-zinc-400">No projected CRS</span>
        )}
        {mergedCRS?.description && (
          <span className="text-[10px] font-mono text-teal-500/60 truncate">{mergedCRS.description}</span>
        )}
        {editable && (
          <EpsgLookupDialog onSelect={handleEpsgSelect}>
            <button className="flex items-center gap-1 text-[9px] text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors ml-auto shrink-0">
              <Search className="h-2.5 w-2.5" />
              EPSG
            </button>
          </EpsgLookupDialog>
        )}
      </div>

      {/* IfcProjectedCRS */}
      {mergedCRS && (
        <div>
          <button
            onClick={() => setCrsOpen(!crsOpen)}
            className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-left transition-colors border-b border-zinc-100 dark:border-zinc-900"
          >
            <ChevronRight className={`h-3 w-3 text-teal-500 shrink-0 transition-transform ${crsOpen ? 'rotate-90' : ''}`} />
            <Globe className="h-3 w-3 text-teal-500 shrink-0" />
            <span className="font-bold text-[11px] text-zinc-700 dark:text-zinc-300 uppercase tracking-wide flex-1 text-left">Projected CRS</span>
            {!crsOpen && mergedCRS.name && (
              <span className="text-[10px] font-mono text-teal-600/70 dark:text-teal-500/60 truncate max-w-[50%]">{mergedCRS.name}</span>
            )}
          </button>
          {crsOpen && (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
              <GeorefRow label="Name" value={mergedCRS.name} editable={editable} isMutated={isMutated('projectedCRS', 'name')} fieldEntity="projectedCRS" fieldName="name" onSave={v => handleSave('projectedCRS', 'name', v)} />
              <GeorefRow label="Description" value={mergedCRS.description} editable={editable} isMutated={isMutated('projectedCRS', 'description')} fieldEntity="projectedCRS" fieldName="description" onSave={v => handleSave('projectedCRS', 'description', v)} />
              <GeorefRow label="GeodeticDatum" value={mergedCRS.geodeticDatum} editable={editable} isMutated={isMutated('projectedCRS', 'geodeticDatum')} fieldEntity="projectedCRS" fieldName="geodeticDatum" onSave={v => handleSave('projectedCRS', 'geodeticDatum', v)} />
              <GeorefRow label="VerticalDatum" value={mergedCRS.verticalDatum} editable={editable} isMutated={isMutated('projectedCRS', 'verticalDatum')} fieldEntity="projectedCRS" fieldName="verticalDatum" onSave={v => handleSave('projectedCRS', 'verticalDatum', v)} />
              <GeorefRow label="MapProjection" value={mergedCRS.mapProjection} editable={editable} isMutated={isMutated('projectedCRS', 'mapProjection')} fieldEntity="projectedCRS" fieldName="mapProjection" onSave={v => handleSave('projectedCRS', 'mapProjection', v)} />
              <GeorefRow label="MapZone" value={mergedCRS.mapZone} editable={editable} isMutated={isMutated('projectedCRS', 'mapZone')} fieldEntity="projectedCRS" fieldName="mapZone" onSave={v => handleSave('projectedCRS', 'mapZone', v)} />
              <GeorefRow label="MapUnit" value={mergedCRS.mapUnit} editable={editable} isMutated={isMutated('projectedCRS', 'mapUnit')} fieldEntity="projectedCRS" fieldName="mapUnit" onSave={v => handleSave('projectedCRS', 'mapUnit', v)} />
            </div>
          )}
        </div>
      )}

      {!mergedCRS && editable && mergedConversion && (
        <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-900 flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 dark:text-zinc-400 flex-1">Coordinate operation exists, but projected CRS is missing.</span>
          <EpsgLookupDialog onSelect={handleEpsgSelect}>
            <button className="flex items-center gap-1 text-[9px] text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors shrink-0">
              <Search className="h-2.5 w-2.5" />
              Add CRS
            </button>
          </EpsgLookupDialog>
        </div>
      )}

      {/* IfcMapConversion */}
      {mergedConversion && (
        <div>
          <button
            onClick={() => setConversionOpen(!conversionOpen)}
            className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-left transition-colors border-b border-zinc-100 dark:border-zinc-900"
          >
            <ChevronRight className={`h-3 w-3 text-teal-500 shrink-0 transition-transform ${conversionOpen ? 'rotate-90' : ''}`} />
            <MapPin className="h-3 w-3 text-teal-500 shrink-0" />
            <span className="font-bold text-[11px] text-zinc-700 dark:text-zinc-300 uppercase tracking-wide flex-1 text-left">Coordinate Operation</span>
            {!conversionOpen && (
              <span className="text-[10px] font-mono text-teal-600/70 dark:text-teal-500/60">
                E {mergedConversion.eastings.toFixed(0)} N {mergedConversion.northings.toFixed(0)}
              </span>
            )}
          </button>
          {conversionOpen && (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
              <GeorefRow label="Type" value="IfcMapConversion" />
              <GeorefRow label="Eastings" value={mergedConversion.eastings} suffix={mapUnitSuffix} isNumber editable={editable} isMutated={isMutated('mapConversion', 'eastings')} fieldEntity="mapConversion" fieldName="eastings" onSave={v => handleSave('mapConversion', 'eastings', v)} />
              <GeorefRow label="Northings" value={mergedConversion.northings} suffix={mapUnitSuffix} isNumber editable={editable} isMutated={isMutated('mapConversion', 'northings')} fieldEntity="mapConversion" fieldName="northings" onSave={v => handleSave('mapConversion', 'northings', v)} />
              <GeorefRow label="OrthogonalHeight" value={mergedConversion.orthogonalHeight} suffix={mapUnitSuffix} isNumber editable={editable} isMutated={isMutated('mapConversion', 'orthogonalHeight')} fieldEntity="mapConversion" fieldName="orthogonalHeight" onSave={v => handleSave('mapConversion', 'orthogonalHeight', v)}>
                <TerrainHeightButton modelId={modelId} editable={editable} onApply={(h) => handleSave('mapConversion', 'orthogonalHeight', Math.round(metersToMapUnit(h) * 100) / 100)} />
              </GeorefRow>
              <GeorefRow label="XAxisAbscissa" value={mergedConversion.xAxisAbscissa} isNumber editable={editable} isMutated={isMutated('mapConversion', 'xAxisAbscissa')} fieldEntity="mapConversion" fieldName="xAxisAbscissa" onSave={v => handleSave('mapConversion', 'xAxisAbscissa', v)} />
              <GeorefRow label="XAxisOrdinate" value={mergedConversion.xAxisOrdinate} isNumber editable={editable} isMutated={isMutated('mapConversion', 'xAxisOrdinate')} fieldEntity="mapConversion" fieldName="xAxisOrdinate" onSave={v => handleSave('mapConversion', 'xAxisOrdinate', v)} />
              <AngleRow angle={angleToGridNorth} editable={editable} onAngleChange={handleAngleChange} />
              <GeorefRow label="Scale" value={mergedConversion.scale} isNumber editable={editable} isMutated={isMutated('mapConversion', 'scale')} fieldEntity="mapConversion" fieldName="scale" onSave={v => handleSave('mapConversion', 'scale', v)} />
            </div>
          )}
        </div>
      )}

      {!mergedConversion && editable && mergedCRS && (
        <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-900 flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 dark:text-zinc-400 flex-1">No coordinate operation. Add map coordinates, angle to grid north, and scale.</span>
          <button
            onClick={initializeMapConversionDefaults}
            className="flex items-center gap-1 text-[9px] text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors shrink-0"
          >
            <MapPin className="h-2.5 w-2.5" />
            Add Coordinates
          </button>
        </div>
      )}

      {/* Terrain clamp toggle — only when Cesium overlay is active */}
      {cesiumEnabled && isActiveCesiumModel && mergedConversion && (
        <div className="px-3 py-1.5 border-t border-zinc-100 dark:border-zinc-900 space-y-1">
          <div className="flex items-center gap-2">
            <Mountain className="h-3 w-3 text-teal-500 shrink-0" />
            <label className="flex items-center gap-1.5 cursor-pointer flex-1">
              <input
                type="checkbox"
                checked={terrainClamp}
                onChange={(e) => setCesiumTerrainClamp(e.target.checked)}
                className="accent-teal-500 h-3 w-3"
              />
              <span className="text-[10px] text-zinc-600 dark:text-zinc-400">Clamp to terrain</span>
            </label>
            {cesiumTerrainHeight !== null ? (
              <span className="text-[9px] font-mono text-teal-500">
                {cesiumTerrainHeight.toFixed(1)} m
              </span>
            ) : (
              <span className="text-[9px] font-mono text-zinc-400">querying...</span>
            )}
          </div>
          {cesiumTerrainHeight !== null && editable && modelId && (
            <div className="flex items-center gap-1 ml-5">
              <button
                onClick={() => handleSave('mapConversion', 'orthogonalHeight', Math.round(metersToMapUnit(cesiumTerrainHeight) * 100) / 100)}
                className="text-[9px] text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors flex items-center gap-0.5"
              >
                <Mountain className="h-2.5 w-2.5" />
                Set OrthogonalHeight to {cesiumTerrainHeight.toFixed(1)} m
              </button>
            </div>
          )}
        </div>
      )}

      {/* Location minimap */}
      <LocationMap
        mapConversion={mergedConversion}
        projectedCRS={mergedCRS}
        coordinateInfo={coordinateInfo}
        geometryResult={geometryResult}
        lengthUnitScale={lengthUnitScale}
        editable={editable}
        onApplyPosition={editable ? handleApplyPosition : undefined}
      />
    </div>
  );
}

/** Small button to apply Cesium terrain height to OrthogonalHeight field */
function TerrainHeightButton({ modelId, editable, onApply }: {
  modelId?: string;
  editable?: boolean;
  onApply: (height: number) => void;
}) {
  const cesiumEnabled = useViewerStore(s => s.cesiumEnabled);
  const terrainHeight = useViewerStore(s => s.cesiumTerrainHeight);
  const sourceModelId = useViewerStore(s => s.cesiumSourceModelId);

  // Only show when this panel's model is the active Cesium model
  if (!cesiumEnabled || terrainHeight === null || !editable || !modelId || modelId !== sourceModelId) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onApply(terrainHeight);
          }}
          className="flex items-center gap-0.5 text-[9px] text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors mt-0.5"
        >
          <Mountain className="h-2.5 w-2.5" />
          <span>{terrainHeight.toFixed(1)} m</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>Set OrthogonalHeight to Cesium terrain elevation ({terrainHeight.toFixed(1)} m)</TooltipContent>
    </Tooltip>
  );
}
