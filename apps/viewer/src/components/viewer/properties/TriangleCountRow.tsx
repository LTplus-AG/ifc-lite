/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useSceneTriangleCounts } from '@/hooks/useSceneTriangleCounts';
import { modelTriangleCount, modelTrianglesReady } from '@/lib/model-triangle-counts';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { InspectorRow } from './inspector-ui';

/** Model totals count each instanced occurrence; an object row counts only
 * that object's own pieces. Unavailable geometry is distinct from zero. */
export function TriangleCountRow({ modelId, globalId }: { modelId: string; globalId?: number }) {
  const { t, locale } = useTranslation();
  const models = useViewerStore(state => state.models);
  const geometryResult = useViewerStore(state => state.geometryResult);
  useViewerStore(state => state.mutationVersion);
  const counts = useSceneTriangleCounts();
  const state = useViewerStore.getState();
  const ready = modelTrianglesReady({ models, geometryResult }, modelId, counts);
  const count = globalId === undefined ? modelTriangleCount(state, modelId, counts)
    : counts && ready ? counts.get(globalId) ?? 0 : null;
  return <InspectorRow label={t('properties.modelMetadata.triangles')}
    value={count === null ? '—' : formatLocaleNumber(locale, count)} copy={false} />;
}
