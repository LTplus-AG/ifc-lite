/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Add Element panel — right-side authoring surface for dropping
 * walls / slabs / beams / columns onto a parsed model. Tool-driven
 * (rendered when `activeTool === 'addElement'`); the actual drop
 * happens on a 3D click handled in `selectionHandlers.ts`.
 *
 * Activated via the Panels menu in the toolbar or the command palette.
 * The tool stays active across drops so the user can place several
 * elements in a row; Esc returns to the select tool.
 */

import { useEffect, useMemo, useState } from 'react';
import { Box, Wand2, X } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { EntityNode } from '@ifc-lite/query';
import type { AddElementType } from '@/store/slices/addElementSlice';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { ELEMENT_OPTIONS, SPACE_PREDEFINED_TYPES } from './add-element-options';
import { formatWallSkipReasons } from './add-element-wall-skip-i18n';
import { effectiveStoreyIds } from './add-element-storeys';

interface StoreyOption {
  expressId: number;
  label: string;
}

interface AddElementPanelProps {
  onClose: () => void;
}

export function AddElementPanel({ onClose }: AddElementPanelProps) {
  const { t, locale, revision } = useTranslation();
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
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);

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
    const view = effectiveModelId ? mutationViews.get(effectiveModelId) : null;
    const ids = effectiveStoreyIds(dataStore, view);
    const opts: StoreyOption[] = [];
    for (const expressId of ids) {
      const created = view?.getNewEntity(expressId);
      const positional = view?.getPositionalMutationsForEntity(expressId);
      const named = view?.getAttributeMutationsForEntity(expressId).find(({ name }) => name === 'Name');
      const rawName = positional?.has(2)
        ? positional.get(2)
        : named ? named.value : (created ? created.attributes[2] : new EntityNode(dataStore, expressId).name);
      const name = (typeof rawName === 'string' && rawName !== '$' ? rawName : '') || t('addElement.storeyFallback', {
        id: formatLocaleNumber(locale, expressId),
      });
      opts.push({ expressId, label: name });
    }
    return opts;
  }, [effectiveModelId, models, ifcDataStore, mutationViews, mutationVersion, t, locale, revision]);

  // Auto-pick the first storey when the user hasn't chosen one or
  // the previous choice no longer exists in the active model. Also
  // reset on model change — storey express ids are model-local, so a
  // colliding numeric id from a different federated model would
  // otherwise be silently reused as the placement target.
  useEffect(() => {
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
            {t('addElement.heading')}
          </h2>
        </div>
        <IconButton
          label={t('addElement.closeAria')}
          tooltip={t('addElement.closeTitle')}
          className="h-6 w-6"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {/* Element type chips */}
        <section className="space-y-1.5">
          <Label className="text-2xs font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            {t('addElement.type')}
          </Label>
          <div className="grid grid-cols-3 gap-1">
            {ELEMENT_OPTIONS.map(({ type, labelKey, Icon }) => {
              const selected = addElementType === type;
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => setAddElementType(type)}
                  aria-pressed={selected}
                  className={[
                    'flex items-center justify-center gap-1 h-8 px-1.5 rounded-sm text-2xs font-mono uppercase tracking-wide',
                    'border transition-colors',
                    'outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                    selected
                      ? 'bg-emerald-500 border-emerald-500 text-white hover:bg-emerald-600'
                      : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200 hover:border-emerald-300 dark:hover:border-emerald-800',
                  ].join(' ')}
                >
                  <Icon className="h-3 w-3 shrink-0" />
                  <span className="truncate">{t(labelKey)}</span>
                </button>
              );
            })}
          </div>
          <p className="text-2xs font-mono text-zinc-500 dark:text-zinc-400 leading-snug pt-1">
            {t(activeOption.hintKey)}
          </p>
        </section>

        {/* Model + storey context */}
        {modelOptions.length > 1 && (
          <section className="space-y-1.5">
            <Label className="text-2xs font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              {t('addElement.model')}
            </Label>
            <Select
              value={effectiveModelId ?? undefined}
              onValueChange={(v) => setAddElementModelId(v)}
            >
              <SelectTrigger className="h-8 font-mono text-xs">
                <SelectValue placeholder={t('addElement.selectModel')} />
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
          <Label className="text-2xs font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            {t('addElement.storey')}
          </Label>
          {storeyOptions.length > 0 ? (
            <Select
              value={(addElementStoreyId ?? storeyOptions[0]?.expressId ?? '').toString()}
              onValueChange={(v) => setAddElementStoreyId(Number(v))}
            >
              <SelectTrigger className="h-8 font-mono text-xs">
                <SelectValue placeholder={t('addElement.pickStorey')} />
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
            <p className="text-2xs font-mono text-amber-600 dark:text-amber-400">
              {hasModel
                ? t('addElement.noStorey')
                : t('addElement.noModel')}
            </p>
          )}
        </section>

        {/* Slab mode toggle — rectangle (2 clicks) vs polygon (N clicks + Enter) */}
        {/* Profile mode toggle — applies to slab, roof, plate, space (anything that supports both rect + polygon) */}
        {(addElementType === 'slab' || addElementType === 'roof' || addElementType === 'plate' || addElementType === 'space') && (
          <section className="space-y-1.5">
            <Label className="text-2xs font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              {t(`addElement.profile.${addElementType}` as TranslationKey)}
            </Label>
            <div className="grid grid-cols-2 gap-1">
              <ModeChip selected={slabMode === 'rectangle'} onClick={() => setSlabMode('rectangle')}>
                {t('addElement.rectangleMode')}
              </ModeChip>
              <ModeChip selected={slabMode === 'polygon'} onClick={() => setSlabMode('polygon')}>
                {t('addElement.polygonMode')}
              </ModeChip>
            </div>
          </section>
        )}

        {/* Type-specific dimensions */}
        <section className="space-y-2 pt-1">
          <Label className="text-2xs font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            {t(`addElement.dimensions.${addElementType}`)}
          </Label>

          {addElementType === 'wall' && (
            <div className="grid grid-cols-2 gap-2">
              <NumberField label={t('addElement.dimension.thicknessUnit', { unit: 'm' })} value={wallParams.Thickness} min={0.01} onChange={(v) => setWallParams({ Thickness: v })} />
              <NumberField label={t('addElement.dimension.heightUnit', { unit: 'm' })} value={wallParams.Height} min={0.01} onChange={(v) => setWallParams({ Height: v })} />
            </div>
          )}

          {addElementType === 'slab' && (
            <NumberField label={t('addElement.dimension.thicknessUnit', { unit: 'm' })} value={slabParams.Thickness} min={0.01} onChange={(v) => setSlabParams({ Thickness: v })} />
          )}

          {addElementType === 'beam' && (
            <div className="grid grid-cols-2 gap-2">
              <NumberField label={t('addElement.dimension.widthUnit', { unit: 'm' })} value={beamParams.Width} min={0.01} onChange={(v) => setBeamParams({ Width: v })} />
              <NumberField label={t('addElement.dimension.heightUnit', { unit: 'm' })} value={beamParams.Height} min={0.01} onChange={(v) => setBeamParams({ Height: v })} />
            </div>
          )}

          {addElementType === 'column' && (
            <div className="grid grid-cols-3 gap-2">
              <NumberField label={t('addElement.dimension.widthUnit', { unit: 'm' })} value={columnParams.Width} min={0.01} onChange={(v) => setColumnParams({ Width: v })} />
              <NumberField label={t('addElement.dimension.depthUnit', { unit: 'm' })} value={columnParams.Depth} min={0.01} onChange={(v) => setColumnParams({ Depth: v })} />
              <NumberField label={t('addElement.dimension.heightUnit', { unit: 'm' })} value={columnParams.Height} min={0.01} onChange={(v) => setColumnParams({ Height: v })} />
            </div>
          )}

          {addElementType === 'door' && (
            <div className="grid grid-cols-3 gap-2">
              <NumberField label={t('addElement.dimension.widthUnit', { unit: 'm' })} value={doorParams.Width} min={0.01} onChange={(v) => setDoorParams({ Width: v })} />
              <NumberField label={t('addElement.dimension.heightUnit', { unit: 'm' })} value={doorParams.Height} min={0.01} onChange={(v) => setDoorParams({ Height: v })} />
              <NumberField label={t('addElement.dimension.frameUnit', { unit: 'm' })} value={doorParams.FrameThickness} min={0.005} onChange={(v) => setDoorParams({ FrameThickness: v })} />
            </div>
          )}

          {addElementType === 'window' && (
            <div className="grid grid-cols-3 gap-2">
              <NumberField label={t('addElement.dimension.widthUnit', { unit: 'm' })} value={windowParams.Width} min={0.01} onChange={(v) => setWindowParams({ Width: v })} />
              <NumberField label={t('addElement.dimension.heightUnit', { unit: 'm' })} value={windowParams.Height} min={0.01} onChange={(v) => setWindowParams({ Height: v })} />
              <NumberField label={t('addElement.dimension.frameUnit', { unit: 'm' })} value={windowParams.FrameThickness} min={0.005} onChange={(v) => setWindowParams({ FrameThickness: v })} />
            </div>
          )}

          {addElementType === 'space' && (
            <NumberField label={t('addElement.dimension.heightUnit', { unit: 'm' })} value={spaceParams.Height} min={0.01} onChange={(v) => setSpaceParams({ Height: v })} />
          )}

          {addElementType === 'roof' && (
            <NumberField label={t('addElement.dimension.thicknessUnit', { unit: 'm' })} value={roofParams.Thickness} min={0.01} onChange={(v) => setRoofParams({ Thickness: v })} />
          )}

          {addElementType === 'plate' && (
            <NumberField label={t('addElement.dimension.thicknessUnit', { unit: 'm' })} value={plateParams.Thickness} min={0.001} onChange={(v) => setPlateParams({ Thickness: v })} />
          )}

          {addElementType === 'member' && (
            <div className="grid grid-cols-2 gap-2">
              <NumberField label={t('addElement.dimension.widthUnit', { unit: 'm' })} value={memberParams.Width} min={0.01} onChange={(v) => setMemberParams({ Width: v })} />
              <NumberField label={t('addElement.dimension.heightUnit', { unit: 'm' })} value={memberParams.Height} min={0.01} onChange={(v) => setMemberParams({ Height: v })} />
            </div>
          )}
        </section>

        {/* Auto Spaces — wall-graph face finder, runs only when the
            current type is 'space' so the panel stays focused. */}
        {addElementType === 'space' && (
          <AutoSpacesSection
            modelId={effectiveModelId}
            storeyId={addElementStoreyId ?? storeyOptions[0]?.expressId ?? null}
          />
        )}

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

        <p className="text-2xs font-mono text-zinc-400 dark:text-zinc-600 leading-snug">
          {t('addElement.snapHint')}
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
        'h-7 px-2 rounded-sm text-2xs font-mono uppercase tracking-wide',
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
  const { t, locale } = useTranslation();
  if (!ready) {
    return (
      <section className="mt-2 rounded-sm border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3 text-2xs font-mono text-zinc-500 dark:text-zinc-400">
        {t('addElement.guidance.disabled')}
      </section>
    );
  }

  let primary: string;
  let secondary: string;
  // Single-click placements share the same prompt shape.
  if (type === 'column' || type === 'door' || type === 'window') {
    primary = t(`addElement.guidance.single.${type}` as TranslationKey);
    secondary = t('addElement.guidance.single.secondary');
  } else if (type === 'wall' || type === 'beam' || type === 'member') {
    // Two-click axial placements (start → end).
    if (pendingCount === 0) {
      primary = t(`addElement.guidance.axis.${type}Start` as TranslationKey);
      secondary = t('addElement.guidance.axis.startSecondary');
    } else {
      primary = t(`addElement.guidance.axis.${type}End` as TranslationKey);
      secondary = hoverDistance !== null
        ? t('addElement.guidance.axis.length', { length: formatLocaleNumber(locale, hoverDistance, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })
        : t('addElement.guidance.restart');
    }
  } else {
    // slab / roof / plate / space — rectangle (2 clicks) or polygon (N + Enter).
    if (slabMode === 'rectangle') {
      if (pendingCount === 0) {
        primary = t(`addElement.guidance.rectangle.${type}First` as TranslationKey);
        secondary = t('addElement.guidance.rectangle.firstSecondary');
      } else {
        primary = t('addElement.guidance.rectangle.opposite');
        secondary = t('addElement.guidance.rectangle.oppositeSecondary');
      }
    } else {
      if (pendingCount === 0) {
        primary = t(`addElement.guidance.polygon.${type}First` as TranslationKey);
        secondary = t('addElement.guidance.polygon.firstSecondary');
      } else if (pendingCount < 3) {
        primary = t('addElement.guidance.polygon.needPoint', { point: formatLocaleNumber(locale, pendingCount + 1) });
        secondary = t('addElement.guidance.restart');
      } else {
        primary = t('addElement.guidance.polygon.nextPoint', { point: formatLocaleNumber(locale, pendingCount + 1) });
        secondary = t('addElement.guidance.polygon.restart');
      }
    }
  }

  return (
    <section
      className="mt-2 rounded-sm border border-emerald-300 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 p-3 text-2xs font-mono leading-relaxed text-emerald-800 dark:text-emerald-300"
      aria-live="polite"
    >
      <div className="flex items-start gap-2 justify-between">
        <div className="min-w-0">
          <span className="block font-semibold">{primary}</span>
          <span className="block text-2xs opacity-80 mt-0.5">{secondary}</span>
        </div>
        {pendingCount > 0 && (
          <button
            type="button"
            onClick={onClearPending}
            className="shrink-0 text-2xs underline-offset-2 hover:underline opacity-80 hover:opacity-100"
            aria-label={t('addElement.guidance.discardAria')}
          >
            {t('addElement.guidance.reset')}
          </button>
        )}
      </div>
    </section>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  onChange: (v: number) => void;
}

interface AutoSpacesSectionProps {
  modelId: string | null;
  storeyId: number | null;
}

/**
 * Compact "Auto Spaces" pane: wires the per-storey wall-graph face
 * finder to the viewer slice. Preview button runs detection without
 * emitting; Generate commits each candidate as an IfcSpace.
 */
function AutoSpacesSection({ modelId, storeyId }: AutoSpacesSectionProps) {
  const { t, locale } = useTranslation();
  const params = useViewerStore((s) => s.addElementAutoSpaceParams);
  const setParams = useViewerStore((s) => s.setAddElementAutoSpaceParams);
  const preview = useViewerStore((s) => s.addElementAutoSpacePreview);
  const setPreview = useViewerStore((s) => s.setAddElementAutoSpacePreview);
  const generate = useViewerStore((s) => s.generateSpacesFromWalls);
  const [busy, setBusy] = useState(false);

  const ready = modelId !== null && storeyId !== null;

  const [debugLogging, setDebugLogging] = useState(false);

  const runPreview = () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const result = generate(modelId!, storeyId!, {
        snapTolerance: params.SnapTolerance,
        minArea: params.MinArea,
        height: params.Height,
        namePattern: params.NamePattern,
        predefinedType: params.PredefinedType,
        dryRun: true,
        debug: debugLogging,
      });
      if ('error' in result) {
        toast.error(result.error);
        setPreview(null);
        return;
      }
      const skipReasons: Record<string, number> = {};
      for (const s of result.wallsSkipped) {
        skipReasons[s.reason] = (skipReasons[s.reason] ?? 0) + 1;
      }
      setPreview({
        storeyExpressId: storeyId!,
        outlines: result.detected.map((d) => d.outline.map((p) => [p[0], p[1]])),
        regions: result.detected.map((d) => ({ area: d.area })),
        wallsConsidered: result.wallsConsidered,
        wallsContributing: result.wallsContributing,
        diagnostics: {
          vertices: result.detectionStats.vertices,
          edgesAfterSplit: result.detectionStats.segmentsAfterSplit,
          facesTotal: result.detectionStats.faces,
          outerFacesDropped: result.detectionStats.outerFacesDropped,
          belowMinAreaDropped: result.detectionStats.belowMinAreaDropped,
          largestArea: result.detectionStats.largestArea,
          skipReasons,
        },
      });
      if (result.detected.length === 0) {
        toast.info(t('addElement.auto.noneDetected'));
      }
    } finally {
      setBusy(false);
    }
  };

  const runCommit = () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const result = generate(modelId!, storeyId!, {
        snapTolerance: params.SnapTolerance,
        minArea: params.MinArea,
        height: params.Height,
        namePattern: params.NamePattern,
        predefinedType: params.PredefinedType,
        debug: debugLogging,
      });
      if ('error' in result) {
        toast.error(result.error);
        return;
      }
      setPreview(null);
      const count = result.emitted.length;
      if (count === 0) {
        toast.info(t('addElement.auto.noneToGenerate'));
      } else {
        toast.success(t('addElement.auto.generated', { count, countDisplay: formatLocaleNumber(locale, count) }));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 pt-1">
      <div className="flex items-center gap-1.5">
        <Wand2 className="h-3 w-3 text-emerald-600" />
        <Label className="text-2xs font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          {t('addElement.auto.heading')}
        </Label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={t('addElement.auto.snapUnit', { unit: 'm' })}
          value={params.SnapTolerance} min={0.001}
          onChange={(v) => setParams({ SnapTolerance: v })}
        />
        <NumberField
          label={t('addElement.auto.minAreaUnit', { unit: 'm²' })}
          value={params.MinArea} min={0}
          onChange={(v) => setParams({ MinArea: v })}
        />
        <NumberField
          label={t('addElement.auto.heightUnit', { unit: 'm' })}
          value={params.Height} min={0.01}
          onChange={(v) => setParams({ Height: v })}
        />
        <div className="space-y-1">
          <Label className="text-2xs font-mono text-zinc-500 dark:text-zinc-400" htmlFor="auto-space-type">
            {t('addElement.auto.type')}
          </Label>
          <Select
            value={params.PredefinedType}
            onValueChange={(v) => setParams({ PredefinedType: v })}
          >
            <SelectTrigger id="auto-space-type" className="h-8 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SPACE_PREDEFINED_TYPES.map((predefinedType) => (
                <SelectItem key={predefinedType} value={predefinedType} className="font-mono text-xs">
                  {predefinedType}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="auto-space-name" className="text-2xs font-mono text-zinc-500 dark:text-zinc-400">
          {t('addElement.auto.namePatternLabel', { indexToken: '{n}' })}
        </Label>
        <Input
          id="auto-space-name"
          type="text"
          value={params.NamePattern}
          onChange={(e) => setParams({ NamePattern: e.target.value })}
          className="h-8 font-mono text-xs"
        />
      </div>

      <div className="grid grid-cols-2 gap-2 pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={runPreview}
          disabled={!ready || busy}
          className="h-8 text-2xs font-mono"
        >
          {t('addElement.auto.preview')}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={runCommit}
          disabled={!ready || busy}
          className="h-8 text-2xs font-mono bg-emerald-600 hover:bg-emerald-700"
        >
          {t('addElement.auto.generate')}
        </Button>
      </div>

      <label className="flex items-center gap-1.5 text-2xs font-mono text-zinc-500 dark:text-zinc-400 select-none cursor-pointer">
        <input
          type="checkbox"
          checked={debugLogging}
          onChange={(e) => setDebugLogging(e.target.checked)}
          className="h-3 w-3 accent-emerald-600"
        />
        {t('addElement.auto.verbose')}
      </label>

      {preview && (
        <div className="rounded-sm border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/20 px-2 py-1.5 text-2xs font-mono text-emerald-800 dark:text-emerald-300 leading-snug">
          <div>
            {t('addElement.auto.previewSummary', {
              count: preview.regions.length,
              countDisplay: formatLocaleNumber(locale, preview.regions.length),
              contributing: formatLocaleNumber(locale, preview.wallsContributing),
              considered: formatLocaleNumber(locale, preview.wallsConsidered),
            })}
          </div>
          {preview.regions.length > 0 && (
            <div className="opacity-80">
              {t('addElement.auto.totalArea', { area: formatLocaleNumber(locale, preview.regions.reduce((sum, r) => sum + r.area, 0), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}
            </div>
          )}
          {preview.diagnostics && (
            <div className="opacity-80 mt-1">
              {t('addElement.auto.graph', {
                vertices: formatLocaleNumber(locale, preview.diagnostics.vertices),
                edges: formatLocaleNumber(locale, preview.diagnostics.edgesAfterSplit),
                faces: formatLocaleNumber(locale, preview.diagnostics.facesTotal),
                outer: formatLocaleNumber(locale, preview.diagnostics.outerFacesDropped),
                small: formatLocaleNumber(locale, preview.diagnostics.belowMinAreaDropped),
              })}
            </div>
          )}
          {preview.diagnostics && Object.keys(preview.diagnostics.skipReasons).length > 0 && (
            <div className="opacity-80">
              {t('addElement.auto.skippedWalls', {
                reasons: formatWallSkipReasons(t, locale, preview.diagnostics.skipReasons),
              })}
            </div>
          )}
          {preview.regions.length === 0 && preview.wallsContributing > 0 && (
            <div className="mt-1 text-amber-700 dark:text-amber-400">
              {t('addElement.auto.noRegions')}
            </div>
          )}
          {preview.wallsContributing === 0 && preview.wallsConsidered > 0 && (
            <div className="mt-1 text-amber-700 dark:text-amber-400">
              {t('addElement.auto.noAxes')}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function NumberField({ label, value, min, onChange }: NumberFieldProps) {
  const id = `add-elem-${label.toLowerCase()}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-2xs font-mono text-zinc-500 dark:text-zinc-400">
        {label}
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
