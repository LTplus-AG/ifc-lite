/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-field rows for `GeoreferencingPanel`: `GeorefRow`, `AngleRow` and
 * `TerrainHeightButton`, extracted here so `GeoreferencingPanel.tsx` does not
 * grow past its size (#5812).
 *
 * #5812 labelling: the visible label renders regardless of editing state,
 * so `<Field label>` around the editor would duplicate it; `aria-label` on
 * the `<select>`/`<input>` (same string) names it with no visual dupe. The
 * editor's literal `autoFocus` is a `.focus()` effect on entering edit mode
 * instead, not the initial-load pattern `jsx-a11y(no-autofocus)` warns about.
 *
 * The row `<div>` is never itself interactive: `children` (e.g.
 * `TerrainHeightButton`, a real `<button>`, on the OrthogonalHeight row)
 * renders inside it, so `role="button"` on the row would nest one
 * interactive element inside another (caught in review). Only the value
 * cell — a `<button>` sibling of `children`, never its ancestor — is
 * clickable; the row also never swaps host element type on `editing`.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Check, X, PenLine, Mountain } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { useViewerStore } from '@/store';
import { parseLocaleNumber, useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { parseLocalizedRotationDegrees } from './georeference-angle';

/** The value cell: a `<button>` when `clickable` (sibling of `children`, never its ancestor), else a plain `<div>`. */
function ValueCell({ clickable, onClick, children }: { clickable: boolean | undefined; onClick: () => void; children: React.ReactNode }) {
  const className = 'group/valuecell flex items-start gap-1 min-w-0 text-right';
  if (!clickable) return <div className={className}>{children}</div>;
  return <button type="button" onClick={onClick} className={`${className} bg-transparent border-0 p-0 cursor-pointer`}>{children}</button>;
}

// ── Field-specific assistance data ─────────────────────────────────────

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

  // See the file header re: `autoFocus`.
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
  // See the file header: the row div itself is never interactive.
  const rowClassName = `flex items-start gap-2 px-3 py-1.5 min-w-0 w-full text-left ${isMutated ? 'bg-overlay-accent-soft' : ''}`;
  const valueCellContent = (
    <>
      <span
        className={`text-2xs font-mono tabular-nums break-all text-right ${
          isMutated
            ? 'text-foreground font-semibold'
            : 'text-teal-700 dark:text-teal-400'
        }`}
        title={displayValue}
      >
        {displayValue}
        {suffix && <span className="text-zinc-400 dark:text-zinc-500 ml-0.5">{suffix}</span>}
      </span>
      {clickable && (
        <PenLine className="h-3 w-3 opacity-0 group-hover/valuecell:opacity-100 transition-opacity text-zinc-400 shrink-0 mt-0.5" />
      )}
    </>
  );

  const rowBody = (
    <>
      <span className="text-2xs text-zinc-500 dark:text-zinc-400 shrink-0 pt-0.5 flex items-center gap-0.5 min-w-[110px]">
        {isComputed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-2xs text-teal-500">*</span>
            </TooltipTrigger>
            <TooltipContent>{t('properties.georef.computedTooltip')}</TooltipContent>
          </Tooltip>
        )}
        {label}
      </span>
      <div className="flex-1 flex flex-col items-end gap-0.5 min-w-0">
        <div className="flex items-start gap-1 w-full justify-end">
          {isMutated && !editing && (
            <Badge variant="secondary" className="h-4 px-1 text-2xs bg-overlay-accent-soft text-foreground border-overlay-accent/40 shrink-0 mt-0.5">
              {t('properties.georef.editedBadge')}
            </Badge>
          )}
          {editing ? (
            <div className="flex flex-col gap-1 w-full">{/* no stopPropagation needed: nothing above has a click handler */}
              <div className="flex items-center gap-1">
                {hint.isSelect ? (
                  <select
                    ref={editControlRef as React.Ref<HTMLSelectElement>}
                    aria-label={label}
                    value={editValue}
                    onChange={e => { setEditValue(e.target.value); }}
                    className="flex-1 text-2xs font-mono px-1.5 py-1 border border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400"
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
                    className="flex-1 min-w-0 text-2xs font-mono px-1.5 py-0.5 border border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400 placeholder:text-zinc-400/50"
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
                      className="text-2xs font-mono px-1.5 py-0.5 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-teal-400 hover:text-teal-700 dark:hover:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/50 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {/* Help text */}
              {hint.helpTextKey && (
                <span className="text-2xs text-zinc-400 dark:text-zinc-500">{t(hint.helpTextKey)}</span>
              )}
            </div>
          ) : (
            <ValueCell clickable={clickable} onClick={startEdit}>{valueCellContent}</ValueCell>
          )}
        </div>
        {children}
      </div>
    </>
  );

  // See the file header: always a plain, non-interactive `<div>`.
  return <div className={rowClassName}>{rowBody}</div>;
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

  const rowClassName = 'flex items-start gap-2 px-3 py-1.5 min-w-0 w-full text-left';
  const valueCellContent = (
    <>
      <span className="text-2xs font-mono tabular-nums text-teal-700 dark:text-teal-400">
        {angle != null ? formatLocaleNumber(locale, angle, { maximumFractionDigits: 6 }) : '-'}
        <span className="text-zinc-400 dark:text-zinc-500 ml-0.5">{t('properties.georef.degUnit')}</span>
      </span>
      {editable && (
        <PenLine className="h-3 w-3 opacity-0 group-hover/valuecell:opacity-100 transition-opacity text-zinc-400 shrink-0 mt-0.5" />
      )}
    </>
  );

  const rowBody = (
    <>
      <span className="text-2xs text-zinc-500 dark:text-zinc-400 shrink-0 pt-0.5 flex items-center gap-0.5 min-w-[110px]">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-2xs text-teal-500">*</span>
          </TooltipTrigger>
          <TooltipContent>{editable ? t('properties.georef.angleEditTooltip') : t('properties.georef.computedTooltip')}</TooltipContent>
        </Tooltip>
        {label}
      </span>
      <div className="flex-1 flex items-start gap-1 min-w-0 justify-end">
        {editing ? (
          <div className="flex flex-col gap-1">{/* no stopPropagation needed: see GeorefRow */}
            <div className="flex items-center gap-1">
              <input
                ref={inputRef}
                aria-label={label}
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="0.0"
                className="w-28 text-2xs font-mono px-1.5 py-0.5 border border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400 placeholder:text-zinc-400/50"
              />
              <span className="text-2xs text-zinc-400">{t('properties.georef.degUnit')}</span>
              <button onClick={commitEdit} className="p-0.5 text-green-600 hover:text-green-700 dark:text-green-400 shrink-0">
                <Check className="h-3 w-3" />
              </button>
              <button onClick={cancelEdit} className="p-0.5 text-red-500 hover:text-red-600 dark:text-red-400 shrink-0">
                <X className="h-3 w-3" />
              </button>
            </div>
            <span className="text-2xs text-zinc-400 dark:text-zinc-500">{t('properties.georef.angleSetsAxesNote')}</span>
          </div>
        ) : (
          <ValueCell clickable={editable} onClick={startEdit}>{valueCellContent}</ValueCell>
        )}
      </div>
    </>
  );

  // Always a plain <div>: see GeorefRow's return for why.
  return <div className={rowClassName}>{rowBody}</div>;
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

  // Only the active Cesium model, once the geoid-corrected snap target is ready (#1456).
  if (!cesiumEnabled || terrainHeight === null || terrainSaveHeight === null || !editable || !modelId || modelId !== sourceModelId) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onApply(terrainSaveHeight);
          }}
          className="flex items-center gap-0.5 text-2xs text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors mt-0.5"
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
