/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Calendar, CalendarClock, CalendarPlus, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import type { TranslationKey, TranslationParameters } from '@/i18n';

interface GanttEmptyStateProps {
  loading: boolean;
  hasModel: boolean;
  /** When true, the active model has a spatial hierarchy — enables the CTA. */
  canGenerate?: boolean;
  /** Human-readable extraction error (last parser failure), if any. */
  extractionError?: string | null;
  /** The extraction contains at least one visible IfcWorkPlan container. */
  hasWorkPlans?: boolean;
  /** The model has tasks, but the selected IfcWorkSchedule contains none. */
  selectedScheduleEmpty?: boolean;
  onClose?: () => void;
  onGenerate?: () => void;
  /** Opens the file picker to import an MS Project (MSPDI) / Gantt CSV file. */
  onImport?: () => void;
}

type TFunction = (key: TranslationKey, params?: TranslationParameters) => string;

/**
 * Describe only the actions actually on screen. `canGenerate` gates the
 * generate button on the model having a spatial hierarchy, and `onImport` is
 * omitted by callers that do not wire up a file picker, so either button can
 * be absent independently — text naming a button that was not rendered sends
 * the user looking for it.
 */
export function emptyStateHelperText(t: TFunction, canGenerate: boolean, canImport: boolean): string {
  if (canGenerate && canImport) return t('schedule.emptyState.helperBoth');
  return t(canGenerate ? 'schedule.emptyState.helperGenerateOnly' : 'schedule.emptyState.helperImportOnly');
}

export function GanttEmptyState({
  loading,
  hasModel,
  canGenerate,
  extractionError,
  hasWorkPlans,
  selectedScheduleEmpty,
  onClose,
  onGenerate,
  onImport,
}: GanttEmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div className="relative h-full w-full flex flex-col items-center justify-center text-center p-8 gap-3 text-muted-foreground">
      {onClose && (
        <IconButton
          label={t('schedule.emptyState.closeAriaLabel')}
          size="icon-sm"
          className="absolute top-2 right-2"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </IconButton>
      )}
      <div className="relative">
        <Calendar className="h-12 w-12" strokeWidth={1} />
        <CalendarClock className="h-6 w-6 absolute -bottom-1 -right-1 text-primary" strokeWidth={1.5} />
      </div>
      {!hasModel ? (
        <>
          <h3 className="text-sm font-semibold text-foreground">{t('schedule.emptyState.loadModelTitle')}</h3>
          <p className="text-xs max-w-sm">
            {t('schedule.emptyState.loadModelMessage', { task: 'IfcTask', schedule: 'IfcWorkSchedule' })}
          </p>
        </>
      ) : loading ? (
        <p className="text-xs">{t('schedule.emptyState.extracting')}</p>
      ) : extractionError ? (
        <>
          <h3 className="text-sm font-semibold text-destructive">{t('schedule.emptyState.extractionFailedTitle')}</h3>
          <p className="text-xs max-w-md text-muted-foreground">
            <span className="font-mono text-destructive">{extractionError}</span>
            <br />
            {t('schedule.emptyState.extractionFailedHint')}
          </p>
          {(canGenerate && onGenerate) || onImport ? (
            <div className="flex flex-col items-center gap-2 pt-2">
              {canGenerate && onGenerate && (
                <Button size="sm" variant="outline" onClick={onGenerate} className="gap-2">
                  <CalendarPlus className="h-4 w-4" />
                  {t('schedule.emptyState.generateInstead')}
                </Button>
              )}
              {onImport && (
                <Button size="sm" variant="outline" onClick={onImport} className="gap-2">
                  <Upload className="h-4 w-4" />
                  {t('schedule.emptyState.importEllipsis')}
                </Button>
              )}
            </div>
          ) : null}
        </>
      ) : selectedScheduleEmpty ? (
        <>
          <h3 className="text-sm font-semibold text-foreground">{t('schedule.emptyState.noTasksInScheduleTitle')}</h3>
          <p className="text-xs max-w-md">
            {t('schedule.emptyState.noTasksInScheduleMessage', {
              allTasks: t('schedule.toolbar.allTasks'),
              task: 'IfcTask',
            })}
          </p>
        </>
      ) : hasWorkPlans ? (
        <>
          <h3 className="text-sm font-semibold text-foreground">{t('schedule.emptyState.noScheduledTasksTitle')}</h3>
          <p className="text-xs max-w-md">
            {t('schedule.emptyState.noScheduledTasksMessage', { workPlan: 'IfcWorkPlan', task: 'IfcTask' })}
          </p>
          {(canGenerate && onGenerate) || onImport ? (
            <div className="flex flex-col items-center gap-2 pt-2">
              <div className="flex items-center gap-2">
                {canGenerate && onGenerate && (
                  <Button size="sm" onClick={onGenerate} className="gap-2">
                    <CalendarPlus className="h-4 w-4" />
                    {t('schedule.emptyState.generateScheduleButton')}
                  </Button>
                )}
                {onImport && (
                  <Button size="sm" variant="outline" onClick={onImport} className="gap-2">
                    <Upload className="h-4 w-4" />
                    {t('schedule.emptyState.importEllipsis')}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground max-w-xs">
                {emptyStateHelperText(t, Boolean(canGenerate && onGenerate), Boolean(onImport))}
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <h3 className="text-sm font-semibold text-foreground">{t('schedule.emptyState.noScheduleFoundTitle')}</h3>
          <p className="text-xs max-w-md">
            {t('schedule.emptyState.noScheduleFoundMessage', {
              task: 'IfcTask',
              schedule: 'IfcWorkSchedule',
              sequence: 'IfcRelSequence',
              assigns: 'IfcRelAssignsToProcess',
            })}
          </p>
          {(canGenerate && onGenerate) || onImport ? (
            <div className="flex flex-col items-center gap-2 pt-2">
              <div className="flex items-center gap-2">
                {canGenerate && onGenerate && (
                  <Button size="sm" onClick={onGenerate} className="gap-2">
                    <CalendarPlus className="h-4 w-4" />
                    {t('schedule.emptyState.generateScheduleButton')}
                  </Button>
                )}
                {onImport && (
                  <Button size="sm" variant="outline" onClick={onImport} className="gap-2">
                    <Upload className="h-4 w-4" />
                    {t('schedule.emptyState.importEllipsis')}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground max-w-xs">
                {emptyStateHelperText(t, Boolean(canGenerate && onGenerate), Boolean(onImport))}
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
