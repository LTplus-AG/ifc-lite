/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review of a `rules.proposal` draft (#6915): native rule-set validation on
 * every edit, a dry run through the native rule engine on the loaded models,
 * then save as a new information rule set and hand off to its native editor.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ListChecks, Play, Save, Square } from 'lucide-react';
import type { InformationRule } from '@ifc-lite/rules';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { nativeRuleSet, type RulesProposal } from '@/lib/check-authoring/rules-proposal';
import { describeBlock, describeRequirement } from '@/lib/check-authoring/describe-rule';
import { dryRunRules, isDryRunCurrent, type DryRun } from '@/lib/check-authoring/dry-run';
import { openDefinition, saveRulesDraft, type SavedDefinition } from '@/lib/check-authoring/save';
import { DryRunResults } from './DryRunResults';
import { Notice, ReviewCard, TextField, UnsupportedList } from './DraftParts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function RuleEditor({ rule, index, disabled, onChange }: { rule: InformationRule; index: number; disabled: boolean; onChange: (rule: InformationRule) => void }) {
  const { t } = useTranslation();
  const id = `rules-draft-${index}`;
  return <li className="rounded border border-border p-2 space-y-1.5">
    <TextField id={`${id}-name`} label={t('checkAuthoring.ruleName')} value={rule.name} disabled={disabled} onChange={name => onChange({ ...rule, name })} />
    <div className="flex items-center gap-1.5">
      <label htmlFor={`${id}-severity`} className="text-2xs text-muted-foreground">{t('checkAuthoring.severity')}</label>
      <select id={`${id}-severity`} className="h-7 rounded border border-input bg-background px-1" disabled={disabled} value={rule.severity ?? 'error'}
        onChange={event => onChange({ ...rule, severity: event.target.value === 'warning' ? 'warning' : 'error' })}>
        <option value="error">{t('checkAuthoring.severityError')}</option>
        <option value="warning">{t('checkAuthoring.severityWarning')}</option>
      </select>
    </div>
    <p className="break-words"><span className="text-muted-foreground">{t('checkAuthoring.appliesTo')} </span>{describeBlock(rule.applicability)}</p>
    <p className="break-words"><span className="text-muted-foreground">{t('checkAuthoring.requires')} </span>{describeRequirement(rule.requirement)}</p>
    {rule.cardinality && <p className="text-muted-foreground">{t('checkAuthoring.ruleCardinality', {
      min: rule.cardinality.minApplicable ?? 0, max: rule.cardinality.maxApplicable ?? '∞' })}</p>}
  </li>;
}

export function RulesDraftReview({ initial }: { initial: RulesProposal }) {
  const { t } = useTranslation();
  const panels = usePanelControls();
  const [proposal, setProposal] = useState(initial);
  const [run, setRun] = useState<DryRun | null>(null);
  const [running, setRunning] = useState(false);
  const [saved, setSaved] = useState<SavedDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useViewerStore(s => s.models); useViewerStore(s => s.mutationVersion); useViewerStore(s => s.geometryContentVersion);
  useEffect(() => () => abort.current?.abort(), []);
  // Every edit is re-read by the native rule-set parser; an invalid edit cannot be dry-run or saved.
  const invalid = useMemo(() => {
    try { nativeRuleSet(JSON.parse(JSON.stringify(proposal.ruleSet))); return null; }
    catch (failure) { return message(failure); }
  }, [proposal.ruleSet]);
  const current = !invalid && isDryRunCurrent(run, proposal.ruleSet);
  const locked = saved !== null || running;
  const rules = proposal.ruleSet.rules;
  const dryRun = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true); setError(null);
    try { const result = await dryRunRules(proposal.ruleSet, controller.signal); if (!controller.signal.aborted) setRun(result); }
    catch (failure) { if (!controller.signal.aborted) setError(message(failure)); }
    finally { if (abort.current === controller) abort.current = null; setRunning(false); }
  };
  const save = () => {
    try { setSaved(saveRulesDraft(proposal, run)); setError(null); }
    catch (failure) { setError(message(failure)); }
  };
  return <ReviewCard label={t('checkAuthoring.rulesTitle')} icon={<ListChecks className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}>
    <TextField id="rules-draft-name" label={t('checkAuthoring.ruleSetName')} value={proposal.ruleSet.name} disabled={locked}
      onChange={name => setProposal({ ...proposal, ruleSet: { ...proposal.ruleSet, name } })} />
    {proposal.rationale && <p className="text-muted-foreground break-words">{proposal.rationale}</p>}
    {invalid && <Notice tone="error">{invalid}</Notice>}
    <ul aria-label={t('checkAuthoring.rules')} className="space-y-1.5">
      {rules.map((rule, index) => <RuleEditor key={rule.id} rule={rule} index={index} disabled={locked}
        onChange={next => setProposal({ ...proposal, ruleSet: { ...proposal.ruleSet, rules: rules.map((item, i) => i === index ? next : item) } })} />)}
    </ul>
    <UnsupportedList items={proposal.unsupported} />
    {run && <DryRunResults run={run} current={current} />}
    {!saved && <div className="flex flex-wrap gap-1">
      {running
        ? <Button size="sm" variant="outline" className="h-7" onClick={() => abort.current?.abort()}><Square className="h-3 w-3 mr-1" />{t('checkAuthoring.cancelDryRun')}</Button>
        : <Button size="sm" variant="outline" className="h-7" disabled={!!invalid} onClick={() => void dryRun()}><Play className="h-3 w-3 mr-1" />{t('checkAuthoring.dryRun')}</Button>}
      <Button size="sm" className="h-7" disabled={!current || running} onClick={save}><Save className="h-3 w-3 mr-1" />{t('checkAuthoring.saveRules')}</Button>
    </div>}
    {!saved && !current && <p className="text-muted-foreground">{t('checkAuthoring.saveNeedsDryRun')}</p>}
    {saved && <Notice tone="success">
      <p>{t('checkAuthoring.rulesSaved')}</p>
      {saved.warning && <p>{saved.warning}</p>}
      <Button size="sm" variant="outline" className="h-7" onClick={() => { openDefinition('rules', saved.id); panels.openInHome('validation'); }}>
        {t('checkAuthoring.openRules')}</Button>
    </Notice>}
    {error && <Notice tone="error">{error}</Notice>}
  </ReviewCard>;
}
