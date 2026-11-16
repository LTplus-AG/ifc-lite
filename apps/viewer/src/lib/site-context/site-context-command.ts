/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The command palette's "Load site context": open the model metadata panel
 * of the model the context would be fetched around, where the Georeference
 * panel holds the "Site context" section. It never fetches by itself (the
 * section's button does, owner's decision). A model that cannot host site
 * context is refused with the reason, and when it is not georeferenced the
 * refusal's action opens the existing georeference editor instead.
 */

import { resolve as t } from '@/i18n/registry';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { findReferenceSpatialModel } from '@/hooks/ingest/federationAlign';
import { resolveSiteContextAnchor } from './site-context-anchor';

/** The model to fetch around: the selected model, else the federation anchor, else the first non-context model. */
export function siteContextTargetModel(): string | null {
  const state = useViewerStore.getState();
  const isHost = (id: string) => state.models.has(id) && !state.siteContextModels.has(id);
  if (state.selectedModelId && isHost(state.selectedModelId)) return state.selectedModelId;
  const anchor = findReferenceSpatialModel()?.modelId;
  if (anchor && isHost(anchor)) return anchor;
  return [...state.models.keys()].find(isHost) ?? null;
}

function openModelPanel(modelId: string): void {
  const state = useViewerStore.getState();
  state.setSelectedModelId(modelId);
  state.setRightPanelCollapsed(false);
}

export async function openSiteContext(): Promise<void> {
  const modelId = siteContextTargetModel();
  if (!modelId) {
    toast.info(t('siteContext.refusal.notGeoreferenced'));
    return;
  }
  const anchor = await resolveSiteContextAnchor(modelId);
  if (anchor.ok) {
    openModelPanel(modelId);
    return;
  }
  switch (anchor.reason) {
    case 'stale': return;
    case 'not-georeferenced':
      toast.info(t('siteContext.refusal.notGeoreferenced'), { label: t('siteContext.refusal.openEditor'), onClick: () => openModelPanel(modelId) });
      return;
    case 'unknown-crs':
      toast.info(t('siteContext.refusal.unknownCrs', { crs: anchor.detail ?? '' }), { label: t('siteContext.refusal.openEditor'), onClick: () => openModelPanel(modelId) });
      return;
    case 'height-datum':
      toast.info(t('siteContext.refusal.heightDatum', { datum: anchor.detail ?? '' }));
      return;
    case 'height-unknown':
      toast.info(t('siteContext.refusal.heightUnknown'));
      return;
    case 'outside-switzerland':
      toast.info(t('siteContext.refusal.outsideSwitzerland'));
  }
}
