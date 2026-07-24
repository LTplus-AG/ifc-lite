/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ambient types for dalux-build-api@2.0.0 (a plain-JS package, no shipped
 * .d.ts). Only the subpaths this provider actually imports are declared.
 *
 * None of the library's `*Api` classes are used here — `ProjectsApi` and
 * `FileAreasApi`'s single-GET methods never follow `nextPage`, silently
 * truncating any tenant with more than one page of projects or file areas.
 * `FilesApi.js` and `configuration.js` additionally `require('fs')`/
 * `require('path')`/`require('readline')`/`dotenv` at module scope, which
 * breaks browser bundling. `FoldersApi.getAllFolders` (and the generic
 * `utils/pagination.js` helper it's built on) reads pages as
 * `response.items` only — it never applies the bare-array normalization
 * that the single-page schemas do, so an endpoint that responds with a bare
 * array instead of `{ items, metadata, links }` would silently paginate to
 * zero results.
 *
 * Every listing (projects, file areas, folders, files) is instead fetched
 * with this package's own shape-tolerant, truncation-detecting pager (see
 * `http-client.ts`) and validated with the library's zod schemas directly,
 * dropping individually invalid records rather than failing the whole page
 * (see `mapping.ts#convertListLenient`).
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

  /** Zod schema; `.parse` is called directly by `convertListLenient`. */
  export const ProjectSchema: { parse(value: unknown): DaluxProject };
}

declare module 'dalux-build-api/src/models/fileAreas/index.js' {
  export interface DaluxFileArea {
    readonly fileAreaId: string;
    readonly fileAreaName: string;
    readonly fileAreaType: string;
  }

  export const FileAreaSchema: { parse(value: unknown): DaluxFileArea };
}

declare module 'dalux-build-api/src/models/folders/index.js' {
  export interface DaluxFolder {
    readonly folderId: string;
    readonly folderName: string;
    readonly parentFolderId?: string | null;
  }

  export const FolderSchema: { parse(value: unknown): DaluxFolder };
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

  export const FileSchema: { parse(value: unknown): DaluxFile };
  /** Opaque single-item envelope schema — passed through to `convertToModel`
   * for the one-off metadata lookup in `download()`, never inspected
   * directly (unlike the list schemas, a single invalid record there should
   * fail loudly rather than being dropped). */
  export const FileResponseSchema: unknown;
}

declare module 'dalux-build-api/src/models/convert.js' {
  export function convertToModel<T>(response: unknown, schema: unknown, schemaName?: string): T | null;
}
