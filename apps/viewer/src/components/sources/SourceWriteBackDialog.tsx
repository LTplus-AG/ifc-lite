/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useMemo, useRef, useState } from 'react';
import type { FileSourceProvider, WriteBackMode } from '@ifc-lite/plugin-api';
import { useViewerStore } from '@/store';
import { useSourceHost } from '@/services/sources/SourceHostProvider';
import { bindSourceModel, isSourceBindingCurrent, writeBackModes, type WriteBackBinding } from '@/services/sources/model-writeback-binding';
import { saveSourceModel, type SaveSourceOutcome } from '@/services/sources/model-writeback';
import { loadResolvedSourcePrefs } from '@/lib/sources/preferences';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useTranslation } from '@/i18n';
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

const MODE_LABELS = { 'new-version': 'sources.writeBack.newVersion', 'new-file': 'sources.writeBack.newFile', 'new-location': 'sources.writeBack.newLocation' } as const;

const CONFLICT_ALERTS = { 'stale-base': 'sources.writeBack.staleBase', 'name-exists': 'sources.writeBack.nameExists', 'destination-refused': 'sources.writeBack.refused' } as const;

/** The one problem worth showing, if any. A stale binding outranks the outcome that reported it. */
function alertKey(current: boolean, outcome: SaveSourceOutcome | null) {
  if (!current || outcome?.kind === 'model-changed') return 'sources.writeBack.modelChanged' as const;
  if (outcome?.kind === 'conflict') return CONFLICT_ALERTS[outcome.conflict.kind];
  if (outcome?.kind === 'invalid-destination') return 'sources.writeBack.invalidDestination' as const;
  if (outcome?.kind === 'unavailable') return 'sources.writeBack.unavailable' as const;
  return null;
}

function BoundWriteBackDialog({ binding, provider, onClose }: { binding: WriteBackBinding; provider: FileSourceProvider; onClose: () => void }) {
  const host = useSourceHost(), { t } = useTranslation();
  const modes = writeBackModes(provider);
  const [mode, setMode] = useState<WriteBackMode>(modes.includes('new-version') ? 'new-version' : modes[0] ?? 'new-file');
  const [fileName, setFileName] = useState(`${binding.name.replace(/\.ifc$/i, '')}-edited.ifc`);
  const [folder, setFolder] = useState({ id: '', name: '' });
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveSourceOutcome | null>(null), [error, setError] = useState<string | null>(null);
  /** The running upload; set before the first await, so it also guards against a double submit. */
  const upload = useRef<AbortController | null>(null);
  const ctx = useMemo(() => host.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest)), [host, provider]);
  const current = useViewerStore(() => isSourceBindingCurrent(binding));
  const saved = outcome?.kind === 'saved' ? outcome : null;
  const problem = alertKey(current, outcome);
  // A changed destination needs a fresh confirmation, and the last result no longer applies to it.
  const edited = () => { setConfirmed(false); setOutcome(null); setError(null); };
  const submit = async () => {
    if (upload.current || !confirmed || !current) return;
    const controller = upload.current = new AbortController();
    setBusy(true); setError(null); setOutcome(null);
    try { setOutcome(await saveSourceModel(host, binding, { mode, fileName, containerId: folder.id }, controller.signal)); }
    catch (error) { setError(controller.signal.aborted ? t('sources.writeBack.cancelled') : error instanceof Error ? error.message : String(error)); }
    finally { upload.current = null; setBusy(false); setConfirmed(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !upload.current) onClose(); }}>
    <DialogContent onEscapeKeyDown={event => { if (upload.current) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{t('sources.writeBack.open')}</DialogTitle>
        <DialogDescription>{t('sources.writeBack.description', { name: binding.name, provider: provider.manifest.title })}</DialogDescription>
      </DialogHeader>
      {saved ? <>
        <output className="block">{t('sources.writeBack.saved')}</output>
        {saved.result.revision ? <>
          {!saved.linked && <p role="alert">{t('sources.writeBack.savedUnlinked')}</p>}
          <SourceWriteBackHistory provider={provider} ctx={ctx} projectId={binding.tag.projectId} file={saved.result.file} created={saved.result.revision} />
        </> : <p role="alert">{t('sources.writeBack.savedRevisionUnknown')}</p>}
      </> : <form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-3">
        <fieldset disabled={busy} className="space-y-3">
          <SegmentedControl label={t('sources.writeBack.mode')} value={mode}
            options={modes.map(item => ({ value: item, label: t(MODE_LABELS[item]) }))}
            onValueChange={item => { setMode(item); edited(); }} className="flex-wrap" />
          {mode !== 'new-version' && <label className="block space-y-1"><span>{t('sources.writeBack.name')}</span>
            <Input value={fileName} onChange={event => { setFileName(event.target.value); edited(); }} required />
          </label>}
          {mode === 'new-location' && <>
            <p>{t('sources.writeBack.selectedFolder', { name: folder.name || t('sources.writeBack.noFolder') })}</p>
            <SourceWriteBackFolder provider={provider} ctx={ctx} projectId={binding.tag.projectId} onChoose={container => { setFolder(container); edited(); }} />
          </>}
          <p className="text-sm text-muted-foreground">{t('sources.writeBack.base', { revision: binding.tag.revisionId })}</p>
          <label className="flex items-start gap-2 text-sm"><Checkbox checked={confirmed} onCheckedChange={setConfirmed} />{t('sources.writeBack.confirm')}</label>
        </fieldset>
        {problem && <p role="alert">{t(problem, { reason: outcome?.kind === 'conflict' && outcome.conflict.kind === 'destination-refused' ? outcome.conflict.reason : '' })}</p>}
        {error && <p role="alert">{t('sources.writeBack.failed', { reason: error })}</p>}
        <Button type="submit" disabled={busy || !confirmed || !current || (mode === 'new-location' && !folder.id)}>{t(busy ? 'sources.writeBack.saving' : 'sources.writeBack.save')}</Button>
      </form>}
      <DialogFooter>
        {busy && <Button variant="outline" onClick={() => upload.current?.abort()}>{t('sources.writeBack.cancel')}</Button>}
        <Button variant="outline" disabled={busy} onClick={onClose}>{t('sources.writeBack.close')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
