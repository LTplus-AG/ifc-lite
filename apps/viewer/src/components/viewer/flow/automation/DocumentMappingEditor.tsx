/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { automationInput, automationButton } from './editor-styles';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/i18n';
import { parseDocumentFile } from '@/lib/document/persistence';
import type { DocumentSpec } from '@/lib/document/types';
import type { DocumentResultMapping } from '@/lib/document/build-report-document';

export function DocumentMappingEditor({ value, onChange, jobIds, scopeKey }: {
  value: unknown; onChange: (value: unknown) => void; jobIds: readonly string[]; scopeKey: string;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const config = value && typeof value === 'object' ? value as { name?: string; template?: DocumentSpec; mappings?: DocumentResultMapping[] } : {};
  const mappings = Array.isArray(config.mappings) ? config.mappings : [];
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const latest = useRef({ config, value, onChange, scopeKey }); latest.current = { config, value, onChange, scopeKey };
  const importTemplate = async (file: File) => {
    const importingScope = scopeKey, importingValue = value;
    const stillCurrent = () => mounted.current && latest.current.scopeKey === importingScope && latest.current.value === importingValue;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Document template exceeds 10 MiB');
      const text = await file.text();
      if (!stillCurrent()) return;
      const template = parseDocumentFile(text);
      const reportBlocks = template.blocks.filter((block) => block.kind === 'ids-report' || (block.kind === 'table' && block.source.kind === 'comparison'));
      latest.current.onChange({ ...latest.current.config, template, mappings: reportBlocks.map((block) => ({ blockId: block.id, jobId: jobIds[0] ?? '' })) });
      setError(null);
    } catch (cause) { if (stillCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="space-y-2">
    {error && <output className="text-destructive">{error}</output>}
    <input className={automationInput} aria-label={t('automationEditor.documentName')} value={config.name ?? ''} onChange={(event) => onChange({ ...config, name: event.target.value })} />
    <label>{t('automationEditor.importTemplate')}<input className={automationInput} type="file" aria-label={t('automationEditor.importTemplate')} accept=".json"
      onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importTemplate(file); }} /></label>
    {config.template && <>
      <p>{config.template.name}</p>
      <button className={automationButton} type="button" onClick={() => onChange({ name: config.name })}>{t('automationEditor.removeTemplate')}</button>
    </>}
    <p>{t('automationEditor.mappingHint')}</p>
    {mappings.map((mapping, index) => <fieldset key={mapping.blockId} className="border border-border p-2">
      <legend>{mapping.blockId}</legend>
      <select className={automationInput} aria-label={t('automationEditor.mappingJob', { id: mapping.blockId })} value={mapping.jobId} onChange={(event) => onChange({ ...config,
        mappings: mappings.map((value, i) => i === index ? { ...value, jobId: event.target.value } : value) })}>
        <option value="">{t('automationEditor.chooseJob')}</option>{jobIds.map((id) => <option key={id}>{id}</option>)}
      </select>
      <input className={automationInput} aria-label={t('automationEditor.mappingResult', { id: mapping.blockId })} value={mapping.resultId ?? ''} onChange={(event) => onChange({ ...config,
        mappings: mappings.map((value, i) => i === index ? { ...value, resultId: event.target.value || undefined } : value) })} />
    </fieldset>)}
  </div>;
}
