/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useDialogs } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LIBRARY_FAMILIES, nativeLibraryCatalogue, searchNativeLibraries,
  type LibraryArtifact, type LibraryFamily, type ProfileLibrary } from '@/lib/libraries/native-catalogue';
import { openNativeLibraryArtifact, type LibraryOpenOutcome } from '@/lib/libraries/open-native-artifact';

/** Search native libraries from the existing Advanced Search host (#7235). */
export function NativeLibrarySearch({ onOpened }: { onOpened: () => void }) {
  const { t } = useTranslation();
  const { confirmDialog } = useDialogs();
  const state = useViewerStore();
  const host = useOptionalExtensionHost();
  const [profiles, setProfiles] = useState<ProfileLibrary>({ phase: host ? 'loading' : 'unavailable', entries: [] });
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<LibraryFamily | ''>('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<LibraryOpenOutcome | null>(null);
  useEffect(() => {
    const current = useViewerStore.getState();
    void Promise.allSettled([current.initializeDocuments(), current.initializeValidationReports(),
      current.initializeSavedComparisons(), current.initializeSavedClashReports()]);
  }, []);
  useEffect(() => {
    if (!host) { setProfiles({ phase: 'unavailable', entries: [] }); return; }
    let current = true, sequence = 0;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const entries = await host.flavors.list();
        if (current && request === sequence) setProfiles({ phase: 'ready', entries, owner: host });
      } catch (error) {
        console.warn('[Libraries] Native profile library could not be read', error);
        if (current && request === sequence) setProfiles({ phase: 'unavailable', entries: [],
          warning: error instanceof Error ? error.message : String(error) });
      }
    };
    setProfiles({ phase: 'loading', entries: [] });
    void refresh();
    const off = host.flavors.onChange(() => void refresh());
    return () => { current = false; off(); };
  }, [host]);
  const groups = nativeLibraryCatalogue(state, profiles);
  const matches = searchNativeLibraries(groups, query, family || undefined);
  const shown = matches.slice(0, 100);
  const open = async (row: LibraryArtifact) => {
    if (busy) return;
    // Confirm the explicit editor handoff where a native editor can hold a
    // local draft. No catalogue copy or automatic save replaces that draft.
    if (['check', 'lens', 'list'].includes(row.kind)
      && !await confirmDialog({ description: t('searchModal.library.confirmOpen', { name: row.name }) })) return;
    setBusy(true); setOutcome(null);
    try {
      const result = await openNativeLibraryArtifact(row, host);
      if (result === 'opened') onOpened();
      else setOutcome(result);
    } catch (error) {
      console.warn('[Libraries] Opening the native artifact failed', error);
      setOutcome('unavailable');
    } finally { setBusy(false); }
  };
  return <section aria-label={t('searchModal.library.title')} className="flex min-h-0 flex-1 flex-col">
    <div className="space-y-2 border-b p-3">
      <p className="text-xs text-muted-foreground">{t('searchModal.library.hint')}</p>
      <Input aria-label={t('searchModal.library.query')} placeholder={t('searchModal.library.query')}
        value={query} onChange={event => setQuery(event.target.value)} />
      <label className="flex items-center gap-2 text-xs">{t('searchModal.library.types')}
        <select aria-label={t('searchModal.library.types')} value={family} onChange={event => {
          const next = event.target.value;
          setFamily(LIBRARY_FAMILIES.find(value => value === next) ?? '');
        }}>
          <option value="">{t('searchModal.library.all')}</option>
          {LIBRARY_FAMILIES.map(kind => <option key={kind} value={kind}>{t(`searchModal.library.family.${kind}`)}</option>)}
        </select>
      </label>
      <ul aria-label={t('searchModal.library.sources')} className="flex flex-wrap gap-x-3 text-2xs text-muted-foreground">
        {groups.filter(group => !family || group.family === family).map(group => <li key={group.family}>
          {t(`searchModal.library.family.${group.family}`)}: {t(`searchModal.library.phase.${group.phase}`, { count: group.rows.length })}
          {group.warning && <span> · {group.warning}</span>}
        </li>)}
      </ul>
      {outcome && <p role="alert" className="text-xs">{t(`searchModal.library.open.${outcome}`)}</p>}
    </div>
    <p role="status" className="px-3 py-2 text-xs">{t('searchModal.library.results', { shown: shown.length, total: matches.length })}</p>
    <ul aria-label={t('searchModal.library.resultsLabel')} className="min-h-0 overflow-auto px-3 pb-3">
      {shown.map(row => <li key={`${row.kind}:${row.id}`} className="flex items-center gap-2 border-b py-1">
        <span className="shrink-0 text-2xs text-muted-foreground">{t(`searchModal.library.family.${row.family}`)}</span>
        <Button variant="ghost" className="min-w-0 flex-1 justify-start text-left" disabled={busy}
          onClick={() => void open(row)}>{row.name}</Button>
      </li>)}
    </ul>
  </section>;
}
