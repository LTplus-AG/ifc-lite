/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GenerateScheduleDialog — spawn an IFC 4D schedule from the model's spatial
 * hierarchy in a few clicks.
 *
 * Progressive disclosure: the primary flow (strategy / start / duration /
 * order) is always visible; lag, schedule name, PredefinedType, and the
 * link-sequence / skip-empty toggles hide behind "Advanced".
 *
 * Writes the generated schedule into the viewer store via `setScheduleData`,
 * which is the same path the 4D Gantt and playback loop already read from.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { CalendarPlus, Layers, Building2, ChevronDown, ChevronRight, AlertTriangle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { serializeScheduleToStep } from '@ifc-lite/parser';
import {
  generateScheduleFromSpatialHierarchy,
  canGenerateScheduleFrom,
  defaultStartDate,
  resolveActiveDataStore,
  DEFAULT_OPTIONS,
  type GenerateScheduleOptions,
  type SpatialGroupStrategy,
  type GenerateOrder,
} from './generate-schedule';
import { formatDateTime } from './schedule-utils';

interface GenerateScheduleDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

const TASK_TYPES = [
  'CONSTRUCTION', 'INSTALLATION', 'DEMOLITION', 'DISMANTLE',
  'DISPOSAL', 'LOGISTIC', 'MAINTENANCE', 'MOVE',
  'OPERATION', 'REMOVAL', 'RENOVATION', 'ATTENDANCE',
  'USERDEFINED', 'NOTDEFINED',
] as const;

export function GenerateScheduleDialog({ open, onOpenChange }: GenerateScheduleDialogProps) {
  const { ifcDataStore, models, activeModelId } = useIfc();
  const commitGeneratedSchedule = useViewerStore(s => s.commitGeneratedSchedule);
  const setGanttPanelVisible = useViewerStore(s => s.setGanttPanelVisible);
  const setAnimationEnabled = useViewerStore(s => s.setAnimationEnabled);

  // Resolve the store to read from in federation-aware order. See
  // `resolveActiveDataStore` in GanttPanel for the shared rationale.
  const activeStore = resolveActiveDataStore(ifcDataStore, activeModelId, models);
  const hasSpatial = canGenerateScheduleFrom(activeStore);

  const [options, setOptions] = useState<GenerateScheduleOptions>(DEFAULT_OPTIONS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset form state on every (re)open so users can reuse the dialog.
  useEffect(() => {
    if (open) {
      // Compute a fresh start date on each open so re-opening the dialog
      // reflects "today" — `DEFAULT_OPTIONS.startDate` is evaluated at module
      // load and goes stale in long-running sessions.
      setOptions({ ...DEFAULT_OPTIONS, startDate: defaultStartDate() });
      setAdvancedOpen(false);
      setSubmitting(false);
    }
  }, [open]);

  // Live preview — runs on every option change. The helper is pure and cheap
  // (O(storeys × products)), so we don't debounce.
  const preview = useMemo(() => {
    if (!hasSpatial) return null;
    return generateScheduleFromSpatialHierarchy(activeStore, options);
  }, [activeStore, hasSpatial, options]);

  const canSubmit = !!preview && !preview.empty && preview.groupCount > 0 && !submitting;

  const handleChange = useCallback(<K extends keyof GenerateScheduleOptions>(
    key: K,
    value: GenerateScheduleOptions[K],
  ) => {
    setOptions(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleGenerate = useCallback(() => {
    if (!preview || preview.empty) return;
    setSubmitting(true);

    // DEBUG: full inspection of what's being added to the model. Dumps the
    // extraction (tasks + work schedules + sequences) *and* the STEP lines
    // the serializer will emit when the file is exported. Safe to keep —
    // runs only on user-initiated generation and only logs to console.
    try {
      const extraction = preview.extraction;
      const stepPreview = serializeScheduleToStep(extraction, {
        // These IDs don't matter for inspection — the export adapter
        // remaps them to the host file's ID space at injection time.
        nextId: 1_000_000,
      });
      /* eslint-disable no-console */
      console.groupCollapsed(
        `%c[IfcTask] Generated schedule — ${extraction.tasks.length} task(s), ${stepPreview.lines.length} STEP line(s)`,
        'color:#6ea2ff;font-weight:bold',
      );
      console.log('options', options);
      console.log('workSchedules', extraction.workSchedules);
      console.log('tasks', extraction.tasks);
      console.log('sequences', extraction.sequences);
      console.log('stats', stepPreview.stats);
      console.log('STEP preview (first 50 lines):');
      for (const line of stepPreview.lines.slice(0, 50)) console.log(line);
      if (stepPreview.lines.length > 50) {
        console.log(`… ${stepPreview.lines.length - 50} more line(s). Full STEP:`);
        console.log(stepPreview.lines.join('\n'));
      }
      console.log('raw extraction (JSON)', JSON.stringify(extraction, null, 2));
      console.groupEnd();
      /* eslint-enable no-console */
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[IfcTask] Debug log failed (non-fatal):', err);
    }

    // rAF gives the button time to paint its pressed state before we swap
    // the Gantt rows; cheap-but-visible feedback.
    requestAnimationFrame(() => {
      // Attribute the generated schedule to the currently-active model.
      // Legacy single-model sessions fall back to '__legacy__' so the
      // dirty flag still pairs with the viewer's model identity.
      const sourceModelId = activeModelId
        ?? (models.size === 1 ? (models.keys().next().value ?? '__legacy__') : '__legacy__');
      commitGeneratedSchedule(preview.extraction, sourceModelId);
      setGanttPanelVisible(true);
      setAnimationEnabled(true);
      setSubmitting(false);
      onOpenChange(false);
    });
  }, [preview, options, commitGeneratedSchedule, setGanttPanelVisible, setAnimationEnabled, onOpenChange, activeModelId, models]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="h-5 w-5 text-primary" />
            Generate schedule from spatial hierarchy
          </DialogTitle>
          <DialogDescription>
            Creates a work schedule with one task per building storey (or building),
            and assigns every product contained in that group to the task so the 4D
            Gantt animation can reveal them as time advances.
          </DialogDescription>
        </DialogHeader>

        {!hasSpatial ? (
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-foreground">No spatial hierarchy found</p>
              <p className="text-muted-foreground">
                Load an IFC model that contains at least one IfcBuildingStorey or
                IfcBuilding and try again.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            {/* Strategy */}
            <div className="grid gap-2">
              <Label>Group by</Label>
              <div className="grid grid-cols-2 gap-2">
                <StrategyChoice
                  icon={<Layers className="h-4 w-4" />}
                  label="Storey"
                  description="One task per IfcBuildingStorey"
                  active={options.strategy === 'IfcBuildingStorey'}
                  onSelect={() => handleChange('strategy', 'IfcBuildingStorey')}
                />
                <StrategyChoice
                  icon={<Building2 className="h-4 w-4" />}
                  label="Building"
                  description="One task per IfcBuilding"
                  active={options.strategy === 'IfcBuilding'}
                  onSelect={() => handleChange('strategy', 'IfcBuilding')}
                />
              </div>
            </div>

            {/* Primary fields */}
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="gen-start">Start date</Label>
                <Input
                  id="gen-start"
                  type="datetime-local"
                  value={options.startDate.slice(0, 16)}
                  onChange={(e) => {
                    const v = e.target.value;
                    handleChange('startDate', v ? `${v}:00` : DEFAULT_OPTIONS.startDate);
                  }}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="gen-duration">Days per group</Label>
                <Input
                  id="gen-duration"
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={options.daysPerGroup}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    handleChange('daysPerGroup', Number.isFinite(v) && v > 0 ? v : 1);
                  }}
                />
              </div>
            </div>

            {/* Order */}
            <div className="grid gap-2">
              <Label>Order</Label>
              <div className="grid grid-cols-2 gap-2">
                <StrategyChoice
                  icon={<span className="text-xs font-semibold">↑</span>}
                  label="Bottom-up"
                  description="Site → ground → upper floors"
                  active={options.order === 'bottom-up'}
                  onSelect={() => handleChange('order', 'bottom-up' satisfies GenerateOrder)}
                />
                <StrategyChoice
                  icon={<span className="text-xs font-semibold">↓</span>}
                  label="Top-down"
                  description="Roof → upper floors → ground"
                  active={options.order === 'top-down'}
                  onSelect={() => handleChange('order', 'top-down' satisfies GenerateOrder)}
                />
              </div>
            </div>

            {/* Advanced */}
            <div className="rounded-md border">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium text-left hover:bg-muted/40 transition-colors"
                onClick={() => setAdvancedOpen(o => !o)}
                aria-expanded={advancedOpen}
              >
                {advancedOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                Advanced
              </button>
              {advancedOpen && (
                <div className="grid gap-3 border-t p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="gen-lag">Lag days (between groups)</Label>
                      <Input
                        id="gen-lag"
                        type="number"
                        min={0}
                        step={1}
                        value={options.lagDays}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          handleChange('lagDays', Number.isFinite(v) && v >= 0 ? v : 0);
                        }}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="gen-type">PredefinedType</Label>
                      <Select
                        value={options.predefinedType}
                        onValueChange={(v) => handleChange('predefinedType', v)}
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
                      value={options.scheduleName}
                      onChange={(e) => handleChange('scheduleName', e.target.value)}
                      placeholder="Construction schedule"
                    />
                  </div>

                  <ToggleRow
                    label="Link tasks with FS dependencies"
                    description="Adds IfcRelSequence edges between consecutive groups."
                    checked={options.linkSequences}
                    onChange={(v) => handleChange('linkSequences', v)}
                  />
                  <ToggleRow
                    label="Skip empty groups"
                    description="Ignore storeys with no contained products."
                    checked={options.skipEmptyGroups}
                    onChange={(v) => handleChange('skipEmptyGroups', v)}
                  />
                </div>
              )}
            </div>

            {/* Live summary */}
            <div className="rounded-md bg-muted/30 p-3 text-sm">
              {preview && !preview.empty ? (
                <div className="grid gap-1">
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium">Summary</span>
                    <span className="text-xs text-muted-foreground">Generated locally — not written to IFC</span>
                  </div>
                  <p>
                    <span className="font-semibold">{preview.groupCount}</span> tasks ·{' '}
                    <span className="font-semibold">{preview.productCount}</span> products ·{' '}
                    finishes <span className="font-mono">{formatDateTime(new Date(preview.finishDate).getTime())}</span>
                  </p>
                  {preview.groupCount > 0 && (
                    <p className="text-xs text-muted-foreground">
                      First task: <span className="font-medium">{preview.extraction.tasks[0]?.name}</span>
                      {preview.groupCount > 1 && <> · last: <span className="font-medium">{preview.extraction.tasks.at(-1)?.name}</span></>}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground">
                  No groups match the current options — tweak the strategy or disable
                  &quot;Skip empty groups&quot;.
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleGenerate} disabled={!canSubmit}>
            {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CalendarPlus className="h-4 w-4 mr-2" />}
            Generate schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface StrategyChoiceProps {
  icon: React.ReactNode;
  label: string;
  description: string;
  active: boolean;
  onSelect: () => void;
}

function StrategyChoice({ icon, label, description, active, onSelect }: StrategyChoiceProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={
        'flex items-start gap-2 rounded-md border p-2.5 text-left transition-colors ' +
        (active
          ? 'border-primary bg-primary/5 text-foreground'
          : 'border-input hover:bg-muted/40 text-foreground')
      }
      aria-pressed={active}
    >
      <span className={'mt-0.5 ' + (active ? 'text-primary' : 'text-muted-foreground')}>{icon}</span>
      <span className="grid gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
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
      <span className="grid gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}
