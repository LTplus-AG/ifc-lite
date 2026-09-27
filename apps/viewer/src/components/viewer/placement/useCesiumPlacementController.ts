/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The georeference edit session's non-visual state: the live draft, its
 * deltas against the saved anchor, the map-absolute guard, and the
 * apply/reset/nudge actions. Extracted from the former `CesiumPlacementEditor`
 * monolith (#5505) so both halves that need it — `CesiumPlacementGizmo` (the
 * scene-mounted drag handles, which also needs screen projection) and
 * `GeoreferenceTab` (the docked `placement` panel's content) — read the same
 * derived numbers without duplicating the map-absolute-guard math. The
 * underlying draft itself already lives in the store (`cesiumPlacementDraft`),
 * so two independent calls to this hook stay in lock-step for free.
 */
import { useCallback, useEffect, useMemo } from 'react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { getMapUnitScale, metersToMapUnits } from '@/lib/geo/cesium-placement';
import { effectiveMapConversionForGeometry } from '@/lib/geo/map-absolute';
import { useViewerStore, type CesiumPlacementDraft } from '@/store';
import { axisAngleDegrees, axisFromAngleDegrees, normalizeDegrees, round2 } from './cesium-placement-math';

export interface CesiumPlacementControllerProps {
  modelId: string;
  mapConversion: MapConversion;
  baseMapConversion: MapConversion;
  projectedCRS?: ProjectedCRS;
  coordinateInfo?: CoordinateInfo;
  lengthUnitScale?: number;
}

export function useCesiumPlacementController({
  modelId,
  mapConversion,
  baseMapConversion,
  projectedCRS,
  coordinateInfo,
  lengthUnitScale = 1,
}: CesiumPlacementControllerProps) {
  const { t } = useTranslation();
  const editMode = useViewerStore((s) => s.cesiumPlacementEditMode);
  const draftModelId = useViewerStore((s) => s.cesiumPlacementDraftModelId);
  const draft = useViewerStore((s) => s.cesiumPlacementDraft);
  const beginDraft = useViewerStore((s) => s.beginCesiumPlacementDraft);
  const updateDraft = useViewerStore((s) => s.updateCesiumPlacementDraft);
  const resetDraft = useViewerStore((s) => s.resetCesiumPlacementDraft);
  const setEditMode = useViewerStore((s) => s.setCesiumPlacementEditMode);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const setGeorefFields = useViewerStore((s) => s.setGeorefFields);

  // Bootstrap a real draft in the store as soon as editing starts. Without
  // this, `activeDraft` below falls into its ELSE branch (a fresh object
  // literal every render, since there is no stored draft to reuse) and never
  // stabilizes — other hooks/memos derived from it (the gizmo's screen
  // projection, `guardConversion`) never stabilize either, so an unstable
  // `activeDraft` free-runs downstream renders into an infinite loop (caught
  // the hard way by `CesiumPlacementGizmo.i18n.test.tsx` timing out at
  // "Maximum update depth exceeded", #5505). Two independent callers of this
  // hook (the gizmo and the Georeference tab) both run this effect; it is
  // idempotent per model.
  useEffect(() => {
    if (!editMode) return;
    if (draftModelId !== modelId || !draft) beginDraft(modelId, baseMapConversion);
  }, [baseMapConversion, beginDraft, draft, draftModelId, editMode, modelId]);

  const activeDraft: CesiumPlacementDraft = draftModelId === modelId && draft
    ? draft
    : {
        eastings: mapConversion.eastings,
        northings: mapConversion.northings,
        orthogonalHeight: mapConversion.orthogonalHeight,
        // MapConversion's cos/sin pair is optional; identity = no rotation.
        xAxisAbscissa: mapConversion.xAxisAbscissa ?? 1,
        xAxisOrdinate: mapConversion.xAxisOrdinate ?? 0,
      };

  const mapUnitScale = getMapUnitScale(projectedCRS, lengthUnitScale);
  const mapUnitSuffix = mapUnitScale === 1 ? 'm' : 'map units';
  const baseAngle = axisAngleDegrees(baseMapConversion);
  const activeAngle = axisAngleDegrees(activeDraft);
  const deltaE = activeDraft.eastings - baseMapConversion.eastings;
  const deltaN = activeDraft.northings - baseMapConversion.northings;
  const deltaH = activeDraft.orthogonalHeight - baseMapConversion.orthogonalHeight;
  const deltaAngle = normalizeDegrees(activeAngle - baseAngle);
  const dirty = Math.abs(deltaE) > 1e-6 || Math.abs(deltaN) > 1e-6 || Math.abs(deltaH) > 1e-6 || Math.abs(deltaAngle) > 1e-6;
  const nudgeStep = round2(metersToMapUnits(1, projectedCRS, lengthUnitScale));

  // See CesiumPlacementEditor's original note (still true): both the gizmo's
  // preview and the drag math must evaluate the map-absolute guard (#2526)
  // against the SAME anchor, `{ session baseline, ...current draft }`.
  const guardConversion: MapConversion = useMemo(
    () => ({ ...baseMapConversion, ...activeDraft }),
    [baseMapConversion, activeDraft],
  );

  const mapAbsoluteActive = useMemo(
    () => effectiveMapConversionForGeometry(guardConversion, mapUnitScale, coordinateInfo) !== guardConversion,
    [guardConversion, mapUnitScale, coordinateInfo],
  );

  const handleReset = useCallback(() => {
    beginDraft(modelId, baseMapConversion);
  }, [baseMapConversion, beginDraft, modelId]);

  const handleApply = useCallback(() => {
    if (!dirty) return;
    setGeorefFields(modelId, 'mapConversion', [
      { field: 'eastings', value: activeDraft.eastings, oldValue: baseMapConversion.eastings },
      { field: 'northings', value: activeDraft.northings, oldValue: baseMapConversion.northings },
      { field: 'orthogonalHeight', value: activeDraft.orthogonalHeight, oldValue: baseMapConversion.orthogonalHeight },
      // MapConversion's cos/sin pair is optional in the IFC schema; fall back
      // to the identity (1, 0) so the diff against an un-rotated source picks
      // up the new explicit rotation rather than skipping the field entirely.
      { field: 'xAxisAbscissa', value: activeDraft.xAxisAbscissa, oldValue: baseMapConversion.xAxisAbscissa ?? 1 },
      { field: 'xAxisOrdinate', value: activeDraft.xAxisOrdinate, oldValue: baseMapConversion.xAxisOrdinate ?? 0 },
    ]);
    resetDraft();
    toast.success(t('cesiumGeo.placement.toastApplied'));
  }, [activeDraft, baseMapConversion, dirty, modelId, resetDraft, setGeorefFields, t]);

  const nudge = useCallback((eastDelta: number, northDelta: number) => {
    updateDraft({
      eastings: round2(activeDraft.eastings + eastDelta),
      northings: round2(activeDraft.northings + northDelta),
    });
  }, [activeDraft.eastings, activeDraft.northings, updateDraft]);

  const nudgeHeight = useCallback((heightDelta: number) => {
    updateDraft({ orthogonalHeight: round2(activeDraft.orthogonalHeight + heightDelta) });
  }, [activeDraft.orthogonalHeight, updateDraft]);

  const nudgeRotation = useCallback((angleDelta: number) => {
    updateDraft(axisFromAngleDegrees(activeAngle + angleDelta));
  }, [activeAngle, updateDraft]);

  const handleClose = useCallback(() => {
    setEditMode(false);
    setActiveTool('select');
    resetDraft();
  }, [resetDraft, setActiveTool, setEditMode]);

  const beginEditing = useCallback(() => {
    setEditMode(true);
  }, [setEditMode]);

  return {
    editMode, draftModelId, draft, activeDraft, updateDraft, beginDraft,
    mapUnitScale, mapUnitSuffix, activeAngle, deltaE, deltaN, deltaH, deltaAngle,
    dirty, nudgeStep, guardConversion, mapAbsoluteActive,
    handleReset, handleApply, handleClose, beginEditing,
    nudge, nudgeHeight, nudgeRotation,
  };
}

export type CesiumPlacementController = ReturnType<typeof useCesiumPlacementController>;
