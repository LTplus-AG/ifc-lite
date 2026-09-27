/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS BCF Export Dialog
 *
 * Provides a configuration dialog for exporting IDS validation results to BCF.
 * Options include:
 * - Topic grouping strategy (per-entity, per-specification, per-requirement)
 * - Include passing entities
 * - Include per-entity camera positions (from entity bounds)
 * - Capture per-entity snapshots (batch render)
 * - Load into BCF panel after export
 */

import { useState, useCallback } from 'react';
import { FileBox, Camera, Focus, Upload } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n';
import { useExportDialogOpenGuard } from '@/hooks/useExportDialogOpenGuard';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { IDSReportInput } from '@ifc-lite/bcf';
import { IDSExportTopicCount } from './IDSExportTopicCount';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

// ============================================================================
// Types
// ============================================================================

export type TopicGrouping = 'per-entity' | 'per-specification' | 'per-requirement';

export interface IDSBCFExportSettings {
  topicGrouping: TopicGrouping;
  includePassingEntities: boolean;
  includeCamera: boolean;
  includeSnapshots: boolean;
  loadIntoBcfPanel: boolean;
}

export interface IDSExportProgress {
  phase: 'building' | 'snapshots' | 'writing' | 'done';
  current: number;
  total: number;
  message: string;
}

interface IDSExportDialogProps {
  /** Trigger element (e.g., a button) — only used for uncontrolled mode */
  trigger?: React.ReactNode;
  /** Whether a report is available */
  hasReport: boolean;
  /** Total failing entity count for display */
  failedCount: number;
  /** The report's specification results, to show how many topics each grouping makes (#5824). */
  specificationResults?: IDSReportInput['specificationResults'];
  /** Called when export is confirmed */
  onExport: (settings: IDSBCFExportSettings) => Promise<void>;
  /** Export progress (controlled externally) */
  progress: IDSExportProgress | null;
  /** Controlled open state (if provided, dialog is controlled externally) */
  open?: boolean;
  /** Controlled open state callback */
  onOpenChange?: (open: boolean) => void;
}

// ============================================================================
// Component
// ============================================================================

export function IDSExportDialog({
  trigger,
  hasReport,
  failedCount,
  specificationResults,
  onExport,
  progress,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: IDSExportDialogProps) {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = controlledOnOpenChange ?? setInternalOpen;
  const [settings, setSettings] = useState<IDSBCFExportSettings>({
    // One topic per failing SPECIFICATION by default: per-entity scales with
    // the model and hits the topic cap on any large failure (#5824).
    topicGrouping: 'per-specification',
    includePassingEntities: false,
    includeCamera: true,
    includeSnapshots: false,
    loadIntoBcfPanel: false,
  });

  // `onExport` may do async setup before it publishes a progress value, so the
  // in-flight promise counts as exporting too, not only a non-done `progress`.
  const [running, setRunning] = useState(false);
  const isExporting = running || (progress !== null && progress.phase !== 'done');

  const handleExport = useCallback(async () => {
    setRunning(true);
    try {
      await onExport(settings);
    } finally {
      setRunning(false);
    }
    // Don't close — let the progress indicator finish, then user closes
  }, [onExport, settings]);

  const handleOpenChange = useExportDialogOpenGuard({ busy: isExporting, setOpen });

  const progressPercent = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger && (
        <DialogTrigger asChild>
          {trigger}
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileBox className="h-5 w-5 text-green-500" />
            {t('idsPanel.export.title')}
          </DialogTitle>
          <DialogDescription>
            {t('idsPanel.export.description')}
            {failedCount > 0 && ` ${t('idsPanel.export.failedEntitiesFound', { count: failedCount })}`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Topic Grouping */}
          <div className="grid gap-2">
            <Label htmlFor="grouping">{t('idsPanel.export.topicGrouping')}</Label>
            <Select
              value={settings.topicGrouping}
              onValueChange={(v) => setSettings(s => ({
                ...s,
                topicGrouping: v as TopicGrouping,
                // Reset includePassingEntities when switching away from per-entity (only valid in per-entity mode)
                ...(v !== 'per-entity' && { includePassingEntities: false }),
              }))}
              disabled={isExporting}
            >
              <SelectTrigger id="grouping">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per-entity">{t('idsPanel.export.grouping.perEntity')}</SelectItem>
                <SelectItem value="per-specification">{t('idsPanel.export.grouping.perSpecification')}</SelectItem>
                <SelectItem value="per-requirement">{t('idsPanel.export.grouping.perRequirement')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {settings.topicGrouping === 'per-entity' && t('idsPanel.export.groupingHint.perEntity')}
              {settings.topicGrouping === 'per-specification' && t('idsPanel.export.groupingHint.perSpecification')}
              {settings.topicGrouping === 'per-requirement' && t('idsPanel.export.groupingHint.perRequirement')}
            </p>
            {specificationResults && <IDSExportTopicCount specificationResults={specificationResults} settings={settings} />}
          </div>

          {/* Include Passing */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="include-passing">{t('idsPanel.export.includePassing')}</Label>
              <p className="text-xs text-muted-foreground">{t('idsPanel.export.includePassingHint')}</p>
            </div>
            <Switch
              id="include-passing"
              checked={settings.includePassingEntities}
              onCheckedChange={(v) => setSettings(s => ({ ...s, includePassingEntities: v }))}
              disabled={isExporting || settings.topicGrouping !== 'per-entity'}
            />
          </div>

          {/* Include Camera */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="include-camera" className="flex items-center gap-1.5">
                <Focus className="h-3.5 w-3.5" />
                {t('idsPanel.export.perEntityCamera')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('idsPanel.export.perEntityCameraHint')}</p>
            </div>
            <Switch
              id="include-camera"
              checked={settings.includeCamera}
              onCheckedChange={(v) => setSettings(s => ({ ...s, includeCamera: v }))}
              disabled={isExporting}
            />
          </div>

          {/* Include Snapshots */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="include-snapshots" className="flex items-center gap-1.5">
                <Camera className="h-3.5 w-3.5" />
                {t('idsPanel.export.captureSnapshots')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('idsPanel.export.captureSnapshotsHint')}
              </p>
            </div>
            <Switch
              id="include-snapshots"
              checked={settings.includeSnapshots}
              onCheckedChange={(v) => setSettings(s => ({ ...s, includeSnapshots: v }))}
              disabled={isExporting}
            />
          </div>

          {/* Load into BCF Panel */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="load-panel" className="flex items-center gap-1.5">
                <Upload className="h-3.5 w-3.5" />
                {t('idsPanel.export.loadIntoPanel')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('idsPanel.export.loadIntoPanelHint')}</p>
            </div>
            <Switch
              id="load-panel"
              checked={settings.loadIntoBcfPanel}
              onCheckedChange={(v) => setSettings(s => ({ ...s, loadIntoBcfPanel: v }))}
              disabled={isExporting}
            />
          </div>

          {/* Progress */}
          {progress && (
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{progress.message}</span>
                <span className="font-mono text-xs">{progress.current}/{progress.total}</span>
              </div>
              <Progress value={progressPercent} className="h-2" />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isExporting}
          >
            {progress?.phase === 'done' ? t('idsPanel.export.close') : t('idsPanel.export.cancel')}
          </Button>
          <Button
            onClick={handleExport}
            disabled={isExporting || !hasReport}
          >
            {isExporting ? (
              <>
                <Spinner size="md" className="mr-2" />
                {t('idsPanel.export.exporting')}
              </>
            ) : (
              <>
                <FileBox className="h-4 w-4 mr-2" />
                {t('idsPanel.export.exportBcf')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
