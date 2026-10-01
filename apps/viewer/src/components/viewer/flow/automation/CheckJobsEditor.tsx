/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { automationInput, automationButton } from './editor-styles';
import { useEffect, useRef, useState } from 'react';
import { type CheckJob, type ModelSelector } from '@ifc-lite/flow-nodes';
import { parseRuleSetFile } from '@ifc-lite/rules';
import { parseIDS } from '@ifc-lite/ids';
import { useTranslation } from '@/i18n';
import type { ComparisonRecipe } from '@/lib/compare/comparison-recipe';
import { validateComparisonRecipe } from '@/lib/compare/comparison-recipe-io';
import { collectRuleTagIds } from '@/lib/flow/rule-tag-bindings';
import { TagBindingsEditor } from './TagBindingsEditor';
import { ModelSelectorEditor } from './ModelSelectorEditor';

function editableSelector(value: unknown): value is ModelSelector {
  if (!value || typeof value !== 'object') return false;
  const selector = value as Record<string, unknown>;
  return selector.kind === 'slot' ? typeof selector.slotId === 'string'
    : selector.kind === 'filename' ? typeof selector.filename === 'string'
    : selector.kind === 'tagName' && typeof selector.tagName === 'string';
}
function editableRecipe(value: unknown): value is ComparisonRecipe {
  if (!value || typeof value !== 'object') return false;
  const recipe = value as Partial<ComparisonRecipe>;
  return recipe.kind === 'ifc-lite-comparison-recipe' && recipe.version === 1
    && editableSelector(recipe.base) && editableSelector(recipe.head);
}

export function CheckJobsEditor({ value, onChange, slots, kind, scopeKey }: {
  value: unknown; onChange: (value: readonly CheckJob[]) => void; slots: readonly string[]; kind: 'validation' | 'comparison'; scopeKey: string;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const jobs = Array.isArray(value) ? value.filter((job): job is CheckJob =>
    job !== null && typeof job === 'object' && typeof job.id === 'string' && typeof job.enabled === 'boolean'
    && job.source !== null && typeof job.source === 'object'
    && (job.source.kind === 'embedded' || (job.source.kind === 'slot' && typeof job.source.slotId === 'string'))
    && (job.targets === undefined || (Array.isArray(job.targets) && job.targets.every(editableSelector)))) : [];
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const latest = useRef({ jobs, onChange, scopeKey }); latest.current = { jobs, onChange, scopeKey };
  const update = (index: number, patch: Partial<CheckJob>) => onChange(jobs.map((job, i) => i === index ? { ...job, ...patch } : job));
  const importFile = async (index: number, file: File) => {
    const importingScope = scopeKey;
    const stillMountedInScope = () => mounted.current && latest.current.scopeKey === importingScope;
    const importingId = jobs[index].id;
    const importingSource = jobs[index].source;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Resource exceeds 10 MiB');
      const text = await file.text();
      if (!stillMountedInScope()) return;
      let parsed: unknown;
      if (kind === 'validation' && file.name.toLowerCase().endsWith('.ids')) { parseIDS(text); parsed = text; }
      else {
        parsed = JSON.parse(text);
        if (kind === 'comparison') validateComparisonRecipe(parsed);
        else { const rules = parseRuleSetFile(parsed); if (!rules.ok) throw new Error(rules.error); }
      }
      if (!latest.current.jobs.some((job) => job.id === importingId && job.source === importingSource && job.source.kind === 'embedded')) throw new Error('The check changed while importing; select the file again.');
      latest.current.onChange(latest.current.jobs.map((job) => job.id === importingId ? { ...job, source: { kind: 'embedded' as const, value: parsed, name: file.name } } : job));
      setError(null);
    } catch (cause) { if (stillMountedInScope()) setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="space-y-2">
    {error && <output className="text-destructive">{error}</output>}
    {jobs.map((job, index) => {
      const parsed = job.source.kind === 'embedded' && typeof job.source.value !== 'string' ? parseRuleSetFile(job.source.value) : null;
      const referenced = parsed?.ok ? collectRuleTagIds(parsed.file) : [];
      const comparison = kind === 'comparison' && job.source.kind === 'embedded' && editableRecipe(job.source.value)
        ? job.source.value : null;
      const targets = job.targets ?? [];
      return <fieldset key={index} className="rounded border border-border p-2 space-y-1">
        <legend>{t('automationEditor.job', { index: index + 1 })}</legend>
        <label><input type="checkbox" checked={job.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} />{t('automationEditor.enabled')}</label>
        <input className={automationInput} aria-label={t('automationEditor.jobId')} value={job.id} onChange={(event) => update(index, { id: event.target.value })} />
        <select className={automationInput} aria-label={t('automationEditor.resourceMode')} value={job.source.kind} onChange={(event) => update(index, {
          source: event.target.value === 'embedded' ? { kind: 'embedded', value: null } : { kind: 'slot', slotId: slots[0] ?? '' },
        })}>
          <option value="embedded">{t('automationEditor.embed')}</option><option value="slot">{t('automationEditor.chooseEachRun')}</option>
        </select>
        {job.source.kind === 'embedded' ? <label>{t('automationEditor.importResource')}
          <input className={automationInput} type="file" aria-label={t('automationEditor.importResource')} accept={kind === 'validation' ? '.json,.ids' : '.comparison.json,.json'}
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(index, file); }} />
          <span>{job.source.name}</span>
        </label> : <>
          <select className={automationInput} aria-label={t('automationEditor.resourceSlot')} value={job.source.slotId}
            onChange={(event) => update(index, { source: { kind: 'slot', slotId: event.target.value } })}>
            <option value="">{t('automationEditor.chooseSlot')}</option>{slots.map((slot) => <option key={slot}>{slot}</option>)}
          </select>
          <input className={automationInput} aria-label={t('automationEditor.resourceFilename')} value={job.source.filename ?? ''} onChange={(event) => {
            if (job.source.kind === 'slot') update(index, { source: { ...job.source, filename: event.target.value || undefined } });
          }} />
        </>}
        <p>{t('automationEditor.targetsHint')}</p>
        {targets.map((target, ti) => <div key={ti} className="flex gap-1">
          <ModelSelectorEditor value={target} slots={slots} label={t('automationEditor.target')} onChange={(next) => update(index, { targets: targets.map((value, i) => i === ti ? next : value) })} />
          <button className={automationButton} type="button" onClick={() => update(index, { targets: targets.filter((_, i) => i !== ti) })}>{t('automationEditor.remove')}</button>
        </div>)}
        <button className={automationButton} type="button" onClick={() => update(index, { targets: [...targets, { kind: 'filename', filename: 'model.ifc' } satisfies ModelSelector] })}>{t('automationEditor.addTarget')}</button>
        <TagBindingsEditor referenced={referenced} value={job.tagBindings ?? {}} onChange={(tagBindings) => update(index, { tagBindings })} />
        {comparison && job.source.kind === 'embedded' && <>
          <ModelSelectorEditor value={comparison.base} slots={slots} label={t('automationEditor.base')} onChange={(base) => {
            if (job.source.kind === 'embedded') update(index, { source: { ...job.source, value: { ...comparison, base } } });
          }} />
          <ModelSelectorEditor value={comparison.head} slots={slots} label={t('automationEditor.head')} onChange={(head) => {
            if (job.source.kind === 'embedded') update(index, { source: { ...job.source, value: { ...comparison, head } } });
          }} />
        </>}
        <button className={automationButton} type="button" disabled={index === 0} onClick={() => { const next = [...jobs]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onChange(next); }}>{t('automationEditor.up')}</button>
        <button className={automationButton} type="button" onClick={() => onChange(jobs.filter((_, i) => i !== index))}>{t('automationEditor.remove')}</button>
      </fieldset>;
    })}
    <button className={automationButton} type="button" disabled={jobs.length >= 100} onClick={() => onChange([...jobs, { id: crypto.randomUUID(), enabled: true,
      source: { kind: 'embedded', value: null } }])}>{t('automationEditor.addJob')}</button>
  </div>;
}
