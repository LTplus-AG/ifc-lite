/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import { BsddNamespace, type BsddSearchResult } from '@ifc-lite/sdk';
import { assertProfile, DEFAULT_PROFILE, generateArtifacts, dictionaryToProfile, profileFromBsdd, type ProfileDefinition } from '@ifc-lite/semantic';
import { useTranslation } from '@/i18n';
import { downloadFile } from '@/lib/export/download';

export interface SemanticProfileControlsProps {
  profile: ProfileDefinition;
  onProfile: (profile: ProfileDefinition) => void;
  onError: (message: string) => void;
}
const control = 'w-full rounded border border-border bg-background p-2 text-sm';
const button = 'rounded border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50';
/** Profiles contain data definitions only. Imported JSON never supplies executable contexts or shapes. */
export function SemanticProfileControls({ profile, onProfile, onError }: SemanticProfileControlsProps) {
  const { t } = useTranslation();
  const [definition, setDefinition] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<BsddSearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const provider = useRef<BsddNamespace | null>(null);
  const requestGeneration = useRef(0);
  useEffect(() => () => { requestGeneration.current++; }, []);
  const sdk = () => provider.current ?? (provider.current = new BsddNamespace());
  function importDefinition() {
    try {
      if (new TextEncoder().encode(definition).byteLength > 1024 * 1024) throw new Error('Profile definition exceeds the 1 MiB limit');
      const candidate = JSON.parse(definition) as ProfileDefinition;
      assertProfile(candidate); onProfile(candidate); setDiagnostics([]);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  function importDictionary() {
    try {
      if (new TextEncoder().encode(definition).byteLength > 1024 * 1024) throw new Error('Dictionary exceeds the 1 MiB limit');
      const imported = dictionaryToProfile(JSON.parse(definition) as unknown);
      onProfile(imported.profile); setDiagnostics(imported.diagnostics);
      // Keep the original dictionary, including unsupported relations, in the
      // editable input. Profile/workspace export makes no claim to carry them.
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  async function search() {
    const generation = ++requestGeneration.current; setBusy(true);
    try { const found = await sdk().search(query); if (generation === requestGeneration.current) setResults(found); }
    catch (error) { if (generation === requestGeneration.current) onError(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === requestGeneration.current) setBusy(false); }
  }
  async function choose(result: BsddSearchResult) {
    const generation = ++requestGeneration.current; setBusy(true);
    try {
      const imported = await profileFromBsdd(sdk(), result.uri, { id: result.uri + '/ifc-lite-profile', version: '1.0.0', vocabulary: result.uri + '#' });
      if (generation !== requestGeneration.current) return;
      onProfile(imported.profile); setDiagnostics(imported.diagnostics); setDefinition(JSON.stringify(imported.profile, null, 2));
    } catch (error) { if (generation === requestGeneration.current) onError(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === requestGeneration.current) setBusy(false); }
  }
  async function exportProfile() {
    try {
      const artifacts = await generateArtifacts(profile);
      downloadFile(JSON.stringify({ profile, artifacts }, null, 2), 'semantic-profile.json', 'application/json');
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  return <details className="rounded border border-border p-2">
    <summary>{t('semantic.profileControls')}</summary>
    <p className="my-2 break-all text-sm">{profile.id} · {profile.version}</p>
    <label className="block text-sm">{t('semantic.profileDefinition')}<textarea className={control} rows={6} value={definition} onChange={event => setDefinition(event.target.value)} /></label>
    <div className="my-2 flex flex-wrap gap-2">
      <button className={button} disabled={!definition || busy} onClick={importDefinition}>{t('semantic.importProfile')}</button>
      <button className={button} disabled={!definition || busy} onClick={importDictionary}>{t('semantic.importDictionary')}</button>
      <button className={button} disabled={!definition || busy} onClick={() => downloadFile(definition, 'semantic-source-definition.json', 'application/json')}>{t('semantic.exportSourceDefinition')}</button>
      <button className={button} disabled={busy} onClick={() => { onProfile(DEFAULT_PROFILE); setDefinition(''); setDiagnostics([]); }}>{t('semantic.referenceProfile')}</button>
      <button className={button} disabled={busy} onClick={() => void exportProfile()}>{t('semantic.exportProfile')}</button>
    </div>
    <p className="my-2 text-xs text-muted-foreground">{t('semantic.dictionaryRetention')}</p>
    <label className="block text-sm">{t('semantic.bsddSearch')}<input className={control} value={query} onChange={event => setQuery(event.target.value)} /></label>
    <button className={`${button} my-2`} disabled={busy || !query.trim()} onClick={() => void search()}>{t('semantic.searchBsdd')}</button>
    <ul className="space-y-1">{results.map(result => <li key={result.uri}>
      <button className={`${button} w-full text-left`} disabled={busy} onClick={() => void choose(result)}>{result.name} · {result.dictionaryUri}</button>
    </li>)}</ul>
    {diagnostics.length > 0 && <ul className="my-2 text-sm text-muted-foreground">{diagnostics.map(message => <li key={message}>{message}</li>)}</ul>}
  </details>;
}
