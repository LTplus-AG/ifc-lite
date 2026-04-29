/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Add Column dialog — front-end for `bim.store.addColumn`. Lets the user
 * pick a target storey, set the column's storey-local position and
 * cross-section, optional name / metadata, and submit. Triggered from:
 *
 *   • EntityContextMenu  → "Add column here…" on an IfcBuildingStorey
 *   • EditToolbar        → "Add column" button when a storey is selected
 *
 * Mounted once at the ViewerLayout level. State is held on the mutation
 * slice (`addColumnDialog`) so any future entry point shares the same
 * surface without prop-threading.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Columns3, AlertCircle, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import type { ColumnInStoreParams } from '@ifc-lite/create';

interface StoreyOption {
  expressId: number;
  label: string;
  elevation: number | null;
}

const DEFAULTS = {
  posX: '1',
  posY: '1',
  posZ: '0',
  width: '0.3',
  depth: '0.4',
  height: '3',
  name: 'Column',
  description: '',
  objectType: '',
  tag: '',
};

export function AddColumnDialog() {
  const dialog = useViewerStore((s) => s.addColumnDialog);
  const closeDialog = useViewerStore((s) => s.closeAddColumnDialog);
  const addColumn = useViewerStore((s) => s.addColumn);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);
  const models = useViewerStore((s) => s.models);

  const [posX, setPosX] = useState(DEFAULTS.posX);
  const [posY, setPosY] = useState(DEFAULTS.posY);
  const [posZ, setPosZ] = useState(DEFAULTS.posZ);
  const [width, setWidth] = useState(DEFAULTS.width);
  const [depth, setDepth] = useState(DEFAULTS.depth);
  const [height, setHeight] = useState(DEFAULTS.height);
  const [name, setName] = useState(DEFAULTS.name);
  const [description, setDescription] = useState(DEFAULTS.description);
  const [objectType, setObjectType] = useState(DEFAULTS.objectType);
  const [tag, setTag] = useState(DEFAULTS.tag);
  const [showOptional, setShowOptional] = useState(false);
  const [storeyId, setStoreyId] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Resolve the active model + its IfcBuildingStoreys via the data
  // store's spatial hierarchy. Each storey's elevation is read from the
  // pre-computed map for context display.
  const { storeys, modelLabel } = useMemo(() => {
    if (!dialog.modelId) return { storeys: [] as StoreyOption[], modelLabel: '' };
    const model = models.get(dialog.modelId);
    const dataStore = model?.ifcDataStore;
    if (!dataStore) return { storeys: [] as StoreyOption[], modelLabel: model?.name ?? '' };

    const ids = dataStore.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? [];
    const elevations = dataStore.spatialHierarchy?.storeyElevations ?? new Map<number, number>();
    const opts: StoreyOption[] = ids.map((id) => ({
      expressId: id,
      label: dataStore.entities.getName(id) || `Storey #${id}`,
      elevation: elevations.get(id) ?? null,
    }));
    // Sort by elevation when present (then by id) so the dropdown
    // reads bottom-to-top, matching the building.
    opts.sort((a, b) => {
      const ae = a.elevation ?? Number.NEGATIVE_INFINITY;
      const be = b.elevation ?? Number.NEGATIVE_INFINITY;
      if (ae !== be) return ae - be;
      return a.expressId - b.expressId;
    });
    return { storeys: opts, modelLabel: model?.name ?? '' };
  }, [dialog.modelId, models]);

  // Reset form to defaults each time the dialog re-opens.
  useEffect(() => {
    if (!dialog.isOpen) return;
    setPosX(DEFAULTS.posX);
    setPosY(DEFAULTS.posY);
    setPosZ(DEFAULTS.posZ);
    setWidth(DEFAULTS.width);
    setDepth(DEFAULTS.depth);
    setHeight(DEFAULTS.height);
    setName(DEFAULTS.name);
    setDescription(DEFAULTS.description);
    setObjectType(DEFAULTS.objectType);
    setTag(DEFAULTS.tag);
    setShowOptional(false);
    setSubmitError(null);
    // Pre-fill from caller, otherwise default to the first storey.
    setStoreyId(dialog.storeyExpressId ?? storeys[0]?.expressId ?? null);
  }, [dialog.isOpen, dialog.storeyExpressId, storeys]);

  // Coerce numeric inputs once for both validation + submit. Returns
  // null when any value isn't a finite number.
  const numbers = useMemo(() => {
    const parse = (s: string) => {
      const n = Number.parseFloat(s);
      return Number.isFinite(n) ? n : null;
    };
    return {
      x: parse(posX),
      y: parse(posY),
      z: parse(posZ),
      w: parse(width),
      d: parse(depth),
      h: parse(height),
    };
  }, [posX, posY, posZ, width, depth, height]);

  const validation = useMemo(() => {
    const errors: { field: string; message: string }[] = [];
    if (storeyId == null) errors.push({ field: 'storey', message: 'Pick a storey' });
    if (numbers.x == null) errors.push({ field: 'x', message: 'X must be a number' });
    if (numbers.y == null) errors.push({ field: 'y', message: 'Y must be a number' });
    if (numbers.z == null) errors.push({ field: 'z', message: 'Z must be a number' });
    if (numbers.w == null || numbers.w <= 0) errors.push({ field: 'width', message: 'Width must be > 0' });
    if (numbers.d == null || numbers.d <= 0) errors.push({ field: 'depth', message: 'Depth must be > 0' });
    if (numbers.h == null || numbers.h <= 0) errors.push({ field: 'height', message: 'Height must be > 0' });
    return { errors, ok: errors.length === 0 };
  }, [storeyId, numbers]);

  const fieldError = useCallback(
    (field: string) => validation.errors.find((e) => e.field === field)?.message ?? null,
    [validation],
  );

  const handleSubmit = useCallback(() => {
    if (!validation.ok || storeyId == null || !dialog.modelId) return;
    if (
      numbers.x == null ||
      numbers.y == null ||
      numbers.z == null ||
      numbers.w == null ||
      numbers.d == null ||
      numbers.h == null
    ) {
      return;
    }
    const params: ColumnInStoreParams = {
      Position: [numbers.x, numbers.y, numbers.z],
      Width: numbers.w,
      Depth: numbers.d,
      Height: numbers.h,
      Name: name.trim() || undefined,
      Description: description.trim() || undefined,
      ObjectType: objectType.trim() || undefined,
      Tag: tag.trim() || undefined,
    };
    const result = addColumn(dialog.modelId, storeyId, params);
    if ('error' in result) {
      setSubmitError(result.error);
      return;
    }
    bumpMutationVersion();
    setSelectedEntityId(result.expressId);
    toast.success(`Column #${result.expressId} added — undo to remove`);
    closeDialog();
  }, [
    validation.ok,
    storeyId,
    dialog.modelId,
    numbers,
    name,
    description,
    objectType,
    tag,
    addColumn,
    bumpMutationVersion,
    setSelectedEntityId,
    closeDialog,
  ]);

  const selectedStorey = storeyId != null ? storeys.find((s) => s.expressId === storeyId) : null;

  return (
    <Dialog open={dialog.isOpen} onOpenChange={(o) => { if (!o) closeDialog(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400">
              <Columns3 className="h-4 w-4" />
            </span>
            <span>Add Column</span>
          </DialogTitle>
          <DialogDescription>
            Drops a new <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400">IfcColumn</span>
            {selectedStorey ? (
              <> into <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{selectedStorey.label}</span></>
            ) : (
              <> into the selected storey</>
            )}
            . Position is storey-local; metres throughout.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Storey picker */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Storey</Label>
            <Select
              value={storeyId != null ? String(storeyId) : ''}
              onValueChange={(v) => setStoreyId(Number.parseInt(v, 10))}
              disabled={storeys.length === 0}
            >
              <SelectTrigger className="font-mono text-sm">
                <SelectValue placeholder={storeys.length === 0 ? 'No storeys in this model' : 'Pick a storey…'} />
              </SelectTrigger>
              <SelectContent>
                {storeys.map((s) => (
                  <SelectItem key={s.expressId} value={String(s.expressId)}>
                    <div className="flex items-baseline gap-2">
                      <span className="truncate">{s.label}</span>
                      {s.elevation != null && (
                        <span className="text-[10px] font-mono text-zinc-400 tabular-nums">
                          {s.elevation.toFixed(2)} m
                        </span>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {modelLabel && (
              <p className="text-[10.5px] font-mono text-zinc-400">{modelLabel}</p>
            )}
          </div>

          {/* Position */}
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Position <span className="font-normal normal-case text-zinc-400">(storey-local, metres)</span>
            </legend>
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="X" value={posX} onChange={setPosX} error={fieldError('x')} />
              <NumberField label="Y" value={posY} onChange={setPosY} error={fieldError('y')} />
              <NumberField label="Z" value={posZ} onChange={setPosZ} error={fieldError('z')} />
            </div>
          </fieldset>

          {/* Cross-section */}
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Cross-section <span className="font-normal normal-case text-zinc-400">(metres)</span>
            </legend>
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Width" value={width} onChange={setWidth} error={fieldError('width')} min={0} />
              <NumberField label="Depth" value={depth} onChange={setDepth} error={fieldError('depth')} min={0} />
              <NumberField label="Height" value={height} onChange={setHeight} error={fieldError('height')} min={0} />
            </div>
          </fieldset>

          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="add-column-name" className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Name
            </Label>
            <Input
              id="add-column-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Column"
              className="font-mono text-sm"
            />
          </div>

          {/* Optional */}
          <Collapsible open={showOptional} onOpenChange={setShowOptional}>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors">
              <span className={`transition-transform ${showOptional ? 'rotate-90' : ''}`}>▸</span>
              <span className="uppercase tracking-wide">Optional metadata</span>
              <span className="text-zinc-400">— Description, ObjectType, Tag</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3 space-y-2">
              <div className="space-y-1">
                <Label htmlFor="add-column-desc" className="text-[10.5px] font-mono uppercase tracking-wide text-zinc-500">Description</Label>
                <Input
                  id="add-column-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="add-column-otype" className="text-[10.5px] font-mono uppercase tracking-wide text-zinc-500">ObjectType</Label>
                <Input
                  id="add-column-otype"
                  value={objectType}
                  onChange={(e) => setObjectType(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="add-column-tag" className="text-[10.5px] font-mono uppercase tracking-wide text-zinc-500">Tag</Label>
                <Input
                  id="add-column-tag"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Submit error (anchor resolution failure, missing model, …) */}
          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-red-300 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 px-3 py-2"
            >
              <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
              <p className="text-xs text-red-700 dark:text-red-300 leading-relaxed">{submitError}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={closeDialog}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!validation.ok || !dialog.modelId}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            Add Column
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NumberField({
  label,
  value,
  onChange,
  error,
  min,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  error?: string | null;
  min?: number;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <Label className="text-[10.5px] font-mono uppercase tracking-wide text-zinc-500">{label}</Label>
        {error && (
          <span className="text-[9.5px] text-red-500 dark:text-red-400 truncate" title={error}>
            ⚠ {error}
          </span>
        )}
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type="number"
        step="any"
        min={min}
        className={`font-mono text-sm tabular-nums ${
          error ? 'border-red-300 dark:border-red-900 focus-visible:ring-red-400' : ''
        }`}
        aria-invalid={error ? true : undefined}
      />
    </div>
  );
}
