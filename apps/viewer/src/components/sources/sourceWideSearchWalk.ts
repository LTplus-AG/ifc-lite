/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { FileSourceProvider, PluginContext, SourceProject, Page } from '@ifc-lite/plugin-api';
import type { SourceSearchMatch } from './sourceWideSearchPages';
import { IFC_NAME_PATTERNS, LIST_PAGE_LIMIT } from './sourceCatalogPaging';

type Task = { kind: 'projects'; cursor?: string }
  | { kind: 'containers'; project: SourceProject; parentId?: string; cursor?: string; files: boolean }
  | { kind: 'files'; project: SourceProject; containerId: string; cursor?: string };
interface Position { tasks: readonly Task[]; visited: ReadonlySet<string> }

/** Iterative listing search for sources without a native search API. Never
 * downloads a file. A request budget bounds each page; the visited set bounds
 * folder cycles, scoped by project so identical folder ids stay independent. */
export function createSourceWideSearchWalk(provider: FileSourceProvider, ctx: PluginContext, query: string) {
  const positions = new Map<string, Position>();
  let sequence = 0;
  return async (cursor: string | undefined, signal: AbortSignal): Promise<Page<SourceSearchMatch>> => {
    const previous = cursor ? positions.get(cursor) : { tasks: [{ kind: 'projects' } as Task], visited: new Set<string>() };
    if (!previous) throw new Error('Search continuation expired');
    const tasks = [...previous.tasks];
    const visited = new Set(previous.visited);
    const items: SourceSearchMatch[] = [];
    const options = { limit: LIST_PAGE_LIMIT, signal };
    for (let count = 0; count < 10 && tasks.length > 0; count++) {
      signal.throwIfAborted();
      const task = tasks.shift()!;
      const key = JSON.stringify(task.kind === 'projects' ? ['projects', task.cursor]
        : [task.kind, task.project.id, task.kind === 'containers' ? task.parentId : task.containerId, task.cursor]);
      if (visited.has(key)) continue;
      visited.add(key);
      if (task.kind === 'projects') {
        const page = await provider.listProjects(ctx, { ...options, cursor: task.cursor });
        tasks.push(...page.items.map((project): Task => ({ kind: 'containers', project, files: true })));
        if (page.cursor !== undefined) tasks.push({ kind: 'projects', cursor: page.cursor });
      } else if (task.kind === 'containers') {
        const page = await provider.listContainers(ctx, task.project.id, task.parentId, { ...options, cursor: task.cursor });
        if (page.cursor !== undefined) tasks.push({ ...task, cursor: page.cursor });
        for (const container of page.items) {
          if (task.files && (!provider.manifest.capabilities.listFilesIsRecursive || container.parentId === task.parentId)) {
            tasks.push({ kind: 'files', project: task.project, containerId: container.id });
          }
          if (provider.manifest.capabilities.containerListing === 'direct-children'
            || (!provider.manifest.capabilities.listFilesIsRecursive && task.parentId === undefined && container.parentId === undefined)) {
            // Flat listings expose file areas first, then each area's subtree.
            // Per-folder files still require discovering that subtree once.
            tasks.push({ kind: 'containers', project: task.project, parentId: container.id,
              files: !provider.manifest.capabilities.listFilesIsRecursive });
          }
        }
      } else {
        const page = await provider.listFiles(ctx, task.project.id, task.containerId,
          { namePatterns: provider.manifest.capabilities.sourceNamePatterns ?? IFC_NAME_PATTERNS }, { ...options, cursor: task.cursor });
        if (page.cursor !== undefined) tasks.push({ ...task, cursor: page.cursor });
        items.push(...page.items.filter((file) => file.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((file) => ({ file, project: task.project })));
        if (items.length > 0) break;
      }
    }
    const next = tasks.length > 0 ? String(++sequence) : undefined;
    if (next) positions.set(next, { tasks, visited });
    return { items, cursor: next };
  };
}
