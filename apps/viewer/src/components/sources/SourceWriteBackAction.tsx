/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { CloudUpload } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useViewerStore } from '@/store';
import { useOptionalSourceHost } from '@/services/sources/SourceHostProvider';
import { useShallow } from 'zustand/react/shallow';
import { canWriteBackModel } from '@/services/sources/model-writeback-binding';
import { openSourceWriteBack } from '@/services/sources/source-writeback-command';
import { useTranslation } from '@/i18n';

export function SourceWriteBackAction({ modelId }: { modelId: string }) {
  const host = useOptionalSourceHost();
  const writable = useViewerStore(() => canWriteBackModel(host, modelId));
  const name = useViewerStore(state => state.models.get(modelId)?.name ?? '');
  const { t } = useTranslation();
  if (!writable) return null;
  return <IconButton size="icon-xs" className="size-6"
    tooltip={t('sources.writeBack.open')} label={t('sources.writeBack.openModel', { name })}
    onClick={event => { event.stopPropagation(); openSourceWriteBack(modelId); }}>
    <CloudUpload aria-hidden />
  </IconButton>;
}

/** Also keeps the action reachable in single-model hierarchy mode. */
export function SourceWriteBackModels() {
  const host = useOptionalSourceHost();
  // Flat string arrays, so useShallow sees an unchanged list as equal.
  const writable = useViewerStore(useShallow(state => [...state.models.keys()].filter(id => canWriteBackModel(host, id))));
  const names = useViewerStore(useShallow(state => writable.map(id => state.models.get(id)?.name ?? '')));
  const { t } = useTranslation();
  if (!writable.length) return null;
  return <section className="space-y-1 border-b p-2" aria-label={t('sources.writeBack.loadedModels')}>
    <p className="text-xs text-muted-foreground">{t('sources.writeBack.loadedModels')}</p>
    {writable.map((id, index) => <div key={id} className="flex items-center justify-between gap-2 text-xs">
      <span className="truncate">{names[index]}</span><SourceWriteBackAction modelId={id} />
    </div>)}
  </section>;
}
