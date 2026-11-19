/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { exportRegistryModel } from '@/lib/registry/export-model';
import { authorizeRepository, resourceAllows, type ResourceSession } from '@/lib/registry/handoff-auth';
import { browseRepositoryVersions, pushHandoff } from '@/lib/registry/handoff-client';
import { connectionFor, HANDOFF_PATH, HANDOFF_PROTOCOL, registryConnections, type ArtifactSource, type OciHandoff, type RegistryConnection } from '@/lib/registry/handoff-contract';
import { useHandoffWorkspace } from '@/lib/registry/handoff-workspace';

function versionLink(source: ArtifactSource, intent: OciHandoff['intent']): string {
  const context = { protocol: HANDOFF_PROTOCOL, source, intent };
  const bytes = new TextEncoder().encode(JSON.stringify(context));
  const encoded = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return `${HANDOFF_PATH}#handoff=${encoded}`;
}

/** Browse and publish versions in a known OCI repository. */
export function OciPushTo({ disabled = false, onBusyChange, connections: configuredConnections }: {
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
  connections?: RegistryConnection[];
}) {
  const { t } = useTranslation();
  const id = useId();
  const [connections] = useState(() => configuredConnections ?? registryConnections());
  const { handoff, saved: savedResult } = useHandoffWorkspace();
  const [registry, setRegistry] = useState(handoff?.destination?.registry ?? handoff?.source.registry ?? connections[0]?.registry ?? '');
  const [repository, setRepository] = useState(handoff?.destination?.repository ?? handoff?.source.repository ?? '');
  const [tag, setTag] = useState('revision-2');
  const [page, setPage] = useState<Awaited<ReturnType<typeof browseRepositoryVersions>>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const model = useViewerStore(state => {
    const id = state.activeModelId ?? (state.models.size === 1 ? state.models.keys().next().value : undefined);
    return id ? state.models.get(id) : undefined;
  });
  const saved = savedResult?.modelId === model?.id ? savedResult?.artifact : undefined;

  useEffect(() => () => { pending.current?.abort(); }, []);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  function clearSaved() {
    useHandoffWorkspace.setState(state => state.saved?.modelId === model?.id ? { saved: undefined } : state);
  }

  function clearRepositoryResults() {
    setPage(undefined);
    setError('');
    clearSaved();
  }

  async function run(action: 'pull' | 'push', operation: (session: ResourceSession, signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const connection = connectionFor(registry, connections);
      const { repositorySession, sourceSession } = useHandoffWorkspace.getState();
      const previous = [repositorySession, sourceSession].find(session =>
        session?.registry === registry && resourceAllows(session, repository, 'pull') &&
        (action === 'pull' || resourceAllows(session, repository, 'push')));
      const session = previous ?? await authorizeRepository(connection, repository, action, controller.signal, connections);
      controller.signal.throwIfAborted();
      if (!previous) useHandoffWorkspace.setState({ repositorySession: session });
      await operation(session, controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t('registry.failed'));
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function browse(more = false) {
    return run('pull', async (session, signal) => {
      const result = await browseRepositoryVersions(registry, repository, session, signal, more ? page?.remaining : undefined);
      signal.throwIfAborted();
      setPage(more && page ? { ...result, versions: [...page.versions, ...result.versions] } : result);
    });
  }

  function publish() {
    if (!model) return;
    return run('push', async (session, signal) => {
      clearSaved();
      const current = useViewerStore.getState();
      const activeId = current.activeModelId ?? (current.models.size === 1 ? current.models.keys().next().value : undefined);
      if (activeId !== model.id) throw new Error(t('registry.push.modelChanged'));
      const source = await exportRegistryModel();
      signal.throwIfAborted();
      const artifact = await pushHandoff(registry, repository, tag, source.bytes, source.filename, session, signal);
      signal.throwIfAborted();
      useHandoffWorkspace.setState({ saved: { modelId: model.id, artifact } });
      setPage(undefined);
    });
  }

  if (!connections.length) return null;
  const repositoryDisabled = busy || disabled || !registry || !repository;
  return <div className="grid gap-3">
    <p className="text-sm">{t('registry.push.explain')}</p>
    <Label htmlFor={`${id}-store`}>{t('registry.push.store')}</Label>
    <Select value={registry} disabled={busy || disabled} onValueChange={value => {
      setRegistry(value);
      clearRepositoryResults();
    }}>
      <SelectTrigger id={`${id}-store`}><SelectValue /></SelectTrigger>
      <SelectContent>
        {connections.map(c => <SelectItem key={c.registry} value={c.registry}>{c.name ?? new URL(c.registry).host}</SelectItem>)}
      </SelectContent>
    </Select>
    <Label htmlFor={`${id}-folder`}>{t('registry.push.folder')}</Label>
    <Input id={`${id}-folder`} value={repository} disabled={busy || disabled} autoComplete="off" placeholder="project/model"
      onChange={e => { setRepository(e.target.value); clearRepositoryResults(); }} />
    <Button variant="outline" disabled={repositoryDisabled} onClick={() => void browse()}>
      {t(page ? 'registry.refresh' : 'registry.browseVersions')}
    </Button>
    {page && <>
      {page.versions.length > 0 && <ul className="grid gap-1">
        {page.versions.map(({ tag, title, digest }) => <li key={tag}>
          <a className="break-all text-sm underline" href={versionLink({ registry, repository, digest }, 'view')} target="_blank" rel="noopener noreferrer">
            {title === tag ? tag : `${title} · ${tag}`}
          </a>
        </li>)}
      </ul>}
      {page.remaining.length > 0
        ? <Button variant="outline" disabled={repositoryDisabled} onClick={() => void browse(true)}>
          {t('registry.moreVersions')}
        </Button>
        : page.versions.length === 0 && <p className="text-sm">{t('registry.noReleases')}</p>}
    </>}
    <p className="text-xs text-muted-foreground">{model ? t('registry.activeModel', { name: model.name }) : t('registry.noModel')}</p>
    <Label htmlFor={`${id}-version`}>{t('registry.newVersion')}</Label>
    <Input id={`${id}-version`} value={tag} disabled={busy || disabled} autoComplete="off"
      onChange={e => { setTag(e.target.value); clearSaved(); }} />
    <Button disabled={repositoryDisabled || !model || !tag} onClick={() => void publish()}>
      {t('registry.push.action')}
    </Button>
    {busy && <output className="text-sm">{t('registry.working')}</output>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {saved && <>
      <output className="text-sm">{t('registry.push.saved')}</output>
      <a className="text-sm underline" href={versionLink(saved, 'edit')} target="_blank" rel="noopener noreferrer">{t('registry.reopen')}</a>
      <details>
        <summary className="cursor-pointer text-xs">{t('registry.details')}</summary>
        <p className="break-all text-xs">{saved.registry}/{saved.repository}@{saved.digest}</p>
      </details>
    </>}
  </div>;
}
