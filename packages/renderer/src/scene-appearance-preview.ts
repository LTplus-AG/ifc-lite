/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { AppearanceInstances, type InstanceAppearanceAccess, type InstanceAppearanceRecord } from './scene-appearance-instances.js';
import type { TexturedMesh } from './scene.js';
import { AppearancePreviewController } from './appearance-preview.js';
import { equivalentAppearanceGeometry } from './appearance-uvs.js';
import {
  AppearanceBuckets,
  type AppearanceBucketAccess,
  type FlatAppearanceResource,
} from './scene-appearance-buckets.js';

type Resource =
  | { kind: 'textured'; mesh: TexturedMesh }
  | { kind: 'flat'; flat: FlatAppearanceResource }
  | { kind: 'instance'; record: InstanceAppearanceRecord };
interface SceneAppearanceAccess {
  meshes(): TexturedMesh[];
  data: Map<number, MeshData[]>;
  instances: InstanceAppearanceAccess;
  ready(): boolean;
  buckets: AppearanceBucketAccess;
  adopt(part: MeshData): MeshData;
  source(part: MeshData): MeshData;
  upload(part: MeshData): void;
  release(mesh: TexturedMesh): void;
  invalidate(id: number): void;
}
const textured = (part: MeshData) =>
  !!(part.uvs && (part.texture || (part.textureRef && part.textureBitmap)));
export function createSceneAppearancePreview(
  access: SceneAppearanceAccess,
): AppearancePreviewController<Resource> {
  const instances = new AppearanceInstances(access.instances);
  const buckets = new AppearanceBuckets(access.buckets, (id) =>
    access.data.get(id),
  );
  function release(resources: readonly Resource[]) {
    for (const resource of resources) {
      try {
        if (resource.kind === 'textured') access.release(resource.mesh);
        else if (resource.kind === 'flat') buckets.release(resource.flat);
      } catch (error) {
        console.warn('[Appearance] resource disposal failed', error);
      }
    }
  }
  return new AppearancePreviewController({
    prepareRebuild(geometry, models) {
      const byOwner = new Map<number, MeshData[]>();
      for (const part of geometry) { const list = byOwner.get(part.expressId) ?? []; list.push(part); byOwner.set(part.expressId, list); }
      return instances.retainedOwners(record => {
        if (!models.has(record.owner.modelIndex)) return false;
        const incoming = byOwner.get(record.owner.expressId) ?? [];
        if (record.active) return incoming.length === 0;
        const current = access.data.get(record.owner.expressId);
        return !!current && current.length === incoming.length && current.every((placed, index) => {
          const part = access.source(placed), next = incoming[index];
          return (next.modelIndex ?? 0) === record.owner.modelIndex && next.geometryItemId === part.geometryItemId
            && equivalentAppearanceGeometry(next, part) && next.color.every((value, axis) => value === part.color[axis])
            && next.texture === part.texture && next.textureRef === part.textureRef && next.textureBitmap === part.textureBitmap
            && next.uvs === part.uvs && next.shadingColor === part.shadingColor;
        });
      });
    },
    finishRebuild(retained) { instances.forgetExcept(retained); buckets.forget(); },
    discardedForRebuild: retained => instances.discardedFlatOwners(retained),
    instanced(owner, parts) {
      const record = instances.get(owner);
      return !!record && instances.isOriginal(record, parts);
    },
    parts(owner) {
      return access.data.get(owner.expressId) ?? instances.get(owner)?.originals;
    },
    retainSource: owner => instances.retain(owner),
    capture(owner, originals) {
      if (!access.ready()) throw new Error('Appearance requires finalized resident geometry.');
      const record = instances.capture(owner, originals);
      if (record?.active) return { parts: record.originals, resources: [{ kind: 'instance' as const, record }],
        abandon: () => instances.finish(owner, record) };
      try {
        const parts = access.data.get(owner.expressId);
        const meshes = access
          .meshes()
          .filter((mesh) => mesh.expressId === owner.expressId);
        if (
          !access.ready() ||
          !parts?.length ||
          (access.instances.has(owner.expressId) && !record) ||
          meshes.length !== parts.filter(textured).length ||
          parts.some(
            (p) =>
              (p.modelIndex ?? 0) !== owner.modelIndex ||
              p.entityIds ||
              p.positions.length === 0 ||
              p.indices.length === 0 ||
              (!textured(p) && !access.buckets.reverse().has(p)),
          )
        ) {
          throw new Error(
            'Appearance preview requires finalized, resident, non-instanced geometry',
          );
        }
        const resources: Resource[] = meshes.map((mesh) => ({
          kind: 'textured',
          mesh,
        }));
        resources.push(
          ...buckets
            .capture(parts)
            .map((flat) => ({ kind: 'flat' as const, flat })),
        );
        buckets.begin(owner);
        return { parts, resources, abandon: () => { buckets.finish(owner); instances.finish(owner, record); } };
      } catch (error) { instances.finish(owner, record); throw error; }
    },
    stage(parts) {
      const record = instances.get({ expressId: parts[0].expressId, modelIndex: parts[0].modelIndex ?? 0 });
      if (record && instances.isOriginal(record, parts)) return [{ kind: 'instance', record }];
      const meshes = access.meshes(),
        start = meshes.length;
      const resources: Resource[] = [];
      try {
        const flatIndices: number[] = [];
        parts.forEach((part, index) => {
          if (textured(part)) access.upload(part);
          else flatIndices.push(index);
        });
        resources.push(
          ...meshes
            .splice(start)
            .map((mesh) => ({ kind: 'textured' as const, mesh })),
        );
        resources.push(
          ...buckets
            .stage(parts, flatIndices)
            .map((flat) => ({ kind: 'flat' as const, flat })),
        );
        return resources;
      } catch (error) {
        resources.push(
          ...meshes
            .splice(start)
            .map((mesh) => ({ kind: 'textured' as const, mesh })),
        );
        release(resources);
        throw error;
      }
    },
    install(owner, parts, resources) {
      const meshes = access.meshes();
      const installed = parts.map((part) => access.adopt({ ...part }));
      // Allocate all wrapper lists before touching live scene state.
      const flatParts = resources.map((resource) =>
        resource.kind === 'flat'
          ? resource.flat.partIndices.map((index) => installed[index])
          : undefined,
      );
      const original = resources.find(resource => resource.kind === 'instance');
      const record = instances.get(owner);
      if (record) instances.activate(record, !!original);
      buckets.detach(owner.expressId);
      for (let i = meshes.length - 1; i >= 0; i--) {
        if (meshes[i].expressId === owner.expressId) meshes.splice(i, 1);
      }
      resources.forEach((resource, index) => {
        if (resource.kind === 'textured') meshes.push(resource.mesh);
        else if (resource.kind === 'flat') buckets.attach(resource.flat, flatParts[index]!);
      });
      buckets.refresh();
      if (original) access.data.delete(owner.expressId);
      else access.data.set(owner.expressId, installed);
      access.invalidate(owner.expressId);
    },
    finished(owner) { try { buckets.finish(owner); } finally { instances.finish(owner); } },
    forget(id) { instances.forget(id); buckets.forget(id); },
    release,
  });
}
