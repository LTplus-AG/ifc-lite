/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { bcfViewpointMetadata } from './coordination-bcf-metadata';
import { coordination } from './coordination-common';
interface Ref { topic_id: string; viewpoint_id: string }
function topic(id: string) {
  const state = useViewerStore.getState(), project = state.bcfProject, topic = project?.topics.get(id);
  if (!topic) throw new Error('Unknown local BCF topic.'); return { state, project, topic };
}
const refSchema = { type: 'object' as const, properties: { topic_id: { type: 'string' as const, minLength: 1, maxLength: 200 }, viewpoint_id: { type: 'string' as const, minLength: 1, maxLength: 200 } }, required: ['topic_id', 'viewpoint_id'] as ('topic_id' | 'viewpoint_id')[], additionalProperties: false as const };
export const coordinationViewpointOperations = [
  coordination<{ topic_id: string; snapshot: boolean; selection: boolean; visibility: boolean }>('bcf.captureViewpoint', 'Capture the live native camera, selection, visibility and clipping into a topic. Snapshots use the native GPU readback; missing renderer is an explicit host error.', ['configuration'], {
    type: 'object', properties: { topic_id: { type: 'string', minLength: 1, maxLength: 200 }, snapshot: { type: 'boolean' }, selection: { type: 'boolean' }, visibility: { type: 'boolean' } }, required: ['topic_id', 'snapshot', 'selection', 'visibility'], additionalProperties: false,
  }, async (i, c) => {
    const initial = topic(i.topic_id); const [{ captureNativeBcfViewpoint }, { getGlobalRenderer, getGlobalCanvas }] = await Promise.all([import('@/hooks/bcf/capture-viewpoint'), import('@/hooks/useBCF')]);
    const renderer = getGlobalRenderer(); if (!renderer) throw new Error('A live viewer renderer is required for BCF camera capture.');
    const current = () => {
      const s = useViewerStore.getState(); return s.models === initial.state.models && s.mutationVersion === initial.state.mutationVersion && s.geometryContentVersion === initial.state.geometryContentVersion && s.bcfProject === initial.project && getGlobalRenderer() === renderer;
    };
    c.checkpoint?.(); const viewpoint = await captureNativeBcfViewpoint(renderer, getGlobalCanvas(), { includeSnapshot: i.snapshot, includeSelection: i.selection, includeHidden: i.visibility, isCaptureStillValid: current });
    c.checkpoint?.(); if (!viewpoint || !current()) throw new Error('Scene or BCF project changed during viewpoint capture.');
    return c.commit(() => { useViewerStore.getState().addViewpoint(i.topic_id, viewpoint); return { topic_id: i.topic_id, viewpoint: bcfViewpointMetadata(viewpoint) }; });
  }),
  coordination<Ref & { animate: boolean }>('bcf.applyViewpoint', 'Apply a known BCF viewpoint through the exact native camera/section/selection/visibility transition.', ['view', 'selection'], { type: 'object', properties: { ...refSchema.properties, animate: { type: 'boolean' } }, required: ['topic_id', 'viewpoint_id', 'animate'], additionalProperties: false }, async (i, c) => {
    const [{ applyNativeBcfViewpoint }, { getGlobalRenderer }] = await Promise.all([import('@/hooks/bcf/apply-viewpoint'), import('@/hooks/useBCF')]);
    const { topic: found } = topic(i.topic_id), viewpoint = found.viewpoints.find(viewpoint => viewpoint.guid === i.viewpoint_id);
    if (!viewpoint) throw new Error('Unknown BCF viewpoint.'); const renderer = getGlobalRenderer(); if (!renderer) throw new Error('A live viewer renderer is required to apply a BCF viewpoint.');
    return c.commit(() => { applyNativeBcfViewpoint(viewpoint, renderer, i.animate); useViewerStore.getState().setActiveTopic(i.topic_id); useViewerStore.getState().setActiveViewpoint(viewpoint.guid); return { applied: viewpoint.guid }; });
  }),
  coordination<Ref>('bcf.deleteViewpoint', 'Delete an existing local viewpoint using the native topic deletion contracts.', ['configuration'], refSchema, (i, c) => c.commit(() => {
    const { state, topic: found } = topic(i.topic_id); if (!found.viewpoints.some(viewpoint => viewpoint.guid === i.viewpoint_id)) throw new Error('Unknown BCF viewpoint.');
    state.deleteViewpoint(i.topic_id, i.viewpoint_id); return { deleted: i.viewpoint_id };
  })),
];
