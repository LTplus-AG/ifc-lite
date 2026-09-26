/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Check, PenLine, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { IconButton } from '@/components/ui/icon-button';
import { Badge } from '@/components/ui/badge';
import { parseLocaleNumber, useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { parseLocalizedRotationDegrees } from './georeference-angle';

function focusInlineEditor(node: HTMLInputElement | HTMLSelectElement | null): void {
  node?.focus();
}

function activateEditableRow(event: React.KeyboardEvent<HTMLDivElement>, startEdit: () => void): void {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  startEdit();
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

interface GeorefRowProps {
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

  const hint = useMemo(() => getFieldHint(fieldEntity ?? '', fieldName ?? ''), [fieldEntity, fieldName]);

  const startEdit = useCallback(() => {
    if (!editable || isComputed) return;
    seededValue.current = typeof value === 'number' ? formatLocaleNumber(locale, value, { maximumFractionDigits: 20, useGrouping: false }) : String(value ?? ''); // locale-formatted seed (#4918), commitEdit parses via parseLocaleNumber
    setEditValue(seededValue.current);
    setEditing(true);
  }, [value, editable, isComputed, locale]);

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

  return (
    // Read-only rows remain plain content; editable rows have a keyboard button role.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={`flex items-start gap-2 px-3 py-1.5 min-w-0 ${
        isMutated ? 'bg-overlay-accent-soft' : ''
      } ${editable && !isComputed ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/50 group/row' : ''}`}
      onClick={!editing ? event => {
        // An extra action (terrain height) belongs to its own button, not
        // the inline editor that the rest of this row opens.
        if (event.target instanceof Element && event.target.closest('button')) return;
        startEdit();
      } : undefined}
      role={children ? 'group' : editable && !isComputed && !editing ? 'button' : undefined}
      tabIndex={!children && editable && !isComputed && !editing ? 0 : undefined}
      aria-label={editable && !isComputed && !editing ? label : undefined}
      onKeyDown={!children && !editing ? event => activateEditableRow(event, startEdit) : undefined}
    >
      <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0 pt-0.5 flex items-center gap-0.5 min-w-[110px]">
        {isComputed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-teal-500">*</span>
            </TooltipTrigger>
            <TooltipContent>{t('properties.georef.computedTooltip')}</TooltipContent>
          </Tooltip>
        )}
        {label}
      </span>
      <div className="flex-1 flex flex-col items-end gap-0.5 min-w-0">
        <div className="flex items-start gap-1 w-full justify-end">
          {isMutated && !editing && (
            <Badge variant="secondary" className="h-4 px-1 text-xs bg-overlay-accent-soft text-foreground border-overlay-accent/40 shrink-0 mt-0.5">
              {t('properties.georef.editedBadge')}
            </Badge>
          )}
          {editing ? (
            <div className="flex flex-col gap-1 w-full">
              <div className="flex items-center gap-1">
                {hint.isSelect ? (
                  <select
                    ref={focusInlineEditor}
                    value={editValue}
                    onChange={e => { setEditValue(e.target.value); }}
                    className="flex-1 text-xs font-mono px-1.5 py-1 border border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400"
                  >
                    <option value="">{t('properties.georef.selectPlaceholder')}</option>
                    {hint.suggestions?.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                ) : (
                  <input
                    ref={focusInlineEditor}
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={hint.placeholderKey ? t(hint.placeholderKey) : undefined}
                    className="flex-1 min-w-0 text-xs font-mono px-1.5 py-0.5 border border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400 placeholder:text-zinc-400/50"
                  />
                )}
                <IconButton label={t('properties.georef.saveField', { field: label })} onClick={() => commitEdit()} className="h-5 w-5 p-0.5 text-green-600 hover:text-green-700 dark:text-green-400 shrink-0">
                  <Check className="h-3 w-3" />
                </IconButton>
                <IconButton label={t('properties.georef.cancelField', { field: label })} onClick={cancelEdit} className="h-5 w-5 p-0.5 text-red-500 hover:text-red-600 dark:text-red-400 shrink-0">
                  <X className="h-3 w-3" />
                </IconButton>
              </div>
              {/* Suggestion chips for fields with common values */}
              {hint.suggestions && !hint.isSelect && (
                <div className="flex flex-wrap gap-1">
                  {hint.suggestions.map(s => (
                    <button
                      key={s}
                      onClick={() => selectSuggestion(s)}
                      className="text-xs font-mono px-1.5 py-0.5 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-teal-400 hover:text-teal-700 dark:hover:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/50 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {/* Help text */}
              {hint.helpTextKey && (
                <span className="text-xs text-zinc-400 dark:text-zinc-500">{t(hint.helpTextKey)}</span>
              )}
            </div>
          ) : (
            <>
              <span
                className={`text-xs font-mono tabular-nums break-all text-right ${
                  isMutated
                    ? 'text-foreground font-semibold'
                    : 'text-teal-700 dark:text-teal-400'
                }`}
                title={displayValue}
              >
                {displayValue}
                {suffix && <span className="text-zinc-400 dark:text-zinc-500 ml-0.5">{suffix}</span>}
              </span>
              {editable && !isComputed && (children ? (
                <IconButton label={t('properties.georef.editField', { field: label })} onClick={event => { event.stopPropagation(); startEdit(); }} className="h-5 w-5 p-0.5 text-zinc-400 shrink-0">
                  <PenLine className="h-3 w-3" />
                </IconButton>
              ) : (
                <PenLine className="h-3 w-3 opacity-0 group-hover/row:opacity-100 transition-opacity text-zinc-400 shrink-0 mt-0.5" />
              ))}
            </>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

// ── AngleRow: edit angle and auto-compute XAxisAbscissa/XAxisOrdinate ───

interface AngleRowProps {
  angle: number | null;
  editable?: boolean;
  onAngleChange?: (abscissa: number, ordinate: number) => void;
}

export function AngleRow({ angle, editable, onAngleChange }: AngleRowProps) {
  const { t, locale } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const startEdit = useCallback(() => {
    if (!editable) return;
    setEditValue(angle != null ? formatLocaleNumber(locale, angle, { maximumFractionDigits: 6, useGrouping: false }) : ''); // locale-formatted seed (#4918), see GeorefRow.startEdit
    setEditing(true);
  }, [angle, editable, locale]);

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

  return (
    // Read-only angles remain plain content; editable rows have a keyboard button role.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={`flex items-start gap-2 px-3 py-1.5 min-w-0 ${editable ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/50 group/row' : ''}`}
      onClick={!editing ? startEdit : undefined}
      role={editable && !editing ? 'button' : undefined}
      tabIndex={editable && !editing ? 0 : undefined}
      aria-label={editable && !editing ? t('properties.georef.angleToGridNorth') : undefined}
      onKeyDown={!editing ? event => activateEditableRow(event, startEdit) : undefined}
    >
      <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0 pt-0.5 flex items-center gap-0.5 min-w-[110px]">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-xs text-teal-500">*</span>
          </TooltipTrigger>
          <TooltipContent>{editable ? t('properties.georef.angleEditTooltip') : t('properties.georef.computedTooltip')}</TooltipContent>
        </Tooltip>
        {t('properties.georef.angleToGridNorth')}
      </span>
      <div className="flex-1 flex items-start gap-1 min-w-0 justify-end">
        {editing ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <input
                ref={focusInlineEditor}
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="0.0"
                className="w-28 text-xs font-mono px-1.5 py-0.5 border border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400 placeholder:text-zinc-400/50"
              />
              <span className="text-xs text-zinc-400">{t('properties.georef.degUnit')}</span>
              <IconButton label={t('properties.georef.saveField', { field: t('properties.georef.angleToGridNorth') })} onClick={commitEdit} className="h-5 w-5 p-0.5 text-green-600 hover:text-green-700 dark:text-green-400 shrink-0">
                <Check className="h-3 w-3" />
              </IconButton>
              <IconButton label={t('properties.georef.cancelField', { field: t('properties.georef.angleToGridNorth') })} onClick={cancelEdit} className="h-5 w-5 p-0.5 text-red-500 hover:text-red-600 dark:text-red-400 shrink-0">
                <X className="h-3 w-3" />
              </IconButton>
            </div>
            <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('properties.georef.angleSetsAxesNote')}</span>
          </div>
        ) : (
          <>
            <span className="text-xs font-mono tabular-nums text-teal-700 dark:text-teal-400">
              {angle != null ? formatLocaleNumber(locale, angle, { maximumFractionDigits: 6 }) : '-'}
              <span className="text-zinc-400 dark:text-zinc-500 ml-0.5">{t('properties.georef.degUnit')}</span>
            </span>
            {editable && (
              <PenLine className="h-3 w-3 opacity-0 group-hover/row:opacity-100 transition-opacity text-zinc-400 shrink-0 mt-0.5" />
            )}
          </>
        )}
      </div>
    </div>
  );
}
