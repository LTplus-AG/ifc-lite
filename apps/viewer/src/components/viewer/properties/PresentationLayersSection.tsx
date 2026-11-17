/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore, type EntityRef } from '@/store';
import { presentationLayerOwner } from './presentationLayerOwner';
import { useProductPresentationLayers, type PresentationLayerLoader } from './useProductPresentationLayers';
import { liftStartFold } from '../welcome/useEmptyStartFold';

/** Current model-local layer membership, including authored edits (#9273). */
export function PresentationLayersSection({ entityRef, loadLookup }: { entityRef: EntityRef; loadLookup?: PresentationLayerLoader }) {
  const { t } = useTranslation();
  const models = useViewerStore(s => s.models);
  const legacyStore = useViewerStore(s => s.ifcDataStore);
  const views = useViewerStore(s => s.mutationViews);
  const version = useViewerStore(s => s.mutationVersion);
  const { store, modelId } = presentationLayerOwner(entityRef, models, legacyStore);
  const view = modelId === 'legacy' ? views.get('__legacy__') ?? views.get('legacy') : views.get(modelId);
  const { layers, error, retry } = useProductPresentationLayers(store, view, entityRef.expressId, version, loadLookup);
  if (!error && !layers?.length) return null;
  return <section aria-label={t('properties.panel.presentationLayersHeading')} className="border-b border-border px-3 py-1 text-xs">
    <div className="text-muted-foreground">{t('properties.panel.presentationLayersHeading')}</div>
    {error && <div role="alert" className="py-1">
      {t('properties.panel.presentationLayersLoadError')}{' '}
      <Button type="button" variant="link" size="sm" className="h-auto p-0 font-normal underline" onClick={retry}>{t('properties.panel.presentationLayersRetry')}</Button>
    </div>}
    {layers?.map(layer => <Button key={layer.expressId} type="button" variant="ghost" size="sm"
      className="h-auto w-full justify-start px-0 py-1 text-left font-normal text-primary hover:bg-muted/50 hover:text-primary"
      onClick={() => {
        const state = useViewerStore.getState();
        state.setHierarchyMode('presentation-layers');
        state.setPanelShownInSidebar('hierarchy', true);
        state.setSidebarActivePanel('hierarchy');
        liftStartFold('left');
        state.setLeftPanelCollapsed(false);
        useViewerStore.setState({ pendingPresentationLayerReveal: {
          nodeId: `presentation-layer-${modelId}-${layer.expressId}`, modelId, selectionRevision: state.selectionRevision,
        } });
      }}>
      {layer.Name}{layer.Identifier ? ` (${layer.Identifier})` : ''}
    </Button>)}
  </section>;
}
