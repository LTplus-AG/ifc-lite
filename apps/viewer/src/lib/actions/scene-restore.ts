/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Restore previous view": put back what a scene-action application captured,
 * channel by channel, and ONLY where the application is still verifiably what
 * the user sees (see the ownership notes in `scene-session.ts`). A channel the
 * user — or another feature — changed since is left exactly as it is now and
 * reported as `changed`, so the card can say what could not be restored.
 */

import { useViewerStore } from '@/store';
import { ownsCurrentVisibility } from '@/lib/visibility/ownership';
import { setActiveApplication, type RestoreChannel, type RestoreOutcome, type RestoreReport, type SceneApplication } from './scene-session';

export function restoreSceneApplication(application: SceneApplication): RestoreReport {
  const channels: RestoreReport['channels'] = [];
  const report = (channel: RestoreChannel, outcome: RestoreOutcome) => channels.push({ channel, outcome });
  const touched = (['selection', 'isolate', 'hide', 'colour', 'section', 'camera'] as const).filter(channel => application[channel]);

  const models = [...useViewerStore.getState().models.keys()];
  if (models.length !== application.modelIds.length || models.some(id => !application.modelIds.includes(id))) {
    // Captured ids name models that are gone (or a different federation); applying them would be wrong, not stale.
    for (const channel of touched) report(channel, 'models-changed');
    const result = { title: application.title, channels };
    setActiveApplication(null, result);
    return result;
  }

  const { selection, isolate, hide, colour, section, camera } = application;
  if (selection) {
    const state = useViewerStore.getState();
    if (state.selectionRevision === selection.revision) {
      const prior = selection.prior;
      useViewerStore.setState({
        selectedEntityId: prior.selectedEntityId, selectedEntityIds: new Set(prior.selectedEntityIds), selectedEntity: prior.selectedEntity,
        selectedEntitiesSet: new Set(prior.selectedEntitiesSet), selectedEntities: [...prior.selectedEntities], selectedModelId: prior.selectedModelId,
        selectionRevision: state.selectionRevision + 1,
      });
      report('selection', 'restored');
    } else report('selection', 'changed');
  }

  if (isolate) {
    const state = useViewerStore.getState();
    if (isolate.claim && ownsCurrentVisibility(state, isolate.claim)) {
      // The ghost channel was cleared by the isolate; put the prior ghost back only if nobody set one since.
      const ghost = state.ghostExceptEntities === null ? isolate.prior.ghost : state.ghostExceptEntities;
      // Records ride the same patch, so the invalidation middleware leaves them exactly as captured.
      useViewerStore.setState({ isolatedEntities: isolate.prior.isolated, ghostExceptEntities: ghost, ...isolate.prior.records });
      report('isolate', 'restored');
    } else report('isolate', 'changed');
  }

  if (hide) {
    const state = useViewerStore.getState();
    const lensHidden = new Set(state.lensAppliedHiddenIds);
    const stillHidden = hide.added.filter(id => state.hiddenEntities.has(id) && !lensHidden.has(id));
    if (stillHidden.length) state.showEntities(stillHidden);
    // An id the user revealed meanwhile already shows; that is the restored state, not a conflict.
    report('hide', 'restored');
  }

  if (colour) {
    const state = useViewerStore.getState();
    if (state.colorPresentationRevision === colour.revision) {
      state.setPendingColorUpdates(colour.prior);
      // Validation colours that were on screen are on screen again: hand IDS its claim back.
      if (colour.idsOwned) state.setIdsColorRevision(useViewerStore.getState().colorPresentationRevision);
      report('colour', 'restored');
    } else report('colour', 'changed');
  }

  if (section) {
    const state = useViewerStore.getState();
    if (state.sectionPlane === section.installed && state.sceneState.section.visible === section.installedVisible) {
      useViewerStore.setState({ sectionPlane: section.prior, sceneState: { ...state.sceneState, section: { visible: section.priorVisible } } });
      report('section', 'restored');
    } else report('section', 'changed');
  }

  if (camera) {
    const apply = useViewerStore.getState().cameraCallbacks.applyViewpoint;
    if (apply) { apply(camera.prior, true); report('camera', 'restored'); }
    else report('camera', 'unavailable');
  }

  const result = { title: application.title, channels };
  setActiveApplication(null, result);
  return result;
}
