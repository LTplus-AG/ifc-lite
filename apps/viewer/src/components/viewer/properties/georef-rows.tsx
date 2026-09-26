/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-field rows for `GeoreferencingPanel`: `GeorefRow`, `AngleRow` and
 * `TerrainHeightButton`, extracted here so `GeoreferencingPanel.tsx` does not
 * grow past its size (#5812).
 *
 * #5812 labelling: the visible label renders whether or not the row is
 * editing, so wrapping the editor in `<Field label>` would duplicate that
 * text; `aria-label` on the `<select>`/`<input>` reusing the same string
 * gives it a name with no visual duplicate — what `getByLabelText`/
 * `getByRole(..., { name })` key off of. The clickable row keeps its `<div>`
 * (`clickToEditProps` adds `role="button"`/`tabIndex`/`onKeyDown` instead of
 * swapping to a real `<button>`, which would unmount/remount it on entering
 * `editing`). The editor's literal `autoFocus` is a `.focus()` effect on
 * entering edit mode instead: an intentional focus move after a user click,
 * not the initial-load pattern `jsx-a11y(no-autofocus)` warns about.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Check, X, PenLine, Mountain } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { useViewerStore } from '@/store';
import { parseLocaleNumber, useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { parseLocalizedRotationDegrees } from './georeference-angle';

// ── Field-specific assistance data ─────────────────────────────────────

/** Makes a row's `<div>` keyboard-clickable (Enter/Space) without swapping it for a `<button>`. */
function clickToEditProps(active: boolean | undefined, activate: () => void) {
  if (!active) return {};
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
  };
  return { role: 'button' as const, tabIndex: 0, onClick: activate, onKeyDown };
}

const COMMON_DATUMS = ['WGS84', 'ETRS89', 'NAD83', 'NAD27', 'GRS80', 'Bessel 1841', 'Clarke 1866'];
const COMMON_PROJECTIONS = ['Transverse Mercator', 'UTM', 'Lambert Conformal Conic', 'Mercator', 'Stereographic', 'Oblique Mercator'];
const MAP_UNITS = ['METRE', 'FOOT', 'US SURVEY FOOT'];
const COMMON_VERTICAL_DATUMS = ['MSL', 'NAVD88', 'EVRF2007', 'EVRF2019', 'AHD', 'ODN', 'LN02'];

type FieldHint = {
  placeholderKey?: TranslationKey; suggestions?: string[]; isSelect?: boolean; helpTextKey?: TranslationKey;
};
function getFieldHint(entity: string, field: string): FieldHint {
  if (entity === 'projectedCRS') {
    switch (field) {
      case 'name': return { placeholderKey: 'properties.georef.hint.crsName', helpTextKey: 'properties.georef.hint.epsgLookup' };
      case 'description': return { placeholderKey: 'properties.georef.hint.crsDescription' };
      case 'geodeticDatum': return { placeholderKey: 'properties.georef.hint.geodeticDatum', suggestions: COMMON_DATUMS };
      case 'verticalDatum': return { placeholderKey: 'properties.georef.hint.verticalDatum', suggestions: COMMON_VERTICAL_DATUMS };
      case 'mapProjection': return { placeholderKey: 'properties.georef.hint.mapProjection', suggestions: COMMON_PROJECTIONS };
      case 'mapZone': return { placeholderKey: 'properties.georef.hint.mapZone' };
      case 'mapUnit': return { isSelect: true, suggestions: MAP_UNITS };
      default: return {};
    }
  }
  if (entity === 'mapConversion') {
    switch (field) {
      case 'eastings': return { placeholderKey: 'properties.georef.hint.zero', helpTextKey: 'properties.georef.hint.eastings' };
      case 'northings': return { placeholderKey: 'properties.georef.hint.zero', helpTextKey: 'properties.georef.hint.northings' };
      case 'orthogonalHeight': return { placeholderKey: 'properties.georef.hint.zero', helpTextKey: 'properties.georef.hint.height' };
      case 'xAxisAbscissa': return { placeholderKey: 'properties.georef.hint.one', helpTextKey: 'properties.georef.hint.abscissa' };
      case 'xAxisOrdinate': return { placeholderKey: 'properties.georef.hint.zero', helpTextKey: 'properties.georef.hint.ordinate' };
      case 'scale': return { placeholderKey: 'properties.georef.hint.one', helpTextKey: 'properties.georef.hint.scale' };
      default: return {};
    }
  }
  return {};
}

// ── GeorefRow: a single editable field ─────────────────────────────────

export interface GeorefRowProps {
  label: string;
  value: string | number | undefined | null;
  suffix?: string;
  isComputed?: boolean;
  isNumber?: boolean;
  editable?: boolean;
  isMutated?: boolean;
  fieldEntity?: string;
  fieldName?: string;
  onSave?: (value: string | number) => void;
  /** Extra inline content rendered after the value (e.g. terrain height button) */
  children?: React.ReactNode;
}

export function GeorefRow({ label, value, suffix, isComputed, isNumber, editable, isMutated, fieldEntity, fieldName, onSave, children }: GeorefRowProps) {
  const { t, locale } = useTranslation();
  const [editing, setEditing] = useState(false), [editValue, setEditValue] = useState('');
  const seededValue = useRef(''); // a commit still equal to the seed is a no-op, never a re-parse of a rounded display string
  const editControlRef = useRef<HTMLInputElement | HTMLSelectElement>(null);

  const hint = useMemo(() => getFieldHint(fieldEntity ?? '', fieldName ?? ''), [fieldEntity, fieldName]);

  const startEdit = useCallback(() => {
    if (!editable || isComputed) return;
    seededValue.current = typeof value === 'number' ? formatLocaleNumber(locale, value, { maximumFractionDigits: 20, useGrouping: false }) : String(value ?? ''); // locale-formatted seed (#4918), commitEdit parses via parseLocaleNumber
    setEditValue(seededValue.current);
    setEditing(true);
  }, [value, editable, isComputed, locale]);

  // Replaces a literal `autoFocus` on the editor: focus moves to it once
  // editing starts, but as an explicit side effect of the click that opened
  // it rather than the initial-page-load pattern jsx-a11y(no-autofocus) flags.
  useEffect(() => {
    if (editing) editControlRef.current?.focus();
  }, [editing]);

  const commitEdit = useCallback((overrideValue?: string) => {
    if (!onSave) { setEditing(false); return; }
    const trimmed = (overrideValue ?? editValue).trim();
    if ((!trimmed && !hint.isSelect) || trimmed === seededValue.current.trim()) { setEditing(false); return; }
    if (isNumber) {
      const num = parseLocaleNumber(locale, trimmed);
      if (num === null) { setEditing(false); return; }
      onSave(num);
    } else {
      onSave(trimmed);
    }
    setEditing(false);
  }, [editValue, isNumber, locale, onSave, hint.isSelect]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') cancelEdit();
  }, [commitEdit, cancelEdit]);

  const selectSuggestion = useCallback((s: string) => {
    if (!onSave) return;
    if (isNumber) {
      const num = parseFloat(s);
      if (Number.isFinite(num)) onSave(num);
    } else {
      onSave(s);
    }
    setEditing(false);
  }, [onSave, isNumber]);

  const displayValue = typeof value === 'number' ? formatLocaleNumber(locale, value, { maximumFractionDigits: 12 }) : value ?? '-';
  const clickable = editable && !isComputed;
  const rowClassName = `flex items-start gap-2 px-3 py-1.5 min-w-0 w-full text-left ${
    isMutated ? 'bg-overlay-accent-soft' : ''
  } ${clickable ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/50 group/row' : ''}`;

  const rowBody = (
    <>
      <span className="text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0 pt-0.5 flex items-center gap-0.5 min-w-[110px]">
        {isComputed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[10px] text-teal-500">*</span>
            </TooltipTrigger>
            <TooltipContent>{t('properties.georef.computedTooltip')}</TooltipContent>
          </Tooltip>
        )}
        {label}
      </span>
      <div className="flex-1 flex flex-col items-end gap-0.5 min-w-0">
        <div className="flex items-start gap-1 w-full justify-end">
          {isMutated && !editing && (
            <Badge variant="secondary" className="h-4 px-1 text-[9px] bg-overlay-accent-soft text-foreground border-overlay-accent/40 shrink-0 mt-0.5">
              {t('properties.georef.editedBadge')}
            </Badge>
          )}
          {editing ? (
            <div className="flex flex-col gap-1 w-full">{/* no stopPropagation: only the non-editing <button> branch below has a click handler to bubble into */}
              <div className="flex items-center gap-1">
                {hint.isSelect ? (
                  <select
                    ref={editControlRef as React.Ref<HTMLSelectElement>}
                    aria-label={label}
                    value={editValue}
                    onChange={e => { setEditValue(e.target.value); }}
                    className="flex-1 text-[11px] font-mono px-1.5 py-1 border border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400"
                  >
                    <option value="">{t('properties.georef.selectPlaceholder')}</option>
                    {hint.suggestions?.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                ) : (
                  <input
                    ref={editControlRef as React.Ref<HTMLInputElement>}
                    aria-label={label}
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={hint.placeholderKey ? t(hint.placeholderKey) : undefined}
                    className="flex-1 min-w-0 text-[11px] font-mono px-1.5 py-0.5 border border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400 placeholder:text-zinc-400/50"
                  />
                )}
                <button onClick={() => commitEdit()} className="p-0.5 text-green-600 hover:text-green-700 dark:text-green-400 shrink-0">
                  <Check className="h-3 w-3" />
                </button>
                <button onClick={cancelEdit} className="p-0.5 text-red-500 hover:text-red-600 dark:text-red-400 shrink-0">
                  <X className="h-3 w-3" />
                </button>
              </div>
              {/* Suggestion chips for fields with common values */}
              {hint.suggestions && !hint.isSelect && (
                <div className="flex flex-wrap gap-1">
                  {hint.suggestions.map(s => (
                    <button
                      key={s}
                      onClick={() => selectSuggestion(s)}
                      className="text-[9px] font-mono px-1.5 py-0.5 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-teal-400 hover:text-teal-700 dark:hover:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/50 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {/* Help text */}
              {hint.helpTextKey && (
                <span className="text-[9px] text-zinc-400 dark:text-zinc-500">{t(hint.helpTextKey)}</span>
              )}
            </div>
          ) : (
            <>
              <span
                className={`text-[11px] font-mono tabular-nums break-all text-right ${
                  isMutated
                    ? 'text-foreground font-semibold'
                    : 'text-teal-700 dark:text-teal-400'
                }`}
                title={displayValue}
              >
                {displayValue}
                {suffix && <span className="text-zinc-400 dark:text-zinc-500 ml-0.5">{suffix}</span>}
              </span>
              {editable && !isComputed && (
                <PenLine className="h-3 w-3 opacity-0 group-hover/row:opacity-100 transition-opacity text-zinc-400 shrink-0 mt-0.5" />
              )}
            </>
          )}
        </div>
        {children}
      </div>
    </>
  );

  // Stays a `<div>` in every state, never a `<button>`: swapping the host
  // element type on entering `editing` would make React unmount/remount the
  // whole row instead of updating it in place (losing focus, and any DOM
  // reference held across the click that starts editing).
  return <div className={rowClassName} {...clickToEditProps(clickable && !editing, startEdit)}>{rowBody}</div>;
}

// ── AngleRow: edit angle and auto-compute XAxisAbscissa/XAxisOrdinate ───

export interface AngleRowProps {
  angle: number | null;
  editable?: boolean;
  onAngleChange?: (abscissa: number, ordinate: number) => void;
}

export function AngleRow({ angle, editable, onAngleChange }: AngleRowProps) {
  const { t, locale } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const label = t('properties.georef.angleToGridNorth');

  const startEdit = useCallback(() => {
    if (!editable) return;
    setEditValue(angle != null ? formatLocaleNumber(locale, angle, { maximumFractionDigits: 6, useGrouping: false }) : ''); // locale-formatted seed (#4918), see GeorefRow.startEdit
    setEditing(true);
  }, [angle, editable, locale]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commitEdit = useCallback(() => {
    if (!onAngleChange) return;
    let rad: number;
    try { rad = parseLocalizedRotationDegrees(locale, editValue); } catch (error) {
      if (error instanceof Error) return;
      throw error;
    }
    onAngleChange(Math.cos(rad), Math.sin(rad));
    setEditing(false);
  }, [editValue, locale, onAngleChange]);

  const cancelEdit = useCallback(() => setEditing(false), []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') cancelEdit();
  }, [commitEdit, cancelEdit]);

  const rowClassName = `flex items-start gap-2 px-3 py-1.5 min-w-0 w-full text-left ${editable ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/50 group/row' : ''}`;

  const rowBody = (
    <>
      <span className="text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0 pt-0.5 flex items-center gap-0.5 min-w-[110px]">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-[10px] text-teal-500">*</span>
          </TooltipTrigger>
          <TooltipContent>{editable ? t('properties.georef.angleEditTooltip') : t('properties.georef.computedTooltip')}</TooltipContent>
        </Tooltip>
        {label}
      </span>
      <div className="flex-1 flex items-start gap-1 min-w-0 justify-end">
        {editing ? (
          <div className="flex flex-col gap-1">{/* no stopPropagation: see GeorefRow */}
            <div className="flex items-center gap-1">
              <input
                ref={inputRef}
                aria-label={label}
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="0.0"
                className="w-28 text-[11px] font-mono px-1.5 py-0.5 border border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400 placeholder:text-zinc-400/50"
              />
              <span className="text-[10px] text-zinc-400">{t('properties.georef.degUnit')}</span>
              <button onClick={commitEdit} className="p-0.5 text-green-600 hover:text-green-700 dark:text-green-400 shrink-0">
                <Check className="h-3 w-3" />
              </button>
              <button onClick={cancelEdit} className="p-0.5 text-red-500 hover:text-red-600 dark:text-red-400 shrink-0">
                <X className="h-3 w-3" />
              </button>
            </div>
            <span className="text-[9px] text-zinc-400 dark:text-zinc-500">{t('properties.georef.angleSetsAxesNote')}</span>
          </div>
        ) : (
          <>
            <span className="text-[11px] font-mono tabular-nums text-teal-700 dark:text-teal-400">
              {angle != null ? formatLocaleNumber(locale, angle, { maximumFractionDigits: 6 }) : '-'}
              <span className="text-zinc-400 dark:text-zinc-500 ml-0.5">{t('properties.georef.degUnit')}</span>
            </span>
            {editable && (
              <PenLine className="h-3 w-3 opacity-0 group-hover/row:opacity-100 transition-opacity text-zinc-400 shrink-0 mt-0.5" />
            )}
          </>
        )}
      </div>
    </>
  );

  // Same reasoning as GeorefRow: stays a <div> in every state, see there.
  return <div className={rowClassName} {...clickToEditProps(editable && !editing, startEdit)}>{rowBody}</div>;
}

/** Small button to apply Cesium terrain height to OrthogonalHeight field */
export function TerrainHeightButton({ modelId, editable, onApply }: {
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
          className="flex items-center gap-0.5 text-[9px] text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors mt-0.5"
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
