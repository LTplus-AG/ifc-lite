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
import { useTranslation } from '@/i18n';
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
  /**
   * Whether to add a standalone `IfcWorkPlan` container that groups the
   * generated `IfcWorkSchedule`. Kept out of `GenerateScheduleOptions` (its
   * own on/off + name pair here) rather than folded into the generator's
   * options, as an optional feature (see `buildWorkPlanInfo`'s doc comment
   * for round-trip details).
   */
  createWorkPlan: boolean;
  onCreateWorkPlanChange: (next: boolean) => void;
  workPlanName: string;
  onWorkPlanNameChange: (next: string) => void;
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
  createWorkPlan,
  onCreateWorkPlanChange,
  workPlanName,
  onWorkPlanNameChange,
}: GenerateAdvancedPanelProps) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium text-left hover:bg-muted/40 transition-colors"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {t('schedule.generateAdvanced.toggle')}
      </button>
      {open && (
        <div className="grid gap-3 border-t p-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="gen-lag">{t('schedule.generateAdvanced.lagDaysLabel')}</Label>
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
              <Label htmlFor="gen-type">{t('schedule.generateAdvanced.predefinedTypeLabel')}</Label>
              <Select
                value={predefinedType}
                onValueChange={(v) => onChange('predefinedType', v)}
              >
                <SelectTrigger id="gen-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TASK_TYPES.map(taskType => (
                    <SelectItem key={taskType} value={taskType}>{taskType}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="gen-name">{t('schedule.generateAdvanced.scheduleNameLabel')}</Label>
            <Input
              id="gen-name"
              value={scheduleName}
              onChange={(e) => onChange('scheduleName', e.target.value)}
              placeholder={t('schedule.generateAdvanced.scheduleNamePlaceholder')}
            />
          </div>

          <ToggleRow
            label={t('schedule.generateAdvanced.linkSequencesLabel')}
            description={t('schedule.generateAdvanced.linkSequencesDescription')}
            checked={linkSequences}
            onChange={(v) => onChange('linkSequences', v)}
          />
          <ToggleRow
            label={t('schedule.generateAdvanced.skipEmptyLabel')}
            description={
              strategy === 'IfcElement'
                ? t('schedule.generateAdvanced.skipEmptyDescriptionElement')
                : t('schedule.generateAdvanced.skipEmptyDescriptionSpatial')
            }
            checked={skipEmptyGroups}
            onChange={(v) => onChange('skipEmptyGroups', v)}
          />
          <ToggleRow
            label={t('schedule.generateAdvanced.workPlanToggleLabel')}
            description={t('schedule.generateAdvanced.workPlanToggleDescription')}
            checked={createWorkPlan}
            onChange={onCreateWorkPlanChange}
          />
          {createWorkPlan && (
            <div className="grid gap-1.5">
              <Label htmlFor="gen-plan-name">{t('schedule.generateAdvanced.workPlanNameLabel')}</Label>
              <Input
                id="gen-plan-name"
                value={workPlanName}
                onChange={(e) => onWorkPlanNameChange(e.target.value)}
                placeholder={t('schedule.generateAdvanced.workPlanNamePlaceholder')}
              />
            </div>
          )}
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
