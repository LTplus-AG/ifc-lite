/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ValidationPanel` — the Data validation panel (#5138 plan §6), the panel
 * that replaced the `ids` registry entry and closes #5138. Orchestrates
 * four states for the "Information validation" (rule-set) path — `empty`
 * (no rule set yet), `authoring`, `running`, `results` — while the "IDS
 * validation" path stays the existing, self-contained `IDSPanel` (embedded:
 * its own empty/loading/results sub-states are unchanged, only its outer
 * title/close chrome is suppressed in favour of this panel's own).
 *
 * The empty state (no source picked at all, no content on either side) is
 * the two entry cards. Once a source is picked — by an entry-card click, or
 * because one already has content on mount — a persistent header TOGGLE
 * (IDS validation | Information validation) stays visible so the user can
 * switch sources at any time without losing either side's state: `IDSPanel`
 * keeps its own document/report in the store regardless of which side is on
 * screen, and `useInformationValidation`'s rule-set/report state is equally
 * unaffected by which side is displayed.
 */

import { X } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { IDSPanel } from '@/components/viewer/IDSPanel';
import { IDSPanelResults } from '@/components/viewer/IDSPanelResults';
import { RuleSetEditor } from './RuleSetEditor';
import { ValidationPanelEmpty, InformationValidationEntry } from './ValidationPanel.empty';
import { IdsSummary } from './ValidationPanel.idsSummary';
import { useInformationValidation } from '@/hooks/validation/useInformationValidation';
import { useValidationResults } from '@/hooks/validation/useValidationResults';
import type { RecentRuleSet } from '@/lib/validation/recent-rule-sets';
import {
  setValidationSourceChoice as setActiveSource,
  useValidationSourceChoice,
  type ValidationSourceChoice,
} from '@/lib/validation/validation-source-choice';
import type { RuleModelPickerModel } from './RuleModelPicker';

type Source = ValidationSourceChoice;

interface ValidationPanelProps {
  onClose?: () => void;
}

export function ValidationPanel({ onClose }: ValidationPanelProps) {
  const { t } = useTranslation();
  const info = useInformationValidation();
  const results = useValidationResults();
  const idsDocument = useViewerStore((s) => s.idsDocument);
  const validationSource = useViewerStore((s) => s.validationSource);
  const storeModels = useViewerStore((s) => s.models);

  // Shared with the IDS tour (#5608), which puts the panel on its IDS side.
  const activeSource = useValidationSourceChoice((s) => s.choice);
  // Default, before any explicit pick: whichever side already has content,
  // IDS first. Both IDS and Information validation drafts survive remounts.
  // Once the user picks a source, the toggle drives it explicitly.
  const effectiveSource: Source | null =
    activeSource ?? (idsDocument ? 'ids' : (info.file || validationSource === 'rules') ? 'rules' : null);

  const modelsForPicker: RuleModelPickerModel[] = [...storeModels.values()].map((m) => ({
    id: m.id, name: m.name, sourceFingerprint: m.sourceFingerprint,
  }));

  const handleLoadRecent = (entry: RecentRuleSet) => {
    info.loadFromRecent(entry);
    setActiveSource('rules');
  };

  const handleOpenRuleSetFile = async (file: File) => {
    const outcome = await info.openFromFile(file);
    if (outcome.ok) setActiveSource('rules');
    return outcome;
  };

  const handleImportIds = async (file: File) => {
    const outcome = await info.importIds(file);
    // Even a fully refused import switches to the rules side, where its
    // summary (every specification and why) is shown.
    setActiveSource('rules');
    return outcome;
  };

  const handleNewRuleSet = () => {
    info.newRuleSet();
    setActiveSource('rules');
  };

  const handleClose = onClose ? () => {
    useViewerStore.getState().clearValidationRuleSetDraft();
    onClose();
  } : undefined;

  if (effectiveSource === null) {
    return (
      <div className="h-full flex flex-col bg-background">
        <PanelHeader title={t('validationPanel.title')} onClose={handleClose} />
        <ValidationPanelEmpty
          onSelectIds={() => setActiveSource('ids')}
          onOpenRuleSetFile={handleOpenRuleSetFile}
          onImportIds={handleImportIds}
          onNewRuleSet={handleNewRuleSet}
          onLoadRecent={handleLoadRecent}
          recentRuleSets={info.recentRuleSets}
          error={info.error}
        />
      </div>
    );
  }

  // Information validation (rule-set) sub-states.
  const hasResults = validationSource === 'rules' && results.report !== null && !info.editing && !info.running;

  return (
    <Tabs value={effectiveSource} onValueChange={(value) => setActiveSource(value === 'ids' ? 'ids' : 'rules')} className="h-full flex flex-col bg-background">
      <PanelHeader title={t('validationPanel.title')} onClose={handleClose} />
      <SourceToggle />
      <TabsContent value="ids" className="mt-0 flex-1 min-h-0 flex flex-col">
        <IDSPanel embedded />
      </TabsContent>
      <TabsContent value="rules" className="mt-0 flex-1 min-h-0 flex flex-col">
      {info.running ? (
        <RunningState progress={info.progress} totalRules={info.file?.rules.length ?? 0} onCancel={info.cancel} />
      ) : hasResults ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="p-2 border-b">
            <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => info.setEditing(true)}>
              {t('validationPanel.editRules')}
            </Button>
          </div>
          <IDSPanelResults
            results={results}
            runValidation={async () => null}
            onEntityClick={(modelId, expressId) => results.focusEntity(modelId, expressId)}
          />
        </div>
      ) : info.file ? (
        <AuthoringState info={info} models={modelsForPicker} />
      ) : (
        <div className="flex-1 min-h-0 overflow-auto p-4">
          {info.idsSummary && <IdsSummary summary={info.idsSummary} onDismiss={info.dismissIdsSummary} />}
          <InformationValidationEntry
            onOpenRuleSetFile={handleOpenRuleSetFile}
            onImportIds={handleImportIds}
            onNewRuleSet={handleNewRuleSet}
            onLoadRecent={handleLoadRecent}
            recentRuleSets={info.recentRuleSets}
            error={info.error}
          />
        </div>
      )}
      </TabsContent>
    </Tabs>
  );
}

function PanelHeader({ title, onClose }: { title: string; onClose?: () => void }) {
  return (
    <div className="flex items-center justify-between p-3 border-b">
      <span className="font-medium text-sm">{title}</span>
      {onClose && (
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label={title} onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

/** Persistent source switch (issue #5138's core UX ask): visible in every
 *  non-empty state so the user can move between IDS validation and
 *  Information validation without losing either side's state. */
function SourceToggle() {
  const { t } = useTranslation();
  const options: [Source, TranslationKey][] = [
    ['ids', 'validationPanel.toggle.ids'],
    ['rules', 'validationPanel.toggle.rules'],
  ];
  return (
    <TabsList className="flex h-auto justify-start gap-1 rounded-none border-b bg-transparent px-3 py-1.5">
      {options.map(([source, labelKey]) => (
        <TabsTrigger
          key={source}
          value={source}
          className="rounded px-2 py-1 text-xs transition-colors data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none"
        >
          {t(labelKey)}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

interface AuthoringStateProps {
  info: ReturnType<typeof useInformationValidation>;
  models: RuleModelPickerModel[];
}

function AuthoringState({ info, models }: AuthoringStateProps) {
  const { t } = useTranslation();
  if (!info.file) return null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto p-3" {...tourAnchor(TOUR_ANCHORS.ruleEditor)}>
        <RuleSetEditor file={info.file} onChange={info.setFile} models={models} />
      </div>
      {info.error && <p className="px-3 pb-1 text-xs text-red-600">{info.error}</p>}
      {info.idsSummary && <IdsSummary summary={info.idsSummary} onDismiss={info.dismissIdsSummary} />}
      <div className="flex items-center gap-2 p-3 border-t">
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={info.save}>
          {t('validationPanel.save')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          onClick={info.exportIds}
          disabled={info.file.rules.length === 0}
        >
          {t('validationPanel.exportIds')}
        </Button>
        <div className="flex-1" />
        <Button type="button" size="sm" className="h-8" onClick={() => { void info.run(); }} disabled={info.file.rules.length === 0}>
          {t('validationPanel.run')}
        </Button>
      </div>
    </div>
  );
}

interface RunningStateProps {
  progress: ReturnType<typeof useInformationValidation>['progress'];
  totalRules: number;
  onCancel: () => void;
}

/** Exported for direct testing (`ValidationPanel.i18n.test.tsx`): the real
 *  engine run this state renders during is async and transient, so a direct
 *  mount with a hand-built progress value is how its i18n keys get covered
 *  rather than racing a live run. */
export function RunningState({ progress, totalRules, onCancel }: RunningStateProps) {
  const { t } = useTranslation();
  const ruleNumber = progress ? Math.min(progress.ruleIndex + 1, totalRules) : 0;
  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="text-sm font-medium">
        {t('validationPanel.running.rule', { current: ruleNumber, total: totalRules })}
      </div>
      <div className="text-xs text-muted-foreground">
        {t(progress?.phase === 'applicability' ? 'validationPanel.running.applicability' : 'validationPanel.running.requirements')}
      </div>
      <Progress value={percent} className="h-2" />
      <Button type="button" size="sm" variant="outline" className="h-8 w-fit" onClick={onCancel}>
        {t('validationPanel.cancel')}
      </Button>
    </div>
  );
}
