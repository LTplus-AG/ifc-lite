/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { downloadBlob, buildExportFilename } from '@/lib/export/download';
import { positionedExportSnapshot, hasUnappliedPositionedMove } from '@/lib/export/positioned/frame';

/** The same export action in model rows and the placement panel. */
export function PositionedDownload({ modelId }: { modelId: string }) {
  const { t } = useTranslation();
  const model = useViewerStore(state => state.models.get(modelId));
  const preview = useViewerStore(state => hasUnappliedPositionedMove(state, modelId));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(0);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [modelId, model?.sourceFile]);
  if (!model || (!model.gaussianSplat && model.pointCloudHandleId === undefined)) return null;
  const unavailable = !model.sourceFile || (model.loadState !== undefined && model.loadState !== 'complete') || preview;
  const start = async () => {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true); setError(''); setDone(false); setCount(0);
    try {
      const snapshot = positionedExportSnapshot(useViewerStore.getState(), modelId);
      const { exportPositionedFile } = await import('@/lib/export/positioned/export');
      const blob = await exportPositionedFile(snapshot, abort.signal, setCount);
      abort.signal.throwIfAborted();
      const current = useViewerStore.getState().models.get(modelId);
      if (current?.sourceFile !== snapshot.file) throw new Error('The source was removed or replaced. Export cancelled.');
      downloadBlob(blob, buildExportFilename(`${snapshot.name.replace(/\.[^.]+$/, '')}-positioned`, '.ply'));
      setDone(true);
    } catch (err) {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally { controller.current = null; setBusy(false); }
  };
  return <span role="presentation" className="contents" onClick={event => event.stopPropagation()}>
    <button type="button" className="p-[5px]" aria-label={t('positionedDownload.open')} title={t('positionedDownload.open')}
      onClick={event => { event.stopPropagation(); setOpen(true); }}><Download className="h-3.5 w-3.5" /></button>
    <Dialog open={open} onOpenChange={value => { if (!value) controller.current?.abort(); setOpen(value); }}>
      <DialogContent onClick={event => event.stopPropagation()}>
        <DialogHeader><DialogTitle>{t('positionedDownload.open')}</DialogTitle>
          <DialogDescription>{t('positionedDownload.description')}</DialogDescription></DialogHeader>
        <p className="text-sm">{model.name}</p>
        <p className="text-sm">{t(model.gaussianSplat ? 'positionedDownload.gaussian' : 'positionedDownload.scan')}</p>
        <p className="text-sm">{t('positionedDownload.limit')}</p>
        {unavailable && <output>{t('positionedDownload.unavailable')}</output>}
        {busy && <output>{t('positionedDownload.progress', { count })}</output>}
        {done && <output>{t('positionedDownload.done')}</output>}
        {error && <p role="alert">{error}</p>}
        <div className="flex gap-2">
          <Button disabled={busy || unavailable} onClick={() => void start()}>{t('positionedDownload.save')}</Button>
          {busy && <Button variant="outline" onClick={() => controller.current?.abort()}>{t('positionedDownload.cancel')}</Button>}
        </div>
      </DialogContent>
    </Dialog>
  </span>;
}
