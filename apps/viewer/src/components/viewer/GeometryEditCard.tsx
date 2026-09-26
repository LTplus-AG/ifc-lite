/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inline geometry editor for the Properties panel. Surfaces the
 * three IFC-level mutations every authoring user reaches for:
 *
 *   - Move — numeric XYZ for the entity's storey-local origin, with
 *     ±step quick buttons on each axis.
 *   - Duplicate — clone the entity along a picked axis (reuses
 *     `MutationSlice.duplicateEntity` so the new geometry shares the
 *     existing representation reference).
 *   - Delete — tombstone the entity (`MutationSlice.removeEntity`),
 *     undoable from the same model's history stack.
 *
 * Move reads the entity's existing IfcCartesianPoint coordinates via
 * `resolvePlacementChain` and writes back through
 * `MutationSlice.setEntityPosition` / `translateEntity`. Entities
 * whose placement isn't a simple `IfcLocalPlacement` chain (mapped
 * representations, missing ObjectPlacement, 2D-only placements)
 * render the card with a single explanatory message and disabled
 * Move controls — the Duplicate and Delete actions still work.
 *
 * Card only renders when the global `editEnabled` pill is on. Native-
 * lazy selections (server-streamed entities without full STEP data)
 * never see this card — the parent panel gates the entire edit
 * surface on `!isNativeLazySelection`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Move as MoveIcon, RotateCw, Slice as KnifeIcon, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { GeometryAxisRow } from './GeometryAxisRow';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';

interface GeometryEditCardProps {
  modelId: string;
  entityId: number;
  /** Display label — e.g. "IfcWall #42". Surfaced in toasts. */
  entityLabel?: string;
}

/**
 * Read the current placement coordinates for the entity via the
 * mutation slice's `readEntityPosition` action — which lazily
 * creates the `StoreEditor` on first call, so this works on a
 * freshly-loaded model that hasn't seen any mutations yet. Returns
 * null when the chain doesn't match the expected shape (entities
 * with mapped representations etc.), which the UI translates into
 * a disabled Move state.
 */
function useEntityCoordinates(
  modelId: string,
  entityId: number,
): [number, number, number] | null {
  // Re-resolve whenever the model's mutation version bumps — a
  // previous Move in this same session must surface in the inputs
  // on the next render.
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const readEntityPosition = useViewerStore((s) => s.readEntityPosition);
  return useMemo(() => {
    return readEntityPosition(modelId, entityId);
    // mutationVersion is the dependency that forces re-resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, entityId, mutationVersion, readEntityPosition]);
}

const STEP_PRESETS = [0.1, 0.5, 1];

export function GeometryEditCard({ modelId, entityId, entityLabel }: GeometryEditCardProps) {
  const { t } = useTranslation();
  const setEntityPosition = useViewerStore((s) => s.setEntityPosition);
  const translateEntity = useViewerStore((s) => s.translateEntity);
  const rotateEntity = useViewerStore((s) => s.rotateEntity);
  const readEntityRotation = useViewerStore((s) => s.readEntityRotation);
  const duplicateEntity = useViewerStore((s) => s.duplicateEntity);
  const removeEntity = useViewerStore((s) => s.removeEntity);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);

  const coordinates = useEntityCoordinates(modelId, entityId);
  const movable = coordinates !== null;

  const [expanded, setExpanded] = useState(true);
  const [step, setStep] = useState<number>(0.5);
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [z, setZ] = useState('');
  // Track which entity the inputs were last seeded for so we don't
  // clobber an in-progress edit when the user types into X then the
  // mutationVersion bumps from an unrelated mutation.
  const seededForRef = useRef<string>('');

  useEffect(() => {
    const key = `${modelId}:${entityId}:${coordinates?.join(',') ?? 'none'}`;
    if (seededForRef.current === key) return;
    seededForRef.current = key;
    if (coordinates) {
      setX(coordinates[0].toString());
      setY(coordinates[1].toString());
      setZ(coordinates[2].toString());
    } else {
      setX(''); setY(''); setZ('');
    }
  }, [modelId, entityId, coordinates]);

  const applyAbsolute = useCallback(() => {
    const parsed: [number, number, number] = [parseFloat(x), parseFloat(y), parseFloat(z)];
    if (parsed.some((n) => !Number.isFinite(n))) {
      toast.error(t('geometryExport.editCard.enterNumericError'));
      return;
    }
    const result = setEntityPosition(modelId, entityId, parsed);
    if (!result.ok) {
      toast.error(t('geometryExport.editCard.moveFailedError', { reason: result.reason }));
      return;
    }
    toast.success(t('geometryExport.editCard.movedSuccess', { coordinates: parsed.map((n) => n.toFixed(2)).join(', ') }));
  }, [modelId, entityId, x, y, z, setEntityPosition, t]);

  const nudge = useCallback(
    (axis: 0 | 1 | 2, sign: 1 | -1) => {
      const delta: [number, number, number] = [0, 0, 0];
      delta[axis] = sign * step;
      const result = translateEntity(modelId, entityId, delta);
      if (!result.ok) {
        toast.error(t('geometryExport.editCard.moveFailedError', { reason: result.reason }));
        return;
      }
    },
    [modelId, entityId, step, translateEntity, t],
  );

  // Live rotation read — re-pulls after each mutation so the angle
  // display tracks R/T keyboard rotations and gizmo drags.
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const rotation = useMemo(() => {
    return readEntityRotation(modelId, entityId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, entityId, mutationVersion, readEntityRotation]);
  const yawDegrees = rotation ? (rotation.yawZ * 180) / Math.PI : null;

  const rotateBy = useCallback(
    (deltaDeg: number) => {
      const result = rotateEntity(modelId, entityId, (deltaDeg * Math.PI) / 180);
      if (!result.ok) {
        toast.error(t('geometryExport.editCard.rotateFailedError', { reason: result.reason }));
      }
    },
    [modelId, entityId, rotateEntity, t],
  );

  // Resolve whether the selected entity can be split. Three paths:
  // walls, linear elements (beam / column / member), and slab-like
  // (slab / roof / plate / space — only slab supports split in v1
  // but the chain resolver accepts all four). The Split action
  // surfaces only when the entity matches one of them — keeps
  // panel chrome out of the user's way for unrelated selections.
  const readWallEndpoints = useViewerStore((s) => s.readWallEndpoints);
  const readLinearElementSplitProjection = useViewerStore((s) => s.readLinearElementSplitProjection);
  const readSlabFootprint = useViewerStore((s) => s.readSlabFootprint);
  const splittable = useMemo(() => {
    if (readWallEndpoints(modelId, entityId) !== null) return true;
    // Probe with [0,0,0] — we only care whether the chain resolves,
    // not the projection value.
    if (readLinearElementSplitProjection(modelId, entityId, [0, 0, 0]) !== null) return true;
    // Slab-like types (IfcSlab / IfcRoof / IfcPlate / IfcSpace)
    // all share the same chain shape; any of them is splittable.
    return readSlabFootprint(modelId, entityId) !== null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    modelId,
    entityId,
    mutationVersion,
    readWallEndpoints,
    readLinearElementSplitProjection,
    readSlabFootprint,
  ]);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const setSplitTarget = useViewerStore((s) => s.setSplitTarget);
  const onSplit = useCallback(() => {
    // Arm the tool with this entity pre-targeted so the user's next
    // cursor move lights up the guide. setActiveTool('split')
    // auto-enables edit mode if needed.
    setSplitTarget(modelId, entityId);
    setActiveTool('split');
  }, [modelId, entityId, setActiveTool, setSplitTarget]);

  const onDuplicate = useCallback(() => {
    const result = duplicateEntity(modelId, entityId);
    if ('error' in result) {
      toast.error(t('geometryExport.editCard.duplicateFailedError', { reason: result.error }));
      return;
    }
    toast.success(t('geometryExport.editCard.duplicatedSuccess', { expressId: result.expressId }));
    // Select the duplicate so the user can immediately move it. The
    // action already returns the federated globalId so we don't have
    // to recompute it.
    setSelectedEntityId(result.globalId);
  }, [modelId, entityId, duplicateEntity, setSelectedEntityId, t]);

  const onDelete = useCallback(() => {
    const ok = removeEntity(modelId, entityId);
    if (!ok) {
      toast.error(t('geometryExport.editCard.deleteFailedError'));
      return;
    }
    toast.success(t('geometryExport.editCard.deletedSuccess', { entityLabel: entityLabel ?? `#${entityId}` }));
    setSelectedEntityId(null);
  }, [modelId, entityId, entityLabel, removeEntity, setSelectedEntityId, t]);

  return (
    <div className="border border-overlay-accent/40 bg-overlay-accent/5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full text-left px-2 py-1.5 text-xs font-semibold tracking-wide uppercase text-foreground hover:bg-overlay-accent-soft"
        aria-expanded={expanded}
      >
        <MoveIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{t('geometryExport.editCard.header')}</span>
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {expanded && (
        <div className="px-2 pb-2 space-y-2">
          {/* Position — XYZ inputs + ±step nudges */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
              <span>{t('geometryExport.editCard.positionSectionLabel')}</span>
              <select
                value={step}
                onChange={(e) => setStep(parseFloat(e.target.value))}
                className="bg-transparent border border-overlay-accent/40 px-1 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-overlay-accent"
                aria-label={t('geometryExport.editCard.nudgeStepAriaLabel')}
                disabled={!movable}
              >
                {STEP_PRESETS.map((s) => (
                  <option key={s} value={s}>{t('geometryExport.editCard.nudgeStepOption', { step: s })}</option>
                ))}
              </select>
            </div>
            {!movable ? (
              <p className="text-[11px] text-muted-foreground">
                {t('geometryExport.editCard.nonStandardPlacementHint')}
              </p>
            ) : (
              <>
                <GeometryAxisRow
                  label={t('geometryExport.editCard.axisX')}
                  value={x}
                  onChange={setX}
                  onNudgeMinus={() => nudge(0, -1)}
                  onNudgePlus={() => nudge(0, 1)}
                />
                <GeometryAxisRow
                  label={t('geometryExport.editCard.axisY')}
                  value={y}
                  onChange={setY}
                  onNudgeMinus={() => nudge(1, -1)}
                  onNudgePlus={() => nudge(1, 1)}
                />
                <GeometryAxisRow
                  label={t('geometryExport.editCard.axisZ')}
                  value={z}
                  onChange={setZ}
                  onNudgeMinus={() => nudge(2, -1)}
                  onNudgePlus={() => nudge(2, 1)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-7 text-xs border-overlay-accent/40"
                  onClick={applyAbsolute}
                >
                  {t('geometryExport.editCard.applyXyzButton')}
                </Button>
              </>
            )}
          </div>

          {/* Rotation — yaw about storey-up Z. R / Shift+R fire the
              same action; this row gives the discoverable UI plus a
              readout for the current angle. */}
          {rotation && (
            <div className="flex items-center gap-1 pt-1 border-t border-overlay-accent/40">
              <RotateCw className="h-3 w-3 shrink-0 text-overlay-accent" />
              <span className="text-[11px] font-mono text-foreground flex-1">
                {yawDegrees !== null
                  ? t('geometryExport.editCard.yawReadout', { degrees: yawDegrees.toFixed(1) })
                  : t('geometryExport.editCard.yawReadoutEmpty')}
              </span>
              <IconButton
                label={t('geometryExport.editCard.rotateMinus15AriaLabel')}
                tooltip={t('geometryExport.editCard.rotateMinus15Tooltip')}
                variant="ghost"
                size="icon-xs"
                className="h-6 w-6 text-overlay-accent"
                onClick={() => rotateBy(-15)}
              >
                ⟲
              </IconButton>
              <IconButton
                label={t('geometryExport.editCard.rotatePlus15AriaLabel')}
                tooltip={t('geometryExport.editCard.rotatePlus15Tooltip')}
                variant="ghost"
                size="icon-xs"
                className="h-6 w-6 text-overlay-accent"
                onClick={() => rotateBy(15)}
              >
                ⟳
              </IconButton>
              <IconButton
                label={t('geometryExport.editCard.rotatePlus90AriaLabel')}
                tooltip={t('geometryExport.editCard.rotatePlus90Tooltip')}
                variant="ghost"
                size="icon-xs"
                className="h-6 w-6 text-overlay-accent"
                onClick={() => rotateBy(90)}
              >
                90
              </IconButton>
            </div>
          )}

          {/* Actions — split (when applicable) + duplicate + delete.
              Available even when Move isn't. Split surfaces only
              for resizable walls so the panel stays uncluttered
              for selections where the action doesn't apply. */}
          <div className="flex items-center gap-1 pt-1 border-t border-overlay-accent/40">
            {splittable && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 flex-1 text-xs"
                    onClick={onSplit}
                  >
                    <KnifeIcon className="h-3 w-3 mr-1" /> {t('geometryExport.editCard.splitButton')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('geometryExport.editCard.splitTooltip')}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 flex-1 text-xs"
                  onClick={onDuplicate}
                >
                  <Copy className="h-3 w-3 mr-1" /> {t('geometryExport.editCard.duplicateButton')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('geometryExport.editCard.duplicateTooltip')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 flex-1 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                  onClick={onDelete}
                >
                  <Trash2 className="h-3 w-3 mr-1" /> {t('geometryExport.editCard.deleteButton')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('geometryExport.editCard.deleteTooltip')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
}
