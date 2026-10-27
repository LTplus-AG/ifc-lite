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
import { RegistryError } from '@/lib/registry/transport';
import { clearRegistrySession, registryTransport, updateRegistryWorkspace as update, useRegistryWorkspace } from '@/lib/registry/workspace';
import { RegistryArtifacts } from '@/lib/registry/artifacts';
import { exportRegistryModel } from '@/lib/registry/export-model';

interface RegistrySourceProps {
  expanded: boolean;
  navigationDisabled: boolean;
  onToggle: () => void;
  onBusyChange: (busy: boolean) => void;
}

/** An OCI-specific source card; publishing stays outside the read-only file-provider API. */
export function RegistrySource({ expanded, navigationDisabled, onToggle, onBusyChange }: RegistrySourceProps) {
  const { t } = useTranslation();
  const id = useId();
  const [transport] = useState(() => registryTransport(window.location.origin));
  const [artifacts] = useState(() => new RegistryArtifacts(transport));
  const { session, repository, release, version, tags, fingerprint, published } = useRegistryWorkspace();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
  useEffect(() => { if (!expanded) setPassword(''); }, [expanded]);

  const logout = () => {
    pending.current?.abort();
    clearRegistrySession(); setPassword(''); setUsername('');
    setMessage(''); setError(''); setBusy(false);
  };

  const run = async (operation: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController();
    pending.current?.abort(); pending.current = controller;
    setBusy(true); setError(''); setMessage('');
    try { await operation(controller.signal); }
    catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : String(failure));
        if (failure instanceof RegistryError && failure.status === 401) clearRegistrySession();
      }
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  };

  const pull = async (reference: string, signal: AbortSignal) => {
    const received = await artifacts.pull(repository, reference, signal);
    signal.throwIfAborted();
    await loadFile(new File([received.bytes], sanitizeFilename(received.filename, { fallback: 'model.ifc' }), { type: 'application/x-step' }));
    signal.throwIfAborted();
    const loadError = useViewerStore.getState().error;
    if (loadError) throw new RegistryError(loadError);
    update({ fingerprint: received.digest });
    setMessage(t('registry.opened', { reference: received.reference }));
  };

  return (
    <li className={`rounded-lg border bg-background ${expanded ? 'border-primary/40' : ''}`}>
      <div className="flex items-center gap-1 p-2">
        <button type="button" disabled={navigationDisabled || busy} onClick={onToggle}
          aria-expanded={expanded} aria-controls={`${id}-content`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1.5 text-left hover:bg-accent disabled:cursor-default">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted"><Database className="h-5 w-5 text-muted-foreground" aria-hidden="true" /></span>
          <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{t('registry.title')}</span>
            <span className="block truncate text-xs text-muted-foreground">{session ? session.repository : t('sources.workspace.notConnected')}</span></span>
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />}
        </button>
      </div>
      <fieldset id={`${id}-content`} hidden={!expanded} disabled={navigationDisabled} aria-label={t('registry.title')}
        className="min-w-0 space-y-3 border-t p-3">
        <p className="text-xs text-muted-foreground">{t('registry.description')}</p>
        <p className="text-xs text-muted-foreground">{t('registry.local')}</p>
        {!session ? (
          <form className="grid gap-3" onSubmit={event => {
            event.preventDefault(); const secret = password; setPassword('');
            void run(async signal => {
              const connected = await transport.login(repository, username, secret, signal);
              const available = await artifacts.tags(repository, signal);
              signal.throwIfAborted();
              update({ session: connected, tags: available, release: available.length && !available.includes(release) ? available[0] : release });
            });
          }}>
            <Label htmlFor={`${id}-repository`}>{t('registry.repository')}</Label>
            <Input id={`${id}-repository`} value={repository} onChange={e => update({ repository: e.target.value })} required disabled={busy} autoComplete="off" />
            <Label htmlFor={`${id}-username`}>{t('registry.username')}</Label>
            <Input id={`${id}-username`} value={username} onChange={e => setUsername(e.target.value)} required disabled={busy} autoComplete="username" />
            <Label htmlFor={`${id}-password`}>{t('registry.password')}</Label>
            <Input id={`${id}-password`} type="password" value={password} onChange={e => setPassword(e.target.value)} required disabled={busy} autoComplete="off" />
            <p className="text-xs text-muted-foreground">{t('registry.sessionOnly')}</p>
            <Button type="submit" disabled={busy}>{t('registry.signIn')}</Button>
          </form>
        ) : (
          <div className="grid gap-4">
            <div className="flex items-center justify-between gap-3">
              <div><p className="text-sm font-medium">{session.repository}</p><p className="text-xs text-muted-foreground">{t(session.actions.includes('push') ? 'registry.writable' : 'registry.readOnly')}</p></div>
              <Button variant="outline" onClick={logout}>{t('registry.signOut')}</Button>
            </div>
            <div className="grid gap-2 border-t pt-4">
              <Label htmlFor={`${id}-release`}>{t('registry.release')}</Label>
              <Input id={`${id}-release`} list={`${id}-tags`} value={release} onChange={e => update({ release: e.target.value })} disabled={busy} />
              <datalist id={`${id}-tags`}>{tags.map(tag => <option key={tag} value={tag}>{tag}</option>)}</datalist>
              <Button disabled={busy || !release} onClick={() => void run(signal => pull(release, signal))}>{t('registry.open')}</Button>
            </div>
            <div className="grid gap-2 border-t pt-4">
              <p className="text-sm">{modelName ? t('registry.activeModel', { name: modelName }) : t('registry.noModel')}</p>
              <Label htmlFor={`${id}-version`}>{t('registry.newVersion')}</Label>
              <Input id={`${id}-version`} value={version} onChange={e => update({ version: e.target.value })} disabled={busy || !session.actions.includes('push')} />
              <Button disabled={busy || !modelName || !version || !session.actions.includes('push')} onClick={() => void run(async signal => {
                const source = await exportRegistryModel(); signal.throwIfAborted();
                const digest = await artifacts.publish(repository, version, source.bytes, source.filename, signal);
                signal.throwIfAborted();
                update({ fingerprint: digest, published: digest, release: version, tags: [...new Set([...tags, version])] });
                setMessage(t('registry.published', { version }));
              })}>{t('registry.publish')}</Button>
              {published && <Button variant="outline" disabled={busy} onClick={() => void run(signal => pull(published, signal))}>{t('registry.reopen')}</Button>}
            </div>
          </div>
        )}
        {busy && <output className="text-sm text-muted-foreground">{t('registry.working')}</output>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {message && <output className="min-w-0 break-all text-sm">{message}</output>}
        {fingerprint && <div className="grid gap-1"><p className="text-xs text-muted-foreground">{t('registry.fingerprint')}</p><code className="break-all text-xs">{fingerprint}</code></div>}
      </fieldset>
    </li>
  );
}
