/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { viewerOperation, operation, emptySchema } from './contract';
import { assertToolActive } from '../cancellation';
import { resolveRef } from '../refs';
import type { ToolHost } from '../types';
import { evictOldest, retainCandidate } from './host-handles';
import { nativeCapturedSurfaces } from '@/lib/appearance/appearance-native-capture';
import { coordinationModelAdder } from '@/services/coordination-loader';
import { createBlankIfcFile } from '@/utils/createBlankIfc';
import { prepareCapturedRegion } from '@/lib/appearance/capture/source';
import { appearanceRevision } from '@/lib/appearance/command';
import { createIfcFromCapturedMesh, type CapturedMeshSource } from '@/lib/appearance/create-captured-mesh';
import { selectCreatedAppearanceObject } from '@/components/viewer/appearance/select-created-object';
const outputSchema = {
  type: 'object',
  properties: { native_json: { type: 'string' } },
  required: ['native_json'],
  additionalProperties: false,
};
const out = (value: unknown) => ({ native_json: JSON.stringify(value) });
const meta = (id: string, description: string, model = false) => ({
  id,
  owner: 'appearance',
  description,
  effects: model ? (['model', 'view'] as const) : (['read'] as const),
  capability: model ? ('commands-and-edits' as const) : ('read' as const),
  implementation: 'native-store' as const,
  outputSchema,
  policy: model ? { model: 'native-reviewed' as const } : undefined,
});
interface Candidate {
  capture: CapturedMeshSource;
  modelId: string;
  containerId: number;
  revision: string;
  Name: string;
  result?: unknown;
  creating?: boolean;
}
const hosts = new WeakMap<ToolHost, Map<string, Candidate>>();
function owned(c: { host: ToolHost }) {
  let map = hosts.get(c.host);
  if (!map) {
    map = new Map();
    hosts.set(c.host, map);
    const values = map;
    c.host.lifetimeSignal?.addEventListener('abort', () => values.clear(), { once: true });
  }
  return map;
}
export const appearanceCaptureOperations = [
  viewerOperation(
    meta(
      'appearance.capture.sources',
      'Inspect native loaded textured capture surfaces using stable model-qualified mesh ordinals and native source assets. Loading scan/image bundles remains the canonical source loader/browser file-picker workflow.',
    ),
    emptySchema,
    async (_, c) => {
      assertToolActive(c);
      return out(
        nativeCapturedSurfaces(useViewerStore.getState().models).map((item) => ({
          source_model_id: item.modelId,
          model_name: item.modelName,
          mesh_ordinal: item.ordinal,
          triangles: item.mesh.indices.length / 3,
          vertices: item.mesh.positions.length / 3,
          texture: item.mesh.textureRef,
        })),
      );
    },
  ),
  viewerOperation(
    {
      ...meta(
        'appearance.capture.destination',
        'Create the Capture panel’s blank Captured Surfaces destination through the mounted canonical federation addModel/loadFile service. Preserves native admission/RTC and viewer cancellation boundaries.',
      ),
      effects: ['configuration', 'view'],
      capability: 'commands-and-edits',
    },
    emptySchema,
    async (_, c) => {
      assertToolActive(c);
      const id = await c.commitAsync(() =>
        coordinationModelAdder()(createBlankIfcFile({ projectName: 'Captured Surfaces' })),
      );
      if (!id) throw new Error('The native loader refused the blank destination.');
      return out({ model_id: id });
    },
  ),
  operation<{ source_model_id: string; mesh_ordinal: number; triangles: number[]; container_id: number; Name: string }>(
    meta(
      'appearance.capture.prepare',
      'Prepare the exact reviewed textured region using native captureRegistration/captureRegion/image ownership. Pins placement, source mesh and encoded texture identity; returns the immutable region counts before native IFC creation.',
    ),
    {
      type: 'object',
      properties: {
        source_model_id: { type: 'string', minLength: 1, maxLength: 200 },
        mesh_ordinal: { type: 'integer', minimum: 0, maximum: 10000000 },
        triangles: {
          type: 'array',
          minItems: 1,
          maxItems: 200000,
          uniqueItems: true,
          items: { type: 'integer', minimum: 0, maximum: 10000000 },
        },
        container_id: { type: 'integer', minimum: 1 },
        Name: { type: 'string', minLength: 1, maxLength: 240 },
      },
      required: ['source_model_id', 'mesh_ordinal', 'triangles', 'container_id', 'Name'],
      additionalProperties: false,
    },
    async (i, c) => {
      assertToolActive(c);
      resolveRef(c.model, { express_id: i.container_id });
      const mesh = useViewerStore.getState().models.get(i.source_model_id)?.geometryResult?.meshes[i.mesh_ordinal];
      if (!mesh?.textureRef || i.triangles.some((ordinal) => ordinal >= mesh.indices.length / 3))
        throw new Error('Unknown textured surface or triangle ordinal.');
      const capture = prepareCapturedRegion(i.source_model_id, mesh, i.triangles);
      capture.validate();
      evictOldest(owned(c), 32, (row) => !row.creating);
      const token = crypto.randomUUID();
      retainCandidate(c, owned(c), token, {
        capture,
        modelId: c.model.id,
        containerId: i.container_id,
        revision: appearanceRevision(c.model.id),
        Name: i.Name,
      });
      return out({
        token,
        source_model_id: i.source_model_id,
        destination_model_id: c.model.id,
        container_id: i.container_id,
        asset_id: capture.assetId,
        positions: capture.mesh.positions.length,
        triangles: capture.mesh.triangles.length,
        uvs: capture.mesh.uvs.length,
      });
    },
  ),
  operation<{ token: string }>(
    meta(
      'appearance.capture.create',
      'Create the exact prepared captured surface through native createIfcFromCapturedMesh/commitTexturedProduct with native role/IFC4-container/placement/source/transaction and Undo guards. Only a reviewed region token is accepted.',
      true,
    ),
    {
      type: 'object',
      properties: { token: { type: 'string', minLength: 1, maxLength: 100 } },
      required: ['token'],
      additionalProperties: false,
    },
    async (i, c) => {
      const saved = owned(c).get(i.token);
      if (!saved || saved.modelId !== c.model.id) throw new Error('Unknown capture candidate for this host/model.');
      if (saved.result) return out(saved.result);
      if (saved.creating) throw new Error('The capture candidate is being created.');
      assertToolActive(c);
      saved.capture.validate();
      const renderer = getGlobalRenderer();
      if (!renderer || appearanceRevision(c.model.id) !== saved.revision)
        throw new Error('Capture destination or native renderer changed.');
      saved.creating = true;
      try {
        const result = await c.commitAsync(() =>
          createIfcFromCapturedMesh(c.model.id, saved.containerId, saved.capture, renderer, {
            Name: saved.Name,
            signal: c.signal,
            onProgress: () => c.checkpoint?.(),
          }),
        );
        saved.result = result;
        selectCreatedAppearanceObject(c.model.id, result);
        return out(result);
      } finally {
        saved.creating = false;
      }
    },
  ),
  operation<{ token: string }>(
    {
      ...meta(
        'appearance.capture.discard',
        'Discard the host-owned immutable captured-region candidate without creating IFC.',
      ),
      effects: ['configuration'],
      capability: 'commands-and-edits',
    },
    {
      type: 'object',
      properties: { token: { type: 'string', minLength: 1, maxLength: 100 } },
      required: ['token'],
      additionalProperties: false,
    },
    (i, c) => {
      const saved = owned(c).get(i.token);
      if (!saved || saved.modelId !== c.model.id) throw new Error('Unknown capture candidate.');
      if (saved.creating) throw new Error('The capture candidate is being created.');
      return out(c.commit(() => ({ discarded: owned(c).delete(i.token) })));
    },
  ),
];
