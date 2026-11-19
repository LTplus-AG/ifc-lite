/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useMemo, useRef, useState } from 'react';
import type { FileSourceProvider, WriteBackMode } from '@ifc-lite/plugin-api';
import { useViewerStore } from '@/store';
import { useSourceHost } from '@/services/sources/SourceHostProvider';
import { bindSourceModel, isSourceBindingCurrent, saveSourceModel, sourceWriteBackModes, type WriteBackBinding, type SaveSourceOutcome } from '@/services/sources/model-writeback';
import { loadResolvedSourcePrefs } from '@/lib/sources/preferences';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useTranslation } from '@/i18n';
import '@/i18n/catalogues/source-writeback.en';
import { SourceWriteBackFolder } from './SourceWriteBackFolder';
import { SourceWriteBackHistory } from './SourceWriteBackHistory';

export function SourceWriteBackDialog({ modelId, onClose }: { modelId: string; onClose: () => void }) {
  const host = useSourceHost(), { t } = useTranslation();
  const [binding] = useState(() => bindSourceModel(modelId));
  const provider = binding && host.get(binding.tag.provider);
  if (binding && provider) return <BoundWriteBackDialog binding={binding} provider={provider} onClose={onClose} />;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{t('sources.writeBack.open')}</DialogTitle><DialogDescription>{t('sources.writeBack.unavailable')}</DialogDescription></DialogHeader>
    <Button onClick={onClose}>{t('sources.writeBack.close')}</Button>
  </DialogContent></Dialog>;
}

function BoundWriteBackDialog({ binding, provider, onClose }: { binding: WriteBackBinding; provider: FileSourceProvider; onClose: () => void }) {
  const host = useSourceHost(), { t } = useTranslation();
  const modes = sourceWriteBackModes(host, binding);
  const [mode, setMode] = useState<WriteBackMode>(modes.includes('new-version') ? 'new-version' : modes[0] ?? 'new-file');
  const [fileName, setFileName] = useState(binding.name.replace(/\.ifc$/i, '-edited.ifc'));
  const [folder, setFolder] = useState({ id: '', name: '' });
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveSourceOutcome | null>(null), [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const ctx = useMemo(() => host.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest)), [host, provider]);
  const currentModel = useViewerStore(state => state.models.get(binding.modelId));
  const currentTag = useViewerStore(state => state.sourceTags.get(binding.modelId));
  const current = !!currentModel && !!currentTag && isSourceBindingCurrent(binding);
  const labels = { 'new-version': 'sources.writeBack.newVersion', 'new-file': 'sources.writeBack.newFile', 'new-location': 'sources.writeBack.newLocation' } as const;
  const saved = outcome?.kind === 'saved' ? outcome : null;
  const submit = async () => {
    if (submitting.current || !confirmed || !current || !modes.includes(mode)) return;
    submitting.current = true; setBusy(true); setError(null);
    try { setOutcome(await saveSourceModel(host, binding, { mode, fileName, containerId: folder.id })); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { submitting.current = false; setBusy(false); setConfirmed(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !submitting.current) onClose(); }}>
    <DialogContent onEscapeKeyDown={event => { if (submitting.current) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{t('sources.writeBack.open')}</DialogTitle>
        <DialogDescription>{t('sources.writeBack.description', { name: binding.name, provider: provider.manifest.title })}</DialogDescription>
      </DialogHeader>
      {saved ? <>
        <output className="block">{t('sources.writeBack.saved')}</output>
        {!saved.linked && <p role="alert">{t('sources.writeBack.savedUnlinked')}</p>}
        <SourceWriteBackHistory provider={provider} ctx={ctx} projectId={binding.tag.projectId} file={saved.result.file} created={saved.result.revision} />
      </> : <form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-3">
        <fieldset disabled={busy} className="space-y-3">
          <fieldset className="space-y-1"><legend>{t('sources.writeBack.mode')}</legend>
            {modes.map(item => <Button key={item} type="button" variant={mode === item ? 'default' : 'outline'}
              aria-pressed={mode === item} disabled={busy} onClick={() => { setMode(item); setConfirmed(false); }}>{t(labels[item])}</Button>)}
          </fieldset>
          {mode !== 'new-version' && <label className="block space-y-1"><span>{t('sources.writeBack.name')}</span>
            <Input value={fileName} onChange={event => { setFileName(event.target.value); setConfirmed(false); }} required />
          </label>}
          {mode === 'new-location' && <>
            <p>{t('sources.writeBack.selectedFolder', { name: folder.name || t('sources.writeBack.noFolder') })}</p>
            <SourceWriteBackFolder provider={provider} ctx={ctx} projectId={binding.tag.projectId} onChoose={container => { setFolder(container); setConfirmed(false); }} />
          </>}
          <p className="text-sm text-muted-foreground">{t('sources.writeBack.base', { revision: binding.tag.revisionId })}</p>
          <label className="flex items-start gap-2 text-sm"><Checkbox checked={confirmed} onCheckedChange={setConfirmed} />{t('sources.writeBack.confirm')}</label>
        </fieldset>
        {!current && <p role="alert">{t('sources.writeBack.modelChanged')}</p>}
        {outcome?.kind === 'conflict' && <p role="alert">{t(outcome.conflict.kind === 'stale-base' ? 'sources.writeBack.staleBase' : 'sources.writeBack.nameExists')}</p>}
        {outcome?.kind === 'invalid-destination' && <p role="alert">{t('sources.writeBack.invalidDestination')}</p>}
        {outcome?.kind === 'model-changed' && <p role="alert">{t('sources.writeBack.modelChanged')}</p>}
        {outcome?.kind === 'unavailable' && <p role="alert">{t('sources.writeBack.unavailable')}</p>}
        {error && <p role="alert">{t('sources.writeBack.failed', { reason: error })}</p>}
        <Button type="submit" disabled={busy || !confirmed || !current || !modes.includes(mode) || (mode === 'new-location' && !folder.id)}>{t(busy ? 'sources.writeBack.saving' : 'sources.writeBack.save')}</Button>
      </form>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>{t('sources.writeBack.close')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
