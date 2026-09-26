/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AnimationSettingsPopover — compact dropdown from the Gantt toolbar that
 * controls the 4D animation behaviour.
 *
 * Two conceptual layers:
 *   • **Timing** — schedule-driven visibility: hide upcoming products,
 *     remove demolished ones. Always available.
 *   • **Colour overlays** (phased only, opt-in) — task-type palette with
 *     a fully editable colour picker on each swatch.
 *
 * Layout rationale: in phased mode the palette editor is front and centre
 * (right after the style tiles) so users can actually find it — previous
 * iterations buried it at the bottom of the popover and the common
 * complaint was "I don't see how I can change colours". Each swatch is a
 * 20 px clickable preview bound to a native `<input type="color">`.
 */

import { useCallback } from 'react';
import { Sparkles, RotateCcw, Paintbrush, Palette, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import {
  DEFAULT_PALETTE,
  type TaskPaletteKey,
  type RGBA,
} from './schedule-animator';

interface AnimationSettingsPopoverProps {
  animationEnabled: boolean;
  onToggleAnimation: () => void;
}

/** Palette entries surfaced in the customizer — every IfcTaskTypeEnum
 *  value the animator uses. Ordered by expected real-world frequency. */
const PALETTE_LEGEND: { key: TaskPaletteKey; labelKey: TranslationKey }[] = [
  { key: 'CONSTRUCTION', labelKey: 'schedule.animation.taskType.construction' },
  { key: 'INSTALLATION', labelKey: 'schedule.animation.taskType.installation' },
  { key: 'RENOVATION', labelKey: 'schedule.animation.taskType.renovation' },
  { key: 'MAINTENANCE', labelKey: 'schedule.animation.taskType.maintenance' },
  { key: 'LOGISTIC', labelKey: 'schedule.animation.taskType.logistic' },
  { key: 'OPERATION', labelKey: 'schedule.animation.taskType.operation' },
  { key: 'MOVE', labelKey: 'schedule.animation.taskType.move' },
  { key: 'ATTENDANCE', labelKey: 'schedule.animation.taskType.attendance' },
  { key: 'DEMOLITION', labelKey: 'schedule.animation.taskType.demolition' },
  { key: 'DISMANTLE', labelKey: 'schedule.animation.taskType.dismantle' },
  { key: 'REMOVAL', labelKey: 'schedule.animation.taskType.removal' },
  { key: 'DISPOSAL', labelKey: 'schedule.animation.taskType.disposal' },
  { key: 'USERDEFINED', labelKey: 'schedule.animation.taskType.userDefined' },
  { key: 'NOTDEFINED', labelKey: 'schedule.animation.taskType.notDefined' },
];

function rgbaToCss(rgba: RGBA): string {
  const r = Math.round(rgba[0] * 255);
  const g = Math.round(rgba[1] * 255);
  const b = Math.round(rgba[2] * 255);
  return `rgba(${r},${g},${b},${rgba[3]})`;
}

function rgbaToHex(rgba: RGBA): string {
  const toHex = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${toHex(rgba[0])}${toHex(rgba[1])}${toHex(rgba[2])}`;
}

/** Parse `#RRGGBB` into [r,g,b] floats 0-1 (alpha left to caller). */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

/** Colour-equal within 1/255 — used to spot user-customised entries. */
function rgbEquals(a: RGBA, b: RGBA): boolean {
  const eps = 1 / 512;
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps;
}

export function AnimationSettingsPopover({
  animationEnabled,
  onToggleAnimation,
}: AnimationSettingsPopoverProps) {
  const { t, locale } = useTranslation();
  const settings = useViewerStore(s => s.animationSettings);
  const patch = useViewerStore(s => s.patchAnimationSettings);
  const reset = useViewerStore(s => s.resetAnimationSettings);

  // Minimal / Phased tiles are presets over the underlying colour
  // flags, not a separate mode flag. "Phased" turns on task-type
  // coloring at a sensible default intensity; "Minimal" turns every
  // colour overlay off. Users can still toggle individual flags
  // inside the Phased panel after picking either preset.
  const applyMinimalPreset = useCallback(() => patch({
    colorizeByTaskType: false,
    showPreparationGhost: false,
    showCompletedTint: false,
    paletteIntensity: 0,
  }), [patch]);
  const applyPhasedPreset = useCallback(() => patch({
    colorizeByTaskType: true,
    paletteIntensity: 0.6,
    // Leave ghost / completed off by default — power-user toggles inside.
  }), [patch]);

  const setPaletteColor = useCallback((key: TaskPaletteKey, hex: string) => {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const prev = settings.palette[key] ?? DEFAULT_PALETTE[key];
    // Preserve the existing alpha — the native picker is opaque so we only
    // update RGB. Keeps the PREPARATION ghost at its baked low alpha even
    // when users edit its hue.
    const next: RGBA = [rgb[0], rgb[1], rgb[2], prev[3]];
    patch({ palette: { ...settings.palette, [key]: next } });
  }, [patch, settings.palette]);

  const resetPaletteEntry = useCallback((key: TaskPaletteKey) => {
    patch({ palette: { ...settings.palette, [key]: DEFAULT_PALETTE[key] } });
  }, [patch, settings.palette]);

  // Derive the tile state from the underlying flags — "phased" means
  // at least one colour overlay is on. No separate `style` bit.
  const phased = settings.colorizeByTaskType
    || settings.showPreparationGhost
    || settings.showCompletedTint;
  const palette = settings.palette;
  const prepColor = palette.PREPARATION ?? DEFAULT_PALETTE.PREPARATION;
  const prepIsDefault = rgbEquals(prepColor, DEFAULT_PALETTE.PREPARATION);
  const completedColor = palette.COMPLETED ?? DEFAULT_PALETTE.COMPLETED;
  const completedIsDefault = rgbEquals(completedColor, DEFAULT_PALETTE.COMPLETED);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={t('schedule.animation.settingsAriaLabel')}
          tooltip={t('schedule.animation.settingsTooltip')}
          size="icon-sm"
          variant={animationEnabled ? 'default' : 'ghost'}
        >
          <Sparkles className="h-4 w-4" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[360px] p-3 max-h-[min(80vh,700px)] overflow-y-auto">
        {/* ── Master toggle ────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-3 pb-2">
          <div className="grid gap-0.5">
            <span className="text-sm font-medium">{t('schedule.animation.title')}</span>
            <span className="text-[11px] text-muted-foreground">{t('schedule.animation.titleDescription')}</span>
          </div>
          <Switch checked={animationEnabled} onCheckedChange={onToggleAnimation} />
        </div>

        <DropdownMenuSeparator />

        {/* ── Style tiles — two ways to visualize the schedule ─────── */}
        <div className="grid gap-1.5 py-2">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{t('schedule.animation.styleLabel')}</Label>
          <div className="grid grid-cols-2 gap-2">
            <StyleTile
              icon={<Eye className="h-3.5 w-3.5" />}
              label={t('schedule.animation.minimalLabel')}
              description={t('schedule.animation.minimalDescription')}
              active={!phased}
              onSelect={() => applyMinimalPreset()}
            />
            <StyleTile
              icon={<Palette className="h-3.5 w-3.5" />}
              label={t('schedule.animation.phasedLabel')}
              description={t('schedule.animation.phasedDescription')}
              active={phased}
              onSelect={() => applyPhasedPreset()}
            />
          </div>
        </div>

        {/* ── Phased: palette editor FIRST so it's impossible to miss ── */}
        {phased && (
          <>
            <DropdownMenuSeparator />
            <div className="grid gap-1.5 py-2">
              <div className="flex items-center gap-1.5">
                <Paintbrush className="h-3 w-3 text-primary" />
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{t('schedule.animation.taskTypePaletteLabel')}</Label>
              </div>
              <span className="text-[11px] text-muted-foreground">{t('schedule.animation.paletteHint')}</span>
              <div className="grid grid-cols-1 gap-0.5 pt-1">
                {PALETTE_LEGEND.map(entry => {
                  const current = palette[entry.key] ?? DEFAULT_PALETTE[entry.key];
                  return (
                    <PaletteRow
                      key={entry.key}
                      label={t(entry.labelKey)}
                      colorKey={entry.key}
                      rgba={current}
                      onChange={setPaletteColor}
                      onResetEntry={resetPaletteEntry}
                      isDefault={rgbEquals(current, DEFAULT_PALETTE[entry.key])}
                    />
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* ── Minimal: clear CTA explaining what phased adds ───────── */}
        {!phased && (
          <>
            <DropdownMenuSeparator />
            <button
              type="button"
              onClick={() => applyPhasedPreset()}
              className="w-full rounded-md border border-primary/40 bg-primary/5 hover:bg-primary/10 transition-colors px-3 py-2 text-left my-1"
            >
              <div className="flex items-center gap-1.5">
                <Palette className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs font-medium">{t('schedule.animation.switchToPhasedCta')}</span>
              </div>
              <span className="text-[11px] text-muted-foreground">
                {t('schedule.animation.switchToPhasedHint')}
              </span>
            </button>
          </>
        )}

        <DropdownMenuSeparator />

        {/* ── Timing-layer toggles (always visible) ────────────────── */}
        <div className="grid gap-2 py-2">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{t('schedule.animation.timingLabel')}</Label>
          <ToggleRow
            label={t('schedule.animation.hideUpcomingLabel')}
            description={t('schedule.animation.hideUpcomingDescription')}
            checked={settings.hideBeforePreparation}
            onChange={v => patch({ hideBeforePreparation: v })}
          />
          <ToggleRow
            label={t('schedule.animation.hideUnscheduledLabel')}
            description={t('schedule.animation.hideUnscheduledDescription')}
            checked={settings.hideUntaskedProducts}
            onChange={v => patch({ hideUntaskedProducts: v })}
          />
          <ToggleRow
            label={t('schedule.animation.animateDemolitionLabel')}
            description={t('schedule.animation.animateDemolitionDescription')}
            checked={settings.animateDemolition}
            onChange={v => patch({ animateDemolition: v })}
          />
        </div>

        {phased && (
          <>
            <DropdownMenuSeparator />

            {/* ── Colour-layer toggles ─────────────────────────────── */}
            <div className="grid gap-2 py-2">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {t('schedule.animation.colourOverlaysLabel')}
              </Label>
              <ToggleRow
                label={t('schedule.animation.colourByTaskTypeLabel')}
                description={t('schedule.animation.colourByTaskTypeDescription')}
                checked={settings.colorizeByTaskType}
                onChange={v => patch({ colorizeByTaskType: v })}
              />
              <ToggleRow
                label={t('schedule.animation.preparationGhostLabel')}
                description={t('schedule.animation.preparationGhostDescription')}
                checked={settings.showPreparationGhost}
                onChange={v => patch({ showPreparationGhost: v })}
              />

              {settings.showPreparationGhost && (
                <div className="flex items-center justify-between gap-3 pl-2 pt-1 border-l-2 border-primary/30">
                  <span className="grid gap-0.5 min-w-0">
                    <span className="text-xs font-medium">{t('schedule.animation.ghostColourLabel')}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {t('schedule.animation.ghostColourDescription')}
                    </span>
                  </span>
                  <PaletteSwatch
                    colorKey="PREPARATION"
                    rgba={prepColor}
                    onChange={setPaletteColor}
                    isDefault={prepIsDefault}
                  />
                </div>
              )}

              <ToggleRow
                label={t('schedule.animation.tintCompletedLabel')}
                description={t('schedule.animation.tintCompletedDescription')}
                checked={settings.showCompletedTint}
                onChange={v => patch({ showCompletedTint: v })}
              />

              {settings.showCompletedTint && (
                <div className="flex items-center justify-between gap-3 pl-2 pt-1 border-l-2 border-primary/30">
                  <span className="grid gap-0.5 min-w-0">
                    <span className="text-xs font-medium">{t('schedule.animation.completedColourLabel')}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {t('schedule.animation.completedColourDescription')}
                    </span>
                  </span>
                  <PaletteSwatch
                    colorKey="COMPLETED"
                    rgba={completedColor}
                    onChange={setPaletteColor}
                    isDefault={completedIsDefault}
                  />
                </div>
              )}
            </div>

            <DropdownMenuSeparator />

            {/* ── Sliders ──────────────────────────────────────────── */}
            <div className="grid gap-3 py-2">
              <div className="grid gap-1">
                <div className="flex items-center justify-between">
                  <Label htmlFor="prep-days" className="text-xs">{t('schedule.animation.lookAheadWindowLabel')}</Label>
                  <span className="text-xs font-mono text-muted-foreground">{t('schedule.animation.lookAheadWindowValue', { count: settings.preparationDays, days: formatLocaleNumber(locale, settings.preparationDays) })}</span>
                </div>
                <input
                  id="prep-days"
                  type="range"
                  min={0}
                  max={14}
                  step={1}
                  value={settings.preparationDays}
                  onChange={(e) => patch({ preparationDays: Number(e.target.value) })}
                  className="w-full accent-primary"
                />
              </div>

              <div className="grid gap-1">
                <div className="flex items-center justify-between">
                  <Label htmlFor="palette-intensity" className="text-xs">{t('schedule.animation.colourIntensityLabel')}</Label>
                  <span className="text-xs font-mono text-muted-foreground">
                    {formatLocaleNumber(locale, settings.paletteIntensity, { style: 'percent', maximumFractionDigits: 0 })}
                  </span>
                </div>
                <input
                  id="palette-intensity"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(settings.paletteIntensity * 100)}
                  onChange={(e) => patch({ paletteIntensity: Number(e.target.value) / 100 })}
                  className="w-full accent-primary"
                />
                <span className="text-[10px] text-muted-foreground">
                  {t('schedule.animation.colourIntensityHint')}
                </span>
              </div>
            </div>
          </>
        )}

        <DropdownMenuSeparator />

        <div className="flex items-center justify-end pt-1">
          <Button size="sm" variant="ghost" onClick={reset} className="gap-1.5 text-xs">
            <RotateCcw className="h-3 w-3" />
            {t('schedule.animation.resetDefaults')}
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface StyleTileProps {
  icon: React.ReactNode;
  label: string;
  description: string;
  active: boolean;
  onSelect: () => void;
}

function StyleTile({ icon, label, description, active, onSelect }: StyleTileProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex flex-col gap-0.5 rounded-md border p-2 text-left transition-colors',
        active ? 'border-primary bg-primary/10' : 'border-input hover:bg-muted/40',
      )}
      aria-pressed={active}
    >
      <span className="flex items-center gap-1.5">
        <span className={active ? 'text-primary' : 'text-muted-foreground'}>{icon}</span>
        <span className="text-xs font-medium">{label}</span>
      </span>
      <span className="text-[10px] text-muted-foreground">{description}</span>
    </button>
  );
}

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer">
      <span className="grid gap-0.5 min-w-0">
        <span className="text-xs font-medium truncate">{label}</span>
        <span className="text-[10px] text-muted-foreground">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

interface PaletteRowProps {
  label: string;
  colorKey: TaskPaletteKey;
  rgba: RGBA;
  onChange: (key: TaskPaletteKey, hex: string) => void;
  onResetEntry: (key: TaskPaletteKey) => void;
  isDefault: boolean;
}

/**
 * Full-width palette row — 20 px clickable swatch + friendly label + hex
 * code + per-entry reset on hover when modified. Larger than the old 14 px
 * swatches so the interactive affordance actually reads as a button.
 */
function PaletteRow({ label, colorKey, rgba, onChange, onResetEntry, isDefault }: PaletteRowProps) {
  const { t } = useTranslation();
  return (
    <div className="group flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted/40 transition-colors">
      <PaletteSwatch
        colorKey={colorKey}
        rgba={rgba}
        onChange={onChange}
        isDefault={isDefault}
      />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-xs font-medium truncate" title={colorKey}>
          {label}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">
          {rgbaToHex(rgba).toUpperCase()}
          {!isDefault && <span className="ml-1 text-primary">• {t('schedule.animation.modifiedTag')}</span>}
        </span>
      </div>
      {!isDefault && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onResetEntry(colorKey)}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity h-5 w-5 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground shrink-0"
              aria-label={t('schedule.animation.resetEntryAriaLabel', { label })}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('schedule.animation.resetToDefault')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

interface PaletteSwatchProps {
  colorKey: TaskPaletteKey;
  rgba: RGBA;
  onChange: (key: TaskPaletteKey, hex: string) => void;
  /** Kept for parent-side rendering; not used inside the swatch. */
  isDefault?: boolean;
}

/**
 * 20 × 20 px swatch that doubles as a `<input type="color">`. A subtle
 * checker pattern behind the colour communicates alpha (useful for the
 * PREPARATION ghost which has baked low alpha), and a ring on
 * hover/focus confirms it's interactive.
 */
function PaletteSwatch({ colorKey, rgba, onChange }: PaletteSwatchProps) {
  const { t } = useTranslation();
  return (
    <label
      className={cn(
        'relative h-5 w-5 rounded border-2 border-border shrink-0 cursor-pointer overflow-hidden',
        'hover:ring-2 hover:ring-primary/50 focus-within:ring-2 focus-within:ring-primary/60',
        'transition-shadow',
      )}
      style={{
        // Checkerboard showing through low-alpha colours.
        backgroundImage:
          'linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)',
        backgroundSize: '6px 6px',
        backgroundPosition: '0 0, 0 3px, 3px -3px, -3px 0px',
      }}
      title={t('schedule.animation.swatchTitle', { colorKey })}
      aria-label={t('schedule.animation.swatchAriaLabel', { colorKey })}
    >
      <span
        className="absolute inset-0 rounded-sm"
        style={{ backgroundColor: rgbaToCss(rgba) }}
        aria-hidden
      />
      <input
        type="color"
        value={rgbaToHex(rgba)}
        onChange={(e) => onChange(colorKey, e.target.value)}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      />
    </label>
  );
}
