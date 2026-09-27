/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Export to BCF" dialog for clash results.
 *
 * The headline requirement (see docs/architecture/clash-detection.md §6) is
 * a *manageable* BCF: 1,000 clashes must never become 1,000 topics. This dialog
 * puts that control in the user's hands — choose how clashes collapse into
 * topics, filter by severity, cap the count, pick the initial status, and
 * optionally embed a rendered snapshot per topic — with a live readout of
 * exactly how many topics the current settings will produce *before* exporting.
 */

import { useCallback, useMemo, useState } from 'react';
import { Download, Crosshair, ArrowRight, Camera, Layers } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useExportDialogOpenGuard } from '@/hooks/useExportDialogOpenGuard';
import { useClash, type ClashBcfConfig, type ClashBcfGroupBy } from '@/hooks/useClash';
import type { ClashSeverity } from '@ifc-lite/clash';

interface ClashBcfExportDialogProps {
  trigger?: React.ReactNode;
}

const SEVERITIES: { key: ClashSeverity; labelKey: TranslationKey; color: string }[] = [
  { key: 'critical', labelKey: 'clashPanel.severity.critical', color: '#f7768e' },
  { key: 'major', labelKey: 'clashPanel.severity.major', color: '#ff9e64' },
  { key: 'minor', labelKey: 'clashPanel.severity.minor', color: '#e0af68' },
  { key: 'info', labelKey: 'clashPanel.severity.info', color: '#7aa2f7' },
];

const GROUPINGS: { key: ClashBcfGroupBy; labelKey: TranslationKey; hintKey: TranslationKey }[] = [
  { key: 'cluster', labelKey: 'clashTools.bcfExport.groupCluster', hintKey: 'clashTools.bcfExport.groupClusterHint' },
  { key: 'rule', labelKey: 'clashTools.bcfExport.groupRule', hintKey: 'clashTools.bcfExport.groupRuleHint' },
  { key: 'typePair', labelKey: 'clashTools.bcfExport.groupTypePair', hintKey: 'clashTools.bcfExport.groupTypePairHint' },
  { key: 'element', labelKey: 'clashTools.bcfExport.groupElement', hintKey: 'clashTools.bcfExport.groupElementHint' },
];

const DEFAULT_CONFIG: ClashBcfConfig = {
  groupBy: 'cluster',
  severities: ['critical', 'major', 'minor', 'info'],
  includeSnapshots: false,
  maxTopics: 500,
};

export function ClashBcfExportDialog({ trigger }: ClashBcfExportDialogProps) {
  const { t } = useTranslation();
  const { result, exportBcf, bcfPreview } = useClash();

  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<ClashBcfConfig>(DEFAULT_CONFIG);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const bySeverity = result?.summary.bySeverity;
  const preview = useMemo(() => bcfPreview(config), [bcfPreview, config, result]);

  const toggleSeverity = useCallback((sev: ClashSeverity) => {
    setConfig((prev) => {
      const has = prev.severities.includes(sev);
      const severities = has ? prev.severities.filter((s) => s !== sev) : [...prev.severities, sev];
      return { ...prev, severities };
    });
  }, []);

  const grouping = GROUPINGS.find((g) => g.key === config.groupBy) ?? GROUPINGS[0];
  const canExport = preview.topics > 0 && !exporting;

  const handleExport = useCallback(async () => {
    setExporting(true);
    setProgress(config.includeSnapshots ? { done: 0, total: preview.topics } : null);
    try {
      await exportBcf(config, (done, total) => setProgress({ done, total }));
      toast.success(t('clashTools.bcfExport.exportSuccessToast', { count: preview.topics }));
      setOpen(false);
    } catch (err) {
      console.error('[clash] BCF export failed', err);
      toast.error(t('clashTools.bcfExport.exportFailedToast', { reason: err instanceof Error ? err.message : 'unknown error' }));
    } finally {
      setExporting(false);
      setProgress(null);
    }
  }, [config, exportBcf, preview.topics]);

  // The snapshot loop drives the live renderer (camera + isolation), and there's
  // no UI to resume into if the dialog vanishes mid-export.
  const handleOpenChange = useExportDialogOpenGuard({ busy: exporting, setOpen });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
            <Download className="h-3.5 w-3.5 mr-1" />
            BCF
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[460px] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crosshair className="h-4 w-4 text-[#f7768e]" />
            {t('clashTools.bcfExport.dialogTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('clashTools.bcfExport.dialogDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1 max-h-[62vh] overflow-y-auto pr-1">
          {/* Grouping */}
          <div className="space-y-1.5">
            <Label className="text-2xs uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
              <Layers className="h-3 w-3" /> {t('clashTools.bcfExport.groupByLabel')}
            </Label>
            <Select
              value={config.groupBy}
              onValueChange={(v) => setConfig((p) => ({ ...p, groupBy: v as ClashBcfGroupBy }))}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUPINGS.map((g) => (
                  <SelectItem key={g.key} value={g.key}>{t(g.labelKey)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground leading-snug">{t(grouping.hintKey)}</p>
          </div>

          {/* Severity filter */}
          <div className="space-y-1.5">
            <Label className="text-2xs uppercase tracking-wide text-muted-foreground">
              {t('clashTools.bcfExport.severitiesLabel')}
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {SEVERITIES.map((s) => {
                const on = config.severities.includes(s.key);
                const count = bySeverity?.[s.key] ?? 0;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => toggleSeverity(s.key)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                      on ? 'border-transparent text-foreground' : 'border-border text-muted-foreground opacity-60 hover:opacity-100',
                    )}
                    style={on ? { background: `${s.color}1f`, borderColor: `${s.color}66` } : undefined}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                    {t(s.labelKey)}
                    <span className="tabular-nums opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Live preview — the hero readout */}
          <div className="flex items-center justify-center gap-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
            <div className="text-center">
              <div className="text-2xl font-semibold tabular-nums leading-none">{preview.clashes}</div>
              <div className="mt-1 text-2xs uppercase tracking-wide text-muted-foreground">{t('clashTools.bcfExport.clashesLabel')}</div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="text-center">
              <div className="text-2xl font-semibold tabular-nums leading-none text-[#f7768e]">{preview.topics}</div>
              <div className="mt-1 text-2xs uppercase tracking-wide text-muted-foreground">
                {t('clashTools.bcfExport.topicsLabel', { count: preview.topics })}
              </div>
            </div>
          </div>

          {/* Cap + status note */}
          <div className="space-y-1.5">
            <Label className="text-2xs uppercase tracking-wide text-muted-foreground">{t('clashTools.bcfExport.maxTopicsLabel')}</Label>
            <input
              type="number"
              min={1}
              step={50}
              value={config.maxTopics}
              onChange={(e) => setConfig((p) => ({ ...p, maxTopics: Math.max(1, Number(e.target.value) || 1) }))}
              className="h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-sm tabular-nums"
            />
            <p className="text-xs text-muted-foreground leading-snug">
              {t('clashTools.bcfExport.topicStatusNote')}
            </p>
          </div>

          {/* Snapshots */}
          <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5">
            <div className="min-w-0">
              <Label className="flex items-center gap-1.5 text-sm">
                <Camera className="h-3.5 w-3.5" /> {t('clashTools.bcfExport.includeSnapshotsLabel')}
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground leading-snug">
                {t('clashTools.bcfExport.snapshotsHint')}
              </p>
            </div>
            <Switch
              checked={config.includeSnapshots}
              onCheckedChange={(v) => setConfig((p) => ({ ...p, includeSnapshots: v }))}
            />
          </div>
        </div>

        <DialogFooter className="items-center">
          {progress && (
            <span className="mr-auto text-xs text-muted-foreground tabular-nums">
              {t('clashTools.bcfExport.capturingSnapshotsProgress', { done: progress.done, total: progress.total })}
            </span>
          )}
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={exporting}>
            {t('clashTools.bcfExport.cancelButton')}
          </Button>
          <Button onClick={() => void handleExport()} disabled={!canExport}>
            {exporting ? (
              <Spinner size="md" className="mr-1.5" />
            ) : (
              <Download className="h-4 w-4 mr-1.5" />
            )}
            {exporting ? t('clashTools.bcfExport.exportingLabel') : t('clashTools.bcfExport.exportButton', { count: preview.topics })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
