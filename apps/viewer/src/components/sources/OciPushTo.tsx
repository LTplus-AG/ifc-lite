/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { exportRegistryModel } from '@/lib/registry/export-model';
import { authorizeDestination, resourceAllows } from '@/lib/registry/handoff-auth';
import { confirmPublication } from '@/lib/registry/handoff-publication';
import { pushHandoff } from '@/lib/registry/handoff-client';
import { connectionFor, HANDOFF_PATH, HANDOFF_PROTOCOL, registryConnections, type RegistryConnection } from '@/lib/registry/handoff-contract';
import { useHandoffWorkspace } from '@/lib/registry/handoff-workspace';

/** Publishing is available for any active IFC model and obtains destination-specific access. */
export function OciPushTo({ disabled = false, onBusyChange, connections: configuredConnections }: { disabled?: boolean; onBusyChange: (busy: boolean) => void; connections?: RegistryConnection[] }) {
  const { t } = useTranslation(); const id = useId();
  const [connections] = useState(() => configuredConnections ?? registryConnections());
  const { handoff, loadedModelId, pendingPublication, saved } = useHandoffWorkspace();
  const [registry, setRegistry] = useState(handoff?.destination?.registry ?? handoff?.source.registry ?? connections[0]?.registry ?? '');
  const [repository, setRepository] = useState(handoff?.destination?.repository ?? handoff?.source.repository ?? 'project/model');
  const [version, setVersion] = useState('revision-2');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const model = useViewerStore(state => {
    const id = state.activeModelId ?? (state.models.size === 1 ? state.models.keys().next().value : undefined);
    return id ? state.models.get(id) : undefined;
  });
  const managed = handoff?.intent === 'edit' && model?.id && model.id === loadedModelId &&
    handoff.destination?.registry === handoff.source.registry &&
    connections.some(c => c.registry === handoff.source.registry && c.token_exchange?.publication_endpoint)
    ? { handoff, destination: handoff.destination }
    : undefined;
  const uploaded = managed && pendingPublication?.handoff === managed.handoff ? pendingPublication.artifact : undefined;
  const alreadySaved = managed && Boolean(saved);
  const requiresHandoff = !managed && connections.some(c => c.registry === registry && c.token_exchange?.publication_endpoint);
  useEffect(() => () => { pending.current?.abort(); }, []);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  function reopenLink(): string {
    if (!saved) return '#';
    const context = { protocol: HANDOFF_PROTOCOL, source: saved, intent: managed ? 'view' : 'edit' };
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(context)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    return `${HANDOFF_PATH}#handoff=${encoded}`;
  }
  async function publish() {
    const controller = new AbortController(); pending.current?.abort(); pending.current = controller;
    setBusy(true); setError(''); useHandoffWorkspace.setState({ saved: undefined });
    try {
      if (!model) return;
      const target = managed?.destination ?? { registry, repository };
      const connection = connectionFor(target.registry, connections);
      const previous = useHandoffWorkspace.getState().destinationSession;
      const authorization = !managed && previous?.registry === target.registry &&
        resourceAllows(previous, target.repository, 'pull') && resourceAllows(previous, target.repository, 'push')
        ? { session: previous }
        : await authorizeDestination(connection, target.repository, controller.signal);
      controller.signal.throwIfAborted();
      const { session, publicationToken } = authorization;
      if (managed && !publicationToken) throw new Error(t('registry.push.openForEdit'));
      if (!managed) useHandoffWorkspace.setState({ destinationSession: session });

      let artifact = uploaded;
      if (!artifact) {
        const current = useViewerStore.getState();
        const activeId = current.activeModelId ?? (current.models.size === 1 ? current.models.keys().next().value : undefined);
        if (activeId !== model.id) throw new Error(t('registry.push.modelChanged'));
        const source = await exportRegistryModel();
        controller.signal.throwIfAborted();
        const tag = managed ? `save-${crypto.randomUUID()}` : version;
        artifact = await pushHandoff(target.registry, target.repository, tag, source.bytes, source.filename, session, controller.signal);
        if (managed) useHandoffWorkspace.setState({ pendingPublication: { handoff: managed.handoff, artifact } });
      }
      const savedVersion = managed && publicationToken
        ? await confirmPublication(connection, managed.handoff, artifact, publicationToken, controller.signal)
        : artifact;
      controller.signal.throwIfAborted();
      useHandoffWorkspace.setState({ saved: savedVersion, ...(managed && { pendingPublication: undefined }) });
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t('registry.failed')); }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }
  if (!connections.length) return null;
  return <div className="grid gap-3">
    <p className="text-sm">{t(managed ? 'registry.push.managedExplain' : 'registry.push.explain')}</p>
    <p className="text-xs text-muted-foreground">{model ? t('registry.activeModel', { name: model.name }) : t('registry.noModel')}</p>
    {!managed && <>
      <Label htmlFor={`${id}-store`}>{t('registry.push.store')}</Label>
      <select id={`${id}-store`} className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={registry} disabled={busy || disabled} onChange={e => { setRegistry(e.target.value); useHandoffWorkspace.setState({ saved: undefined }); }}>
        {connections.map(c => <option key={c.registry} value={c.registry}>{c.name ?? new URL(c.registry).host}</option>)}
      </select>
      <Label htmlFor={`${id}-folder`}>{t('registry.push.folder')}</Label>
      <Input id={`${id}-folder`} value={repository} disabled={busy || disabled} autoComplete="off" onChange={e => { setRepository(e.target.value); useHandoffWorkspace.setState({ saved: undefined }); }} />
      <Label htmlFor={`${id}-version`}>{t('registry.newVersion')}</Label>
      <Input id={`${id}-version`} value={version} disabled={busy || disabled} onChange={e => { setVersion(e.target.value); useHandoffWorkspace.setState({ saved: undefined }); }} />
    </>}
    {requiresHandoff && <p className="text-sm">{t('registry.push.openForEdit')}</p>}
    {!alreadySaved && <Button disabled={disabled || busy || !model || requiresHandoff || (!managed && (!repository || !version))} onClick={() => void publish()}>
      {t(uploaded ? 'registry.push.finishSave' : managed ? 'registry.push.saveVersion' : 'registry.push.action')}
    </Button>}
    {busy && <output className="text-sm">{t('registry.working')}</output>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {saved && <><output className="text-sm">{t('registry.push.saved')}</output><a className="text-sm underline" href={reopenLink()} target="_blank" rel="noopener noreferrer">{t('registry.reopen')}</a>
      <details><summary className="cursor-pointer text-xs">{t('registry.details')}</summary><p className="break-all text-xs">{saved.registry}/{saved.repository}@{saved.digest}</p></details></>}
  </div>;
}
