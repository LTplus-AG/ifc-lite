/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "Site context" and "Surface runoff" commands (palette and ribbon): open
 * the Information panel on the model the context would be fetched around and
 * bring the matching section of its Georeference panel into view. Neither
 * fetches nor runs anything by itself (the section's button does, owner's
 * decision). The section says what is missing when the model cannot host
 * site context yet (no georeferencing, a CRS that does not resolve, a height
 * datum, a site outside Switzerland) and offers the step that fixes it, so
 * the command never answers with a toast the user cannot act on (#10603).
 */

import { resolve as t } from '@/i18n/registry';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { findReferenceSpatialModel } from '@/hooks/ingest/federationAlign';
import { closeActiveAnalysisExtension } from '@/services/analysis-extensions';
import { liftStartFold } from '@/components/viewer/welcome/useEmptyStartFold';
import type { PanelOpenSource } from '@/lib/analytics-ui-events';
import { requestGeorefSectionFocus, type GeorefSection } from './georef-section-focus';

/** The model to fetch around: the selected model, else the federation anchor, else the first non-context model. */
export function siteContextTargetModel(): string | null {
  const state = useViewerStore.getState();
  const isHost = (id: string) => state.models.has(id) && !state.siteContextModels.has(id);
  if (state.selectedModelId && isHost(state.selectedModelId)) return state.selectedModelId;
  const anchor = findReferenceSpatialModel()?.modelId;
  if (anchor && isHost(anchor)) return anchor;
  return [...state.models.keys()].find(isHost) ?? null;
}

/**
 * Show `modelId`'s Information panel and scroll `section` of its Georeference
 * panel into view. `showWorkspacePanel` is what puts Information into the
 * sidebar slot (un-collapsing the right panel alone does nothing on desktop).
 */
export function openGeorefSection(modelId: string, section: GeorefSection, surface: PanelOpenSource = 'programmatic'): void {
  const state = useViewerStore.getState();
  closeActiveAnalysisExtension();
  liftStartFold('right');
  state.setSelectedModelId(modelId);
  state.setRightPanelCollapsed(false);
  state.showWorkspacePanel('properties', surface);
  requestGeorefSectionFocus(modelId, section);
}

function openFor(section: GeorefSection, surface: PanelOpenSource): void {
  const modelId = siteContextTargetModel();
  if (!modelId) {
    toast.info(t('siteContext.command.noModel'));
    return;
  }
  openGeorefSection(modelId, section, surface);
}

export function openSiteContext(surface: PanelOpenSource = 'programmatic'): void {
  openFor('siteContext', surface);
}

export function openFloodCheck(surface: PanelOpenSource = 'programmatic'): void {
  openFor('floodCheck', surface);
}
