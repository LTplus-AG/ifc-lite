/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash settings dialog — opened from the gear in the clash panel header.
 *
 * Two tabs:
 *  - Detection: the global knobs (mode, tolerance, clearance, cluster radius,
 *    report-touch, default grouping), each persisted on change.
 *  - Rules: the discipline-matrix preset set. Toggle / edit / reset the built-ins
 *    and add your own custom rules (type-selector A × B + severity), with a live
 *    "matches N classes" preview against the loaded model. Persisted to
 *    localStorage; shareable via export / import.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Settings2, Plus, Pencil, Trash2, RotateCcw, Upload, Download,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { matchesSelector, type ClashSeverity } from '@ifc-lite/clash';
import { exportPresets, importPresets, type ClashPreset, type SaveResult } from '@/lib/clash/persistence';
import { ClashRuleDraftEditor, type ClashRuleDraft } from '@/components/viewer/ClashRuleDraftEditor';
import {
  CLASH_SET_FILTER_SELECTOR,
  activeClashSetFilter,
  describeClashSetFilter,
  type ClashSetFilter,
} from '@/lib/clash/set-filter';
import { setClashSettingsSaveReporter } from '@/lib/clash/settings-save-notice';

const SEVERITY: Record<ClashSeverity, { labelKey: TranslationKey; color: string }> = {
  critical: { labelKey: 'clashPanel.severity.critical', color: '#f7768e' },
  major: { labelKey: 'clashPanel.severity.major', color: '#ff9e64' },
  minor: { labelKey: 'clashPanel.severity.minor', color: '#e0af68' },
  info: { labelKey: 'clashPanel.severity.info', color: '#7aa2f7' },
};
const SEVERITIES: ClashSeverity[] = ['critical', 'major', 'minor', 'info'];

interface ClashSettingsDialogProps {
  trigger?: React.ReactNode;
}

export function ClashSettingsDialog({ trigger }: ClashSettingsDialogProps) {
  const { t } = useTranslation();
  const mode = useViewerStore((s) => s.clashMode);
  const tolerance = useViewerStore((s) => s.clashTolerance);
  const clearance = useViewerStore((s) => s.clashClearance);
  const duplicateTolerance = useViewerStore((s) => s.clashDuplicateTolerance);
  const clusterEpsilon = useViewerStore((s) => s.clashClusterEpsilon);
  const reportTouch = useViewerStore((s) => s.clashReportTouch);
  const showRegionBox = useViewerStore((s) => s.showClashRegionBox);
  const groupBy = useViewerStore((s) => s.clashGroupBy);
  const presets = useViewerStore((s) => s.clashPresets);
  const classes = useViewerStore((s) => s.discoveredLensData?.classes ?? null);

  const setMode = useViewerStore((s) => s.setClashMode);
  const setTolerance = useViewerStore((s) => s.setClashTolerance);
  const setClearance = useViewerStore((s) => s.setClashClearance);
  const setDuplicateTolerance = useViewerStore((s) => s.setClashDuplicateTolerance);
  const setClusterEpsilon = useViewerStore((s) => s.setClashClusterEpsilon);
  const setReportTouch = useViewerStore((s) => s.setClashReportTouch);
  const setShowRegionBox = useViewerStore((s) => s.setShowClashRegionBox);
  const setGroupBy = useViewerStore((s) => s.setClashGroupBy);
  const resetSettings = useViewerStore((s) => s.resetClashSettings);
  const createPreset = useViewerStore((s) => s.createClashPreset);
  const updatePreset = useViewerStore((s) => s.updateClashPreset);
  const deletePreset = useViewerStore((s) => s.deleteClashPreset);
  const setPresetEnabled = useViewerStore((s) => s.setClashPresetEnabled);
  const resetPresets = useViewerStore((s) => s.resetClashPresets);
  const importClashPresets = useViewerStore((s) => s.importClashPresets);

  const [draft, setDraft] = useState<ClashRuleDraft | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Detection settings commit optimistically and persist in the background, so
  // a refused write (quota, or storage blocked) is only visible if something
  // says so. This component is mounted with the clash panel header — i.e.
  // whenever the user can reach the Detection tab — so give the slice's
  // once-per-session notice a toast to land in; it falls back to console.warn
  // when nothing is mounted. The effect returns the unregister.
  useEffect(() => setClashSettingsSaveReporter(toast.error), []);

  const matchCount = useCallback(
    (selector: string): number | null => {
      if (!classes) return null;
      const s = selector.trim();
      if (!s) return null;
      return classes.filter((c) => matchesSelector(c, s)).length;
    },
    [classes],
  );

  const startAdd = () =>
    setDraft({ id: null, name: '', selectorA: '', selectorB: '', severity: 'major' });
  /** The stand-in is not something to show the user — it reads as an empty box. */
  const editableSelector = (selector: string) =>
    selector === CLASH_SET_FILTER_SELECTOR ? '' : selector;
  const startEdit = (p: ClashPreset) =>
    setDraft({
      id: p.id,
      name: p.name,
      selectorA: editableSelector(p.selectorA),
      selectorB: editableSelector(p.selectorB),
      severity: p.severity,
      filterA: p.filterA,
      filterB: p.filterB,
    });

  const saveDraft = useCallback(() => {
    if (!draft) return;
    // `id` is the draft's own "new vs edit" flag, never a preset field. A side
    // the user defined with a filter needs no hand-typed selector and gets the
    // fail-closed stand-in (see CLASH_SET_FILTER_SELECTOR).
    const { id, ...fields } = draft;
    const saved = {
      ...fields,
      selectorA: fields.selectorA.trim() || CLASH_SET_FILTER_SELECTOR,
      selectorB: fields.selectorB.trim() || CLASH_SET_FILTER_SELECTOR,
    };
    const result = id ? updatePreset(id, saved) : createPreset(saved);
    if (result.ok) {
      setDraft(null);
    } else {
      toast.error(result.message);
    }
  }, [draft, createPreset, updatePreset]);

  /** A side is defined once it has either a type selector or a filter. */
  const sideValid = (selector: string, filter: ClashSetFilter | undefined) =>
    selector.trim().length > 0 || activeClashSetFilter(filter) !== undefined;
  const draftValid =
    !!draft &&
    draft.name.trim().length > 0 &&
    sideValid(draft.selectorA, draft.filterA) &&
    sideValid(draft.selectorB, draft.filterB);

  const onImport = useCallback(
    async (file: File) => {
      try {
        const imported = await importPresets(file);
        if (imported.length === 0) {
          toast.error(t('clashTools.settings.noValidRulesToast'));
          return;
        }
        const result = importClashPresets(imported);
        if (result.ok) toast.success(t('clashTools.settings.importedRulesToast', { count: imported.length }));
        else toast.error(result.message);
      } catch {
        toast.error(t('clashTools.settings.importReadErrorToast'));
      }
    },
    [importClashPresets, t],
  );

  // Delete / toggle / reset only commit when the write landed (clashSlice), so
  // a refused write leaves the row, the switch and the rule set exactly as they
  // were — all this has to add is the reason.
  const reportSaveFailure = useCallback((result: SaveResult) => {
    if (!result.ok) toast.error(result.message);
  }, []);

  const enabledCount = useMemo(() => presets.filter((p) => p.enabled).length, [presets]);

  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <IconButton label={t('clashTools.settings.title')} className="h-7 w-7">
            <Settings2 className="h-4 w-4" />
          </IconButton>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[540px] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-[#f7768e]" />
            {t('clashTools.settings.title')}
          </DialogTitle>
          <DialogDescription>
            {t('clashTools.settings.summary', { enabled: enabledCount, total: presets.length })}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="detection" className="mt-1">
          <TabsList className="grid w-full grid-cols-2">
            {/* ui/tabs TabsTrigger ships no active styling — add it per-usage,
                matching KeyboardShortcutsDialog / ByokKeyModal, so the active tab
                reads clearly. */}
            <TabsTrigger
              value="detection"
              className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm data-[state=active]:font-semibold"
            >
              {t('clashTools.settings.detectionTab')}
            </TabsTrigger>
            <TabsTrigger
              value="rules"
              className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm data-[state=active]:font-semibold"
            >
              {t('clashTools.settings.rulesTab')}
            </TabsTrigger>
          </TabsList>

          {/* ---- Detection ---------------------------------------------------- */}
          <TabsContent value="detection" className="space-y-3 max-h-[58vh] overflow-y-auto pr-1">
            <SettingRow label={t('clashTools.settings.modeLabel')} hint={t('clashTools.settings.modeHint')}>
              <Select value={mode} onValueChange={(v) => setMode(v as 'hard' | 'clearance')}>
                <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hard">{t('clashTools.settings.modeHard')}</SelectItem>
                  <SelectItem value="clearance">{t('clashTools.settings.modeClearance')}</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow label={t('clashTools.settings.toleranceLabel')} hint={t('clashTools.settings.toleranceHint')}>
              <NumberField value={tolerance} step={0.001} min={0} onCommit={setTolerance} suffix="m" />
            </SettingRow>

            <SettingRow label={t('clashTools.settings.clearanceGapLabel')} hint={t('clashTools.settings.clearanceGapHint')}>
              <NumberField value={clearance} step={0.01} min={0} onCommit={setClearance} suffix="m" />
            </SettingRow>

            <SettingRow label={t('clashTools.settings.duplicateToleranceLabel')} hint={t('clashTools.settings.duplicateToleranceHint')}>
              <NumberField value={duplicateTolerance} step={0.001} min={0} onCommit={setDuplicateTolerance} suffix="m" />
            </SettingRow>

            <SettingRow label={t('clashTools.settings.clusterRadiusLabel')} hint={t('clashTools.settings.clusterRadiusHint')}>
              <NumberField value={clusterEpsilon} step={0.1} min={0.01} onCommit={setClusterEpsilon} suffix="m" />
            </SettingRow>

            <SettingRow label={t('clashTools.settings.reportTouchLabel')} hint={t('clashTools.settings.reportTouchHint')}>
              <Switch checked={reportTouch} onCheckedChange={setReportTouch} />
            </SettingRow>

            <SettingRow label={t('clashTools.settings.showRegionBoxLabel')} hint={t('clashTools.settings.showRegionBoxHint')}>
              <Switch checked={showRegionBox} onCheckedChange={setShowRegionBox} />
            </SettingRow>

            <SettingRow label={t('clashTools.settings.groupingLabel')} hint={t('clashTools.settings.groupingHint')}>
              <Select value={groupBy} onValueChange={(v) => setGroupBy(v as typeof groupBy)}>
                <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="severity">{t('clashTools.settings.groupBySeverity')}</SelectItem>
                  <SelectItem value="rule">{t('clashTools.settings.groupByRule')}</SelectItem>
                  <SelectItem value="typePair">{t('clashTools.settings.groupByTypePair')}</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <div className="pt-1">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={resetSettings}>
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> {t('clashTools.settings.resetDetectionButton')}
              </Button>
            </div>
          </TabsContent>

          {/* ---- Rules -------------------------------------------------------- */}
          <TabsContent value="rules" className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Button size="sm" className="h-7 px-2 text-xs" onClick={startAdd}>
                <Plus className="h-3.5 w-3.5 mr-1" /> {t('clashTools.settings.addRuleButton')}
              </Button>
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title={t('clashTools.settings.resetRulesTooltip')} onClick={() => reportSaveFailure(resetPresets())}>
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title={t('clashTools.settings.exportRulesTooltip')} onClick={() => exportPresets(presets)}>
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title={t('clashTools.settings.importRulesTooltip')} onClick={() => fileRef.current?.click()}>
                  <Upload className="h-3.5 w-3.5" />
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,.clash-presets.json,application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onImport(f);
                    e.target.value = '';
                  }}
                />
              </div>
            </div>

            {/* Native overflow scroller (a definite max-height + overflow-y-auto),
                matching the Detection tab. A Radix ScrollArea here never engaged
                its viewport scroll, so extra rules were clipped and unreachable. (#1464) */}
            <div className="max-h-[42vh] overflow-y-auto pr-1">
              <div className="space-y-1">
                {presets.map((p) => (
                  <div
                    key={p.id}
                    className={cn(
                      'flex items-center gap-2 rounded-md border border-border px-2 py-1.5',
                      !p.enabled && 'opacity-55',
                    )}
                  >
                    <Switch checked={p.enabled} onCheckedChange={(v) => reportSaveFailure(setPresetEnabled(p.id, v))} />
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SEVERITY[p.severity].color }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">
                        {p.name}
                        {!p.builtin && <span className="ml-1.5 text-2xs text-muted-foreground">{t('clashTools.settings.customBadge')}</span>}
                      </div>
                      <div className="truncate text-2xs text-muted-foreground">
                        <SetSummary selector={p.selectorA} filter={p.filterA} />
                        <span className="opacity-60"> × </span>
                        <SetSummary selector={p.selectorB} filter={p.filterB} />
                      </div>
                    </div>
                    <IconButton label={t('clashTools.settings.editTooltip')} className="h-6 w-6" onClick={() => startEdit(p)}>
                      <Pencil className="h-3 w-3" />
                    </IconButton>
                    {p.builtin ? (
                      <span className="w-6" />
                    ) : (
                      <IconButton label={t('clashTools.settings.deleteTooltip')} className="h-6 w-6" onClick={() => reportSaveFailure(deletePreset(p.id))}>
                        <Trash2 className="h-3 w-3" />
                      </IconButton>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {draft && (
              <ClashRuleDraftEditor
                draft={draft}
                severities={SEVERITIES}
                severityLabel={(sev) => t(SEVERITY[sev].labelKey)}
                matchCount={matchCount}
                hasModel={classes !== null}
                onChange={setDraft}
                onCancel={() => setDraft(null)}
                onSave={saveDraft}
                canSave={draftValid}
              />
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** How one side of a rule reads in the list: its filter, or its selector. */
function SetSummary({ selector, filter }: { selector: string; filter?: ClashSetFilter }) {
  const active = activeClashSetFilter(filter);
  return active ? <em>{describeClashSetFilter(active)}</em> : <>{selector}</>;
}

function SettingRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5">
      <div className="min-w-0">
        <Label className="text-sm">{label}</Label>
        <p className="mt-0.5 text-xs text-muted-foreground leading-snug">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Numeric input that commits on change, clamped by the store setter. */
function NumberField({
  value, step, min, suffix, onCommit,
}: { value: number; step: number; min: number; suffix?: string; onCommit: (v: number) => void }) {
  return (
    <div className="inline-flex items-center gap-1">
      <input
        type="number"
        step={step}
        min={min}
        value={value}
        onChange={(e) => onCommit(Number(e.target.value))}
        className="h-8 w-24 rounded-md border border-border bg-transparent px-2 text-sm tabular-nums text-right"
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}
