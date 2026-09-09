/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { TexturedMesh } from './scene.js';
import { AppearancePreviewController } from './appearance-preview.js';
import {
  AppearanceBuckets,
  type AppearanceBucketAccess,
  type FlatAppearanceResource,
} from './scene-appearance-buckets.js';

type Resource =
  | { kind: 'textured'; mesh: TexturedMesh }
  | { kind: 'flat'; flat: FlatAppearanceResource };
interface SceneAppearanceAccess {
  meshes(): TexturedMesh[];
  data: Map<number, MeshData[]>;
  hasInstances(id: number): boolean;
  ready(): boolean;
  buckets: AppearanceBucketAccess;
  upload(part: MeshData): void;
  release(mesh: TexturedMesh): void;
  invalidate(id: number): void;
}
const textured = (part: MeshData) =>
  !!(part.uvs && (part.texture || (part.textureRef && part.textureBitmap)));
export function createSceneAppearancePreview(
  access: SceneAppearanceAccess,
): AppearancePreviewController<Resource> {
  const buckets = new AppearanceBuckets(access.buckets, (id) =>
    access.data.get(id),
  );
  function release(resources: readonly Resource[]) {
    for (const resource of resources) {
      try {
        if (resource.kind === 'textured') access.release(resource.mesh);
        else buckets.release(resource.flat);
      } catch (error) {
        console.warn('[Appearance] resource disposal failed', error);
      }
    }
  }
  return new AppearancePreviewController({
    capture(owner) {
      const parts = access.data.get(owner.expressId);
      const meshes = access
        .meshes()
        .filter((mesh) => mesh.expressId === owner.expressId);
      if (
        !access.ready() ||
        !parts?.length ||
        access.hasInstances(owner.expressId) ||
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
      return { parts, resources };
    },
    stage(parts) {
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
      const installed = parts.map((part) => ({ ...part }));
      // Allocate all wrapper lists before touching live scene state.
      const flatParts = resources.map((resource) =>
        resource.kind === 'flat'
          ? resource.flat.partIndices.map((index) => installed[index])
          : undefined,
      );
      buckets.detach(owner.expressId);
      for (let i = meshes.length - 1; i >= 0; i--) {
        if (meshes[i].expressId === owner.expressId) meshes.splice(i, 1);
      }
      resources.forEach((resource, index) => {
        if (resource.kind === 'textured') meshes.push(resource.mesh);
        else buckets.attach(resource.flat, flatParts[index]!);
      });
      buckets.refresh();
      access.data.set(owner.expressId, installed);
      access.invalidate(owner.expressId);
    },
    finished: (owner) => buckets.finish(owner),
    forget: (id) => buckets.forget(id),
    release,
  });
}
