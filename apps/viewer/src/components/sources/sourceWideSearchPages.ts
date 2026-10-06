/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { FileSourceProvider, PluginContext, SourceFile, SourceProject, Page } from '@ifc-lite/plugin-api';
import { createSourceWideSearchWalk } from './sourceWideSearchWalk';
import { IFC_NAME_PATTERNS, LIST_PAGE_LIMIT } from './sourceCatalogPaging';

export interface SourceSearchMatch { file: SourceFile; project: SourceProject }
interface Position {
  projects: readonly SourceProject[];
  index: number;
  projectCursor?: string;
  fileCursor?: string;
  projectsLoaded: boolean;
}

/** A bounded page of account-wide search. Positions are private to one search;
 * vendor cursors never appear in bookmarks or URLs. Each page does at most ten
 * network requests and exposes continuation even when those yield no matches. */
export function createSourceWideSearch(provider: FileSourceProvider, ctx: PluginContext, query: string) {
  if (!provider.manifest.capabilities.search || !provider.searchFiles) return createSourceWideSearchWalk(provider, ctx, query);
  const positions = new Map<string, Position>();
  let sequence = 0;
  return async (cursor: string | undefined, signal: AbortSignal): Promise<Page<SourceSearchMatch>> => {
    if (!provider.searchFiles) return { items: [] };
    let position: Position = cursor === undefined
      ? { projects: [], index: 0, projectsLoaded: false }
      : positions.get(cursor) ?? (() => { throw new Error('Search continuation expired'); })();
    for (let requests = 0; requests < 10; requests++) {
      signal.throwIfAborted();
      if (position.index >= position.projects.length) {
        if (position.projectsLoaded && position.projectCursor === undefined) return { items: [] };
        const page = await provider.listProjects(ctx, { cursor: position.projectCursor, signal, limit: LIST_PAGE_LIMIT });
        position = { projects: page.items, index: 0, projectCursor: page.cursor, projectsLoaded: true };
        if (page.items.length === 0) continue;
        // Count discovery and search separately against the request budget.
        if (requests === 9) break;
        requests++;
      }
      const project = position.projects[position.index];
      const page = await provider.searchFiles(ctx, project.id, query,
        { namePatterns: provider.manifest.capabilities.sourceNamePatterns ?? IFC_NAME_PATTERNS },
        { cursor: position.fileCursor, limit: LIST_PAGE_LIMIT, signal });
      position = { ...position, index: page.cursor === undefined ? position.index + 1 : position.index, fileCursor: page.cursor };
      const more = position.index < position.projects.length || position.projectCursor !== undefined;
      if (page.items.length > 0) {
        const next = more ? String(++sequence) : undefined;
        if (next) positions.set(next, position);
        return { items: page.items.map((file) => ({ file, project })), cursor: next };
      }
    }
    const more = position.index < position.projects.length || position.projectCursor !== undefined;
    const next = more ? String(++sequence) : undefined;
    if (next) positions.set(next, position);
    return { items: [], cursor: next };
  };
}
