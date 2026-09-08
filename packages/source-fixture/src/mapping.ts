/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { matchesGlob } from '@ifc-lite/plugin-api';
import type { FileFilter, SourceContainer, SourceFile, SourceProject, SourceRevision } from '@ifc-lite/plugin-api';

import type { RuntimeContainer, RuntimeFile, RuntimeProject, RuntimeRevision } from './data.js';
import type { FixtureWorld } from './data.js';

export function toSourceProject(project: RuntimeProject): SourceProject {
  return {
    id: project.id,
    name: project.name,
    ...(project.description !== undefined ? { description: project.description } : {}),
    ...(project.meta !== undefined ? { meta: project.meta } : {}),
  };
}

export function toSourceContainer(container: RuntimeContainer, world: FixtureWorld): SourceContainer {
  return {
    id: container.id,
    name: container.name,
    ...(container.parentId !== undefined ? { parentId: container.parentId } : {}),
    hasChildren: world.hasChildren(container.id),
    ...(container.meta !== undefined ? { meta: container.meta } : {}),
  };
}

export function toSourceFile(file: RuntimeFile): SourceFile {
  const current = file.revisions[0];
  return {
    id: file.id,
    name: file.name,
    containerId: file.containerId,
    ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
    sizeBytes: current.content.byteLength,
    currentRevisionId: current.id,
    modifiedAt: current.createdAt,
    ...(file.modifiedBy !== undefined ? { modifiedBy: file.modifiedBy } : {}),
    ...(file.meta !== undefined ? { meta: file.meta } : {}),
  };
}

export function toSourceRevision(revision: RuntimeRevision): SourceRevision {
  return {
    id: revision.id,
    label: revision.label,
    createdAt: revision.createdAt,
    ...(revision.createdBy !== undefined ? { createdBy: revision.createdBy } : {}),
    sizeBytes: revision.content.byteLength,
  };
}

/** Serializes a `FileFilter` into a stable string suitable for a cursor context key. */
export function serializeFilter(filter: FileFilter | undefined): string {
  if (!filter) return '';
  return JSON.stringify({
    namePatterns: filter.namePatterns ?? [],
    mimeTypes: filter.mimeTypes ?? [],
  });
}

export function applyFileFilter(files: readonly RuntimeFile[], filter: FileFilter | undefined): RuntimeFile[] {
  let result = [...files];
  if (filter?.namePatterns?.length) {
    const patterns = filter.namePatterns;
    result = result.filter((f) => patterns.some((pattern) => matchesGlob(f.name, pattern)));
  }
  if (filter?.mimeTypes?.length) {
    const mimeTypes = filter.mimeTypes;
    result = result.filter((f) => f.mimeType !== undefined && mimeTypes.includes(f.mimeType));
  }
  return result;
}
