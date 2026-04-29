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
import { Box, Layers, Minus, Square, X } from 'lucide-react';
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
  { type: 'wall', label: 'Wall', Icon: Minus, hint: 'Length × Thickness, extruded up by Height. Drops along storey-local +X from the click.' },
  { type: 'slab', label: 'Slab', Icon: Square, hint: 'Width × Depth rectangle, extruded up by Thickness. Click sets the minimum corner.' },
  { type: 'beam', label: 'Beam', Icon: Layers, hint: 'Width × Height cross-section, extruded along storey-local +X for Length. Click sets the start.' },
  { type: 'column', label: 'Column', Icon: Box, hint: 'Width × Depth cross-section, extruded up by Height. Click sets the base centre.' },
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
  // the previous choice no longer exists in the active model.
  useEffect(() => {
    if (storeyOptions.length === 0) return;
    if (addElementStoreyId === null) return;
    const stillValid = storeyOptions.some((s) => s.expressId === addElementStoreyId);
    if (!stillValid) setAddElementStoreyId(null);
  }, [storeyOptions, addElementStoreyId, setAddElementStoreyId]);

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
          <div className="grid grid-cols-2 gap-1">
            {ELEMENT_OPTIONS.map(({ type, label, Icon }) => {
              const selected = addElementType === type;
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => setAddElementType(type)}
                  aria-pressed={selected}
                  className={[
                    'flex items-center justify-center gap-1.5 h-8 px-2 rounded-sm text-[12px] font-mono uppercase tracking-wide',
                    'border transition-colors',
                    'outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                    selected
                      ? 'bg-emerald-500 border-emerald-500 text-white hover:bg-emerald-600'
                      : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200 hover:border-emerald-300 dark:hover:border-emerald-800',
                  ].join(' ')}
                >
                  <Icon className="h-3 w-3 shrink-0" />
                  <span>{label}</span>
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

        {/* Type-specific dimensions */}
        <section className="space-y-2 pt-1">
          <Label className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            {activeOption.label} dimensions
          </Label>

          {addElementType === 'wall' && (
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Length" suffix="m" value={wallParams.Length} min={0.01} onChange={(v) => setWallParams({ Length: v })} />
              <NumberField label="Thickness" suffix="m" value={wallParams.Thickness} min={0.01} onChange={(v) => setWallParams({ Thickness: v })} />
              <NumberField label="Height" suffix="m" value={wallParams.Height} min={0.01} onChange={(v) => setWallParams({ Height: v })} />
            </div>
          )}

          {addElementType === 'slab' && (
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Width" suffix="m" value={slabParams.Width} min={0.01} onChange={(v) => setSlabParams({ Width: v })} />
              <NumberField label="Depth" suffix="m" value={slabParams.Depth} min={0.01} onChange={(v) => setSlabParams({ Depth: v })} />
              <NumberField label="Thickness" suffix="m" value={slabParams.Thickness} min={0.01} onChange={(v) => setSlabParams({ Thickness: v })} />
            </div>
          )}

          {addElementType === 'beam' && (
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Width" suffix="m" value={beamParams.Width} min={0.01} onChange={(v) => setBeamParams({ Width: v })} />
              <NumberField label="Height" suffix="m" value={beamParams.Height} min={0.01} onChange={(v) => setBeamParams({ Height: v })} />
              <NumberField label="Length" suffix="m" value={beamParams.Length} min={0.01} onChange={(v) => setBeamParams({ Length: v })} />
            </div>
          )}

          {addElementType === 'column' && (
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Width" suffix="m" value={columnParams.Width} min={0.01} onChange={(v) => setColumnParams({ Width: v })} />
              <NumberField label="Depth" suffix="m" value={columnParams.Depth} min={0.01} onChange={(v) => setColumnParams({ Depth: v })} />
              <NumberField label="Height" suffix="m" value={columnParams.Height} min={0.01} onChange={(v) => setColumnParams({ Height: v })} />
            </div>
          )}
        </section>

        {/* Drop guidance */}
        <section
          className={[
            'mt-2 rounded-sm border p-3 text-[11px] font-mono leading-relaxed',
            ready
              ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-300'
              : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 text-zinc-500 dark:text-zinc-400',
          ].join(' ')}
          aria-live="polite"
        >
          {ready ? (
            <>
              <span className="block font-semibold">Click in 3D to drop the {activeOption.label.toLowerCase()}.</span>
              <span className="block text-[10px] opacity-80 mt-0.5">Keep clicking to place more — Esc to exit.</span>
            </>
          ) : (
            <span>Authoring is disabled until a model with a building storey is loaded.</span>
          )}
        </section>

        <p className="text-[10px] font-mono text-zinc-400 dark:text-zinc-600 leading-snug">
          Z is fixed to the storey floor. Refine the placement after dropping via the Raw STEP
          tab on the new entity.
        </p>
      </div>
    </div>
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
