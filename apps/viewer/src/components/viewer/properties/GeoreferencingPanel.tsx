/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Georeferencing panel - displays and allows editing of IfcProjectedCRS
 * and IfcMapConversion entities with field-specific editing assistance.
 */

import { useState, useCallback, useMemo } from 'react';
import { Globe, MapPin, Search, ChevronRight, Mountain, AlertTriangle, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { computeAngleToGridNorth, type GeoreferenceInfo, type MapConversion, type ProjectedCRS } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { EpsgLookupDialog, type EpsgResult } from './EpsgLookupDialog';
import { FederationAlignmentControls } from './FederationAlignmentControls';
import { PrecisionGridBadge } from './PrecisionGridBadge';
import { LocationMap, type PickedPosition } from './LocationMap';
import { computeOrthogonalHeightForBaseAltitude } from '@/lib/geo/cesium-placement';
import {
  detectScaleUnitMismatch,
  mergeMapConversion,
  mergeProjectedCRS,
  resolveEpsetMapUnitScale,
  supportsStandardGeoreferencing,
} from '@/lib/geo/effective-georef';
import { detectDoubleGeoreference } from '@/lib/geo/double-georeference';
import { useIfc } from '@/hooks/useIfc';
import { toast } from '@/components/ui/toast';
import { resolveInstancedExportGate } from '@/utils/instancedExport';
import { useTranslation } from '@/i18n';
import { formatLocaleList, formatLocaleNumber } from '@/i18n/intlFormat';
import { localizedApproxDistance, localizedRawValuesNote, localizedScaleOverride } from './georeference-i18n';
import { GeorefRow, AngleRow } from './GeoreferenceFields';

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
  /** IfcBuildingStorey elevations (express id → metres, viewer-Y aligned).
   *  Used to anchor the model's ground floor to terrain. */
  storeyElevations?: Map<number, number>;
}

export function GeoreferencingPanel({ georef, modelId, enableEditing, schemaVersion, coordinateInfo, geometryResult, lengthUnitScale, storeyElevations }: GeoreferencingPanelProps) {
  const { t, locale } = useTranslation();
  const georefMutations = useViewerStore(s => s.georefMutations);
  const setGeorefField = useViewerStore(s => s.setGeorefField);
  const setGeorefFields = useViewerStore(s => s.setGeorefFields);
  const cesiumEnabled = useViewerStore(s => s.cesiumEnabled);
  const cesiumTerrainHeight = useViewerStore(s => s.cesiumTerrainHeight);
  // Geoid-inverted target for snapping OrthogonalHeight to terrain (#1456); the
  // raw cesiumTerrainHeight is still shown to the user.
  const cesiumTerrainSaveHeight = useViewerStore(s => s.cesiumTerrainSaveHeight);
  const cesiumTerrainSource = useViewerStore(s => s.cesiumTerrainSource);
  const cesiumSourceModelId = useViewerStore(s => s.cesiumSourceModelId);
  const heightsAreEllipsoidal = useViewerStore(s => s.cesiumHeightsAreEllipsoidal);
  const setHeightsAreEllipsoidal = useViewerStore(s => s.setCesiumHeightsAreEllipsoidal);
  const models = useViewerStore(s => s.models);
  const loading = useViewerStore(s => s.loading);
  const { addModel, clearAllModels } = useIfc();
  // This model's global-id bracket, scoping `LocationMap`'s KMZ export
  // (`withInstancedMeshes`) to just its own GPU-instanced occurrences — without
  // it, a federation of more than one loaded model leaks every OTHER model's
  // instanced geometry into this model's export (PR #2878 review). See
  // `resolveInstancedExportGate`'s doc for why `canExportKmz` must withhold
  // the export, rather than fall through to `instancedModelRange: null`
  // (no filter), when this panel's model id didn't resolve and more than
  // one model is loaded.
  const { instancedModelRange, canExport: canExportKmz } = useMemo(
    () => resolveInstancedExportGate(modelId, models),
    [modelId, models],
  );
  // Only show terrain actions when this panel's model is the one backing the Cesium overlay
  const isActiveCesiumModel = !!modelId && modelId === cesiumSourceModelId;
  const [crsOpen, setCrsOpen] = useState(false);
  const [conversionOpen, setConversionOpen] = useState(false);
  const [showReloadPrompt, setShowReloadPrompt] = useState(false);

  useViewerStore(s => s.mutationVersion);

  const mutations = modelId ? georefMutations?.get(modelId) : undefined;
  const isLegacySiteGeoreference = georef?.source === 'siteLocation';
  const canUseStandardGeoreferencing = supportsStandardGeoreferencing(schemaVersion, georef);

  const mergedCRS = useMemo((): ProjectedCRS | undefined => {
    const merged = mergeProjectedCRS(georef?.projectedCRS, mutations?.projectedCRS, lengthUnitScale ?? 1);
    if (!merged) return merged;
    // `mergeProjectedCRS` alone doesn't know the georeference's `source`, so an
    // IFC2x3 `ePSet_MapConversion` file with no explicit ePset MapUnit leaves
    // `mapUnitScale` undefined here -- which `resolveMapUnitToMetreScale` then
    // reads as "treat offsets as metres" instead of the buildingSMART
    // convention (project length unit). Every other consumer routes through
    // `getEffectiveGeoreference`, which applies this same correction; this
    // panel built its own `georef` via `extractGeoreferencingOnDemand` and
    // never did, so `detectDoubleGeoreference` below was scaling a millimetre
    // project's eastings/northings by 1 instead of 0.001 -- 1000x off.
    return {
      ...merged,
      mapUnitScale: resolveEpsetMapUnitScale(georef?.source, merged.mapUnitScale, lengthUnitScale ?? 1),
    };
  }, [georef?.projectedCRS, georef?.source, mutations?.projectedCRS, lengthUnitScale]);

  const mergedConversion = useMemo((): MapConversion | undefined => {
    return mergeMapConversion(georef?.mapConversion, mutations?.mapConversion);
  }, [georef?.mapConversion, mutations?.mapConversion]);

  const angleToGridNorth = useMemo(() => {
    return computeAngleToGridNorth(mergedConversion?.xAxisAbscissa, mergedConversion?.xAxisOrdinate);
  }, [mergedConversion]);

  const scaleMismatch = useMemo(() => {
    if (!mergedConversion) return null;
    return detectScaleUnitMismatch(mergedConversion, mergedCRS?.mapUnitScale, lengthUnitScale);
  }, [mergedConversion, mergedCRS?.mapUnitScale, lengthUnitScale]);

  // Geometry already at absolute map coordinates AND a MapConversion repeating
  // the same offset (#2526). `effectiveMapConversionForGeometry` has ALREADY
  // neutralised the duplicate for every geometry consumer by the time this
  // runs — this is the note that says so, and it fires on exactly the same
  // predicate, so the panel can never disagree with the model on screen.
  const doubleGeoref = useMemo(() => {
    return detectDoubleGeoreference(
      mergedConversion,
      mergedCRS,
      coordinateInfo,
      lengthUnitScale ?? 1,
    );
  }, [mergedConversion, mergedCRS, coordinateInfo, lengthUnitScale]);

  const mapUnitSuffix = useMemo(() => {
    const mapUnit = mergedCRS?.mapUnit?.toUpperCase();
    if (!mapUnit) return 'm';
    if (mapUnit.includes('US') && mapUnit.includes('FOOT')) return 'ftUS';
    if (mapUnit.includes('FOOT') || mapUnit.includes('FEET')) return 'ft';
    return 'm';
  }, [mergedCRS?.mapUnit]);

  /**
   * Given a target world altitude (metres) for the model's ground floor
   * (the storey nearest elevation 0, falling back to bounds.min.y when
   * no storeys are present), return the IfcMapConversion.OrthogonalHeight
   * value (in map units, rounded to 0.01) that puts the ground floor there,
   * inverting the Cesium read path (RTC offset, Scale x FactorZ) so the
   * "Set OrthogonalHeight to Cesium terrain elevation" button lands where
   * the model is drawn.
   */
  const oHeightForBaseAltitude = useCallback((targetBaseAltitude: number): number => {
    return computeOrthogonalHeightForBaseAltitude({
      coordinateInfo,
      projectedCRS: mergedCRS,
      mapConversion: mergedConversion,
      lengthUnitScale: lengthUnitScale ?? 1,
      storeyElevations,
      targetBaseAltitude,
    });
  }, [coordinateInfo, mergedCRS, mergedConversion, lengthUnitScale, storeyElevations]);

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
      toast.error(t('properties.georef.reloadMissingSource', { name: missingSource.name }));
      return;
    }

    try {
      clearAllModels();
      const failed: string[] = [];
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
          // Do NOT throw: `clearAllModels()` has already run, so an early exit
          // leaves the federation half-rebuilt — every model after this one is
          // simply gone, and the only feedback is a "reload failed" toast that
          // says nothing about how many survived. The sibling rebuild in
          // `useFileCommands.tsx:317-320` avoids this by validating every read
          // BEFORE clearing and refusing the whole refresh; that is not
          // available here, because a model's failure is only observable once
          // `addModel` has tried to load it. So keep going, reload everything
          // that can be reloaded, and name what could not.
          failed.push(model.name);
          continue;
        }
        if (model.visible === false) {
          useViewerStore.getState().setModelVisibility(model.id, false);
        }
      }
      setShowReloadPrompt(false);
      if (failed.length > 0) {
        toast.error(t('properties.georef.reloadPartial', {
          loaded: formatLocaleNumber(locale, snapshot.length - failed.length), total: formatLocaleNumber(locale, snapshot.length), failed: formatLocaleList(locale, failed),
        }));
      } else {
        toast.success(t('properties.georef.reloadSuccess'));
      }
    } catch (error) {
      toast.error(error instanceof Error ? t('properties.georef.reloadFailedWithMessage', { message: error.message }) : t('properties.georef.reloadFailed'));
    }
  }, [addModel, clearAllModels, locale, t]);

  const handleSave = useCallback((entity: 'projectedCRS' | 'mapConversion', field: string, value: string | number) => {
    if (!modelId || !setGeorefField) return;
    const oldValue = entity === 'projectedCRS'
      ? mergedCRS?.[field as keyof ProjectedCRS]
      : mergedConversion?.[field as keyof MapConversion];
    setGeorefField(modelId, entity, field, value, oldValue as string | number | undefined);
    posthog.capture('georeference_set', { method: 'crs_field', entity, field });
    requestAlignmentReload();
  }, [modelId, setGeorefField, mergedCRS, mergedConversion, requestAlignmentReload]);

  // Handle angle edit: compute and set both XAxisAbscissa and XAxisOrdinate
  const handleAngleChange = useCallback((abscissa: number, ordinate: number) => {
    if (!modelId || !setGeorefFields) return;
    setGeorefFields(modelId, 'mapConversion', [
      { field: 'xAxisAbscissa', value: abscissa, oldValue: mergedConversion?.xAxisAbscissa },
      { field: 'xAxisOrdinate', value: ordinate, oldValue: mergedConversion?.xAxisOrdinate },
    ]);
    posthog.capture('georeference_set', { method: 'true_north' });
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
      // position.terrainHeight is the world altitude where the user wants the
      // base of the model — translate to OrthogonalHeight using the same
      // bounds/shift accounting as the auto-clamp path.
      fields.push({
        field: 'orthogonalHeight',
        value: oHeightForBaseAltitude(position.terrainHeight),
        oldValue: mergedConversion?.orthogonalHeight,
      });
    }
    setGeorefFields(modelId, 'mapConversion', fields);
    posthog.capture('georeference_set', {
      method: 'map_pick',
      has_terrain_height: position.terrainHeight !== null,
    });
    setConversionOpen(true);
    requestAlignmentReload();
  }, [modelId, setGeorefFields, mergedConversion, requestAlignmentReload, oHeightForBaseAltitude]);

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
  const editable = enableEditing && !!modelId && canUseStandardGeoreferencing;

  // When no georef data exists, show "Add Georeferencing" in edit mode
  if (!hasData && !georef?.hasGeoreference) {
    if (!editable) return null;
    return (
      <div className="px-2 py-1.5 flex items-center gap-2">
        <Globe className="h-3 w-3 text-teal-500" />
        <span className="text-xs text-zinc-500 dark:text-zinc-400 flex-1">{t('properties.georef.noGeoreferencing')}</span>
        <EpsgLookupDialog onSelect={handleEpsgSelect}>
          <button className="flex items-center gap-1 text-xs text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 transition-colors px-1.5 py-0.5 border border-teal-300/50 dark:border-teal-700/50 hover:bg-teal-50 dark:hover:bg-teal-950/50">
            <Globe className="h-2.5 w-2.5" />
            {t('properties.georef.addGeoreferencing')}
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
              <p className="text-xs text-zinc-700 dark:text-zinc-300">
                {t('properties.georef.reloadPrompt')}
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={reloadModelsForAlignment}
                  disabled={loading}
                  className="px-2 py-0.5 text-xs font-medium text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('properties.georef.reloadModels')}
                </button>
                <button
                  onClick={() => setShowReloadPrompt(false)}
                  className="px-2 py-0.5 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
                >
                  {t('properties.georef.later')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Only flag the legacy-site / unsupported-schema state when there is
          actually nothing extractable to show. If we have a projectedCRS or
          mapConversion (even partially), the data sections below speak for
          themselves — the schema notice is just noise that contradicts the
          live data the properties panel already renders. */}
      {!canUseStandardGeoreferencing && !mergedCRS && !mergedConversion && (
        <div className="px-3 py-1.5 flex items-center gap-2 border-b border-zinc-100 dark:border-zinc-900">
          <Globe className="h-3 w-3 text-zinc-400 shrink-0" />
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {isLegacySiteGeoreference
              ? t('properties.georef.legacySiteNotice')
              : t('properties.georef.unsupportedSchemaNotice')}
          </span>
        </div>
      )}
      {/* Federation alignment badge + anchor / re-align controls.
          Hidden when only one model is loaded — alignment is a federation concept. */}
      {modelId && models.size > 1 && <FederationAlignmentControls modelId={modelId} />}
      {/* CRS summary — always visible */}
      <div className="px-2 py-1.5 flex items-center gap-2">
        <Globe className="h-3 w-3 text-teal-500 shrink-0" />
        {mergedCRS?.name && (
          <span className="text-xs font-mono font-semibold text-teal-600 dark:text-teal-400">{mergedCRS.name}</span>
        )}
        {!mergedCRS?.name && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{t('properties.georef.noProjectedCrs')}</span>
        )}
        {mergedCRS?.description && (
          <span className="text-xs font-mono text-teal-500/60 truncate">{mergedCRS.description}</span>
        )}
        {mergedCRS?.name && <PrecisionGridBadge crsName={mergedCRS.name} />}
        {editable && (
          <EpsgLookupDialog onSelect={handleEpsgSelect}>
            <button className="flex items-center gap-1 text-xs text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors ml-auto shrink-0">
              <Search className="h-2.5 w-2.5" />
              {t('properties.georef.epsgButton')}
            </button>
          </EpsgLookupDialog>
        )}
      </div>

      {/* Doubly-georeferenced model (#2526). Informational, not a warning, and
          deliberately without an action: the model on screen is already
          correct — `effectiveMapConversionForGeometry` neutralised the
          duplicated conversion before anything was placed. An alarm here would
          tell the user their model is thousands of km out while they are
          looking at it in the right place, and a "fix it" button would only
          bake OUR substituted rotation into their authored data. Sits above the
          collapsibles because it explains a difference between the file and the
          view, which must not be hidden behind a collapsed section. */}
      {doubleGeoref && (
        <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-900 bg-sky-50/60 dark:bg-sky-950/25">
          <div className="flex items-start gap-1.5 text-xs text-sky-700 dark:text-sky-400">
            <Info className="h-3 w-3 mt-0.5 shrink-0" />
            <span className="leading-snug">
              <strong>{t('properties.georef.doubleGeorefHeading')}</strong>{' '}
              {t('properties.georef.doubleGeorefBody', {
                eastingValue: formatLocaleNumber(locale, doubleGeoref.worldCenter.x, { maximumFractionDigits: 0 }),
                northingValue: formatLocaleNumber(locale, doubleGeoref.worldCenter.y, { maximumFractionDigits: 0 }),
                displacement: localizedApproxDistance(t, locale, doubleGeoref.displacement),
              })}
              {/* The fingerprint matches on TRANSLATION, so when the file authors
                  a rotation of its own we are choosing the orientation, not
                  restating it. Say so rather than leaving it implicit. */}
              {doubleGeoref.overridesAuthoredRotation && <> {t('properties.georef.rotationOverrideNote')}</>}
              {' '}{localizedScaleOverride(t, locale, doubleGeoref)}
              {' '}
              {/* Zeroing the offsets is NOT enough when Scale is being
                  overridden: a spec-strict consumer reading the exported file
                  back would still multiply the map-sized coordinates by it. */}
              {localizedRawValuesNote(t, locale, doubleGeoref)}
            </span>
          </div>
        </div>
      )}

      {/* IfcProjectedCRS */}
      {mergedCRS && (
        <div>
          <button
            onClick={() => setCrsOpen(!crsOpen)}
            className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-left transition-colors border-b border-zinc-100 dark:border-zinc-900"
          >
            <ChevronRight className={`h-3 w-3 text-teal-500 shrink-0 transition-transform ${crsOpen ? 'rotate-90' : ''}`} />
            <Globe className="h-3 w-3 text-teal-500 shrink-0" />
            <span className="font-bold text-xs text-zinc-700 dark:text-zinc-300 uppercase tracking-wide flex-1 text-left">{t('properties.georef.projectedCrsHeading')}</span>
            {!crsOpen && mergedCRS.name && (
              <span className="text-xs font-mono text-teal-600/70 dark:text-teal-500/60 truncate max-w-[50%]">{mergedCRS.name}</span>
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
          <span className="text-xs text-zinc-500 dark:text-zinc-400 flex-1">{t('properties.georef.missingCrsNotice')}</span>
          <EpsgLookupDialog onSelect={handleEpsgSelect}>
            <button className="flex items-center gap-1 text-xs text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors shrink-0">
              <Search className="h-2.5 w-2.5" />
              {t('properties.georef.addCrs')}
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
            <span className="font-bold text-xs text-zinc-700 dark:text-zinc-300 uppercase tracking-wide flex-1 text-left">{t('properties.georef.coordinateOperationHeading')}</span>
            {/* A COMPENSATED scale deviation gets no warning glyph: nothing is
                mis-sized here, and an amber flag on a non-problem is what made
                the real defect in #2526 easy to miss. */}
            {scaleMismatch && !scaleMismatch.compensated && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertTriangle
                    className="h-3 w-3 text-amber-500 shrink-0"
                    aria-label={t('properties.georef.scaleInconsistentAriaLabel')}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  {t('properties.georef.scaleInconsistentTooltip')}
                </TooltipContent>
              </Tooltip>
            )}
            {!conversionOpen && (
              <span className="text-xs font-mono text-teal-600/70 dark:text-teal-500/60">
                {t('properties.georef.eastingNorthingSummary', { easting: formatLocaleNumber(locale, mergedConversion.eastings, { maximumFractionDigits: 0 }), northing: formatLocaleNumber(locale, mergedConversion.northings, { maximumFractionDigits: 0 }) })}
              </span>
            )}
          </button>
          {conversionOpen && (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
              <GeorefRow label="Type" value="IfcMapConversion" />
              <GeorefRow label="Eastings" value={mergedConversion.eastings} suffix={mapUnitSuffix} isNumber editable={editable} isMutated={isMutated('mapConversion', 'eastings')} fieldEntity="mapConversion" fieldName="eastings" onSave={v => handleSave('mapConversion', 'eastings', v)} />
              <GeorefRow label="Northings" value={mergedConversion.northings} suffix={mapUnitSuffix} isNumber editable={editable} isMutated={isMutated('mapConversion', 'northings')} fieldEntity="mapConversion" fieldName="northings" onSave={v => handleSave('mapConversion', 'northings', v)} />
              <GeorefRow label="OrthogonalHeight" value={mergedConversion.orthogonalHeight} suffix={mapUnitSuffix} isNumber editable={editable} isMutated={isMutated('mapConversion', 'orthogonalHeight')} fieldEntity="mapConversion" fieldName="orthogonalHeight" onSave={v => handleSave('mapConversion', 'orthogonalHeight', v)}>
                <TerrainHeightButton modelId={modelId} editable={editable} onApply={(h) => handleSave('mapConversion', 'orthogonalHeight', oHeightForBaseAltitude(h))} />
              </GeorefRow>
              <GeorefRow label="XAxisAbscissa" value={mergedConversion.xAxisAbscissa} isNumber editable={editable} isMutated={isMutated('mapConversion', 'xAxisAbscissa')} fieldEntity="mapConversion" fieldName="xAxisAbscissa" onSave={v => handleSave('mapConversion', 'xAxisAbscissa', v)} />
              <GeorefRow label="XAxisOrdinate" value={mergedConversion.xAxisOrdinate} isNumber editable={editable} isMutated={isMutated('mapConversion', 'xAxisOrdinate')} fieldEntity="mapConversion" fieldName="xAxisOrdinate" onSave={v => handleSave('mapConversion', 'xAxisOrdinate', v)} />
              <AngleRow angle={angleToGridNorth} editable={editable} onAngleChange={handleAngleChange} />
              <GeorefRow label="Scale" value={mergedConversion.scale} isNumber editable={editable} isMutated={isMutated('mapConversion', 'scale')} fieldEntity="mapConversion" fieldName="scale" onSave={v => handleSave('mapConversion', 'scale', v)} />
              {scaleMismatch && (
                <div className={`px-3 py-2 flex items-start gap-1.5 text-xs leading-snug ${
                  scaleMismatch.compensated
                    ? 'text-zinc-500 dark:text-zinc-400 bg-zinc-50/60 dark:bg-zinc-900/40'
                    : 'text-amber-600 dark:text-amber-400 bg-amber-50/50 dark:bg-amber-950/20'
                }`}>
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                  <span>
                    <strong>{t('properties.georef.scaleAttributeInconsistent', { attribute: scaleMismatch.attribute })}</strong>{' '}
                    {t('properties.georef.scaleCompensatedNote', {
                      attribute: scaleMismatch.attribute,
                      authoredValue: formatLocaleNumber(locale, scaleMismatch.authoredValue, { maximumSignificantDigits: 4 }),
                      expectedValue: formatLocaleNumber(locale, scaleMismatch.expectedValue, { maximumSignificantDigits: 4 }),
                    })}{' '}
                    {scaleMismatch.compensated
                      ? t('properties.georef.scaleCompensatedDetail', { specEffectiveScale: formatLocaleNumber(locale, scaleMismatch.specEffectiveScale, { maximumSignificantDigits: 4 }) })
                      : t('properties.georef.scaleUncompensatedDetail', {
                          effectiveScale: formatLocaleNumber(locale, scaleMismatch.effectiveScale, { maximumSignificantDigits: 4 }),
                          fixAttribute: scaleMismatch.attribute === 'Scale' ? t('properties.georef.scaleFixAttributeScale') : scaleMismatch.attribute,
                        })}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!mergedConversion && editable && mergedCRS && (
        <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-900 flex items-center gap-2">
          <span className="text-xs text-zinc-500 dark:text-zinc-400 flex-1">{t('properties.georef.noConversionNotice')}</span>
          <button
            onClick={initializeMapConversionDefaults}
            className="flex items-center gap-1 text-xs text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors shrink-0"
          >
            <MapPin className="h-2.5 w-2.5" />
            {t('properties.georef.addCoordinates')}
          </button>
        </div>
      )}

      {/* Sampled surface height — only when Cesium overlay is active */}
      {cesiumEnabled && isActiveCesiumModel && mergedConversion && (
        <div className="px-3 py-1.5 border-t border-zinc-100 dark:border-zinc-900 space-y-1">
          <div className="flex items-center gap-2">
            <Mountain className="h-3 w-3 text-teal-500 shrink-0" />
            <span className="text-xs text-zinc-600 dark:text-zinc-400 flex-1">{t('properties.georef.visibleSurfaceHeight')}</span>
            {cesiumTerrainHeight !== null ? (
              <span className="text-xs font-mono text-teal-500" title={cesiumTerrainSource ?? undefined}>
                {t('properties.georef.heightMeters', { value: formatLocaleNumber(locale, cesiumTerrainHeight, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}
              </span>
            ) : (
              <span className="text-xs font-mono text-zinc-400">{t('properties.georef.queryingEllipsis')}</span>
            )}
          </div>
          {cesiumTerrainSource && (
            <div className="ml-5 text-xs text-zinc-500 dark:text-zinc-400">
              {t('properties.georef.sampledVia', { source: cesiumTerrainSource })}
            </div>
          )}
          {cesiumTerrainHeight !== null && cesiumTerrainSaveHeight !== null && editable && modelId && (
            <div className="flex items-center gap-1 ml-5">
              <button
                onClick={() => handleSave('mapConversion', 'orthogonalHeight', oHeightForBaseAltitude(cesiumTerrainSaveHeight))}
                className="text-xs text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors flex items-center gap-0.5"
              >
                <Mountain className="h-2.5 w-2.5" />
                {t('properties.georef.setOrthogonalHeightButton', { value: formatLocaleNumber(locale, cesiumTerrainHeight, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}
              </button>
            </div>
          )}
          {/* Vertical-datum interpretation: OrthogonalHeight is orthometric by
              spec, so we add the geoid undulation N to convert it to the
              ellipsoidal height Cesium expects (default). Allow opting out for
              the rare file whose heights are already ellipsoidal (#1355). */}
          <label className="flex items-start gap-1.5 ml-5 cursor-pointer">
            <input
              type="checkbox"
              checked={heightsAreEllipsoidal}
              onChange={(e) => setHeightsAreEllipsoidal(e.target.checked)}
              className="mt-0.5 h-3 w-3 accent-teal-500 shrink-0"
            />
            <span className="text-xs text-zinc-600 dark:text-zinc-400 leading-snug">
              {t('properties.georef.heightsEllipsoidalLabel')}
              <span className="block text-zinc-400 dark:text-zinc-500">
                {t('properties.georef.heightsEllipsoidalHelp')}
              </span>
            </span>
          </label>
        </div>
      )}

      {/* Location minimap */}
      <LocationMap
        mapConversion={mergedConversion}
        projectedCRS={mergedCRS}
        coordinateInfo={coordinateInfo}
        // Withhold geometry (rather than fall through to an unfiltered, leaky export) when this
        // panel's model id hasn't resolved and more than one model is loaded — see `canExportKmz`.
        geometryResult={canExportKmz ? geometryResult : null}
        instancedModelRange={instancedModelRange}
        modelName={modelId ? models.get(modelId)?.name : undefined}
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
  const { t, locale } = useTranslation();
  const cesiumEnabled = useViewerStore(s => s.cesiumEnabled);
  const terrainHeight = useViewerStore(s => s.cesiumTerrainHeight);
  // Geoid-inverted snap target (#1456); display still uses terrainHeight.
  const terrainSaveHeight = useViewerStore(s => s.cesiumTerrainSaveHeight);
  const terrainSource = useViewerStore(s => s.cesiumTerrainSource);
  const sourceModelId = useViewerStore(s => s.cesiumSourceModelId);

  // Only show when this panel's model is the active Cesium model and the
  // geoid-corrected snap target is ready (#1456): never fall back to the raw
  // ellipsoidal sample, which would skip the correction.
  if (!cesiumEnabled || terrainHeight === null || terrainSaveHeight === null || !editable || !modelId || modelId !== sourceModelId) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onApply(terrainSaveHeight);
          }}
          className="flex items-center gap-0.5 text-xs text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors mt-0.5"
        >
          <Mountain className="h-2.5 w-2.5" />
          <span>{t('properties.georef.heightMeters', { value: formatLocaleNumber(locale, terrainHeight, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {terrainSource
          ? t('properties.georef.setOrthogonalHeightTooltipViaSource', { value: formatLocaleNumber(locale, terrainHeight, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), source: terrainSource })
          : t('properties.georef.setOrthogonalHeightTooltip', { value: formatLocaleNumber(locale, terrainHeight, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}
      </TooltipContent>
    </Tooltip>
  );
}
