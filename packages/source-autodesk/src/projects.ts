/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ListProjectsOptions, Page, SourceProject } from '@ifc-lite/plugin-api';
import { attributes, AutodeskError, enc, nextLink, record, rows, text, type Api, type Region } from './api.js';
import { address, parseAddress, parseDocsProjectLink, parseSiteLink } from './refs.js';

interface ProjectCursor { hubs: { id: string; name: string; region: Region }[]; index: number; next?: string }
function cursorEncode(cursor: ProjectCursor): string { return encodeURIComponent(JSON.stringify(cursor)); }
function cursorDecode(raw: string): ProjectCursor {
  const value = record(JSON.parse(decodeURIComponent(raw)));
  const hubs = rows(value.hubs).map((hub) => {
    if (hub.region !== 'US' && hub.region !== 'EMEA') throw new AutodeskError('invalid-cursor', 'Invalid Autodesk region.');
    return { id: text(hub.id), name: text(hub.name), region: hub.region as Region };
  });
  if (!Number.isInteger(value.index) || typeof value.index !== 'number' || value.index < 0 || value.index >= hubs.length) {
    throw new AutodeskError('invalid-cursor', 'Invalid Autodesk project cursor.');
  }
  return { hubs, index: value.index, next: value.next === undefined ? undefined : text(value.next) };
}
export async function listProjects(api: Api, options?: ListProjectsOptions): Promise<Page<SourceProject>> {
  const query = options?.query?.trim();
  if (query && ['acc.autodesk.com', 'acc.autodesk.eu'].includes(new URL(query).hostname)) {
    const link = parseDocsProjectLink(query);
    let cursor: string | undefined; const seen = new Set<string>();
    for (let pages = 0; pages < 100; pages++) {
      const page = await listProjects(api, { ...options, query: undefined, cursor });
      const project = page.items.find((item) => parseAddress(item.id).project.replace(/^b\./, '').toLowerCase() === link.project);
      if (project) return { items: [{ ...project, id: address({ ...parseAddress(project.id), id: link.folder }) }] };
      if (!page.cursor) throw new AutodeskError('project-access', 'This project is not available to your account/application. Check Autodesk project access and Custom Integrations.');
      if (seen.has(page.cursor)) throw new AutodeskError('listing-limit', 'Autodesk project paging did not finish.');
      seen.add(page.cursor); cursor = page.cursor;
    }
    throw new AutodeskError('listing-limit', 'Project lookup exceeds the configured page limit. Browse by account.');
  }
  if (query) {
    // Site discovery is deliberately link-driven; no account-wide site crawl.
    const site = parseSiteLink(query);
    const value = record(await api.get(`/forma/site/v1alpha/sites/${enc(site.id)}`, site.region, options?.signal));
    if (value.id !== site.id) throw new AutodeskError('site-mismatch', 'Autodesk returned another site.');
    return { items: [{
      id: address({ kind: 'site', region: site.region, id: site.id, project: text(value.projectId, 'site project') }),
      name: text(value.name ?? site.id, 'site name'), description: `Forma Site Design · ${site.region}`,
      meta: { siteId: site.id, region: site.region },
    }] };
  }
  let cursor: ProjectCursor;
  if (options?.cursor) cursor = cursorDecode(options.cursor);
  else {
    const hubs: ProjectCursor['hubs'] = [];
    let path: string | undefined = '/project/v1/hubs';
    const seen = new Set<string>();
    while (path) {
      if (seen.has(path) || seen.size >= 100) throw new AutodeskError('listing-limit', 'Autodesk hub paging did not finish.');
      seen.add(path);
      const page = record(await api.get(path, 'US', options?.signal));
      for (const hub of rows(page.data)) {
        const attrs = attributes(hub);
        // APS HubData stores its authoritative region on attributes (#6823).
        const region = attrs.region ?? 'US';
        if (region !== 'US' && region !== 'EMEA') {
          throw new AutodeskError('unsupported-region', `This Autodesk hub uses an unsupported region: ${text(region, 'hub region')}.`);
        }
        hubs.push({ id: text(hub.id), name: text(attrs.name), region });
      }
      path = nextLink(page, '/project/v1/hubs');
    }
    if (!hubs.length) return { items: [] };
    cursor = { hubs, index: 0 };
  }
  const hub = cursor.hubs[cursor.index];
  const base = `/project/v1/hubs/${enc(hub.id)}/projects`;
  const path = cursor.next ? nextLink({ links: { next: cursor.next } }, base) : undefined;
  const page = record(await api.get(path ?? `${base}?page[limit]=${Math.max(1, Math.min(200, options?.limit ?? 200))}`, hub.region, options?.signal));
  const next = nextLink(page, base);
  const following = next ? { ...cursor, next } : { ...cursor, index: cursor.index + 1, next: undefined };
  return {
    items: rows(page.data).map((row) => ({
      id: address({ kind: 'project', region: hub.region, hub: hub.id, project: text(row.id) }),
      name: text(attributes(row).name), description: hub.name,
      meta: { hubId: hub.id, hubName: hub.name, region: hub.region },
    })),
    cursor: following.index < following.hubs.length ? cursorEncode(following) : undefined,
  };
}
