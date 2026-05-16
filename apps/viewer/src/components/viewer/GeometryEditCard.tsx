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
import { Copy, Move as MoveIcon, RotateCw, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';

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
      toast.error('Enter numeric X, Y, Z coordinates');
      return;
    }
    const result = setEntityPosition(modelId, entityId, parsed);
    if (!result.ok) {
      toast.error(`Couldn't move: ${result.reason}`);
      return;
    }
    toast.success(`Moved to (${parsed.map((n) => n.toFixed(2)).join(', ')})`);
  }, [modelId, entityId, x, y, z, setEntityPosition]);

  const nudge = useCallback(
    (axis: 0 | 1 | 2, sign: 1 | -1) => {
      const delta: [number, number, number] = [0, 0, 0];
      delta[axis] = sign * step;
      const result = translateEntity(modelId, entityId, delta);
      if (!result.ok) {
        toast.error(`Couldn't move: ${result.reason}`);
        return;
      }
    },
    [modelId, entityId, step, translateEntity],
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
        toast.error(`Couldn't rotate: ${result.reason}`);
      }
    },
    [modelId, entityId, rotateEntity],
  );

  const onDuplicate = useCallback(() => {
    const result = duplicateEntity(modelId, entityId);
    if ('error' in result) {
      toast.error(`Couldn't duplicate: ${result.error}`);
      return;
    }
    toast.success(`Duplicated to #${result.expressId}`);
    // Select the duplicate so the user can immediately move it. The
    // action already returns the federated globalId so we don't have
    // to recompute it.
    setSelectedEntityId(result.globalId);
  }, [modelId, entityId, duplicateEntity, setSelectedEntityId]);

  const onDelete = useCallback(() => {
    const ok = removeEntity(modelId, entityId);
    if (!ok) {
      toast.error("Couldn't delete entity");
      return;
    }
    toast.success(`${entityLabel ?? `#${entityId}`} deleted — undo to restore`);
    setSelectedEntityId(null);
  }, [modelId, entityId, entityLabel, removeEntity, setSelectedEntityId]);

  return (
    <div className="border border-purple-200 dark:border-purple-900/40 bg-purple-50/40 dark:bg-purple-950/20">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full text-left px-2 py-1.5 text-xs font-semibold tracking-wide uppercase text-purple-800 dark:text-purple-300 hover:bg-purple-100/60 dark:hover:bg-purple-900/30"
        aria-expanded={expanded}
      >
        <MoveIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">Geometry</span>
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {expanded && (
        <div className="px-2 pb-2 space-y-2">
          {/* Position — XYZ inputs + ±step nudges */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-purple-700/80 dark:text-purple-400/80">
              <span>Storey-local position (IFC Z-up)</span>
              <select
                value={step}
                onChange={(e) => setStep(parseFloat(e.target.value))}
                className="bg-transparent border border-purple-300 dark:border-purple-700 px-1 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-purple-500"
                aria-label="Nudge step in metres"
                disabled={!movable}
              >
                {STEP_PRESETS.map((s) => (
                  <option key={s} value={s}>±{s} m</option>
                ))}
              </select>
            </div>
            {!movable ? (
              <p className="text-[11px] text-purple-700/70 dark:text-purple-400/70">
                Entity has a non-standard placement (mapped representation
                or 2D-only). Move isn't supported directly — Duplicate and
                Delete still work.
              </p>
            ) : (
              <>
                <AxisRow
                  label="X"
                  value={x}
                  onChange={setX}
                  onNudgeMinus={() => nudge(0, -1)}
                  onNudgePlus={() => nudge(0, 1)}
                />
                <AxisRow
                  label="Y"
                  value={y}
                  onChange={setY}
                  onNudgeMinus={() => nudge(1, -1)}
                  onNudgePlus={() => nudge(1, 1)}
                />
                <AxisRow
                  label="Z"
                  value={z}
                  onChange={setZ}
                  onNudgeMinus={() => nudge(2, -1)}
                  onNudgePlus={() => nudge(2, 1)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-7 text-xs border-purple-300 dark:border-purple-700"
                  onClick={applyAbsolute}
                >
                  Apply XYZ
                </Button>
              </>
            )}
          </div>

          {/* Rotation — yaw about storey-up Z. R / Shift+R fire the
              same action; this row gives the discoverable UI plus a
              readout for the current angle. */}
          {rotation && (
            <div className="flex items-center gap-1 pt-1 border-t border-purple-200/60 dark:border-purple-900/40">
              <RotateCw className="h-3 w-3 shrink-0 text-purple-700 dark:text-purple-400" />
              <span className="text-[11px] font-mono text-purple-800 dark:text-purple-300 flex-1">
                yaw {yawDegrees !== null ? `${yawDegrees.toFixed(1)}°` : '—'}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="h-6 w-6 text-purple-700"
                    onClick={() => rotateBy(-15)}
                    aria-label="Rotate −15°"
                  >
                    ⟲
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Rotate −15° (Shift+R)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="h-6 w-6 text-purple-700"
                    onClick={() => rotateBy(15)}
                    aria-label="Rotate +15°"
                  >
                    ⟳
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Rotate +15° (R)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="h-6 w-6 text-purple-700"
                    onClick={() => rotateBy(90)}
                    aria-label="Rotate +90°"
                  >
                    90
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Rotate +90°</TooltipContent>
              </Tooltip>
            </div>
          )}

          {/* Actions — duplicate + delete. Available even when Move isn't. */}
          <div className="flex items-center gap-1 pt-1 border-t border-purple-200/60 dark:border-purple-900/40">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 flex-1 text-xs"
                  onClick={onDuplicate}
                >
                  <Copy className="h-3 w-3 mr-1" /> Duplicate
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clone the entity along its first axis</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 flex-1 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                  onClick={onDelete}
                >
                  <Trash2 className="h-3 w-3 mr-1" /> Delete
                </Button>
              </TooltipTrigger>
              <TooltipContent>Tombstone the entity — undo to restore</TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
}

interface AxisRowProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onNudgeMinus: () => void;
  onNudgePlus: () => void;
}

function AxisRow({ label, value, onChange, onNudgeMinus, onNudgePlus }: AxisRowProps) {
  return (
    <div className="flex items-center gap-1">
      <span className="w-4 text-[11px] font-mono text-purple-700 dark:text-purple-400">{label}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="h-6 w-6 text-purple-600"
        onClick={onNudgeMinus}
        aria-label={`Decrease ${label}`}
      >
        −
      </Button>
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 text-xs font-mono px-1 flex-1 border-purple-200 dark:border-purple-800/60 bg-white dark:bg-zinc-950"
        step="any"
      />
      <Button
        variant="ghost"
        size="icon-xs"
        className="h-6 w-6 text-purple-600"
        onClick={onNudgePlus}
        aria-label={`Increase ${label}`}
      >
        +
      </Button>
    </div>
  );
}
