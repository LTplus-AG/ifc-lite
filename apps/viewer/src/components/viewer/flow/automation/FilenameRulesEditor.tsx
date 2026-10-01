/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { automationInput, automationButton } from './editor-styles';
import { matchesFilename, type FilenameTagRule } from '@ifc-lite/flow-nodes';
import { normalizeModelTagName } from '@ifc-lite/rules';
import { useTranslation } from '@/i18n';

export function FilenameRulesEditor({ value, onChange, filenames = [] }: { value: unknown; onChange: (value: readonly FilenameTagRule[]) => void; filenames?: readonly string[] }) {
  const { t } = useTranslation();
  const rules = Array.isArray(value) ? value.filter((rule): rule is FilenameTagRule =>
    rule !== null && typeof rule === 'object' && typeof rule.pattern === 'string'
    && ['equals', 'contains', 'startsWith', 'endsWith', 'glob'].includes(rule.operator)
    && Array.isArray(rule.tags) && rule.tags.every((tag: unknown) => typeof tag === 'string')) : [];
  const replace = (index: number, patch: Partial<FilenameTagRule>) => onChange(rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
  return <div className="space-y-2">
    <p>{t('automationEditor.tagsHint')}</p>
    {rules.map((rule, index) => <fieldset key={index} className="border border-border rounded p-2 space-y-1">
      <legend>{t('automationEditor.rule', { index: index + 1 })}</legend>
      <select className={automationInput} aria-label={t('automationEditor.operator')} value={rule.operator}
        onChange={(event) => replace(index, { operator: event.target.value as FilenameTagRule['operator'] })}>
        {(['equals', 'contains', 'startsWith', 'endsWith', 'glob'] as const).map((operator) => <option key={operator} value={operator}>{operator}</option>)}
      </select>
      <input className={automationInput} aria-label={t('automationEditor.pattern')} value={rule.pattern} onChange={(event) => replace(index, { pattern: event.target.value })} />
      <input className={automationInput} aria-label={t('automationEditor.tags')} value={rule.tags.join(', ')}
        onChange={(event) => replace(index, { tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} />
      <label><input type="checkbox" checked={rule.caseSensitive ?? false}
        onChange={(event) => replace(index, { caseSensitive: event.target.checked })} />{t('automationEditor.caseSensitive')}</label>
      <button className={automationButton} type="button" disabled={index === 0} onClick={() => { const next = [...rules]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onChange(next); }}>{t('automationEditor.up')}</button>
      <button className={automationButton} type="button" onClick={() => onChange(rules.filter((_, i) => i !== index))}>{t('automationEditor.remove')}</button>
    </fieldset>)}
    <button className={automationButton} type="button" onClick={() => onChange([...rules, { operator: 'glob', pattern: '*.ifc', tags: ['Model'] }])}>{t('automationEditor.addRule')}</button>
    {filenames.length > 0 && <div>
      <p>{t('automationEditor.tagPreview')}</p>
      <ul>{filenames.slice(0, 100).map((filename) => {
        const tags = [...new Map(rules.filter((rule) => matchesFilename(filename, rule)).flatMap((rule) => rule.tags)
          .map((tag) => [normalizeModelTagName(tag), tag.trim()])).values()].filter(Boolean);
        return <li key={filename} className="break-words">{filename}: {tags.join(', ') || t('automationEditor.noMatchingTags')}</li>;
      })}</ul>
    </div>}
  </div>;
}
