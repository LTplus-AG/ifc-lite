/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useMemo, useState } from 'react';
import type { SourceFile } from '@ifc-lite/plugin-api';
import { useIfc } from '@/hooks/useIfc';
import { toast } from '@/components/ui/toast';
import { syncSourceModel } from '@/lib/sources/syncSourceModel';
import { useSourceHost } from '@/services/sources/SourceHostProvider';
import { useViewerStore } from '@/store';

interface UseLoadedSourceModelsOptions {
  /** Manifest name of the provider being browsed. */
  providerName: string;
  /** Project being browsed, or `null` before one is chosen. */
  projectId: string | null;
  /** Called after a successful re-sync so download records can be refreshed. */
  onSynced: () => void;
}

/**
 * Bridges the browser's file listing to the models already loaded in the
 * viewer: which listed files are open (and under what model names), and
 * re-syncing those models against the source's latest revision.
 *
 * Keeping this out of `SourceBrowser` is what lets the browser stay a pure
 * listing UI — the viewer store, the model registry and the source host are
 * reached only from here.
 */
export function useLoadedSourceModels({ providerName, projectId, onSynced }: UseLoadedSourceModelsOptions) {
  const sourceHost = useSourceHost();
  const { models, addModel, removeModel } = useIfc();
  const sourceTags = useViewerStore((s) => s.sourceTags);
  const [syncingFileIds, setSyncingFileIds] = useState<Set<string>>(new Set());

  const loadedModelIdsByFileId = useMemo(() => {
    const next = new Map<string, string[]>();
    if (!projectId) return next;

    for (const [modelId, tag] of sourceTags) {
      if (tag.provider !== providerName || tag.projectId !== projectId) {
        continue;
      }
      const current = next.get(tag.fileId);
      if (current) {
        current.push(modelId);
      } else {
        next.set(tag.fileId, [modelId]);
      }
    }

    return next;
  }, [projectId, providerName, sourceTags]);

  const loadedModelNamesByFileId = useMemo(() => {
    const next = new Map<string, string[]>();
    for (const [fileId, modelIds] of loadedModelIdsByFileId) {
      next.set(
        fileId,
        modelIds.map((modelId) => models.get(modelId)?.name).filter((name): name is string => Boolean(name)),
      );
    }
    return next;
  }, [loadedModelIdsByFileId, models]);

  const syncLoadedFile = useCallback(async (file: SourceFile) => {
    const loadedModelIds = loadedModelIdsByFileId.get(file.id);
    if (!loadedModelIds || loadedModelIds.length === 0) return;

    setSyncingFileIds((previous) => new Set(previous).add(file.id));
    try {
      let synced = 0;
      let lastLatestFileName: string | undefined;
      let lastProviderTitle: string | undefined;
      for (const modelId of loadedModelIds) {
        const tag = sourceTags.get(modelId);
        if (!tag) continue;

        const { latestFile } = await syncSourceModel({
          modelId,
          tag,
          sourceHost,
          addModel,
          removeModel,
        });
        synced += 1;
        lastLatestFileName = latestFile.name;
        lastProviderTitle = sourceHost.get(tag.provider)?.manifest.title ?? tag.provider;
      }
      onSynced();
      if (synced > 0 && lastLatestFileName && lastProviderTitle) {
        toast.success(
          synced === 1
            ? `Synced ${lastLatestFileName} from ${lastProviderTitle}`
            : `Synced ${synced} models from ${lastProviderTitle}`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to sync source model');
    } finally {
      setSyncingFileIds((previous) => {
        const next = new Set(previous);
        next.delete(file.id);
        return next;
      });
    }
  }, [
    addModel,
    loadedModelIdsByFileId,
    onSynced,
    removeModel,
    sourceHost,
    sourceTags,
  ]);

  return { loadedModelNamesByFileId, syncingFileIds, syncLoadedFile };
}
