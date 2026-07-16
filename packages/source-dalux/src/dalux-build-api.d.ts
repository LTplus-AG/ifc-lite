/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ambient types for dalux-build-api@2.0.0 (a plain-JS package, no shipped
 * .d.ts). Only the subpaths this provider actually imports are declared.
 *
 * `FilesApi.js`, `FoldersApi.js`'s `getAllFolders`, and `configuration.js`
 * are intentionally NOT used here:
 * - `FilesApi.js` and `configuration.js` `require('fs')`/`require('path')`/
 *   `require('readline')`/`dotenv` at module scope, which breaks browser
 *   bundling.
 * - `FoldersApi.getAllFolders` (and the generic `utils/pagination.js`
 *   helper it's built on) reads pages as `response.items` only — it never
 *   applies the bare-array normalization that `listResponseSchema` (used by
 *   the single-page `listFolders`/`listFiles`/etc.) does, so an endpoint
 *   that responds with a bare array instead of `{ items, metadata, links }`
 *   silently paginates to zero results.
 *
 * Both files and folders are instead fetched with this package's own
 * shape-tolerant pager (see `provider.ts`), validated with the library's
 * zod models directly.
 *
 * This has to live in its own `.d.ts` file rather than inline in
 * `provider.ts`: once a file has top-level `import`/`export` it's a module,
 * and `declare module 'x' { ... }` inside a module is a module
 * *augmentation*, not a fresh ambient declaration — augmentations can't
 * contain their own `import`s and collide with real value imports of the
 * same names. A standalone `.d.ts` with no imports/exports of its own stays
 * a script, so `declare module` here declares new ambient modules instead.
 */

declare module 'dalux-build-api/src/models/projects/index.js' {
  export interface DaluxProject {
    readonly projectId: string;
    readonly projectName: string;
  }
}

declare module 'dalux-build-api/src/models/fileAreas/index.js' {
  export interface DaluxFileArea {
    readonly fileAreaId: string;
    readonly fileAreaName: string;
    readonly fileAreaType: string;
  }
}

declare module 'dalux-build-api/src/models/folders/index.js' {
  export interface DaluxFolder {
    readonly folderId: string;
    readonly folderName: string;
    readonly parentFolderId?: string | null;
  }

  /** Opaque zod schema — passed through to `convertToModelList`, never inspected directly. */
  export const FolderSchema: unknown;
}

declare module 'dalux-build-api/src/models/files/index.js' {
  export interface DaluxFile {
    readonly fileId: string;
    readonly fileRevisionId?: string | null;
    readonly fileName: string;
    readonly fileAreaId: string;
    readonly folderId?: string | null;
    readonly uploadedByUserId?: string | null;
    readonly uploaded?: string | null;
    readonly lastModifiedByUserId?: string | null;
    readonly lastModified?: string | null;
    readonly version?: string | null;
    readonly deleted: boolean;
    readonly fileType?: string | null;
    readonly fileSize?: number | null;
    readonly contentHash?: string | null;
    readonly downloadLink?: string | null;
  }

  export interface DaluxFileResponse {
    readonly data: DaluxFile;
  }

  /** Opaque zod schemas — passed through to `convertToModel(List)`, never inspected directly. */
  export const FileSchema: unknown;
  export const FileResponseSchema: unknown;
}

declare module 'dalux-build-api/src/models/convert.js' {
  export function convertToModel<T>(response: unknown, schema: unknown, schemaName?: string): T | null;
  export function convertToModelList<T>(items: readonly unknown[], itemSchema: unknown, schemaName?: string): T[];
}

declare module 'dalux-build-api/src/api/ProjectsApi.js' {
  import type { DaluxProject } from 'dalux-build-api/src/models/projects/index.js';

  export default class ProjectsApi {
    constructor(apiClient: { get(path: string, params?: Record<string, unknown>): Promise<unknown> });
    listProjects(params?: Record<string, unknown>): Promise<{ items: readonly DaluxProject[] }>;
  }
}

declare module 'dalux-build-api/src/api/FileAreasApi.js' {
  import type { DaluxFileArea } from 'dalux-build-api/src/models/fileAreas/index.js';

  export default class FileAreasApi {
    constructor(apiClient: { get(path: string, params?: Record<string, unknown>): Promise<unknown> });
    getFileAreas(projectId: string, params?: Record<string, unknown>): Promise<{ items: readonly DaluxFileArea[] }>;
  }
}
