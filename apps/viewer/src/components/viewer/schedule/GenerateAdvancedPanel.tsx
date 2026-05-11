/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GenerateAdvancedPanel — disclosure-expanded "Advanced" section of the
 * Generate dialog. Holds rarely-touched fields (lag, PredefinedType,
 * schedule name, sequence linking toggle, skip-empty toggle). Extracted
 * so the main dialog stays readable.
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { GenerateScheduleOptions, SpatialGroupStrategy } from './generate-schedule';

const TASK_TYPES = [
  'CONSTRUCTION', 'INSTALLATION', 'DEMOLITION', 'DISMANTLE',
  'DISPOSAL', 'LOGISTIC', 'MAINTENANCE', 'MOVE',
  'OPERATION', 'REMOVAL', 'RENOVATION', 'ATTENDANCE',
  'USERDEFINED', 'NOTDEFINED',
] as const;

export interface GenerateAdvancedPanelProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  strategy: SpatialGroupStrategy;
  lagDays: number;
  predefinedType: string;
  scheduleName: string;
  linkSequences: boolean;
  skipEmptyGroups: boolean;
  onChange: <K extends keyof GenerateScheduleOptions>(
    key: K,
    value: GenerateScheduleOptions[K],
  ) => void;
}

export function GenerateAdvancedPanel({
  open,
  onOpenChange,
  strategy,
  lagDays,
  predefinedType,
  scheduleName,
  linkSequences,
  skipEmptyGroups,
  onChange,
}: GenerateAdvancedPanelProps) {
  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium text-left hover:bg-muted/40 transition-colors"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Advanced
      </button>
      {open && (
        <div className="grid gap-3 border-t p-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="gen-lag">Lag days (between groups)</Label>
              <Input
                id="gen-lag"
                type="number"
                min={0}
                step={1}
                value={lagDays}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  onChange('lagDays', Number.isFinite(v) && v >= 0 ? v : 0);
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="gen-type">PredefinedType</Label>
              <Select
                value={predefinedType}
                onValueChange={(v) => onChange('predefinedType', v)}
              >
                <SelectTrigger id="gen-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TASK_TYPES.map(t => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="gen-name">Work schedule name</Label>
            <Input
              id="gen-name"
              value={scheduleName}
              onChange={(e) => onChange('scheduleName', e.target.value)}
              placeholder="Construction schedule"
            />
          </div>

          <ToggleRow
            label="Link tasks with FS dependencies"
            description="Adds IfcRelSequence edges between consecutive groups."
            checked={linkSequences}
            onChange={(v) => onChange('linkSequences', v)}
          />
          <ToggleRow
            label="Skip empty groups"
            description={
              strategy === 'IfcElement'
                ? 'Ignore Z slices with no elements.'
                : 'Ignore storeys or buildings with no contained products.'
            }
            checked={skipEmptyGroups}
            onChange={(v) => onChange('skipEmptyGroups', v)}
          />
        </div>
      )}
    </div>
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
      <span className="grid gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}
