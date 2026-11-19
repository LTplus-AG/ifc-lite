/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { CloudUpload } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useViewerStore } from '@/store';
import { useOptionalSourceHost } from '@/services/sources/SourceHostProvider';
import { openSourceWriteBack } from '@/services/sources/source-writeback-command';
import { useTranslation } from '@/i18n';
import '@/i18n/catalogues/source-writeback.en';

export function SourceWriteBackAction({ modelId }: { modelId: string }) {
  const host = useOptionalSourceHost();
  const tag = useViewerStore(state => state.sourceTags.get(modelId));
  const model = useViewerStore(state => state.models.get(modelId));
  const { t } = useTranslation();
  const provider = tag && host?.get(tag.provider);
  if (!model?.ifcDataStore || !tag?.revisionId || !provider?.uploadFile ||
      !provider.manifest.capabilities.writeBack?.length || !/\.ifc$/i.test(model.sourceFile?.name ?? model.name)) return null;
  return <IconButton size="icon-xs" className="size-6"
    tooltip={t('sources.writeBack.open')} label={t('sources.writeBack.openModel', { name: model.name })}
    onClick={event => { event.stopPropagation(); openSourceWriteBack(modelId); }}>
    <CloudUpload aria-hidden />
  </IconButton>;
}

/** Also keeps the action reachable in single-model hierarchy mode. */
export function SourceWriteBackModels() {
  const host = useOptionalSourceHost();
  const models = useViewerStore(state => state.models);
  const tags = useViewerStore(state => state.sourceTags);
  const { t } = useTranslation();
  const writable = [...models.values()].filter(model => {
    const tag = tags.get(model.id), provider = tag && host?.get(tag.provider);
    return model.ifcDataStore && tag?.revisionId && provider?.uploadFile &&
      provider.manifest.capabilities.writeBack?.length && /\.ifc$/i.test(model.sourceFile?.name ?? model.name);
  });
  if (!writable.length) return null;
  return <section className="space-y-1 border-b p-2" aria-label={t('sources.writeBack.loadedModels')}>
    <p className="text-xs text-muted-foreground">{t('sources.writeBack.loadedModels')}</p>
    {writable.map(model => <div key={model.id} className="flex items-center justify-between gap-2 text-xs">
      <span className="truncate">{model.name}</span><SourceWriteBackAction modelId={model.id} />
    </div>)}
  </section>;
}
