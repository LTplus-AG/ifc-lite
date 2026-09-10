/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { AppearanceInstances, type InstanceAppearanceAccess, type InstanceAppearanceRecord } from './scene-appearance-instances.js';
import type { TexturedMesh } from './scene.js';
import { stageAppearanceResources, releaseAppearanceResources, textured } from './scene-appearance-resources.js';
import { AppearancePreviewController } from './appearance-preview.js';
import { AppearanceCompanions } from './appearance-companions.js';
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
export interface SceneAppearanceAccess {
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

export function createSceneAppearancePreview(
  access: SceneAppearanceAccess,
  buckets = new AppearanceBuckets(access.buckets, id => access.data.get(id)),
): AppearancePreviewController<Resource> {
  const instances = new AppearanceInstances(access.instances);
  const companions = new AppearanceCompanions();
  const release = (resources: readonly Resource[]) =>
    releaseAppearanceResources(access, buckets, resources.filter(resource => resource.kind !== 'instance'));
  return new AppearancePreviewController({
    validate: owner => companions.validate(owner, access.data.get(owner.expressId)),
    prepareRebuild(geometry, models) {
      const byOwner = new Map<number, MeshData[]>();
      for (const part of geometry) { const list = byOwner.get(part.expressId) ?? []; list.push(part); byOwner.set(part.expressId, list); }
      const retained = instances.retainedOwners(record => {
        if (!models.has(record.owner.modelIndex)) return false;
        const incoming = byOwner.get(record.owner.expressId) ?? [];
        if (record.active) return incoming.length === 0;
        const current = access.data.get(record.owner.expressId)?.map(part => access.source(part)) ?? record.flatSources;
        return !!current && current.length === incoming.length && current.every((part, index) => {
          const next = incoming[index];
          return (next.modelIndex ?? 0) === record.owner.modelIndex && next.geometryItemId === part.geometryItemId
            && equivalentAppearanceGeometry(next, part) && next.color.every((value, axis) => value === part.color[axis])
            && next.texture === part.texture && next.textureRef === part.textureRef && next.textureBitmap === part.textureBitmap
            && next.uvs === part.uvs && next.shadingColor === part.shadingColor;
        });
      });
      for (const id of companions.retained(geometry, models)) retained.add(id);
      return retained;
    },
    finishRebuild(retained) { instances.forgetExcept(retained); companions.forgetExcept(retained); buckets.forget(); },
    discardedForRebuild: retained => instances.discardedFlatOwners(retained),
    instanced(owner, parts) {
      const record = instances.get(owner);
      return !!record && instances.isOriginal(record, parts);
    },
    parts(owner) {
      const record = instances.get(owner);
      return access.data.get(owner.expressId) ?? (record?.active ? record.originals : companions.get(owner) ? (companions.get(owner)!.absent ? [] : companions.get(owner)!.originals) : undefined);
    },
    retainSource: owner => {
      const instance = instances.retain(owner), companion = companions.retain(owner);
      return () => { instance(); companion(); };
    },
    capture(owner, originals, companionOriginals, companionHidden) {
      if (!access.ready()) throw new Error('Appearance requires finalized resident geometry.');
      if (companionOriginals && (originals || access.instances.has(owner.expressId))) throw new Error('Instanced companions are not supported.');
      const companion = companionOriginals ? companions.capture(owner, companionOriginals, access.data.get(owner.expressId), part => access.source(part), companionHidden) : undefined;
      if (companion && (companion.absent || companion.hidden)) return { parts: companion.absent ? [] : companion.originals, resources: [], companionOriginals: companion.originals, abandon: () => companions.finish(owner, companion) };
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
        return { parts: companion?.originals ?? parts, resources, companionOriginals: companion?.originals, abandon: () => { buckets.finish(owner); instances.finish(owner, record); companions.finish(owner, companion); } };
      } catch (error) { instances.finish(owner, record); companions.finish(owner, companion); throw error; }
    },
    stage(parts) {
      if (!parts.length || companions.get({ expressId: parts[0].expressId, modelIndex: parts[0].modelIndex ?? 0 })?.hidden) return [];
      const record = instances.get({ expressId: parts[0].expressId, modelIndex: parts[0].modelIndex ?? 0 });
      if (record && instances.isOriginal(record, parts)) return [{ kind: 'instance', record }];
      return stageAppearanceResources(access, buckets, parts);
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
      const sources = record && !original ? Object.freeze(installed.map(part => Object.freeze({ ...access.source(part) }))) : undefined;
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
      if (original || companions.get(owner)?.hidden) access.data.delete(owner.expressId);
      else access.data.set(owner.expressId, installed);
      if (record) record.flatSources = sources;
      companions.install(owner, parts);
      access.invalidate(owner.expressId);
    },
    finished(owner) { try { buckets.finish(owner); } finally { instances.finish(owner); companions.finish(owner); } },
    forget(id) { instances.forget(id); companions.forget(id); buckets.forget(id); },
    release,
  });
}
