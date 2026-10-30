/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { useIfcLoader } from '@/hooks/useIfcLoader';
import { sanitizeFilename } from '@/lib/export/download';
import { RegistryError } from '@/lib/registry/protocol';
import { parseRegistryAddress } from '@/lib/registry/connection';
import { clearRegistrySession, registryTransport, updateRegistryWorkspace as update, useRegistryWorkspace } from '@/lib/registry/workspace';
import { RegistryArtifacts, type RegistryRelease } from '@/lib/registry/artifacts';
import { exportRegistryModel } from '@/lib/registry/export-model';
import { RegistryPublication, RegistryReleaseDetails } from './RegistryReleaseDetails';

interface RegistrySourceProps {
  expanded: boolean; navigationDisabled: boolean;
  onToggle: () => void; onBusyChange: (busy: boolean) => void;
}
const displayModel = (repository: string) => repository.split('/').pop()?.replace(/[-_]/g, ' ') || repository;
const releaseLabel = (release: RegistryRelease) => release.tag.startsWith('sha256:') ? release.title : release.tag;
function nextVersion(releases: RegistryRelease[]): string {
  let revision = 2;
  while (releases.some(release => release.tag === `revision-${revision}`)) revision += 1;
  return `revision-${revision}`;
}

/** OCI-specific browsing and publishing inside the common Cloud Sources layout. */
export function RegistrySource({ expanded, navigationDisabled, onToggle, onBusyChange }: RegistrySourceProps) {
  const { t } = useTranslation();
  const id = useId();
  const [transport] = useState(() => registryTransport(window.location.origin));
  const [artifacts] = useState(() => new RegistryArtifacts(transport));
  const { address, session, models, modelTitles, catalogNext, releases, repository, release, version, fingerprint, published } = useRegistryWorkspace();
  const selected = releases.find(item => item.tag === release);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  const { loadFile } = useIfcLoader();
  const modelName = useViewerStore(state => {
    const active = state.activeModelId ?? (state.models.size === 1 ? state.models.keys().next().value : undefined);
    return active ? state.models.get(active)?.name ?? '' : '';
  });
  useEffect(() => () => { pending.current?.abort(); }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);

  const logout = () => {
    void run(async () => { await transport.signOut(); clearRegistrySession(); });
  };
  const run = async (operation: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController();
    pending.current?.abort(); pending.current = controller;
    setBusy(true); setError(''); setMessage('');
    try { await operation(controller.signal); }
    catch (failure) {
      if (!controller.signal.aborted) {
        const status = failure instanceof RegistryError ? failure.status : 0;
        setError(status === 401 ? t(session ? 'registry.expired' : 'registry.signInFailed') : status === 403 ? t('registry.denied') : failure instanceof Error ? failure.message : t('registry.failed'));
        if (status === 401) clearRegistrySession();
      }
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  };
  const browseModel = async (name: string, signal: AbortSignal, requested?: string) => {
    const available = await artifacts.releases(name, signal);
    if (requested?.startsWith('sha256:')) available.unshift(await artifacts.describe(name, requested, signal));
    signal.throwIfAborted();
    const chosen = available.find(item => item.tag === requested) ?? available[0];
    update({ modelTitles: { ...useRegistryWorkspace.getState().modelTitles, [name]: chosen?.title || displayModel(name) }, repository: name, releases: available, tags: available.map(item => item.tag), release: chosen?.tag ?? '', version: nextVersion(available), fingerprint: '', published: '' });
    if (requested && !available.some(item => item.tag === requested)) setError(t('registry.releaseMissing'));
  };
  const pull = async (reference: string, signal: AbortSignal) => {
    const received = await artifacts.pull(repository, reference, signal);
    signal.throwIfAborted();
    await loadFile(new File([received.bytes], sanitizeFilename(received.filename, { fallback: 'model.ifc' }), { type: 'application/x-step' }));
    signal.throwIfAborted();
    const loadError = useViewerStore.getState().error;
    if (loadError) throw new RegistryError(loadError);
    update({ fingerprint: received.digest });
    setMessage(t('registry.opened', { name: selected?.title ?? displayModel(repository), version: selected ? releaseLabel(selected) : t('registry.savedRelease') }));
  };

  useEffect(() => {
    const current = useRegistryWorkspace.getState();
    if (current.session && current.models.length) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const session = await transport.restore(controller.signal);
        if (!session) return;
        const catalog = await artifacts.modelCatalog(controller.signal);
        const repository = catalog.repositories[0] ?? '';
        const releases = repository ? await artifacts.releases(repository, controller.signal) : [];
        controller.signal.throwIfAborted();
        update({ session, models: catalog.repositories, modelTitles: { ...catalog.titles, ...(repository && releases[0] ? { [repository]: releases[0].title } : {}) }, catalogNext: catalog.next, repository, releases,
          release: releases[0]?.tag ?? '', version: nextVersion(releases), tags: releases.map(item => item.tag) });
      } catch (error) {
        if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
          console.warn('[registry] Could not restore the browser session', error instanceof Error ? error.message : 'unknown error');
        }
      }
    })();
    return () => controller.abort();
  }, [transport, artifacts]);

  return <li className={`rounded-lg border bg-background ${expanded ? 'border-primary/40' : ''}`}>
    <div className="flex items-center gap-1 p-2">
      <button type="button" disabled={navigationDisabled || busy} onClick={onToggle} aria-expanded={expanded} aria-controls={`${id}-content`}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1.5 text-left hover:bg-accent disabled:cursor-default">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted"><Database className="h-5 w-5 text-muted-foreground" aria-hidden="true" /></span>
        <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{t('registry.title')}</span>
          <span className="block truncate text-xs text-muted-foreground">{session ? t('registry.connected') : t('sources.workspace.notConnected')}</span></span>
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />}
      </button>
    </div>
    <fieldset id={`${id}-content`} hidden={!expanded} disabled={navigationDisabled} aria-label={t('registry.title')} className="min-w-0 space-y-3 border-t p-3">
      {!session ? <form className="grid gap-2" onSubmit={event => {
        event.preventDefault();
        void run(async signal => {
          const connection = parseRegistryAddress(address);
          const connected = await transport.login(null, signal);
          const catalog = await artifacts.modelCatalog(signal);
          const names = [...catalog.repositories];
          if (connection.repository && connected.repositories.some(access => access.repository === connection.repository && access.actions.includes('pull')) && !names.includes(connection.repository)) names.unshift(connection.repository);
          signal.throwIfAborted(); update({ session: connected, models: names, modelTitles: catalog.titles, catalogNext: catalog.next, address: connection.origin });
          const model = connection.repository && names.includes(connection.repository) ? connection.repository : names[0];
          if (model) await browseModel(model, signal, connection.reference);
          if (connection.repository && !names.includes(connection.repository)) setError(t('registry.denied'));
        });
      }}>
        <Label htmlFor={`${id}-address`}>{t('registry.address')}</Label>
        <Input id={`${id}-address`} value={address} onChange={event => update({ address: event.target.value })} required disabled={busy} autoComplete="off" />
        <p className="text-xs text-muted-foreground">{t('registry.local')}</p>
        <p className="text-xs text-muted-foreground">{t('registry.sessionOnly')}</p>
        <Button type="submit" disabled={busy}>{t('registry.signIn')}</Button>
      </form> : <div className="grid min-w-0 grid-cols-1 gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{session.subject}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={logout}>{t('registry.signOut')}</Button>
        </div>
        {models.length ? <>
          <Label htmlFor={`${id}-model`}>{t('registry.model')}</Label>
          <select id={`${id}-model`} value={repository} disabled={busy} className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm" onChange={event => void run(signal => browseModel(event.target.value, signal))}>
            {models.map(model => <option key={model} value={model}>{modelTitles[model] || displayModel(model)}</option>)}
          </select>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{t(transport.can('push', repository) ? 'registry.writable' : 'registry.readOnly')}</p>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(signal => browseModel(repository, signal))}>{t('registry.refresh')}</Button>
          </div>
          {releases.length ? <>
            <Label htmlFor={`${id}-release`}>{t('registry.release')}</Label>
            <select id={`${id}-release`} value={release} disabled={busy} className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm" onChange={event => update({ release: event.target.value, fingerprint: '' })}>
              {releases.map(item => <option key={item.tag} value={item.tag}>{releaseLabel(item)}</option>)}
            </select>
            {selected && <RegistryPublication release={selected} />}
            <Button disabled={busy || !release} onClick={() => void run(signal => pull(release, signal))}>{t('registry.open')}</Button>
          </> : <p className="text-sm text-muted-foreground">{t('registry.noReleases')}</p>}
          <div className="grid min-w-0 grid-cols-1 gap-2 border-t pt-3">
            <p className="text-xs text-muted-foreground">{modelName ? t('registry.activeModel', { name: modelName }) : t('registry.noModel')}</p>
            <Label htmlFor={`${id}-version`}>{t('registry.newVersion')}</Label>
            <Input id={`${id}-version`} value={version} onChange={event => update({ version: event.target.value })} disabled={busy || !transport.can('push', repository)} />
            <Button disabled={busy || !modelName || !version || !transport.can('push', repository)} onClick={() => void run(async signal => {
              const source = await exportRegistryModel(); signal.throwIfAborted();
              const digest = await artifacts.publish(repository, version, source.bytes, source.filename, signal);
              const info = await artifacts.describe(repository, version, signal);
              signal.throwIfAborted();
              update({ fingerprint: digest, published: digest, release: version, releases: [info, ...releases.filter(item => item.tag !== version)], tags: [...new Set([...releases.map(item => item.tag), version])] });
              setMessage(t('registry.published', { version }));
            })}>{t('registry.publish')}</Button>
            {published && <Button variant="outline" disabled={busy} onClick={() => void run(signal => pull(published, signal))}>{t('registry.reopen')}</Button>}
          </div>
          <RegistryReleaseDetails address={address} repository={repository} release={selected} fingerprint={fingerprint || selected?.digest || ''} onCopy={() => void run(async () => { await navigator.clipboard.writeText(fingerprint || selected?.digest || ''); setMessage(t('registry.copied')); })} />
        </> : <p className="text-sm text-muted-foreground">{t('registry.noModels')}</p>}
        {catalogNext && <Button variant="ghost" disabled={busy} onClick={() => void run(async signal => {
          const page = await artifacts.modelCatalog(signal, catalogNext); signal.throwIfAborted();
          update({ models: [...new Set([...models, ...page.repositories])], modelTitles: { ...modelTitles, ...page.titles }, catalogNext: page.next });
        })}>{t('registry.moreModels')}</Button>}
      </div>}
      {busy && <output className="block text-sm text-muted-foreground">{t('registry.working')}</output>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {message && <output className="block text-sm">{message}</output>}
    </fieldset>
  </li>;
}
