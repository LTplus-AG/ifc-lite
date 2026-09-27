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

import { useEffect, useMemo, useState, useCallback, type ReactNode } from 'react';
import { CalendarPlus, Layers, Building2, Ruler, AlertTriangle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
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
import { useTranslation } from '@/i18n';
import { styleInterpolatedValues } from '@/i18n/richInterpolate';
import { useViewerStore } from '@/store';
import { resolveScheduleSourceModelId } from '@/store/slices/schedule-edit-helpers';
import { useIfc } from '@/hooks/useIfc';
import {
  generateScheduleFromSpatialHierarchy,
  canGenerateScheduleFrom,
  defaultStartDate,
  resolveActiveDataStore,
  DEFAULT_OPTIONS,
  type GenerateScheduleOptions,
  type GenerateOrder,
} from './generate-schedule';
import { buildWorkPlanInfo, logGeneratedScheduleDebug } from './schedule-utils';
import { formatLocaleDate } from '@/i18n/intlFormat';
import { HeightStrategyPanel } from './HeightStrategyPanel';
import { GenerateAdvancedPanel } from './GenerateAdvancedPanel';
import { ScheduleSummaryLine } from './ScheduleSummaryLine';

interface GenerateScheduleDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

export function GenerateScheduleDialog({ open, onOpenChange }: GenerateScheduleDialogProps) {
  const { t, locale } = useTranslation();
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
    const sourceModelId = resolveScheduleSourceModelId(models, activeModelId);
    if (!sourceModelId) return null;
    const model = models.get(sourceModelId);
    const meshes = model?.geometryResult?.meshes;
    if (!meshes || meshes.length === 0) return null;
    return { meshes, idOffset: model?.idOffset ?? 0 };
  }, [models, activeModelId]);

  const hasSpatial = canGenerateScheduleFrom(activeStore);
  const hasGeometry = !!modelContext;
  const canGenerate = hasSpatial || hasGeometry;

  const [options, setOptions] = useState<GenerateScheduleOptions>({ ...DEFAULT_OPTIONS, scheduleName: '' });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Standalone IfcWorkPlan — see `buildWorkPlanInfo`'s doc comment for why
  // it's kept out of `GenerateScheduleOptions` and composed in here instead.
  const [createWorkPlan, setCreateWorkPlan] = useState(false);
  const [workPlanName, setWorkPlanName] = useState('');

  // Reset form state on every (re)open so users can reuse the dialog.
  useEffect(() => {
    if (open) {
      // Compute a fresh start date on each open so re-opening the dialog
      // reflects "today" — `DEFAULT_OPTIONS.startDate` is evaluated at module
      // load and goes stale in long-running sessions.
      setOptions({ ...DEFAULT_OPTIONS, startDate: defaultStartDate(), scheduleName: '' });
      setAdvancedOpen(false);
      setSubmitting(false);
      setCreateWorkPlan(false);
      setWorkPlanName('');
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

  // Live preview is cheap enough to run on every option change without debouncing.
  const defaultScheduleName = t('schedule.generateAdvanced.scheduleNamePlaceholder');
  const effectiveOptions = useMemo(() => ({ ...options, scheduleName: options.scheduleName.trim() || defaultScheduleName }), [options, defaultScheduleName]);
  const preview = useMemo(() => {
    if (!canGenerate) return null;
    return generateScheduleFromSpatialHierarchy(activeStore, effectiveOptions, modelContext);
  }, [activeStore, canGenerate, modelContext, effectiveOptions]);

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

    // Compose in the optional standalone IfcWorkPlan. A new object, not a
    // mutation of `preview.extraction` — that object is `useMemo`-cached
    // and reused across renders until `options` changes, so mutating it
    // in place would leak the plan into a later preview that didn't ask
    // for one.
    const extraction = createWorkPlan
      ? {
          ...preview.extraction,
          workSchedules: [
            ...preview.extraction.workSchedules,
            buildWorkPlanInfo(
              preview.extraction.workSchedules[0]?.globalId ?? 'workplan',
              workPlanName.trim() || t('schedule.generateAdvanced.workPlanNamePlaceholder'),
              // Group the generated IfcWorkSchedule(s) under this plan so
              // the relation round-trips (see buildWorkPlanInfo's doc
              // comment) instead of shipping a decorative orphan.
              preview.extraction.workSchedules.map(s => s.globalId),
            ),
          ],
        }
      : preview.extraction;

    logGeneratedScheduleDebug(extraction, effectiveOptions);

    // rAF gives the button time to paint its pressed state before we swap
    // the Gantt rows; cheap-but-visible feedback.
    requestAnimationFrame(() => {
      // Attribute the generated schedule to the currently-active model.
      // Legacy single-model sessions fall back to '__legacy__' so the
      // dirty flag still pairs with the viewer's model identity.
      const sourceModelId = resolveScheduleSourceModelId(models, activeModelId, '__legacy__');
      commitGeneratedSchedule(extraction, sourceModelId);
      setGanttPanelVisible(true);
      setAnimationEnabled(true);
      setSubmitting(false);
      onOpenChange(false);
    });
  }, [preview, effectiveOptions, createWorkPlan, workPlanName, t, commitGeneratedSchedule, setGanttPanelVisible, setAnimationEnabled, onOpenChange, activeModelId, models]);

  // Only read in the `preview && !preview.empty` branch below; computed
  // here (not memoized — cheap string ops) so the JSX itself stays a
  // single `styleInterpolatedValues` call per line instead of an IIFE.
  const firstTaskName = preview?.extraction.tasks[0]?.name ?? '';
  const lastTaskName = preview?.extraction.tasks.at(-1)?.name ?? '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="h-5 w-5 text-primary" />
            {t('schedule.generateDialog.title')}
          </DialogTitle>
          <DialogDescription>
            {t('schedule.generateDialog.description')}
          </DialogDescription>
        </DialogHeader>

        {!canGenerate ? (
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-foreground">{t('schedule.generateDialog.nothingToGroupByTitle')}</p>
              <p className="text-muted-foreground">
                {t('schedule.generateDialog.nothingToGroupByDescription')}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            {/* Strategy — three tiles. Height is the rescue for models with
                broken spatial hierarchies; sub-options reveal only when it's
                active, keeping the dialog uncluttered for the common case. */}
            <div className="grid gap-2">
              <Label>{t('schedule.generateDialog.groupByLabel')}</Label>
              <div className="grid grid-cols-3 gap-2">
                <StrategyChoice
                  icon={<Layers className="h-4 w-4" />}
                  label={t('schedule.generateDialog.strategyStorey')}
                  description={t('schedule.generateDialog.strategyStoreyDescription')}
                  active={options.strategy === 'IfcBuildingStorey'}
                  disabled={!hasSpatial}
                  onSelect={() => handleChange('strategy', 'IfcBuildingStorey')}
                />
                <StrategyChoice
                  icon={<Building2 className="h-4 w-4" />}
                  label={t('schedule.generateDialog.strategyBuilding')}
                  description={t('schedule.generateDialog.strategyBuildingDescription')}
                  active={options.strategy === 'IfcBuilding'}
                  disabled={!hasSpatial}
                  onSelect={() => handleChange('strategy', 'IfcBuilding')}
                />
                <StrategyChoice
                  icon={<Ruler className="h-4 w-4" />}
                  label={t('schedule.generateDialog.strategyHeight')}
                  description={t('schedule.generateDialog.strategyHeightDescription')}
                  active={options.strategy === 'IfcElement'}
                  disabled={!hasGeometry}
                  onSelect={() => handleChange('strategy', 'IfcElement')}
                />
              </div>
              {options.strategy !== 'IfcElement' && !hasSpatial && (
                <p className="text-[11px] text-muted-foreground">
                  {t('schedule.generateDialog.spatialHierarchyMissing')}
                </p>
              )}
            </div>

            {/* Height sub-panel — only when the IfcElement strategy is active.
                Reads as "settings for the selected group-by". */}
            {options.strategy === 'IfcElement' && (
              <HeightStrategyPanel
                heightTolerance={options.heightTolerance}
                elementZSubgroup={options.elementZSubgroup}
                onHeightToleranceChange={(n) => handleChange('heightTolerance', n)}
                onSubgroupChange={(s) => handleChange('elementZSubgroup', s)}
              />
            )}

            {/* Primary fields */}
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="gen-start">{t('schedule.generateDialog.startDateLabel')}</Label>
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
                <Label htmlFor="gen-duration">{t('schedule.generateDialog.daysPerGroupLabel')}</Label>
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
              <Label>{t('schedule.generateDialog.orderLabel')}</Label>
              <div className="grid grid-cols-2 gap-2">
                <StrategyChoice
                  icon={<span className="text-xs font-semibold">↑</span>}
                  label={t('schedule.generateDialog.orderBottomUp')}
                  description={t('schedule.generateDialog.orderBottomUpDescription')}
                  active={options.order === 'bottom-up'}
                  onSelect={() => handleChange('order', 'bottom-up' satisfies GenerateOrder)}
                />
                <StrategyChoice
                  icon={<span className="text-xs font-semibold">↓</span>}
                  label={t('schedule.generateDialog.orderTopDown')}
                  description={t('schedule.generateDialog.orderTopDownDescription')}
                  active={options.order === 'top-down'}
                  onSelect={() => handleChange('order', 'top-down' satisfies GenerateOrder)}
                />
              </div>
            </div>

            <GenerateAdvancedPanel
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
              strategy={options.strategy}
              lagDays={options.lagDays}
              predefinedType={options.predefinedType}
              scheduleName={options.scheduleName}
              linkSequences={options.linkSequences}
              skipEmptyGroups={options.skipEmptyGroups}
              onChange={handleChange}
              createWorkPlan={createWorkPlan}
              onCreateWorkPlanChange={setCreateWorkPlan}
              workPlanName={workPlanName}
              onWorkPlanNameChange={setWorkPlanName}
            />

            {/* Live summary */}
            <div className="rounded-md bg-muted/30 p-3 text-sm">
              {preview && !preview.empty ? (
                <div className="grid gap-1">
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium">{t('schedule.generateDialog.summaryHeading')}</span>
                    <span className="text-xs text-muted-foreground">{t('schedule.generateDialog.generatedLocally')}</span>
                  </div>
                  <ScheduleSummaryLine
                    groupCount={preview.groupCount}
                    productCount={preview.productCount}
                    date={formatLocaleDate(locale, new Date(preview.finishDate), { year: 'numeric', month: 'short', day: 'numeric' })}
                  />
                  {preview.groupCount > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {styleInterpolatedValues(t, preview.groupCount > 1
                        ? 'schedule.generateDialog.taskRangeMultiple' : 'schedule.generateDialog.taskRangeSingle', [
                        ['first', <span key="first" className="font-medium">{firstTaskName}</span>],
                        ...(preview.groupCount > 1 ? [['last',
                          <span key="last" className="font-medium">{lastTaskName}</span>] as const] : []),
                      ])}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground">
                  {t('schedule.generateDialog.noGroupsMatch')}
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('schedule.generateDialog.cancel')}</Button>
          <Button onClick={handleGenerate} disabled={!canSubmit}>
            {submitting ? <Spinner size="md" className="mr-2" /> : <CalendarPlus className="h-4 w-4 mr-2" />}
            {t('schedule.generateDialog.title')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface StrategyChoiceProps {
  icon: ReactNode;
  label: string;
  description: string;
  active: boolean;
  /** When true the tile is unavailable (greyed out, not clickable). */
  disabled?: boolean;
  onSelect: () => void;
}

function StrategyChoice({ icon, label, description, active, disabled, onSelect }: StrategyChoiceProps) {
  const { t } = useTranslation();
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
      title={disabled ? t('schedule.generateDialog.notAvailableForModel') : undefined}
    >
      <span className={'mt-0.5 ' + (active ? 'text-primary' : 'text-muted-foreground')}>{icon}</span>
      <span className="grid gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}
