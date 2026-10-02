/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { loadIdsContent } from '@/hooks/ids/loadIdsContent';
import { activeDefinition, definitionTitle, type DefinitionKind } from '@/lib/validation/definition-library';
import { downloadFile, sanitizeFilename } from '@/lib/export/download';

/** The same instance controls serve both parsed formats. Import, validation
 * and export stay with their existing format-specific adapters. */
export function DefinitionLibraryToolbar({ kind, onNew, onImport, onImportFile }: {
  kind: DefinitionKind;
  onNew?: () => void;
  onImport?: () => void;
  onImportFile?: (file: File) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const library = useViewerStore(state => state.validationDefinitions);
  const error = useViewerStore(state => state.validationDefinitionsError);
  const entries = library.entries.filter(entry => entry.kind === kind);
  if (!entries.length && !error) return null;
  const current = activeDefinition(library, kind);
  const label = kind === 'rules' ? t('validationPanel.library.rulesSelect') : t('validationPanel.library.idsSelect');
  function select(id: string): void {
    const entry = useViewerStore.getState().validationDefinitions.entries.find(candidate => candidate.id === id);
    if (!entry) return;
    if (entry.kind === 'ids') loadIdsContent(useViewerStore, entry.xml, entry.id);
    else useViewerStore.getState().selectValidationDefinition(id);
  }
  return <div className="border-b p-2">
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
        {label}
        <select aria-label={label} className="h-7 min-w-0 rounded border border-input bg-background px-1.5"
          value={current?.id ?? ''} onChange={event => select(event.target.value)}>
          <option value="" disabled>{t('validationPanel.library.none')}</option>
          {entries.map(entry => <option key={entry.id} value={entry.id}>{definitionTitle(entry).trim() || t('validationPanel.library.untitled')}</option>)}
        </select>
      </label>
      {onNew && <Button size="sm" variant="outline" onClick={onNew}>{t('validationPanel.library.new')}</Button>}
      <Button size="sm" variant="outline" onClick={() => onImport ? onImport() : input.current?.click()}>{t('validationPanel.library.import')}</Button>
      {onImportFile && <input ref={input} type="file" accept=".rules.json,.json" className="hidden" onChange={async event => {
        const target = event.currentTarget;
        const file = target.files?.[0];
        if (file) await onImportFile(file);
        target.value = '';
      }} />}
      <Button size="sm" variant="outline" disabled={!current} onClick={() => {
        if (!current) return;
        if (current.kind === 'ids') loadIdsContent(useViewerStore, current.xml);
        else useViewerStore.getState().addValidationDefinition({ kind: 'rules', file: {
          ...structuredClone(current.file), name: t('validationPanel.library.copyName', { name: current.file.name || t('validationPanel.library.untitled') }),
        } });
      }}>{t('validationPanel.library.copy')}</Button>
      <Button size="sm" variant="outline" disabled={!current} onClick={() => {
        if (!current) return;
        useViewerStore.getState().removeValidationDefinition(current.id);
        const next = activeDefinition(useViewerStore.getState().validationDefinitions, kind);
        if (next?.kind === 'ids') select(next.id);
      }}>{t('validationPanel.library.delete')}</Button>
      {current?.kind === 'ids' && <Button size="sm" variant="outline" onClick={() => {
        downloadFile(current.xml, `${sanitizeFilename(current.document.info.title, { fallback: 'check' })}.ids`, 'application/xml');
      }}>{t('validationPanel.library.idsDownload')}</Button>}
    </div>
    {error && <p role="alert" className="pt-1 text-xs text-red-600">{error}</p>}
  </div>;
}
