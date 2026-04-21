/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AnimationSettingsPopover — compact dropdown from the Gantt toolbar that
 * controls the 4D animation style (minimal vs. phased) and the palette
 * applied to the lifecycle phases.
 *
 * Hosted off a DropdownMenu so the popover positions correctly next to
 * the Sparkles button and stacks on top of the Gantt canvas.
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

/** Palette entries we surface in the UI legend (skip PREPARATION since it's
 *  not a task type). Ordered by real-world usage frequency. */
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
];

function rgbaToCss(rgba: RGBA): string {
  const r = Math.round(rgba[0] * 255);
  const g = Math.round(rgba[1] * 255);
  const b = Math.round(rgba[2] * 255);
  return `rgba(${r},${g},${b},${rgba[3]})`;
}

export function AnimationSettingsPopover({
  animationEnabled,
  onToggleAnimation,
}: AnimationSettingsPopoverProps) {
  const settings = useViewerStore(s => s.animationSettings);
  const patch = useViewerStore(s => s.patchAnimationSettings);
  const reset = useViewerStore(s => s.resetAnimationSettings);

  const setStyle = useCallback((style: AnimationSettings['style']) => patch({ style }), [patch]);

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
      <DropdownMenuContent align="end" className="w-[320px] p-3">
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

        {/* ── Style (minimal vs. phased) ──────────────────────────── */}
        <div className="grid gap-1.5 py-2">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Style</Label>
          <div className="grid grid-cols-2 gap-2">
            <StyleTile
              label="Minimal"
              description="Hard reveal, no colour"
              active={settings.style === 'minimal'}
              onSelect={() => setStyle('minimal')}
            />
            <StyleTile
              label="Phased"
              description="Type-coloured lifecycle"
              active={settings.style === 'phased'}
              onSelect={() => setStyle('phased')}
            />
          </div>
        </div>

        {settings.style === 'phased' && (
          <>
            <DropdownMenuSeparator />

            {/* ── Lifecycle toggles ──────────────────────────────── */}
            <div className="grid gap-2 py-2">
              <ToggleRow
                label="Colour by task type"
                description="Green=construction, blue=install, red=demolition…"
                checked={settings.colorizeByTaskType}
                onChange={v => patch({ colorizeByTaskType: v })}
              />
              <ToggleRow
                label="Preparation ghost"
                description="Ghost-blue outline before work starts."
                checked={settings.showPreparationGhost}
                onChange={v => patch({ showPreparationGhost: v })}
              />
              <ToggleRow
                label="Animate demolition"
                description="Fade products out during removal tasks."
                checked={settings.animateDemolition}
                onChange={v => patch({ animateDemolition: v })}
              />
              <ToggleRow
                label="Hide upcoming products"
                description="Don't render work that hasn't started."
                checked={settings.hideBeforePreparation}
                onChange={v => patch({ hideBeforePreparation: v })}
              />
            </div>

            <DropdownMenuSeparator />

            {/* ── Preparation window ─────────────────────────────── */}
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

            <DropdownMenuSeparator />

            {/* ── Palette legend ─────────────────────────────────── */}
            <div className="grid gap-1 py-2">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Palette (IfcTaskTypeEnum)
              </Label>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1 pt-1">
                {PALETTE_LEGEND.map(entry => (
                  <div key={entry.key} className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="h-3 w-3 rounded-sm border border-border shrink-0"
                      style={{ backgroundColor: rgbaToCss(settings.palette[entry.key] ?? DEFAULT_PALETTE[entry.key]) }}
                    />
                    <span className="text-[11px] text-muted-foreground truncate" title={entry.key}>
                      {entry.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <DropdownMenuSeparator />

            <div className="flex items-center justify-end pt-1">
              <Button size="sm" variant="ghost" onClick={reset} className="gap-1.5 text-xs">
                <RotateCcw className="h-3 w-3" />
                Reset defaults
              </Button>
            </div>
          </>
        )}
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
