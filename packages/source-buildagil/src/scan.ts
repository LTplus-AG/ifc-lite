/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every IFC document of a project, in one bounded scan. The openCDE API has
 * no folder endpoint (a document only names its `folder_url`) and its
 * document list pages with `$top` but no `$skip`, so the scan pages by
 * creation time instead: `$orderby=creation_date` and, after the first page,
 * `creation_date ge <last seen>`, dropping guids it already has. Creation
 * time never changes, unlike `modified_date`, which moves when a version is
 * uploaded mid-scan.
 */

import type { PluginContext, SourceContainer } from '@ifc-lite/plugin-api';
import type { BuildagilClient } from './http-client.js';
import { creationTime, decodeDocument, DOCUMENTS_ROOT, rows, type BuildagilDocument } from './types.js';

/** The API's default page size; a page shorter than this is the last one. */
const PAGE = 100;
/** Above this the project is refused rather than half-listed. */
export const MAX_SCANNED_DOCUMENTS = 5000;
export const MODEL_FILE = /\.(ifc|ifczip|ifcxml|ifcx)$/i;
const MODEL_TYPES = ['ifc', 'ifczip', 'ifcxml', 'ifcx'];
/** `file_type` is the extension; both cases, since OData `eq` is exact. */
const TYPE_FILTER = `(${[...MODEL_TYPES, ...MODEL_TYPES.map((t) => t.toUpperCase())].map((t) => `file_type eq '${t}'`).join(' or ')})`;

export async function scanModelDocuments(
  ctx: PluginContext, client: BuildagilClient, projectId: string, signal?: AbortSignal,
): Promise<BuildagilDocument[]> {
  const byGuid = new Map<string, BuildagilDocument>();
  let after: string | undefined;
  for (;;) {
    const filter = after ? `${TYPE_FILTER} and creation_date ge ${after}` : TYPE_FILTER;
    const params = new URLSearchParams({ $filter: filter, $orderby: 'creation_date asc', $top: String(PAGE) });
    const raw = await client.json(ctx, `1.0/projects/${encodeURIComponent(projectId)}/documents?${params}`, { signal });
    const page = rows(raw, (row) => {
      const doc = decodeDocument(row);
      return doc && { doc, created: creationTime(row) };
    });
    const before = byGuid.size;
    for (const { doc } of page) if (MODEL_FILE.test(doc.filename)) byGuid.set(doc.guid, doc);
    if (byGuid.size >= MAX_SCANNED_DOCUMENTS) {
      throw new Error(`This buildagil project has more than ${MAX_SCANNED_DOCUMENTS} IFC documents; use search to find a model.`);
    }
    // `rows` has already checked that `raw` is a list.
    if ((raw as unknown[]).length < PAGE) break;
    const last = page.at(-1)?.created;
    // A full page that added nothing new, or whose last row has no creation
    // time, cannot advance the cursor: stop rather than loop.
    if (!last || last === after && byGuid.size === before) {
      throw new Error('buildagil returned a document page the scan cannot continue past.');
    }
    after = last;
  }
  return [...byGuid.values()];
}

/** Display name of a folder path: its last segment, or "Documents" for the root. */
function folderName(path: string): string {
  return path === DOCUMENTS_ROOT ? 'Documents' : path.slice(path.lastIndexOf('/') + 1);
}

function parentOf(path: string): string | undefined {
  if (path === DOCUMENTS_ROOT) return undefined;
  return path.slice(0, path.lastIndexOf('/')) || DOCUMENTS_ROOT;
}

/**
 * The folder tree holding the given documents, flattened with parent links:
 * the documents root, and every folder on the way to a document. Folders
 * holding no model anywhere beneath are not listed.
 */
export function folderTree(documents: readonly BuildagilDocument[]): SourceContainer[] {
  const children = new Map<string, Set<string>>();
  const folders = new Set<string>([DOCUMENTS_ROOT]);
  for (const { folder } of documents) {
    for (let path: string | undefined = folder; path && !folders.has(path); path = parentOf(path)) folders.add(path);
  }
  for (const path of folders) {
    const parent = parentOf(path);
    if (parent) children.set(parent, (children.get(parent) ?? new Set()).add(path));
  }
  return [...folders].sort().map((path) => ({
    id: path, name: folderName(path), parentId: parentOf(path), hasChildren: children.has(path),
  }));
}
