/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Apply a previewed scene action set on an explicit user click. The preview is
 * re-run against the live store first (what is applied is what is shown NOW),
 * any earlier application is restored, then the prior view of every channel
 * this set touches is captured BEFORE the first write. Only the channels the
 * set names are touched; everything else stays as the user had it.
 *
 * Writes go through the same native channels every viewer feature uses:
 * selection actions, the shared isolate channel (ownership by value), the
 * hidden set, the colour-override channel, the section slice and the camera
 * callbacks.
 */

import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
import { idsColorsOnScreen } from '@/lib/ids/color-ownership';
import type { EvidenceSnapshot } from '@/lib/assistant/evidence';
import type { EntityRef } from '@/store/types';
import type { SceneActionSet, SceneActionType } from './scene-actions';
import { previewSceneActions, type ActionPreview, type SceneActionPreview } from './scene-preview';
import { captureRecords, captureSelection, setActiveApplication, useSceneSession, type RestoreReport, type SceneApplication } from './scene-session';
import { captureSceneSources } from './scene-source-ownership';
import { restoreSceneApplication } from './scene-restore';

type RGBA = [number, number, number, number];

export interface ApplyResult {
  preview: SceneActionPreview;
  /** Actions that changed the scene, with the element count each one reached. */
  applied: Array<{ type: SceneActionType; count: number }>;
  /** Ready actions that could not run now (the renderer is not mounted). */
  unavailable: SceneActionType[];
  /** The restore of an earlier application this apply replaced, if any. */
  replaced: RestoreReport | null;
}

const presentation = (ids: number[]) =>
  resolvePresentationIds(useViewerStore.getState().cameraCallbacks?.resolveHighlightIds, ids);

/** What the colour channel shows right now: the unflushed signal, else the scene's retained map, else the lens. */
function paintedColours(): Map<number, RGBA> {
  const state = useViewerStore.getState();
  if (state.pendingColorUpdates) return new Map(state.pendingColorUpdates);
  const retained = getGlobalRenderer()?.getScene().getColorOverrides();
  if (retained) return new Map([...retained].map(([id, [r, g, b, a]]): [number, RGBA] => [id, [r, g, b, a]]));
  return new Map(state.lensAppliedColors ?? []);
}

function applySelection(ids: number[], application: SceneApplication): number {
  const state = useViewerStore.getState();
  application.selection = { prior: captureSelection(state), revision: -1 };
  const refs: EntityRef[] = [];
  for (const id of ids) {
    const ref = state.resolveGlobalIdFromModels(id);
    if (ref) refs.push({ modelId: ref.modelId, expressId: ref.expressId });
  }
  // Both channels: the global-id set drives highlight, the refs drive Properties (apps/viewer/AGENTS.md).
  state.clearEntitySelection();
  state.setSelectedEntityIds(ids);
  state.addEntitiesToSelection(refs);
  application.selection.revision = useViewerStore.getState().selectionRevision;
  return ids.length;
}

function applyIsolate(ids: number[], application: SceneApplication): number {
  const state = useViewerStore.getState();
  const installed = new Set(presentation(ids));
  application.isolate = {
    prior: { isolated: state.isolatedEntities, ghost: state.ghostExceptEntities, records: captureRecords(state) },
    claim: { channel: 'isolate', ids: installed },
  };
  // One write; the store's invalidation middleware drops every other owner's now-stale record.
  useViewerStore.setState({ isolatedEntities: installed, ghostExceptEntities: null });
  return ids.length;
}

function applyHide(ids: number[], application: SceneApplication): number {
  const state = useViewerStore.getState();
  // Routed inline (not through `presentation`) so the expansion-routing gate sees this hide's argument.
  const added = resolvePresentationIds(state.cameraCallbacks?.resolveHighlightIds, ids).filter(id => !state.hiddenEntities.has(id));
  // Elements already hidden are left as they are: only what this apply hid is recorded, counted and restored.
  if (!added.length) return 0;
  application.hide = { added };
  state.hideEntities(added);
  return added.length;
}

function applyColour(action: ActionPreview, application: SceneApplication): number {
  const before = useViewerStore.getState();
  const prior = paintedColours();
  const paint = new Map(prior);
  for (const group of action.groups ?? []) {
    const [r, g, b, a] = group.rgba;
    for (const id of presentation(group.ids)) paint.set(id, [r, g, b, a]);
  }
  const idsOwned = idsColorsOnScreen(before);
  before.setPendingColorUpdates(paint);
  application.colour = { prior, revision: useViewerStore.getState().colorPresentationRevision, idsOwned };
  return action.ids.length;
}

function applySection(action: ActionPreview, application: SceneApplication): void {
  const state = useViewerStore.getState();
  const prior = state.sectionPlane;
  const priorVisible = state.sceneState.section.visible;
  if (action.plane) {
    const { normal: n, point: p } = action.plane;
    state.setSectionPlaneFromFace([n.x, n.y, n.z], [p.x, p.y, p.z]);
  } else if (action.box) {
    const { min, max } = action.box;
    state.setSectionBox({ min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] });
    useViewerStore.getState().setSectionVisible(true);
  }
  const after = useViewerStore.getState();
  application.section = { prior, priorVisible, installed: after.sectionPlane, installedVisible: after.sceneState.section.visible };
}

/** Frame or place the camera; false when no renderer is mounted to do it. */
function applyCamera(action: ActionPreview, application: SceneApplication): boolean {
  const callbacks = useViewerStore.getState().cameraCallbacks;
  const prior = callbacks.getViewpoint?.() ?? null;
  if (!prior) return false;
  if (action.action.type === 'frame') {
    if (!callbacks.frameEntities) return false;
    application.camera = { prior };
    callbacks.frameEntities(presentation(action.ids));
    return true;
  }
  if (!action.camera || !callbacks.applyViewpoint) return false;
  application.camera = { prior };
  callbacks.applyViewpoint({ ...prior, position: action.camera.eye, target: action.camera.target, up: { x: 0, y: 1, z: 0 } }, true);
  return true;
}

/**
 * Apply every ready action of `set`. Returns null (and changes nothing) when
 * nothing in the set is ready against the current scene.
 */
export function applySceneActions(set: SceneActionSet, evidence: EvidenceSnapshot | null, title = set.title): ApplyResult | null {
  const preview = previewSceneActions(useViewerStore.getState(), set, evidence);
  if (preview.ready === 0) return null;
  const earlier = useSceneSession.getState().active;
  const replaced = earlier ? restoreSceneApplication(earlier) : null;

  const application: SceneApplication = { id: crypto.randomUUID(), title, sources: captureSceneSources(useViewerStore.getState()) };
  const applied: ApplyResult['applied'] = [];
  const unavailable: SceneActionType[] = [];
  // Visibility before selection and camera: framing reads what is visible.
  const order: SceneActionType[] = ['hide', 'isolate', 'colour', 'select', 'section', 'frame', 'camera'];
  const ready = preview.actions.filter(action => action.status === 'ready')
    .sort((a, b) => order.indexOf(a.action.type) - order.indexOf(b.action.type));
  for (const action of ready) {
    const type = action.action.type;
    if (type === 'select') applied.push({ type, count: applySelection(action.ids, application) });
    else if (type === 'isolate') applied.push({ type, count: applyIsolate(action.ids, application) });
    else if (type === 'hide') { const count = applyHide(action.ids, application); if (count) applied.push({ type, count }); }
    else if (type === 'colour') applied.push({ type, count: applyColour(action, application) });
    else if (type === 'section') { applySection(action, application); applied.push({ type, count: 0 }); }
    else if (applyCamera(action, application)) applied.push({ type, count: action.ids.length });
    else unavailable.push(type);
  }
  // A set whose every ready action was unavailable changed nothing and has nothing to restore;
  // the report of the earlier view it restored first is kept for the restore bar.
  setActiveApplication(applied.length ? application : null, applied.length ? null : replaced);
  return { preview, applied, unavailable, replaced };
}
