/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AnimationSettingsPopover — compact dropdown from the Gantt toolbar that
 * controls the 4D animation behaviour.
 *
 * Two conceptual layers:
 *   • **Timing** (minimal + phased) — schedule-driven visibility: hide
 *     upcoming products, animate demolition. Always available.
 *   • **Colour overlays** (phased only, opt-in) — task-type palette,
 *     preparation ghost, intensity. Customizable palette.
 *
 * The dropdown collapses the colour controls entirely when style=minimal
 * so the "no colour" case is visually calm and obvious.
 */

import { useCallback } from 'react';
import { Sparkles, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import {
  DEFAULT_PALETTE,
  type AnimationSettings,
  type TaskPaletteKey,
  type RGBA,
} from './schedule-animator';

interface AnimationSettingsPopoverProps {
  animationEnabled: boolean;
  onToggleAnimation: () => void;
}

/** Palette entries surfaced in the customizer — every IfcTaskTypeEnum
 *  value the animator uses. Ordered by expected real-world frequency. */
const PALETTE_LEGEND: { key: TaskPaletteKey; label: string }[] = [
  { key: 'CONSTRUCTION', label: 'Construction' },
  { key: 'INSTALLATION', label: 'Installation' },
  { key: 'RENOVATION', label: 'Renovation' },
  { key: 'MAINTENANCE', label: 'Maintenance' },
  { key: 'LOGISTIC', label: 'Logistic' },
  { key: 'OPERATION', label: 'Operation' },
  { key: 'MOVE', label: 'Move' },
  { key: 'ATTENDANCE', label: 'Attendance' },
  { key: 'DEMOLITION', label: 'Demolition' },
  { key: 'DISMANTLE', label: 'Dismantle' },
  { key: 'REMOVAL', label: 'Removal' },
  { key: 'DISPOSAL', label: 'Disposal' },
  { key: 'USERDEFINED', label: 'User-defined' },
  { key: 'NOTDEFINED', label: 'Not defined' },
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
  const settings = useViewerStore(s => s.animationSettings);
  const patch = useViewerStore(s => s.patchAnimationSettings);
  const reset = useViewerStore(s => s.resetAnimationSettings);

  const setStyle = useCallback(
    (style: AnimationSettings['style']) => patch({ style }),
    [patch],
  );

  const setPaletteColor = useCallback((key: TaskPaletteKey, hex: string) => {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const prev = settings.palette[key] ?? DEFAULT_PALETTE[key];
    // Preserve the existing alpha — the native picker is opaque so we only
    // update RGB. Keeps the PREPARATION ghost at its 0.5 alpha even when
    // users edit its hue.
    const next: RGBA = [rgb[0], rgb[1], rgb[2], prev[3]];
    patch({ palette: { ...settings.palette, [key]: next } });
  }, [patch, settings.palette]);

  const resetPaletteEntry = useCallback((key: TaskPaletteKey) => {
    patch({ palette: { ...settings.palette, [key]: DEFAULT_PALETTE[key] } });
  }, [patch, settings.palette]);

  const phased = settings.style === 'phased';

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant={animationEnabled ? 'default' : 'ghost'}
              aria-label="Animation settings"
            >
              <Sparkles className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>4D animation settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-[340px] p-3">
        {/* ── Master toggle ────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-3 pb-2">
          <div className="grid gap-0.5">
            <span className="text-sm font-medium">4D animation</span>
            <span className="text-[11px] text-muted-foreground">
              Drives viewport from the Gantt clock.
            </span>
          </div>
          <Switch checked={animationEnabled} onCheckedChange={onToggleAnimation} />
        </div>

        <DropdownMenuSeparator />

        {/* ── Style tiles — the layer switch ───────────────────────── */}
        <div className="grid gap-1.5 py-2">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Style</Label>
          <div className="grid grid-cols-2 gap-2">
            <StyleTile
              label="Minimal"
              description="Visibility only — clean reveal, no colour"
              active={!phased}
              onSelect={() => setStyle('minimal')}
            />
            <StyleTile
              label="Phased"
              description="Task-type colour overlays + preparation ghost"
              active={phased}
              onSelect={() => setStyle('phased')}
            />
          </div>
        </div>

        <DropdownMenuSeparator />

        {/* ── Timing-layer toggles (always visible) ────────────────── */}
        <div className="grid gap-2 py-2">
          <ToggleRow
            label="Hide upcoming products"
            description="Don't render work that hasn't started yet."
            checked={settings.hideBeforePreparation}
            onChange={v => patch({ hideBeforePreparation: v })}
          />
          <ToggleRow
            label="Animate demolition"
            description="Remove products when demolition tasks complete."
            checked={settings.animateDemolition}
            onChange={v => patch({ animateDemolition: v })}
          />
        </div>

        {/* ── Phased-only section ──────────────────────────────────── */}
        {!phased && (
          <>
            <DropdownMenuSeparator />
            <p className="text-[11px] text-muted-foreground italic pt-1 pb-0.5">
              Switch to <span className="font-medium not-italic">Phased</span> to
              enable task-type colour overlays, preparation ghost, and a custom
              palette.
            </p>
          </>
        )}

        {phased && (
          <>
            <DropdownMenuSeparator />

            {/* ── Colour-layer toggles ─────────────────────────────── */}
            <div className="grid gap-2 py-2">
              <ToggleRow
                label="Colour by task type"
                description="Green=construction, blue=install, red=demolition…"
                checked={settings.colorizeByTaskType}
                onChange={v => patch({ colorizeByTaskType: v })}
              />
              <ToggleRow
                label="Preparation ghost"
                description="Translucent outline inside the look-ahead window."
                checked={settings.showPreparationGhost}
                onChange={v => patch({ showPreparationGhost: v })}
              />
            </div>

            <DropdownMenuSeparator />

            {/* ── Look-ahead + intensity sliders ───────────────────── */}
            <div className="grid gap-1.5 py-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="prep-days" className="text-xs">Look-ahead window</Label>
                <span className="text-xs font-mono text-muted-foreground">{settings.preparationDays}d</span>
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

            <div className="grid gap-1.5 py-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="palette-intensity" className="text-xs">Colour intensity</Label>
                <span className="text-xs font-mono text-muted-foreground">
                  {Math.round(settings.paletteIntensity * 100)}%
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
                0% = no colour (equivalent to Minimal); 100% = solid paint.
              </span>
            </div>

            {settings.showPreparationGhost && (
              <>
                <DropdownMenuSeparator />
                {/* ── Preparation ghost colour (separate from task types) ── */}
                <div className="grid gap-1.5 py-2">
                  <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Preparation ghost colour
                  </Label>
                  <PaletteRow
                    label="Ghost (look-ahead window)"
                    colorKey="PREPARATION"
                    rgba={settings.palette.PREPARATION ?? DEFAULT_PALETTE.PREPARATION}
                    onChange={setPaletteColor}
                    onResetEntry={resetPaletteEntry}
                    isDefault={rgbEquals(
                      settings.palette.PREPARATION ?? DEFAULT_PALETTE.PREPARATION,
                      DEFAULT_PALETTE.PREPARATION,
                    )}
                  />
                </div>
              </>
            )}

            <DropdownMenuSeparator />

            {/* ── Task-type palette editor ─────────────────────────── */}
            <div className="grid gap-1.5 py-2">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Task-type palette
              </Label>
              <span className="text-[10px] text-muted-foreground -mt-0.5 mb-1">
                Click any swatch to change the colour for that
                <span className="font-mono"> IfcTaskTypeEnum</span> value.
              </span>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {PALETTE_LEGEND.map(entry => {
                  const current = settings.palette[entry.key] ?? DEFAULT_PALETTE[entry.key];
                  return (
                    <PaletteRow
                      key={entry.key}
                      label={entry.label}
                      colorKey={entry.key}
                      rgba={current}
                      onChange={setPaletteColor}
                      onResetEntry={resetPaletteEntry}
                      isDefault={rgbEquals(current, DEFAULT_PALETTE[entry.key])}
                      compact
                    />
                  );
                })}
              </div>
            </div>
          </>
        )}

        <DropdownMenuSeparator />

        <div className="flex items-center justify-end pt-1">
          <Button size="sm" variant="ghost" onClick={reset} className="gap-1.5 text-xs">
            <RotateCcw className="h-3 w-3" />
            Reset defaults
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface StyleTileProps {
  label: string;
  description: string;
  active: boolean;
  onSelect: () => void;
}

function StyleTile({ label, description, active, onSelect }: StyleTileProps) {
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
      <span className="text-xs font-medium">{label}</span>
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
  /** True when the current colour equals the default — hides the reset dot. */
  isDefault: boolean;
  /** Compact mode: smaller swatch + smaller label for the 2-col grid. */
  compact?: boolean;
}

/**
 * Single palette entry editor. The swatch itself is a colour input —
 * clicking it opens the system colour picker. When the current colour
 * differs from the default, a small reset dot appears; clicking it restores
 * the default for that entry alone.
 */
function PaletteRow({ label, colorKey, rgba, onChange, onResetEntry, isDefault, compact }: PaletteRowProps) {
  const hex = rgbaToHex(rgba);
  return (
    <div className="flex items-center gap-1.5 min-w-0 group">
      <label
        className={cn(
          'relative rounded-sm border border-border shrink-0 cursor-pointer',
          'hover:ring-2 hover:ring-primary/40 transition-shadow',
          compact ? 'h-3.5 w-3.5' : 'h-4 w-4',
        )}
        aria-label={`Change colour for ${label}`}
        title={`${label} — click to edit`}
      >
        <span
          className="absolute inset-0 rounded-sm"
          style={{ backgroundColor: rgbaToCss(rgba) }}
          aria-hidden
        />
        <input
          type="color"
          value={hex}
          onChange={(e) => onChange(colorKey, e.target.value)}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
      </label>
      <span
        className={cn(
          'text-muted-foreground truncate flex-1 min-w-0',
          compact ? 'text-[11px]' : 'text-xs',
        )}
        title={colorKey}
      >
        {label}
      </span>
      {!isDefault && (
        <button
          type="button"
          onClick={() => onResetEntry(colorKey)}
          className="h-3 w-3 rounded-full border border-primary/60 bg-primary/20 hover:bg-primary/40 shrink-0 transition-colors"
          aria-label={`Reset ${label} to default colour`}
          title="Modified — click to reset"
        />
      )}
    </div>
  );
}
