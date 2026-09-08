/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// The fixture's data model: a plain, declarative description of a CDE's
// content (projects -> containers -> files -> revisions -> bytes), plus a
// small in-memory index over it. No I/O, no host types beyond the domain
// model shapes re-used for the constructed `Source*` values.
// ============================================================================

import { FixtureApiError } from './errors.js';

export interface FixtureRevisionSpec {
  readonly id: string;
  /** Defaults to `id`. */
  readonly label?: string;
  /** Defaults to a deterministic timestamp derived from position. */
  readonly createdAt?: string;
  readonly createdBy?: string;
  /** Deterministic content bytes for this revision. A `string` is UTF-8 encoded. */
  readonly content: Uint8Array | string;
}

export interface FixtureFileSpec {
  readonly id: string;
  readonly name: string;
  /** The container this file lives in. Must name a container declared in the same project. */
  readonly containerId: string;
  readonly mimeType?: string;
  readonly modifiedBy?: string;
  readonly meta?: Record<string, unknown>;
  /** Newest first — `revisions[0]` is the file's current revision. At least one required. */
  readonly revisions: readonly FixtureRevisionSpec[];
}

export interface FixtureContainerSpec {
  readonly id: string;
  readonly name: string;
  /** Omit for a root-level container. Must name a container declared earlier in the same project. */
  readonly parentId?: string;
  readonly meta?: Record<string, unknown>;
}

export interface FixtureProjectSpec {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly meta?: Record<string, unknown>;
  readonly containers: readonly FixtureContainerSpec[];
  readonly files: readonly FixtureFileSpec[];
}

export interface FixtureWorldSpec {
  readonly projects: readonly FixtureProjectSpec[];
}

interface RuntimeRevision {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly content: Uint8Array;
}

interface RuntimeFile {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly containerId: string;
  readonly mimeType?: string;
  readonly modifiedBy?: string;
  readonly meta?: Record<string, unknown>;
  /** Newest first. */
  readonly revisions: readonly RuntimeRevision[];
}

interface RuntimeContainer {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly parentId?: string;
  readonly meta?: Record<string, unknown>;
}

interface RuntimeProject {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly meta?: Record<string, unknown>;
}

function toBytes(content: Uint8Array | string): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

/**
 * Normalizes a declarative {@link FixtureWorldSpec} into an in-memory index
 * and validates every cross-reference eagerly (unknown parent, unknown file
 * container, duplicate id) — so a malformed fixture fails at construction
 * with a clear message rather than surfacing as a confusing null somewhere
 * deep in a test.
 */
export class FixtureWorld {
  private readonly projects = new Map<string, RuntimeProject>();
  private readonly containersByProject = new Map<string, RuntimeContainer[]>();
  private readonly containerById = new Map<string, RuntimeContainer>();
  private readonly filesByProject = new Map<string, RuntimeFile[]>();
  private readonly fileById = new Map<string, { projectId: string; file: RuntimeFile }>();

  constructor(spec: FixtureWorldSpec) {
    for (const projectSpec of spec.projects) {
      if (this.projects.has(projectSpec.id)) {
        throw new FixtureApiError(`Duplicate project id in fixture spec: ${projectSpec.id}`);
      }
      this.projects.set(projectSpec.id, {
        id: projectSpec.id,
        name: projectSpec.name,
        description: projectSpec.description,
        meta: projectSpec.meta,
      });

      const containers: RuntimeContainer[] = [];
      this.containersByProject.set(projectSpec.id, containers);
      for (const containerSpec of projectSpec.containers) {
        if (this.containerById.has(containerSpec.id)) {
          throw new FixtureApiError(`Duplicate container id in fixture spec: ${containerSpec.id}`);
        }
        if (containerSpec.parentId !== undefined && !this.containerById.has(containerSpec.parentId)) {
          throw new FixtureApiError(
            `Container ${containerSpec.id} declares unknown parentId ${containerSpec.parentId} (containers must be declared after their parent)`,
          );
        }
        const container: RuntimeContainer = {
          id: containerSpec.id,
          name: containerSpec.name,
          projectId: projectSpec.id,
          parentId: containerSpec.parentId,
          meta: containerSpec.meta,
        };
        containers.push(container);
        this.containerById.set(container.id, container);
      }

      const files: RuntimeFile[] = [];
      this.filesByProject.set(projectSpec.id, files);
      for (const fileSpec of projectSpec.files) {
        if (this.fileById.has(fileSpec.id)) {
          throw new FixtureApiError(`Duplicate file id in fixture spec: ${fileSpec.id}`);
        }
        const container = this.containerById.get(fileSpec.containerId);
        if (!container || container.projectId !== projectSpec.id) {
          throw new FixtureApiError(
            `File ${fileSpec.id} declares containerId ${fileSpec.containerId}, which is not a container of project ${projectSpec.id}`,
          );
        }
        if (fileSpec.revisions.length === 0) {
          throw new FixtureApiError(`File ${fileSpec.id} must declare at least one revision`);
        }
        const seenRevisionIds = new Set<string>();
        const revisions: RuntimeRevision[] = fileSpec.revisions.map((revisionSpec, index) => {
          if (seenRevisionIds.has(revisionSpec.id)) {
            throw new FixtureApiError(`File ${fileSpec.id} declares duplicate revision id ${revisionSpec.id}`);
          }
          seenRevisionIds.add(revisionSpec.id);
          return {
            id: revisionSpec.id,
            label: revisionSpec.label ?? revisionSpec.id,
            createdAt: revisionSpec.createdAt ?? new Date(1700000000000 - index * 86_400_000).toISOString(),
            createdBy: revisionSpec.createdBy,
            content: toBytes(revisionSpec.content),
          };
        });
        const file: RuntimeFile = {
          id: fileSpec.id,
          name: fileSpec.name,
          projectId: projectSpec.id,
          containerId: fileSpec.containerId,
          mimeType: fileSpec.mimeType,
          modifiedBy: fileSpec.modifiedBy,
          meta: fileSpec.meta,
          revisions,
        };
        files.push(file);
        this.fileById.set(file.id, { projectId: projectSpec.id, file });
      }
    }
  }

  listProjects(): readonly RuntimeProject[] {
    return [...this.projects.values()];
  }

  /** Direct children of `parentId` (or root containers when omitted) within one project. */
  directChildren(projectId: string, parentId: string | undefined): readonly RuntimeContainer[] {
    const containers = this.containersByProject.get(projectId) ?? [];
    return containers.filter((c) => c.parentId === parentId);
  }

  /**
   * Every descendant of `parentId`, flattened, excluding `parentId` itself.
   * `parentId` omitted returns every container in the project (each is a
   * descendant of the implicit root).
   */
  subtreeDescendants(projectId: string, parentId: string | undefined): readonly RuntimeContainer[] {
    const containers = this.containersByProject.get(projectId) ?? [];
    if (parentId === undefined) return containers;

    const result: RuntimeContainer[] = [];
    const frontier = [parentId];
    const idsInFrontier = new Set<string>();
    while (frontier.length > 0) {
      const current = frontier.shift()!;
      const children = containers.filter((c) => c.parentId === current);
      for (const child of children) {
        if (idsInFrontier.has(child.id)) continue; // ids are unique so this only guards pathological specs
        idsInFrontier.add(child.id);
        result.push(child);
        frontier.push(child.id);
      }
    }
    return result;
  }

  hasChildren(containerId: string): boolean {
    const container = this.containerById.get(containerId);
    if (!container) return false;
    const siblings = this.containersByProject.get(container.projectId) ?? [];
    return siblings.some((c) => c.parentId === containerId);
  }

  /** Files directly in `containerId`, or also in its descendants when `recursive`. */
  filesInContainer(projectId: string, containerId: string, recursive: boolean): readonly RuntimeFile[] {
    const files = this.filesByProject.get(projectId) ?? [];
    if (!recursive) return files.filter((f) => f.containerId === containerId);

    const descendantIds = new Set(this.subtreeDescendants(projectId, containerId).map((c) => c.id));
    descendantIds.add(containerId);
    return files.filter((f) => descendantIds.has(f.containerId));
  }

  searchFiles(projectId: string, query: string): readonly RuntimeFile[] {
    const files = this.filesByProject.get(projectId) ?? [];
    const needle = query.toLowerCase();
    return files.filter((f) => f.name.toLowerCase().includes(needle));
  }

  /** Looks up a file by full reference, validating that `containerId` still matches. */
  getFile(projectId: string, containerId: string, fileId: string): RuntimeFile {
    const entry = this.fileById.get(fileId);
    if (!entry || entry.projectId !== projectId) {
      throw new FixtureApiError(`Unknown file ${fileId} in project ${projectId}`, 404);
    }
    if (entry.file.containerId !== containerId) {
      throw new FixtureApiError(
        `File ${fileId} lives in container ${entry.file.containerId}, not ${containerId}`,
        400,
      );
    }
    return entry.file;
  }

  /** Same lookup as {@link getFile}, but returns `undefined` instead of throwing — used by change detection. */
  tryGetFile(projectId: string, fileId: string): RuntimeFile | undefined {
    const entry = this.fileById.get(fileId);
    return entry && entry.projectId === projectId ? entry.file : undefined;
  }

  currentRevision(file: RuntimeFile): RuntimeRevision {
    return file.revisions[0];
  }

  getRevision(file: RuntimeFile, revisionId: string): RuntimeRevision {
    const revision = file.revisions.find((r) => r.id === revisionId);
    if (!revision) {
      throw new FixtureApiError(`Unknown revision ${revisionId} for file ${file.id}`, 404);
    }
    return revision;
  }
}

export type { RuntimeContainer, RuntimeFile, RuntimeProject, RuntimeRevision };
