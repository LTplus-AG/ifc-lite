/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { getAgentViewportHost } from '@/lib/agent-bridge/viewport-host';
import { captureViewportPick } from '@/components/viewer/viewportPickOwnership';
import { resolveRef } from '../refs';
import { viewerOperation } from './contract';
import { stale, unavailable } from './refusals';
function pickingOperation(id: string, method: 'gpu' | 'ray') {
  return viewerOperation<{ x: number; y: number }>({ id, owner: 'viewport',
  description: `Read the native ${method === 'gpu' ? 'GPU pick' : 'exact CPU visible-surface intersection (point/normal/triangle/barycentric coordinates)'} at normalized canvas coordinates (top-left 0,0; bottom-right approaches 1,1), using the exact mounted click visibility/clip/streaming options. Does not select or change the tool. Native camera/scene/viewport ownership guards reject stale picks. GPU work may drain after cancellation; cancelled results are suppressed. hit_json is the native pick/intersection result; ref_json is a validated model-qualified entity or null with an explicit reason.`,
  effects: ['read'], capability: 'read', implementation: 'native-store', outputSchema: {
    type: 'object', properties: { hit_json: { type: 'string' }, ref_json: { type: 'string' }, reason: { type: 'string' }, width_css: { type: 'number' }, height_css: { type: 'number' } }, required: ['hit_json', 'ref_json', 'reason', 'width_css', 'height_css'], additionalProperties: false,
  },
}, { type: 'object', properties: { x: { type: 'number', minimum: 0, exclusiveMaximum: 1 }, y: { type: 'number', minimum: 0, exclusiveMaximum: 1 } }, required: ['x', 'y'], additionalProperties: false }, async (i, c) => {
  const host = getAgentViewportHost();
  if (!host?.renderer.getGPUDevice()) throw unavailable('A live mounted viewport is required for native picking.');
  // Agent reads are independent: one pick must not invalidate another (exclusive: false).
  // Renderer-side changes (clip applied by a frame, streamed geometry) are not in the store stamp.
  const clip = host.renderer.getPickClipRevision(), geometry = host.renderer.getPickGeometryRevision();
  const request = captureViewportPick({ ...host, channel: 'agent', exclusive: false, getTool: () => useViewerStore.getState().activeTool,
    isOwnerCurrent: () => getAgentViewportHost() === host && host.renderer.getPickClipRevision() === clip
      && host.renderer.getPickGeometryRevision() === geometry });
  if (request.rect.width <= 0 || request.rect.height <= 0 || request.pickOptions.isStreaming) throw unavailable('The native viewport must be visible and finished loading before picking.');
  const x = i.x * request.rect.width, y = i.y * request.rect.height;
  const hit = method === 'gpu' ? await host.renderer.pick(x, y, request.pickOptions)
    : host.renderer.raycastScene(x, y, request.pickOptions)?.intersection ?? null;
  c.checkpoint?.();
  if (!request.current() || !host.renderer.getGPUDevice()) throw stale('The native camera, scene or viewport changed during picking.');
  let ref: ReturnType<typeof resolveRef> | null = null, reason = hit ? 'unresolved_native_renderer_entity' : 'no_hit';
  if (hit) {
    // Read the store after the awaited pick: a model added or replaced meanwhile must not resolve the hit.
    const state = useViewerStore.getState();
    const owner = state.resolveGlobalIdFromModels(hit.expressId);
    const models = c.host.models();
    const model = owner ? models.find(candidate => candidate.id === owner.modelId)
      : state.models.size === 0 && models.length === 1 ? models[0] : undefined;
    if (model?.store) {
      const { usableModel } = await import('../main-viewer-dispatch');
      try { ref = resolveRef(usableModel(model, 'store', 'viewport.pick'), { express_id: owner?.expressId ?? hit.expressId }); reason = 'resolved'; }
      catch (error) { reason = `unresolved_native_renderer_entity: ${error instanceof Error ? error.message : String(error)}`; }
    }
  }
  c.checkpoint?.();
  if (!request.current()) throw stale('The native pick source changed during entity resolution.');
  return { hit_json: JSON.stringify(hit), ref_json: JSON.stringify(ref), reason, width_css: request.rect.width, height_css: request.rect.height };
});
}
export const pickingOperations = [pickingOperation('viewport.pick', 'gpu'), pickingOperation('viewport.raycast', 'ray')];
