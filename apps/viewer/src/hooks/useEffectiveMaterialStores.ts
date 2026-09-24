/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Parsed model snapshots for the material tree and totals panel (#5249). */

import { useEffect, useMemo, useState } from 'react';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import type { SchemaVersion } from '@/store/types';
import { materializeEffectiveIfcStore } from '@/lib/effective-ifc-store';
import { LEGACY_MUTATION_MODEL_ID } from '@/sdk/adapters/model-compat';

export interface MaterialStoreSource {
  modelId: string;
  store: IfcDataStore;
  schemaVersion: SchemaVersion;
}

interface SnapshotCacheEntry {
  revision: number;
  promise: Promise<IfcDataStore>;
}

// Both material consumers can be mounted together. Share one export/reparse
// for each model and edit revision, rather than doing the expensive work twice.
const snapshots = new WeakMap<IfcDataStore, WeakMap<MutablePropertyView, SnapshotCacheEntry>>();

export async function loadEffectiveMaterialStores(
  sources: readonly MaterialStoreSource[],
  views: ReadonlyMap<string, MutablePropertyView>,
  revision: number,
): Promise<Map<string, IfcDataStore>> {
  const resolved = await Promise.all(sources.map(async ({ modelId, store, schemaVersion }) => {
    const view = views.get(modelId === 'legacy' ? LEGACY_MUTATION_MODEL_ID : modelId);
    if (!view?.hasPendingChanges()) return [modelId, store] as const;
    let byView = snapshots.get(store);
    if (!byView) {
      byView = new WeakMap();
      snapshots.set(store, byView);
    }
    let cached = byView.get(view);
    if (!cached || cached.revision !== revision) {
      // Material usage needs edited relationships,
      // created materials and quantities, so filtering a cached source map
      // after the fact cannot give the full answer.
      cached = { revision, promise: materializeEffectiveIfcStore(store, view, schemaVersion) };
      byView.set(view, cached);
    }
    return [modelId, await cached.promise] as const;
  }));
  return new Map(resolved);
}

export function useEffectiveMaterialStores(
  models: ReadonlyMap<string, FederatedModel>,
  legacyStore: IfcDataStore | null | undefined,
  enabled: boolean,
): { stores: ReadonlyMap<string, IfcDataStore>; ready: boolean } {
  const views = useViewerStore((s) => s.mutationViews);
  const revision = useViewerStore((s) => s.mutationVersion);
  const sources = useMemo((): MaterialStoreSource[] => {
    if (models.size > 0) {
      return [...models].flatMap(([modelId, model]) => model.ifcDataStore
        ? [{ modelId, store: model.ifcDataStore as IfcDataStore, schemaVersion: model.schemaVersion }]
        : []);
    }
    return legacyStore
      ? [{ modelId: 'legacy', store: legacyStore, schemaVersion: legacyStore.schemaVersion as SchemaVersion }]
      : [];
  }, [models, legacyStore]);
  const sourceStores = useMemo(() => new Map(sources.map(({ modelId, store }) => [modelId, store])), [sources]);
  const hasPending = enabled && sources.some(({ modelId }) =>
    views.get(modelId === 'legacy' ? LEGACY_MUTATION_MODEL_ID : modelId)?.hasPendingChanges());
  const token = useMemo(() => ({ sources, views, revision }), [sources, views, revision]);
  const [resolved, setResolved] = useState<{
    token: typeof token;
    stores?: Map<string, IfcDataStore>;
    error?: unknown;
  }>();

  useEffect(() => {
    if (!hasPending) return;
    let active = true;
    void loadEffectiveMaterialStores(sources, views, revision).then(
      (stores) => { if (active) setResolved({ token, stores }); },
      (error: unknown) => { if (active) setResolved({ token, error }); },
    );
    return () => { active = false; };
  }, [hasPending, token, sources, views, revision]);

  if (!hasPending) return { stores: sourceStores, ready: true };
  if (resolved?.token !== token) return { stores: new Map(), ready: false };
  if (resolved.error) throw resolved.error;
  return { stores: resolved.stores ?? new Map(), ready: true };
}
