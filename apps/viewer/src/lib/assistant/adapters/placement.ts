/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model placement and georeference as evidence (#6833): one row per loaded
 * model with its committed workspace move/heading (`modelPlacement`), its
 * effective georeference (file values plus this session's georeference edits,
 * `getEffectiveGeoreference`, the reader every placement consumer shares) and
 * whether the file georeferences it twice (`detectDoubleGeoreference`, the
 * same predicate the geometry correction fires on).
 *
 * Pure store reads, no React: the Georeference tab's runtime context
 * (`usePlacementGeorefContext`) is only the active model's copy of these same
 * values. `MapConversion` / `ProjectedCRS` keep their frozen field names.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import { getEffectiveGeoreference } from '@/lib/geo/effective-georef';
import { detectDoubleGeoreference } from '@/lib/geo/double-georeference';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

type GeoreferenceStatus = 'present' | 'absent' | 'unknown';

/** Without its STEP source (or a pre-extracted result) a store cannot say whether it is georeferenced. */
function georeferenceKnowable(store: IfcDataStore | null | undefined): store is IfcDataStore {
  return Boolean(store && (store.georeferencing !== undefined || (store.source?.length && store.entityIndex)));
}

function modelRow(s: ViewerState, modelId: string) {
  const model = s.models.get(modelId);
  const store = model?.ifcDataStore as IfcDataStore | null | undefined;
  const coordinateInfo = model?.geometryResult?.coordinateInfo;
  const placement = placementFor(s.modelPlacement, modelId);
  const knowable = georeferenceKnowable(store);
  const eff = knowable ? getEffectiveGeoreference(store, coordinateInfo, s.georefMutations.get(modelId)) : null;
  const status: GeoreferenceStatus = !knowable ? 'unknown' : eff ? 'present' : 'absent';
  const conversion = eff?.mapConversion;
  const crs = eff?.projectedCRS;
  const double = eff ? detectDoubleGeoreference(conversion, crs, coordinateInfo, eff.lengthUnitScale) : null;
  return evidenceRow({ kind: 'model-placement', modelId, status: `georeference-${status}`, unit: 'm' }, {
    name: model?.name ?? modelId,
    localPlacement: {
      translation: [...placement.translation],
      // A move being previewed is not committed; both are stated.
      previewTranslation: s.modelPlacement.preview?.before.has(modelId) ? [...displayedTranslation(s.modelPlacement, modelId)] : null,
      rotationRadians: placement.rotation.angle,
      rotationPivot: [...placement.rotation.pivot],
      locked: placement.locked,
      frame: 'workspace engineering axes, Z up, metres; rotation is a yaw about Z, counter-clockwise from above',
    },
    federationAlignmentStatus: model?.federationAlignmentStatus ?? null,
    georeferencePresent: status === 'unknown' ? null : status === 'present',
    georeferenceSource: eff?.source ?? null,
    georeferenceEdited: s.georefMutations.has(modelId),
    projectedCRS: crs ? {
      name: crs.name, geodeticDatum: crs.geodeticDatum ?? null, verticalDatum: crs.verticalDatum ?? null,
      mapProjection: crs.mapProjection ?? null, mapZone: crs.mapZone ?? null, mapUnit: crs.mapUnit ?? null,
      mapUnitScale: crs.mapUnitScale ?? null,
    } : null,
    mapConversion: conversion ? {
      eastings: conversion.eastings, northings: conversion.northings, orthogonalHeight: conversion.orthogonalHeight,
      xAxisAbscissa: conversion.xAxisAbscissa ?? null, xAxisOrdinate: conversion.xAxisOrdinate ?? null,
      scale: conversion.scale ?? null, unit: crs?.mapUnit ?? 'map unit not declared',
    } : null,
    lengthUnitScale: eff?.lengthUnitScale ?? null,
    // Null when it cannot be evaluated (no geometry bounds or no conversion), not "clean".
    doubleGeoreference: !conversion || !coordinateInfo ? null : double ? {
      detected: true, residualMetres: double.residual, offsetMetres: double.offset,
      overridesAuthoredRotation: double.overridesAuthoredRotation,
      displacementMetres: Number.isFinite(double.displacement) ? double.displacement : null,
    } : { detected: false },
  });
}

export const placementAdapter: EvidenceAdapter = {
  id: 'placement', group: 'coordination', panelIds: ['placement'],
  titleKey: 'placementPanel.title', descriptionKey: 'assistantSources.placement.description',
  rowMeaningKey: 'assistantSources.placement.rows', unavailableKey: 'assistantSources.placement.unavailable',
  suggestionKeys: ['assistantSources.placement.suggestAlignment', 'assistantSources.placement.suggestGeoref'],
  readiness: s => s.models.size
    ? { status: { labelKey: 'assistant.pickModels', params: { count: s.models.size } }, ready: true }
    : { status: { labelKey: 'assistant.pickNoModels' }, ready: false },
  // Georeference edits also bump mutationVersion, which the context stamp covers.
  identity: s => [s.models, s.modelPlacement, s.georefMutations],
  capture: (s, limit) => {
    if (s.models.size === 0) return unavailableCapture();
    const ids = [...s.models.keys()];
    const rows = ids.slice(0, limit).map(id => modelRow(s, id));
    return {
      summary: {
        kind: 'model-placement', modelCount: ids.length,
        movedModels: ids.filter(id => placementFor(s.modelPlacement, id).translation.some(v => v !== 0)).length,
        rotatedModels: ids.filter(id => placementFor(s.modelPlacement, id).rotation.angle !== 0).length,
        repositionInProgress: s.modelPlacement.preview !== null,
        // An explicit Re-align decision; null means the workspace frame is derived live from the anchor model.
        realignedFrameKey: s.modelPlacement.realignedFrameKey,
        units: { translation: 'm', rotation: 'rad', mapConversion: 'map unit of the projected CRS (mapUnit; metres when undeclared)' },
        limitations: 'Placement is the workspace move/heading committed in this session, not an edit of the IFC file. Georeference is the effective IfcMapConversion/IfcProjectedCRS including unsaved edits. georeferencePresent null means the model data cannot say (no STEP source), not that it is absent. doubleGeoreference null means it could not be evaluated. The legacy single-model channel is not listed.',
      },
      rows, totalRows: ids.length, availability: 'available',
    };
  },
};
