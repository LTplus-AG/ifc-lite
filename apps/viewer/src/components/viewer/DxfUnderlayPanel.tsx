/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DxfUnderlayPanel - manage imported DXF reference underlays (issue #1782)
 *
 * Import DXF files as toggleable reference layers under the 2D drawing:
 * per-file visibility/opacity, per-DXF-layer toggles, centre-on-model, and
 * placement (offset / rotation / scale) against the model's coordinate
 * system. Underlays render on plan ('down') sections.
 *
 * "Align to model georeference" (issue #1929) is a per-underlay toggle for
 * DXFs authored in map/CRS coordinates (eastings/northings) rather than
 * the model's local frame — the inverse IfcMapConversion, resolved from
 * the federation anchor, is applied before the offset/rotation/scale
 * placement above.
 *
 * PR #1965 review: the toggle is now tri-state (`DxfUnderlayState`'s
 * `georeferenced` field doc, `drawing2DSlice.ts`). `ingestDxfFile` seeds a
 * fresh entry to "auto" (`undefined`) rather than baking in a boolean at
 * import time; the checkbox below shows the EFFECTIVE resolved state
 * (`resolveEffectiveGeoreferenced`, following `georeferenceAvailable`
 * while in auto mode) and only becomes an explicit `true`/`false` — pinned
 * regardless of anchor availability — once the user actually clicks it.
 *
 * Issue #2043: the 2D underlay is one of TWO independent visibility
 * toggles per entry — `visible` (2D drawing panel, this panel's original
 * behaviour) and `visible3D` (3D viewport overlay, `Viewport.tsx`'s
 * `useDxfUnderlays3DLines`). Both default to on and are controlled here,
 * not at import time, per the issue's explicit rejection of a load-time
 * 2D-vs-3D choice. The 3D overlay currently renders line paths only
 * (walls/boundaries); fills/hatches and text labels are not lifted to 3D
 * yet (`dxfUnderlayToWorldLines3D`'s doc in `dxfUnderlayMath.ts`).
 */

import React, { useCallback, useRef, useState } from 'react';
import { X, Eye, EyeOff, FileUp, Trash2, Layers, ChevronDown, ChevronRight, Loader2, AlertTriangle, Crosshair } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { ingestDxfFile } from '@/hooks/ingest/dxfIngest';
import { resolveEffectiveGeoreferenced } from '@/hooks/dxfUnderlayMath';
import type { DxfUnderlayState } from '@/store/slices/drawing2DSlice';

interface DxfUnderlayPanelProps {
  onClose: () => void;
  /** Centre the underlay on the generated drawing (offset adjustment). */
  onCenterOnModel: (id: string) => void;
  /** False when the current section is not a cardinal plan view. */
  planViewActive: boolean;
  /**
   * Whether an anchor model currently has a usable IfcMapConversion (issue
   * #1929 / PR #1965 review) — drives the checkbox's displayed state for
   * any underlay still in "auto" mode (`entry.georeferenced === undefined`).
   */
  georeferenceAvailable: boolean;
}

/** One numeric placement field with a label. */
function PlacementField({
  label,
  value,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  onCommit: (value: number) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        step={step}
        value={Number.isFinite(value) ? Number(value.toFixed(4)) : 0}
        onChange={(e) => {
          const n = Number.parseFloat(e.target.value);
          if (Number.isFinite(n)) onCommit(n);
        }}
        className="h-6 text-xs px-1.5"
      />
    </div>
  );
}

function UnderlayCard({
  state,
  onCenterOnModel,
  planViewActive,
  georeferenceAvailable,
}: {
  state: DxfUnderlayState;
  onCenterOnModel: (id: string) => void;
  planViewActive: boolean;
  georeferenceAvailable: boolean;
}): React.ReactElement {
  const removeDxfUnderlay = useViewerStore((s) => s.removeDxfUnderlay);
  const setDxfUnderlayVisible = useViewerStore((s) => s.setDxfUnderlayVisible);
  const setDxfUnderlayVisible3D = useViewerStore((s) => s.setDxfUnderlayVisible3D);
  const setDxfUnderlayOpacity = useViewerStore((s) => s.setDxfUnderlayOpacity);
  const toggleDxfUnderlayLayer = useViewerStore((s) => s.toggleDxfUnderlayLayer);
  const updateDxfUnderlayPlacement = useViewerStore((s) => s.updateDxfUnderlayPlacement);
  const setDxfUnderlayGeoreferenced = useViewerStore((s) => s.setDxfUnderlayGeoreferenced);

  const [layersOpen, setLayersOpen] = useState(false);
  const [placementOpen, setPlacementOpen] = useState(false);

  const { underlay, placement } = state;
  const pathCount = underlay.layers.reduce((n, l) => n + l.paths.length + l.fills.length, 0);
  const textCount = underlay.layers.reduce((n, l) => n + l.texts.length, 0);

  return (
    <div className="border rounded-md p-2 space-y-2 bg-muted/20">
      <div className="flex items-center gap-1.5 min-w-0">
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setDxfUnderlayVisible(state.id, !state.visible)}
            title={state.visible ? 'Hide in 2D drawing view' : 'Show in 2D drawing view'}
          >
            {state.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </Button>
          <span className="text-[8px] leading-none text-muted-foreground -ml-1">2D</span>
        </div>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setDxfUnderlayVisible3D(state.id, !state.visible3D)}
            title={state.visible3D ? 'Hide in 3D view' : 'Show in 3D view'}
          >
            {state.visible3D ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </Button>
          <span className="text-[8px] leading-none text-muted-foreground -ml-1">3D</span>
        </div>
        <span className="text-xs font-medium truncate flex-1" title={state.name}>{state.name}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onCenterOnModel(state.id)}
          disabled={!planViewActive}
          title={planViewActive ? 'Center on model' : 'Center on model (switch to a plan view first)'}
        >
          <Crosshair className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => removeDxfUnderlay(state.id)}
          title="Remove underlay"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="text-[10px] text-muted-foreground px-1">
        {underlay.layers.length} layers · {pathCount} paths · {textCount} texts
      </div>

      {underlay.warnings.length > 0 && (
        <div className="flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-500 px-1">
          <AlertTriangle className="h-3 w-3 mt-px shrink-0" />
          <span>{underlay.warnings[0]}{underlay.warnings.length > 1 ? ` (+${underlay.warnings.length - 1} more)` : ''}</span>
        </div>
      )}

      {/* Opacity */}
      <div className="flex items-center gap-2 px-1">
        <Label className="text-[10px] text-muted-foreground w-12">Opacity</Label>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={state.opacity}
          onChange={(e) => setDxfUnderlayOpacity(state.id, Number.parseFloat(e.target.value))}
          className="flex-1 h-1.5 accent-primary"
        />
        <span className="text-[10px] text-muted-foreground w-8 text-right">{Math.round(state.opacity * 100)}%</span>
      </div>

      {/* Georeference alignment (issue #1929) — mirrors the .laz/.las
          "Align to model georeference" toggle (issue #1804), but per-DXF
          since each imported file may or may not be in map/CRS
          coordinates. Tri-state (PR #1965 review): a freshly-imported
          entry starts in "auto" (`state.georeferenced === undefined`) and
          the checkbox shows the EFFECTIVE resolved state — following
          `georeferenceAvailable` — until the user clicks it, at which
          point it becomes an explicit true/false that no longer moves on
          its own. */}
      {(() => {
        const isAuto = state.georeferenced === undefined;
        const effectiveChecked = resolveEffectiveGeoreferenced(state, georeferenceAvailable);
        return (
          <label
            className="flex items-center justify-between gap-2 cursor-pointer px-1"
            title={
              isAuto
                ? `Auto: currently ${effectiveChecked ? 'ON' : 'OFF'} — follows whether the anchor model has a usable georeference. Click to pin this explicitly.`
                : "Applies the inverse IfcMapConversion so this DXF's map/CRS coordinates (eastings/northings) line up with the IFC model. Turn off if this DXF is already drawn in the model's local coordinates."
            }
          >
            <span className="text-[10px] text-muted-foreground">
              Align to model georeference{isAuto ? ' (auto)' : ''}
            </span>
            <input
              type="checkbox"
              checked={effectiveChecked}
              onChange={(e) => setDxfUnderlayGeoreferenced(state.id, e.target.checked)}
              className="accent-primary"
            />
          </label>
        );
      })()}

      {/* DXF layers */}
      <Collapsible open={layersOpen} onOpenChange={setLayersOpen}>
        <CollapsibleTrigger asChild>
          <button className="flex items-center gap-1 text-xs font-medium w-full px-1 py-0.5 hover:text-primary">
            {layersOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Layers
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-0.5 pl-2 max-h-48 overflow-y-auto">
            {underlay.layers.map((layer) => {
              const layerVisible = state.layerVisibility[layer.name] ?? layer.visible;
              return (
                <button
                  key={layer.name}
                  onClick={() => toggleDxfUnderlayLayer(state.id, layer.name)}
                  className="flex items-center gap-1.5 w-full px-1 py-0.5 rounded hover:bg-muted text-left"
                  title={layerVisible ? `Hide layer ${layer.name}` : `Show layer ${layer.name}`}
                >
                  {layerVisible ? (
                    <Eye className="h-3 w-3 shrink-0" />
                  ) : (
                    <EyeOff className="h-3 w-3 shrink-0 text-muted-foreground" />
                  )}
                  <span
                    className="w-2.5 h-2.5 rounded-sm border shrink-0"
                    style={{ backgroundColor: layer.color }}
                  />
                  <span className={`text-[11px] truncate ${layerVisible ? '' : 'text-muted-foreground'}`}>
                    {layer.name}
                  </span>
                  <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                    {layer.paths.length + layer.fills.length + layer.texts.length}
                  </span>
                </button>
              );
            })}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Placement */}
      <Collapsible open={placementOpen} onOpenChange={setPlacementOpen}>
        <CollapsibleTrigger asChild>
          <button className="flex items-center gap-1 text-xs font-medium w-full px-1 py-0.5 hover:text-primary">
            {placementOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Placement
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid grid-cols-2 gap-1.5 pl-2 pr-1 pt-1">
            <PlacementField
              label="Offset X (m)"
              value={placement.offsetX}
              step={0.1}
              onCommit={(v) => updateDxfUnderlayPlacement(state.id, { offsetX: v })}
            />
            {/* Drawing-space +y points south on a plan; show north-positive. */}
            <PlacementField
              label="Offset Y (m)"
              value={-placement.offsetY}
              step={0.1}
              onCommit={(v) => updateDxfUnderlayPlacement(state.id, { offsetY: -v })}
            />
            <PlacementField
              label="Rotation (°)"
              value={placement.rotationDeg}
              step={1}
              onCommit={(v) => updateDxfUnderlayPlacement(state.id, { rotationDeg: v })}
            />
            <PlacementField
              label="Scale"
              value={placement.scale}
              step={0.1}
              onCommit={(v) => {
                if (v > 0) updateDxfUnderlayPlacement(state.id, { scale: v });
              }}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function DxfUnderlayPanel({ onClose, onCenterOnModel, planViewActive, georeferenceAvailable }: DxfUnderlayPanelProps): React.ReactElement {
  const dxfUnderlays = useViewerStore((s) => s.dxfUnderlays);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = ''; // allow re-importing the same file
    if (files.length === 0) return;

    setImporting(true);
    try {
      for (const file of files) {
        await ingestDxfFile(file); // errors surface as toasts inside
      }
      posthog.capture('dxf_underlay_imported', { file_count: files.length });
    } finally {
      setImporting(false);
    }
  }, []);

  return (
    <div className="flex flex-col h-full bg-background border-l">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-primary" />
          <h2 className="font-semibold text-sm">DXF Underlays</h2>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".dxf"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={importing}
          onClick={() => fileInputRef.current?.click()}
        >
          {importing ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <FileUp className="h-4 w-4 mr-2" />
          )}
          Import DXF...
        </Button>

        {dxfUnderlays.length === 0 && (
          <p className="text-xs text-muted-foreground px-1">
            Import a DXF drawing (site plan, survey, coordination set) as a
            reference layer under the 2D section. You can also drop .dxf
            files anywhere on the viewport. Underlays render on plan views;
            use Placement or Center on model to position them.
          </p>
        )}

        {dxfUnderlays.length > 0 && !planViewActive && (
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground border rounded-md p-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" />
            <span>Underlays render on plan (top-down) sections. Switch the section to a plan view to see them.</span>
          </div>
        )}

        {dxfUnderlays.map((state) => (
          <UnderlayCard key={state.id} state={state} onCenterOnModel={onCenterOnModel} planViewActive={planViewActive} georeferenceAvailable={georeferenceAvailable} />
        ))}
      </div>
    </div>
  );
}
