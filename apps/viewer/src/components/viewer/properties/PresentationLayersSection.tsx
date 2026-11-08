/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { useViewerStore, type EntityRef } from '@/store';
import { presentationLayersByProduct } from '@/lib/presentation-layers';
import { liftStartFold } from '../welcome/useEmptyStartFold';

/** Current model-local layer membership, including authored edits (#9273). */
export function PresentationLayersSection({ entityRef }: { entityRef: EntityRef }) {
  const { t } = useTranslation();
  const models = useViewerStore(s => s.models);
  const legacyStore = useViewerStore(s => s.ifcDataStore);
  const views = useViewerStore(s => s.mutationViews);
  useViewerStore(s => s.mutationVersion);
  // Match PropertiesPanel: only the selection sentinel 'legacy' bypasses models.
  const model = entityRef.modelId === 'legacy' ? undefined : models.get(entityRef.modelId);
  const store = model?.ifcDataStore ?? legacyStore;
  const view = views.get(entityRef.modelId === 'legacy' ? '__legacy__' : entityRef.modelId);
  const layers = store ? presentationLayersByProduct(store, view).get(entityRef.expressId) : undefined;
  if (!layers?.length) return null;
  return <section aria-label={t('hierarchy.panel.grouping.presentationLayersTooltip')} className="border-b border-border px-3 py-1 text-xs">
    <div className="text-muted-foreground">{t('hierarchy.panel.grouping.presentationLayersTooltip')}</div>
    {layers.map(layer => <button key={layer.expressId} type="button" className="block w-full py-1 text-left text-primary hover:bg-muted/50"
      onClick={() => {
        const state = useViewerStore.getState();
        state.setHierarchyMode('presentation-layers');
        state.setPanelShownInSidebar('hierarchy', true);
        state.setSidebarActivePanel('hierarchy');
        liftStartFold('left');
        state.setLeftPanelCollapsed(false);
        useViewerStore.setState({ pendingPresentationLayerReveal: {
          nodeId: `presentation-layer-${entityRef.modelId}-${layer.expressId}`,
        } });
      }}>
      {layer.Name}{layer.Identifier ? ` (${layer.Identifier})` : ''}
    </button>)}
  </section>;
}
