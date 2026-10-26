/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  createViewpoint, fillMissingSnapshots, perspectiveToCamera, orthogonalToCamera,
  type BCFProject, type BCFViewpoint, type EntityBoundsInput, type IDSReportInput,
} from '@ifc-lite/bcf';
import { isSpatialStructureTypeName } from '@ifc-lite/data';
import type { Renderer } from '@ifc-lite/renderer';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
import { captureViewportFrame } from '@/lib/viewport-capture';
import { resolveGlobalId } from '@/store/resolveEntityRef';
import type { IDSExportProgress } from '@/components/viewer/IDSExportDialog';

const FALLBACK_NOTICE = 'Complete bounds for the reported entities were unavailable; this viewpoint uses the current viewer camera.';

/** Viewer-only camera fallback and one screenshot per exported topic (#7974). */
export async function completeIdsBcfViewpoints(
  project: BCFProject,
  report: Pick<IDSReportInput, 'specificationResults'>,
  bounds: ReadonlyMap<string, EntityBoundsInput> | undefined,
  renderer: Renderer | null | undefined,
  toViewerGlobalId: (modelId: string, expressId: number) => number | undefined,
  resolveHighlightIds: ((ids: number[]) => number[]) | undefined,
  settings: { includeCamera: boolean; snapshots: 'required' | 'best-effort' | 'off' },
  progress: (value: IDSExportProgress) => void,
): Promise<void> {
  if (settings.snapshots === 'required' && !renderer) {
    throw new Error('Cannot capture IDS BCF snapshots: open the model in the 3D viewer and retry.');
  }
  const entitiesByGuid = new Map<string, { id: number | undefined; bounds: EntityBoundsInput | undefined; spatial: boolean }[]>();
  const seenEntities = new Set<string>();
  for (const spec of report.specificationResults) {
    for (const entity of spec.entityResults) {
      const key = `${entity.modelId}:${entity.expressId}`;
      if (!entity.globalId || seenEntities.has(key)) continue;
      seenEntities.add(key);
      const entries = entitiesByGuid.get(entity.globalId) ?? [];
      entries.push({ id: toViewerGlobalId(entity.modelId, entity.expressId), bounds: bounds?.get(key), spatial: isSpatialStructureTypeName(entity.entityType) });
      entitiesByGuid.set(entity.globalId, entries);
    }
  }

  let current = 0;
  for (const topic of project.topics.values()) {
    let viewpoint = topic.viewpoints[0];
    const entries = (viewpoint?.components?.selection ?? []).flatMap(component =>
      component.ifcGuid ? entitiesByGuid.get(component.ifcGuid) ?? [] : []);
    const knownBounds = entries.flatMap(entry => entry.bounds ? [entry.bounds] : []);
    const rawIds = entries.flatMap(entry => entry.id == null ? [] : [entry.id]);
    const spatialContext = entries.some(entry => entry.spatial && !entry.bounds);
    const expansionIds = entries.flatMap(entry => entry.id == null || entry.spatial ? [] : [entry.id]);
    const ids = new Set([...rawIds, ...resolvePresentationIds(resolveHighlightIds, expansionIds)]);
    if (spatialContext && viewpoint) {
      viewpoint.components ??= {};
      viewpoint.components.visibility = { defaultVisibility: true };
      topic.description = [topic.description, 'The spatial container has no direct geometry; model context remains visible.'].filter(Boolean).join('\n\n');
    }
    // BCF consumers apply explicit component visibility; they need descendant
    // GUIDs as well as the assembly's own GUID, just as our renderer needs IDs.
    const rawIdSet = new Set(rawIds);
    const expandedGuids: string[] = [];
    let unresolvedDescendant = false;
    for (const id of ids) {
      if (rawIdSet.has(id)) continue;
      const guid = resolveGlobalId(id);
      if (guid) expandedGuids.push(guid);
      else unresolvedDescendant = true;
    }
    if (viewpoint?.components && expandedGuids.length > 0) {
      const visibility = viewpoint.components.visibility;
      if (visibility && !visibility.defaultVisibility) {
        const guids = new Set([...(visibility.exceptions ?? []).map(component => component.ifcGuid), ...expandedGuids]);
        visibility.exceptions = [...guids].filter((guid): guid is string => !!guid).map(ifcGuid => ({ ifcGuid }));
      }
      for (const group of viewpoint.components.coloring ?? []) {
        const guids = new Set([...group.components.map(component => component.ifcGuid), ...expandedGuids]);
        group.components = [...guids].filter((guid): guid is string => !!guid).map(ifcGuid => ({ ifcGuid }));
      }
    }
    if (unresolvedDescendant && viewpoint?.components) {
      viewpoint.components.visibility = { defaultVisibility: true };
      topic.description = [topic.description, 'Some related geometry has no resolvable IFC GlobalId; model context remains visible.'].filter(Boolean).join('\n\n');
    }
    const missingCamera = !viewpoint?.perspectiveCamera && !viewpoint?.orthogonalCamera;
    if (settings.includeCamera && missingCamera) {
      if (!renderer) throw new Error('Cannot export IDS BCF cameras: open the model in the 3D viewer and retry. Complete entity bounds and a live renderer are unavailable.');
      const captured = createViewpoint({ camera: readCamera(renderer) });
      if (!viewpoint) { viewpoint = captured; topic.viewpoints.push(viewpoint); }
      else {
        viewpoint.perspectiveCamera = captured.perspectiveCamera;
        viewpoint.orthogonalCamera = captured.orthogonalCamera;
      }
      topic.description = [topic.description, FALLBACK_NOTICE].filter(Boolean).join('\n\n');
      // A geometry-less selection cannot be isolated into a useful view.
      if (knownBounds.length === 0) {
        viewpoint.components ??= {};
        viewpoint.components.visibility = { defaultVisibility: true };
      }
    }

    if (settings.snapshots !== 'off' && renderer) {
      progress({ phase: 'snapshots', current: ++current, total: project.topics.size,
        message: `Capturing snapshot ${current}/${project.topics.size}...` });
      // Camera-disabled exports may still frame their screenshot without persisting a camera.
      const snapshotViewpoint = viewpoint ?? { guid: '' };
      const snapshot = await captureTopic(renderer, snapshotViewpoint, ids,
        knownBounds.length > 0 && !viewpoint?.components?.visibility?.defaultVisibility);
      if (!snapshot && settings.snapshots === 'required') throw new Error(`Could not capture the IDS BCF snapshot for "${topic.title}". Keep the model open in the 3D viewer and retry.`);
      // A best-effort miss keeps the placeholder that fillMissingSnapshots supplies.
      if (snapshot) {
        if (!viewpoint) { viewpoint = { guid: createViewpoint({ camera: readCamera(renderer) }).guid }; topic.viewpoints.push(viewpoint); }
        viewpoint.snapshot = snapshot;
        delete viewpoint.snapshotData; // the reporter's placeholder would otherwise win in writeBCF
      }
    }
    if (!settings.includeCamera && viewpoint) {
      delete viewpoint.perspectiveCamera;
      delete viewpoint.orthogonalCamera;
    }
  }
  // Fallback viewpoints created above have no image yet (#7974).
  fillMissingSnapshots(project);
}

function readCamera(renderer: Renderer) {
  const camera = renderer.getCamera();
  return { position: { ...camera.getPosition() }, target: { ...camera.getTarget() }, up: { ...camera.getUp() },
    fov: camera.getFOV(), aspectRatio: camera.getAspect(), isOrthographic: camera.getProjectionMode() === 'orthographic', orthoScale: camera.getOrthoSize() * 2 };
}

function captureTopic(renderer: Renderer, viewpoint: BCFViewpoint, ids: Set<number>, isolate: boolean): Promise<string | null> {
  const camera = renderer.getCamera();
  return captureViewportFrame(renderer, {
    options: { hiddenIds: undefined, isolatedIds: isolate ? ids : null, ghostExceptIds: null,
      selectedId: null, selectedIds: undefined, selectedModelIndex: undefined, hoverOutline: null,
      sectionPlane: undefined, extraSectionPlanes: undefined, clipBox: undefined, terrainClipY: undefined,
      emphasizeOverrides: false, clearColor: [0.102, 0.106, 0.149, 1] },
    prepare: () => {
      const target = viewpoint.perspectiveCamera ? perspectiveToCamera(viewpoint.perspectiveCamera, camera.getDistance())
        : viewpoint.orthogonalCamera ? orthogonalToCamera(viewpoint.orthogonalCamera, camera.getDistance()) : undefined;
      if (!target) return;
      const before = readCamera(renderer);
      const apply = (state: ReturnType<typeof readCamera>) => {
        camera.setProjectionMode(state.isOrthographic ? 'orthographic' : 'perspective');
        camera.setFOV(state.fov);
        if (state.orthoScale !== undefined) camera.setOrthoSize(state.orthoScale / 2);
        void camera.animateToWithUp(state.position, state.target, state.up, 0);
      };
      apply({ ...before, ...target });
      const captured = JSON.stringify(readCamera(renderer));
      return () => { if (JSON.stringify(readCamera(renderer)) === captured) apply(before); };
    },
    read: canvas => canvas.toDataURL('image/png'),
  });
}
