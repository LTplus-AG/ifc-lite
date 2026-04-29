/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Add Element panel — right-side authoring surface for dropping
 * walls / slabs / beams / columns onto a parsed model. Tool-driven
 * (rendered when `activeTool === 'addElement'`); the actual drop
 * happens on a 3D click handled in `selectionHandlers.ts`.
 *
 * Activation only via the command palette — no menubar button. The
 * tool stays active across drops so the user can place several
 * elements in a row; Esc returns to the select tool.
 */

import { useEffect, useMemo } from 'react';
import { Box, Cog, DoorOpen, Home, Layers, Minus, Square, SquareDashedBottom, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { EntityNode } from '@ifc-lite/query';
import type { AddElementType } from '@/store/slices/addElementSlice';

interface ElementOption {
  type: AddElementType;
  label: string;
  Icon: typeof Box;
  /** Short description shown below the type chips. */
  hint: string;
}

const ELEMENT_OPTIONS: ElementOption[] = [
  { type: 'wall', label: 'Wall', Icon: Minus, hint: 'Click Start, then End. Cross-section = Thickness × Height, profile spans the click-to-click axis.' },
  { type: 'slab', label: 'Slab', Icon: Square, hint: 'Rectangle: 2 corner clicks. Polygon: N clicks + Enter to close. Extruded up by Thickness.' },
  { type: 'beam', label: 'Beam', Icon: Layers, hint: 'Click Start, then End. Cross-section (Width × Height) is centred on the beam axis.' },
  { type: 'column', label: 'Column', Icon: Box, hint: 'Single click sets the base centre. Width × Depth cross-section, extruded up by Height.' },
  { type: 'door', label: 'Door', Icon: DoorOpen, hint: 'Single click sets the bottom-centre. Width × Height leaf with a thin frame depth. Free-standing — refine wall hosting via Raw STEP if needed.' },
  { type: 'window', label: 'Window', Icon: SquareDashedBottom, hint: 'Single click sets the sill-centre. Width × Height sash with a thin frame depth.' },
  { type: 'space', label: 'Space', Icon: Home, hint: 'Rectangle: 2 corner clicks. Polygon: N clicks + Enter. Extruded up by Height into a room volume; aggregated to the storey via IfcRelAggregates.' },
  { type: 'roof', label: 'Roof', Icon: Square, hint: 'Same shape as a slab — flat-roof emit with .FLAT_ROOF. PredefinedType. Pitched roofs need IfcCreator.addIfcGableRoof.' },
  { type: 'plate', label: 'Plate', Icon: Square, hint: 'Thin flat plate (steel / gusset). Rectangle or polygon profile, extruded by Thickness.' },
  { type: 'member', label: 'Member', Icon: Cog, hint: 'Generic structural member (brace, post, strut). Click Start, then End. Pick PredefinedType to set role.' },
];

interface StoreyOption {
  expressId: number;
  label: string;
}

interface AddElementPanelProps {
  onClose: () => void;
}

export function AddElementPanel({ onClose }: AddElementPanelProps) {
  const { models, ifcDataStore } = useIfc();

  const addElementType = useViewerStore((s) => s.addElementType);
  const setAddElementType = useViewerStore((s) => s.setAddElementType);

  const addElementModelId = useViewerStore((s) => s.addElementModelId);
  const setAddElementModelId = useViewerStore((s) => s.setAddElementModelId);
  const addElementStoreyId = useViewerStore((s) => s.addElementStoreyId);
  const setAddElementStoreyId = useViewerStore((s) => s.setAddElementStoreyId);

  const wallParams = useViewerStore((s) => s.addElementWallParams);
  const setWallParams = useViewerStore((s) => s.setAddElementWallParams);
  const slabParams = useViewerStore((s) => s.addElementSlabParams);
  const setSlabParams = useViewerStore((s) => s.setAddElementSlabParams);
  const beamParams = useViewerStore((s) => s.addElementBeamParams);
  const setBeamParams = useViewerStore((s) => s.setAddElementBeamParams);
  const columnParams = useViewerStore((s) => s.addElementColumnParams);
  const setColumnParams = useViewerStore((s) => s.setAddElementColumnParams);
  const doorParams = useViewerStore((s) => s.addElementDoorParams);
  const setDoorParams = useViewerStore((s) => s.setAddElementDoorParams);
  const windowParams = useViewerStore((s) => s.addElementWindowParams);
  const setWindowParams = useViewerStore((s) => s.setAddElementWindowParams);
  const spaceParams = useViewerStore((s) => s.addElementSpaceParams);
  const setSpaceParams = useViewerStore((s) => s.setAddElementSpaceParams);
  const roofParams = useViewerStore((s) => s.addElementRoofParams);
  const setRoofParams = useViewerStore((s) => s.setAddElementRoofParams);
  const plateParams = useViewerStore((s) => s.addElementPlateParams);
  const setPlateParams = useViewerStore((s) => s.setAddElementPlateParams);
  const memberParams = useViewerStore((s) => s.addElementMemberParams);
  const setMemberParams = useViewerStore((s) => s.setAddElementMemberParams);

  const slabMode = useViewerStore((s) => s.addElementSlabMode);
  const setSlabMode = useViewerStore((s) => s.setAddElementSlabMode);
  const pendingPoints = useViewerStore((s) => s.addElementPendingPoints);
  const hoverPoint = useViewerStore((s) => s.addElementHoverPoint);
  const clearPending = useViewerStore((s) => s.clearAddElementPending);

  const activeModelId = useViewerStore((s) => s.activeModelId);

  // Resolve the effective model + its storeys for the selects. When
  // the user hasn't pinned a model the panel auto-tracks the active
  // model; same for storey (auto-tracks first when null).
  const effectiveModelId = addElementModelId ?? activeModelId ?? (models.size > 0 ? models.keys().next().value ?? null : null);

  const modelOptions = useMemo(() => {
    const opts: { id: string; label: string }[] = [];
    for (const [id, model] of models) {
      if (!model.ifcDataStore) continue;
      opts.push({ id, label: model.name || id });
    }
    return opts;
  }, [models]);

  const storeyOptions = useMemo<StoreyOption[]>(() => {
    const dataStore = effectiveModelId
      ? models.get(effectiveModelId)?.ifcDataStore ?? null
      : ifcDataStore;
    if (!dataStore) return [];
    const ids = dataStore.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? [];
    const opts: StoreyOption[] = [];
    for (const expressId of ids) {
      const node = new EntityNode(dataStore, expressId);
      const name = node.name || `Storey #${expressId}`;
      opts.push({ expressId, label: name });
    }
    return opts;
  }, [effectiveModelId, models, ifcDataStore]);

  // Auto-pick the first storey when the user hasn't chosen one or
  // the previous choice no longer exists in the active model. Also
  // reset on model change — storey express ids are model-local, so a
  // colliding numeric id from a different federated model would
  // otherwise be silently reused as the placement target.
  useEffect(() => {
    if (storeyOptions.length === 0) return;
    if (addElementStoreyId === null) return;
    const stillValid = storeyOptions.some((s) => s.expressId === addElementStoreyId);
    if (!stillValid) setAddElementStoreyId(null);
  }, [storeyOptions, addElementStoreyId, setAddElementStoreyId, effectiveModelId]);

  const hasModel = !!effectiveModelId;
  const hasStorey = storeyOptions.length > 0;
  const ready = hasModel && hasStorey;

  const activeOption = ELEMENT_OPTIONS.find((o) => o.type === addElementType) ?? ELEMENT_OPTIONS[0];

  return (
    <div className="h-full flex flex-col bg-white dark:bg-black">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950">
        <div className="flex items-center gap-2">
          <Box className="h-4 w-4 text-emerald-600" />
          <h2 className="font-bold uppercase tracking-wider text-xs text-zinc-900 dark:text-zinc-100">
            Add Element
          </h2>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onClose}
              aria-label="Close add element panel"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close (Esc)</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {/* Element type chips */}
        <section className="space-y-1.5">
          <Label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Type
          </Label>
          <div className="grid grid-cols-3 gap-1">
            {ELEMENT_OPTIONS.map(({ type, label, Icon }) => {
              const selected = addElementType === type;
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => setAddElementType(type)}
                  aria-pressed={selected}
                  className={[
                    'flex items-center justify-center gap-1 h-8 px-1.5 rounded-sm text-[10px] font-mono uppercase tracking-wide',
                    'border transition-colors',
                    'outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                    selected
                      ? 'bg-emerald-500 border-emerald-500 text-white hover:bg-emerald-600'
                      : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200 hover:border-emerald-300 dark:hover:border-emerald-800',
                  ].join(' ')}
                >
                  <Icon className="h-3 w-3 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400 leading-snug pt-1">
            {activeOption.hint}
          </p>
        </section>

        {/* Model + storey context */}
        {modelOptions.length > 1 && (
          <section className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Model
            </Label>
            <Select
              value={effectiveModelId ?? undefined}
              onValueChange={(v) => setAddElementModelId(v)}
            >
              <SelectTrigger className="h-8 font-mono text-xs">
                <SelectValue placeholder="Select model…" />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map(({ id, label }) => (
                  <SelectItem key={id} value={id} className="font-mono text-xs">
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>
        )}

        <section className="space-y-1.5">
          <Label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Storey
          </Label>
          {storeyOptions.length > 0 ? (
            <Select
              value={(addElementStoreyId ?? storeyOptions[0]?.expressId ?? '').toString()}
              onValueChange={(v) => setAddElementStoreyId(Number(v))}
            >
              <SelectTrigger className="h-8 font-mono text-xs">
                <SelectValue placeholder="Pick a storey…" />
              </SelectTrigger>
              <SelectContent>
                {storeyOptions.map(({ expressId, label }) => (
                  <SelectItem key={expressId} value={expressId.toString()} className="font-mono text-xs">
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-[11px] font-mono text-amber-600 dark:text-amber-400">
              {hasModel
                ? 'This model has no IfcBuildingStorey — load a model with a spatial hierarchy.'
                : 'Load a model to begin.'}
            </p>
          )}
        </section>

        {/* Slab mode toggle — rectangle (2 clicks) vs polygon (N clicks + Enter) */}
        {/* Profile mode toggle — applies to slab, roof, plate, space (anything that supports both rect + polygon) */}
        {(addElementType === 'slab' || addElementType === 'roof' || addElementType === 'plate' || addElementType === 'space') && (
          <section className="space-y-1.5">
            <Label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              {activeOption.label} profile
            </Label>
            <div className="grid grid-cols-2 gap-1">
              <ModeChip selected={slabMode === 'rectangle'} onClick={() => setSlabMode('rectangle')}>
                Rectangle (2 clicks)
              </ModeChip>
              <ModeChip selected={slabMode === 'polygon'} onClick={() => setSlabMode('polygon')}>
                Polygon (N + Enter)
              </ModeChip>
            </div>
          </section>
        )}

        {/* Type-specific dimensions */}
        <section className="space-y-2 pt-1">
          <Label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            {activeOption.label} dimensions
          </Label>

          {addElementType === 'wall' && (
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="Thickness" suffix="m" value={wallParams.Thickness} min={0.01} onChange={(v) => setWallParams({ Thickness: v })} />
              <NumberField label="Height" suffix="m" value={wallParams.Height} min={0.01} onChange={(v) => setWallParams({ Height: v })} />
            </div>
          )}

          {addElementType === 'slab' && (
            <NumberField label="Thickness" suffix="m" value={slabParams.Thickness} min={0.01} onChange={(v) => setSlabParams({ Thickness: v })} />
          )}

          {addElementType === 'beam' && (
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="Width" suffix="m" value={beamParams.Width} min={0.01} onChange={(v) => setBeamParams({ Width: v })} />
              <NumberField label="Height" suffix="m" value={beamParams.Height} min={0.01} onChange={(v) => setBeamParams({ Height: v })} />
            </div>
          )}

          {addElementType === 'column' && (
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Width" suffix="m" value={columnParams.Width} min={0.01} onChange={(v) => setColumnParams({ Width: v })} />
              <NumberField label="Depth" suffix="m" value={columnParams.Depth} min={0.01} onChange={(v) => setColumnParams({ Depth: v })} />
              <NumberField label="Height" suffix="m" value={columnParams.Height} min={0.01} onChange={(v) => setColumnParams({ Height: v })} />
            </div>
          )}

          {addElementType === 'door' && (
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Width" suffix="m" value={doorParams.Width} min={0.01} onChange={(v) => setDoorParams({ Width: v })} />
              <NumberField label="Height" suffix="m" value={doorParams.Height} min={0.01} onChange={(v) => setDoorParams({ Height: v })} />
              <NumberField label="Frame" suffix="m" value={doorParams.FrameThickness} min={0.005} onChange={(v) => setDoorParams({ FrameThickness: v })} />
            </div>
          )}

          {addElementType === 'window' && (
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Width" suffix="m" value={windowParams.Width} min={0.01} onChange={(v) => setWindowParams({ Width: v })} />
              <NumberField label="Height" suffix="m" value={windowParams.Height} min={0.01} onChange={(v) => setWindowParams({ Height: v })} />
              <NumberField label="Frame" suffix="m" value={windowParams.FrameThickness} min={0.005} onChange={(v) => setWindowParams({ FrameThickness: v })} />
            </div>
          )}

          {addElementType === 'space' && (
            <NumberField label="Height" suffix="m" value={spaceParams.Height} min={0.01} onChange={(v) => setSpaceParams({ Height: v })} />
          )}

          {addElementType === 'roof' && (
            <NumberField label="Thickness" suffix="m" value={roofParams.Thickness} min={0.01} onChange={(v) => setRoofParams({ Thickness: v })} />
          )}

          {addElementType === 'plate' && (
            <NumberField label="Thickness" suffix="m" value={plateParams.Thickness} min={0.001} onChange={(v) => setPlateParams({ Thickness: v })} />
          )}

          {addElementType === 'member' && (
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="Width" suffix="m" value={memberParams.Width} min={0.01} onChange={(v) => setMemberParams({ Width: v })} />
              <NumberField label="Height" suffix="m" value={memberParams.Height} min={0.01} onChange={(v) => setMemberParams({ Height: v })} />
            </div>
          )}
        </section>

        {/* Click-state guidance — drives the user through the multi-click flow */}
        <DropGuidance
          ready={ready}
          type={addElementType}
          slabMode={slabMode}
          pendingCount={pendingPoints.length}
          hoverDistance={pendingPoints.length > 0 && hoverPoint
            ? distance2D(pendingPoints[pendingPoints.length - 1], hoverPoint)
            : null}
          onClearPending={clearPending}
        />

        <p className="text-[10px] font-mono text-zinc-400 dark:text-zinc-600 leading-snug">
          Snap to vertices, edges, and faces is on by default — toggle with <span className="font-semibold">S</span>.
          Z is fixed to the storey floor; refine via the Raw STEP tab after dropping.
        </p>
      </div>
    </div>
  );
}

function distance2D(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

interface ModeChipProps {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function ModeChip({ selected, onClick, children }: ModeChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={[
        'h-7 px-2 rounded-sm text-[11px] font-mono uppercase tracking-wide',
        'border transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        selected
          ? 'bg-emerald-500 border-emerald-500 text-white hover:bg-emerald-600'
          : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200 hover:border-emerald-300 dark:hover:border-emerald-800',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

interface DropGuidanceProps {
  ready: boolean;
  type: AddElementType;
  slabMode: 'rectangle' | 'polygon';
  pendingCount: number;
  hoverDistance: number | null;
  onClearPending: () => void;
}

/** Stateful guidance pane — mirrors the multi-click flow so the user always knows what comes next. */
function DropGuidance({ ready, type, slabMode, pendingCount, hoverDistance, onClearPending }: DropGuidanceProps) {
  if (!ready) {
    return (
      <section className="mt-2 rounded-sm border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3 text-[11px] font-mono text-zinc-500 dark:text-zinc-400">
        Authoring is disabled until a model with a building storey is loaded.
      </section>
    );
  }

  let primary: string;
  let secondary: string;
  // Single-click placements share the same prompt shape.
  if (type === 'column' || type === 'door' || type === 'window') {
    primary = `Click in 3D to drop the ${type}.`;
    secondary = 'Keep clicking to place more — Esc to exit.';
  } else if (type === 'wall' || type === 'beam' || type === 'member') {
    // Two-click axial placements (start → end).
    if (pendingCount === 0) {
      primary = `Click the ${type} start point.`;
      secondary = 'Snap to vertex/edge for precise placement.';
    } else {
      primary = `Click the ${type} end point.`;
      secondary = hoverDistance !== null
        ? `Length so far: ${hoverDistance.toFixed(2)} m — Esc to restart.`
        : 'Esc to restart.';
    }
  } else {
    // slab / roof / plate / space — rectangle (2 clicks) or polygon (N + Enter).
    const polygonable = `${type[0].toUpperCase()}${type.slice(1)}`;
    if (slabMode === 'rectangle') {
      if (pendingCount === 0) {
        primary = `Click the first ${type} corner.`;
        secondary = 'A second click sets the opposite corner.';
      } else {
        primary = 'Click the opposite corner.';
        secondary = 'Esc to restart, or switch to Polygon mode for irregular outlines.';
      }
    } else {
      if (pendingCount === 0) {
        primary = `Click the ${polygonable} polygon's first point.`;
        secondary = 'Need at least 3 points; press Enter to close.';
      } else if (pendingCount < 3) {
        primary = `Click point ${pendingCount + 1} (need at least 3).`;
        secondary = 'Esc to restart.';
      } else {
        primary = `Click point ${pendingCount + 1} or press Enter to close.`;
        secondary = 'Esc to restart the polygon.';
      }
    }
  }

  return (
    <section
      className="mt-2 rounded-sm border border-emerald-300 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 p-3 text-[11px] font-mono leading-relaxed text-emerald-800 dark:text-emerald-300"
      aria-live="polite"
    >
      <div className="flex items-start gap-2 justify-between">
        <div className="min-w-0">
          <span className="block font-semibold">{primary}</span>
          <span className="block text-[10px] opacity-80 mt-0.5">{secondary}</span>
        </div>
        {pendingCount > 0 && (
          <button
            type="button"
            onClick={onClearPending}
            className="shrink-0 text-[10px] underline-offset-2 hover:underline opacity-80 hover:opacity-100"
            aria-label="Discard pending points"
          >
            Reset
          </button>
        )}
      </div>
    </section>
  );
}

interface NumberFieldProps {
  label: string;
  suffix?: string;
  value: number;
  min: number;
  onChange: (v: number) => void;
}

function NumberField({ label, suffix, value, min, onChange }: NumberFieldProps) {
  const id = `add-elem-${label.toLowerCase()}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
        {label}
        {suffix && <span className="text-zinc-400 dark:text-zinc-600 ml-1">({suffix})</span>}
      </Label>
      <Input
        id={id}
        type="number"
        step={0.05}
        min={min}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next) && next >= min) onChange(next);
        }}
        className="h-8 font-mono text-xs"
      />
    </div>
  );
}
