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
import { CalendarPlus, Layers, Building2, Ruler, ChevronDown, ChevronRight, AlertTriangle, Loader2 } from 'lucide-react';
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

  // Resolve the source-model's geometry context. The `IfcElement` strategy
  // needs `meshes` + `idOffset` to compute each element's true Z elevation;
  // the spatial strategies don't touch geometry.
  const modelContext = useMemo(() => {
    const sourceModelId = activeModelId
      ?? (models.size === 1 ? (models.keys().next().value ?? '') : '');
    if (!sourceModelId) return null;
    const model = models.get(sourceModelId);
    const meshes = model?.geometryResult?.meshes;
    if (!meshes || meshes.length === 0) return null;
    return { meshes, idOffset: model?.idOffset ?? 0 };
  }, [models, activeModelId]);

  const hasSpatial = canGenerateScheduleFrom(activeStore);
  const hasGeometry = !!modelContext;
  const canGenerate = hasSpatial || hasGeometry;

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

  // If the only available source is geometry (no spatial hierarchy),
  // auto-switch the strategy to `IfcElement` so the preview isn't empty.
  useEffect(() => {
    if (!open) return;
    if (!hasSpatial && hasGeometry && options.strategy !== 'IfcElement') {
      setOptions(prev => ({ ...prev, strategy: 'IfcElement' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasSpatial, hasGeometry]);

  // Live preview — runs on every option change. The helper is pure and cheap
  // enough (O(vertex count) for the Z strategy; O(storeys × products) for
  // the others) that we don't debounce.
  const preview = useMemo(() => {
    if (!canGenerate) return null;
    return generateScheduleFromSpatialHierarchy(activeStore, options, modelContext);
  }, [activeStore, canGenerate, modelContext, options]);

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
            Generate schedule
          </DialogTitle>
          <DialogDescription>
            Creates a work schedule with one task per group and assigns every
            product in that group to the task, so the 4D Gantt animation can
            reveal them as time advances.
          </DialogDescription>
        </DialogHeader>

        {!canGenerate ? (
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-foreground">Nothing to group by</p>
              <p className="text-muted-foreground">
                The loaded model has neither a spatial hierarchy nor visible
                geometry. Load an IFC with IfcBuildingStorey/IfcBuilding
                containers or meshed elements and try again.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            {/* Strategy — three tiles. Height is the rescue for models with
                broken spatial hierarchies; sub-options reveal only when it's
                active, keeping the dialog uncluttered for the common case. */}
            <div className="grid gap-2">
              <Label>Group by</Label>
              <div className="grid grid-cols-3 gap-2">
                <StrategyChoice
                  icon={<Layers className="h-4 w-4" />}
                  label="Storey"
                  description="Per IfcBuildingStorey"
                  active={options.strategy === 'IfcBuildingStorey'}
                  disabled={!hasSpatial}
                  onSelect={() => handleChange('strategy', 'IfcBuildingStorey')}
                />
                <StrategyChoice
                  icon={<Building2 className="h-4 w-4" />}
                  label="Building"
                  description="Per IfcBuilding"
                  active={options.strategy === 'IfcBuilding'}
                  disabled={!hasSpatial}
                  onSelect={() => handleChange('strategy', 'IfcBuilding')}
                />
                <StrategyChoice
                  icon={<Ruler className="h-4 w-4" />}
                  label="Height"
                  description="Slice by element Z"
                  active={options.strategy === 'IfcElement'}
                  disabled={!hasGeometry}
                  onSelect={() => handleChange('strategy', 'IfcElement')}
                />
              </div>
              {options.strategy !== 'IfcElement' && !hasSpatial && (
                <p className="text-[11px] text-muted-foreground">
                  Spatial hierarchy missing — only Height is available for this model.
                </p>
              )}
            </div>

            {/* Height sub-panel — only when the IfcElement strategy is active.
                Inline, bordered, visually tied to the tile above so it reads as
                "settings for the selected group-by". */}
            {options.strategy === 'IfcElement' && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 grid gap-3">
                <div className="flex items-center gap-2">
                  <Ruler className="h-3.5 w-3.5 text-primary" />
                  <span className="text-xs font-medium">Height-slice options</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    Uses geometry, ignores spatial tree
                  </span>
                </div>

                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="gen-tol" className="text-xs">Slice height</Label>
                    <span className="text-xs font-mono text-muted-foreground">
                      {options.heightTolerance.toFixed(1)} m
                    </span>
                  </div>
                  <input
                    id="gen-tol"
                    type="range"
                    min={0.5}
                    max={10}
                    step={0.25}
                    value={options.heightTolerance}
                    onChange={(e) => handleChange('heightTolerance', parseFloat(e.target.value))}
                    className="w-full accent-primary"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Elements whose geometry centroid Z falls inside the same
                    band share a task. Typical storey heights are 3–4 m.
                  </p>
                </div>

                <div className="grid gap-1.5">
                  <Label className="text-xs">Subdivide each slice</Label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {([
                      { k: 'none',  label: 'None'  },
                      { k: 'class', label: 'Class' },
                      { k: 'type',  label: 'Type'  },
                      { k: 'name',  label: 'Name'  },
                    ] as const).map(opt => (
                      <SubgroupPill
                        key={opt.k}
                        label={opt.label}
                        active={options.elementZSubgroup === opt.k}
                        onSelect={() => handleChange('elementZSubgroup', opt.k)}
                      />
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {options.elementZSubgroup === 'none'
                      ? 'One task per slice — every element in the band goes to that task.'
                      : options.elementZSubgroup === 'class'
                      ? 'Split each slice by IFC class (IfcWall, IfcSlab, …).'
                      : options.elementZSubgroup === 'type'
                      ? 'Split each slice by the element’s type name (IfcRelDefinesByType target).'
                      : 'Split each slice by each element’s Name attribute.'}
                  </p>
                </div>
              </div>
            )}

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
                    description={
                      options.strategy === 'IfcElement'
                        ? 'Ignore Z slices with no elements.'
                        : 'Ignore storeys or buildings with no contained products.'
                    }
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
  /** When true the tile is unavailable (greyed out, not clickable). */
  disabled?: boolean;
  onSelect: () => void;
}

function StrategyChoice({ icon, label, description, active, disabled, onSelect }: StrategyChoiceProps) {
  const base = 'flex items-start gap-2 rounded-md border p-2.5 text-left transition-colors';
  const state = active
    ? 'border-primary bg-primary/5 text-foreground'
    : disabled
    ? 'border-dashed border-input/60 bg-muted/20 text-muted-foreground cursor-not-allowed opacity-60'
    : 'border-input hover:bg-muted/40 text-foreground';
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onSelect}
      className={`${base} ${state}`}
      aria-pressed={active}
      disabled={disabled}
      title={disabled ? 'Not available for this model' : undefined}
    >
      <span className={'mt-0.5 ' + (active ? 'text-primary' : 'text-muted-foreground')}>{icon}</span>
      <span className="grid gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

interface SubgroupPillProps {
  label: string;
  active: boolean;
  onSelect: () => void;
}

/**
 * Compact 4-across segmented pill used for the Z-subgroup mode
 * (None / Class / Type / Name). Kept small and modest so it reads as a
 * setting, not a navigation target.
 */
function SubgroupPill({ label, active, onSelect }: SubgroupPillProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={
        'rounded border px-2 py-1 text-xs transition-colors ' +
        (active
          ? 'border-primary bg-primary/10 text-primary font-medium'
          : 'border-input text-muted-foreground hover:bg-muted/40 hover:text-foreground')
      }
    >
      {label}
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
