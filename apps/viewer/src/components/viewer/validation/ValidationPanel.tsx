/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ValidationPanel` — the Data validation panel (#5138 plan §6), the panel
 * that replaced the `ids` registry entry and closes #5138. Orchestrates
 * four states for the "Information validation" (rule-set) path — `empty`,
 * `authoring`, `running`, `results` — while the "IDS validation" path stays
 * the existing, self-contained `IDSPanel` (its own empty/loading/results
 * states are unchanged).
 *
 * `effectiveSource` resolves which body to show: an explicit entry-card
 * click for this mount, or — reopening the panel with state already live —
 * whichever source has one (an IDS document, or a rule set being authored /
 * already run). Kept deliberately sticky: `IDSPanel` and the rules states
 * below each own their OWN empty sub-state (e.g. "no IDS loaded" /
 * "no rules yet"), so this orchestrator never needs to bounce back to the
 * two-card chooser once a source is picked.
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { IDSPanel } from '@/components/viewer/IDSPanel';
import { IDSPanelResults } from '@/components/viewer/IDSPanelResults';
import { RuleSetEditor } from './RuleSetEditor';
import { ValidationPanelEmpty } from './ValidationPanel.empty';
import { useInformationValidation } from '@/hooks/validation/useInformationValidation';
import { useValidationResults } from '@/hooks/validation/useValidationResults';
import type { RecentRuleSet } from '@/lib/validation/recent-rule-sets';
import { parseRuleSetFile, exportRuleSet } from '@/lib/validation/rule-set-io';
import type { RuleModelPickerModel } from './RuleModelPicker';

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

  const [activeSource, setActiveSource] = useState<'ids' | 'rules' | null>(null);
  // `info.file` is local React state, lost on remount (e.g. switching to
  // another sidebar panel and back) — a landed rules REPORT survives in the
  // store regardless, so it counts as evidence of the 'rules' path too, even
  // though re-entering "Edit rules" after such a remount has nothing to
  // populate the editor with (a known gap; see PR report).
  const effectiveSource: 'ids' | 'rules' | null =
    activeSource === 'ids' || (activeSource === null && idsDocument) ? 'ids'
    : activeSource === 'rules' || (activeSource === null && (info.file || validationSource === 'rules')) ? 'rules'
    : null;

  const modelsForPicker: RuleModelPickerModel[] = [...storeModels.values()].map((m) => ({
    id: m.id, name: m.name, sourceFingerprint: m.sourceFingerprint,
  }));

  const handleLoadRecent = (entry: RecentRuleSet) => {
    const parsed = parseRuleSetFile(JSON.parse(entry.content) as unknown);
    if (parsed.ok) {
      info.setFile(parsed.file);
      info.setEditing(true);
      setActiveSource('rules');
    }
  };

  const handleOpenRuleSetFile = async (file: File) => {
    const outcome = await info.openFromFile(file);
    if (outcome.ok) setActiveSource('rules');
    return outcome;
  };

  const handleNewRuleSet = () => {
    info.newRuleSet();
    setActiveSource('rules');
  };

  if (effectiveSource === null) {
    return (
      <div className="h-full flex flex-col bg-background">
        <PanelHeader title={t('validationPanel.title')} onClose={onClose} />
        <ValidationPanelEmpty
          onSelectIds={() => setActiveSource('ids')}
          onOpenRuleSetFile={handleOpenRuleSetFile}
          onNewRuleSet={handleNewRuleSet}
          onLoadRecent={handleLoadRecent}
          recentRuleSets={info.recentRuleSets}
        />
      </div>
    );
  }

  if (effectiveSource === 'ids') {
    return <IDSPanel onClose={onClose} />;
  }

  // Information validation (rule-set) path.
  const hasResults = validationSource === 'rules' && results.report !== null && !info.editing && !info.running;

  return (
    <div className="h-full flex flex-col bg-background">
      <PanelHeader title={t('validationPanel.title')} onClose={onClose} />
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
      ) : (
        <AuthoringState
          info={info}
          models={modelsForPicker}
        />
      )}
    </div>
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

interface AuthoringStateProps {
  info: ReturnType<typeof useInformationValidation>;
  models: RuleModelPickerModel[];
}

function AuthoringState({ info, models }: AuthoringStateProps) {
  const { t } = useTranslation();
  if (!info.file) return null;
  const saveAs = () => {
    const name = window.prompt(t('validationPanel.saveAsPrompt'), info.file?.name ?? '');
    if (!name || !info.file) return;
    const renamed = { ...info.file, name };
    info.setFile(renamed);
    exportRuleSet(renamed);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto p-3" {...tourAnchor(TOUR_ANCHORS.ruleEditor)}>
        <RuleSetEditor file={info.file} onChange={info.setFile} models={models} />
      </div>
      {info.error && <p className="px-3 pb-1 text-xs text-red-600">{info.error}</p>}
      <div className="flex items-center gap-2 p-3 border-t">
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={info.save}>
          {t('validationPanel.save')}
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={saveAs}>
          {t('validationPanel.saveAs')}
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
