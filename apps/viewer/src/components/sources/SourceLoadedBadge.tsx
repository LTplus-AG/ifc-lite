/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';

/** Only actual viewer models count: download completion alone is not proof
 * that a model parsed and loaded. File badges also match the selected revision. */
export function SourceLoadedBadge({ providerId, projectId, fileId, revisionId }: {
  providerId: string; projectId?: string; fileId?: string; revisionId?: string;
}) {
  const { t } = useTranslation();
  const count = useViewerStore((state) => {
    let loaded = 0;
    for (const [modelId, tag] of state.sourceTags) {
      if (state.models.has(modelId) && tag.provider === providerId
        && (projectId === undefined || tag.projectId === projectId)
        && (fileId === undefined || tag.fileId === fileId)
        && (revisionId === undefined || tag.revisionId === revisionId)) loaded++;
    }
    return loaded;
  });
  return count === 0 ? null : <output className="block text-xs text-emerald-700 dark:text-emerald-300">{t('sources.workspace.loadedModels', { count })}</output>;
}
