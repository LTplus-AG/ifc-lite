/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { AutodeskProvider } from '../src/provider.js';
import { address } from '../src/refs.js';
import { checkedPath, type AutodeskService } from '../src/api.js';
import type { PluginContext } from '@ifc-lite/plugin-api';

const project = address({ kind: 'project', project: 'b.project', hub: 'b.hub', region: 'EMEA' });
const folder = address({ kind: 'folder', project: 'b.project', hub: 'b.hub', region: 'EMEA', id: 'folder' });
const item = { id: 'item', type: 'items', attributes: { displayName: 'House.ifc' }, relationships: { tip: { data: { id: 'v2' } } } };
const version = (id: string, owner = 'item') => ({ id, type: 'versions', attributes: { displayName: 'House.ifc', versionNumber: id }, relationships: {
  item: { data: { id: owner } }, storage: { data: { id: `urn:adsk.objects:os.object:bucket/${id}.ifc` } },
} });
function harness(reply: (path: string) => unknown, identity = 'user') {
  const calls: { path: string; region: string }[] = [];
  const storage: string[] = [];
  const service: AutodeskService = {
    imports: [], identity: async () => ({ id: identity }), startSignIn: async () => { throw new Error('unused'); }, signOut: async () => {},
    request: async (path, region) => { calls.push({ path, region }); return reply(path); },
    downloadStorage: async (id) => { storage.push(id); return new TextEncoder().encode('ISO-10303-21;END-ISO-10303-21;').buffer; },
    importResource: async () => { throw new Error('No artifact adapter'); },
  };
  const ctx: PluginContext = { fetch: async () => { throw new Error('No browser auth in hosted mode'); }, fetchPublic: async () => { throw new Error('No signed URL in browser'); },
    getPreference: async () => undefined, storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
  return { provider: new AutodeskProvider({ service }), ctx, calls, storage };
}
describe('Autodesk native file sources', () => {
  it('routes an EU hub using the documented attributes.region field (#6823)', async () => {
    const h = harness((path) => path === '/project/v1/hubs'
      ? { data: [{ id: 'b.eu-hub', attributes: { name: 'EU account', region: 'EMEA', extension: { data: {} } } }] }
      : { data: [{ id: 'b.eu-project', attributes: { name: 'EU project' } }] });
    const page = await h.provider.listProjects(h.ctx);
    expect(page.items[0].meta?.region).toBe('EMEA');
    expect(h.calls.find((call) => call.path.includes('/b.eu-hub/projects'))?.region).toBe('EMEA');
  });
  it('refuses unsupported hub regions rather than sending project requests to US (#6823)', async () => {
    const h = harness(() => ({ data: [{ id: 'b.other-hub', attributes: { name: 'Other account', region: 'CAN' } }] }));
    await expect(h.provider.listProjects(h.ctx)).rejects.toThrow('unsupported region: CAN');
    expect(h.calls).toEqual([{ path: '/project/v1/hubs', region: 'US' }]);
  });
  it('downloads selected historical storage even when current tip has changed', async () => {
    const h = harness((path) => path.includes('/items/') ? { data: item, included: [version('v2')] } : { data: version('v1') });
    const bytes = await h.provider.download(h.ctx, { projectId: project, containerId: folder, fileId: 'item', revisionId: 'v1' });
    expect(new TextDecoder().decode(bytes)).toContain('ISO-10303-21');
    expect(h.storage).toEqual(['urn:adsk.objects:os.object:bucket/v1.ifc']);
    expect(h.calls.every((call) => call.region === 'EMEA')).toBe(true);
  });
  it('loads historical bytes without requesting a deleted current item', async () => {
    const h = harness((path) => {
      if (path.includes('/items/')) throw new Error('Current item is deleted');
      return { data: version('v1') };
    });
    await h.provider.download(h.ctx, { projectId: project, containerId: folder, fileId: 'item', revisionId: 'v1' });
    expect(h.storage).toEqual(['urn:adsk.objects:os.object:bucket/v1.ifc']);
  });
  it('refuses a version belonging to another item before fetching model bytes', async () => {
    const h = harness((path) => path.includes('/items/') ? { data: item, included: [version('v2')] } : { data: version('v1', 'other') });
    await expect(h.provider.download(h.ctx, { projectId: project, containerId: folder, fileId: 'item', revisionId: 'v1' })).rejects.toThrow('different resource');
    expect(h.storage).toEqual([]);
  });
  it('keeps a cursor on a filtered-empty page and returns only matching native files', async () => {
    const base = '/data/v1/projects/b.project/folders/folder/contents';
    const h = harness(() => ({ data: [item], included: [version('v2')], links: { next: { href: `https://developer.api.autodesk.com${base}?page[number]=2` } } }));
    const page = await h.provider.listFiles(h.ctx, project, folder, { namePatterns: ['*.glb'] });
    expect(page.items).toEqual([]); expect(page.cursor).toContain('page[number]=2');
    const matching = await h.provider.listFiles(h.ctx, project, folder, { namePatterns: ['*.IFC'] });
    expect(matching.items[0]).toMatchObject({ name: 'House.ifc', currentRevisionId: 'v2', containerId: folder });
  });
  it('rejects foreign and cross-folder pagination before making an authenticated request', async () => {
    const h = harness(() => { throw new Error('Must not request'); });
    await expect(h.provider.listFiles(h.ctx, project, folder, undefined, { cursor: 'https://evil.example/data' })).rejects.toThrow('unexpected continuation');
    expect(h.calls).toEqual([]);
    expect(() => checkedPath('/data/v1/projects/other/items', '/data/v1/projects/b.project/items')).toThrow();
  });
  it('rejects a folder address from another region before requesting data', async () => {
    const h = harness(() => { throw new Error('Must not request'); });
    const foreign = address({ kind: 'folder', project: 'b.project', hub: 'b.hub', region: 'US', id: 'folder' });
    await expect(h.provider.listFiles(h.ctx, project, foreign)).rejects.toThrow('do not match');
    expect(h.calls).toEqual([]);
  });
  it('checks the current tip even when the watched reference pins an older revision', async () => {
    const h = harness(() => ({ data: item, included: [version('v2')] }));
    const updates = await h.provider.watchRevisions(h.ctx, [{ projectId: project, containerId: folder, fileId: 'item', revisionId: 'v1' }]);
    expect(updates.events).toEqual([{ fileId: 'item', previousRevisionId: 'v1', latestRevisionId: 'v2' }]);
    expect(h.calls[0].path).toContain('/items/');
  });
  it('does not expose unsupported authoring files as loadable IFCs', async () => {
    const h = harness(() => ({ data: [{ ...item, attributes: { displayName: 'Architecture.rvt' } }], included: [{ ...version('v2'), attributes: { displayName: 'Architecture.rvt' } }] }));
    const page = await h.provider.listFiles(h.ctx, project, folder);
    expect(page.items[0].unavailableReason).toContain('Data Exchange'); expect(page.items[0].artifactName).toBeUndefined();
  });
  it('lists proposal revisions as native names and requires a configured importer', async () => {
    const site = address({ kind: 'site', project: 'pro_123', id: 'site', region: 'EMEA' });
    const h = harness(() => ({ results: [{ urn: 'urn:adsk-forma-elements:proposal:pro_123:design:123', properties: { name: 'Design A' } }], pagination: {} }));
    const containers = await h.provider.listContainers(h.ctx, site);
    const page = await h.provider.listFiles(h.ctx, site, containers.items[0].id);
    expect(page.items[0]).toMatchObject({ name: 'Design A', kind: 'proposal', artifactName: 'Design A.ifcx', currentRevisionId: 'urn:adsk-forma-elements:proposal:pro_123:design:123' });
    await expect(h.provider.download(h.ctx, { projectId: site, containerId: containers.items[0].id, fileId: page.items[0].id, revisionId: page.items[0].currentRevisionId })).rejects.toThrow('artifact adapter');
  });
});

it('remembers linked sites per signed-in identity without sharing account bookmarks', async () => {
  const h = harness((path) => path.includes('/sites/') ? { id: 'site', projectId: 'project', name: 'Private site' } : { data: [] });
  const stored = new Map<string, string>();
  const ctx = { ...h.ctx, storage: {
    get: async (key: string) => stored.get(key), set: async (key: string, value: string) => { stored.set(key, value); },
    delete: async (key: string) => { stored.delete(key); }, keys: async () => [...stored.keys()],
  } };
  await h.provider.listProjects(ctx, { query: 'https://app.autodeskforma.eu/sites/site' });
  const projects = await h.provider.listProjects(ctx);
  expect(projects.items.some((p) => p.name === 'Private site')).toBe(true);
  const other = harness(() => ({ data: [] }), 'other-user');
  const otherCtx = { ...other.ctx, storage: ctx.storage };
  expect((await other.provider.listProjects(otherCtx)).items).toEqual([]);
});

it('resolves documented Docs project links using account discovery and opens the linked folder', async () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const h = harness((path) => path === '/project/v1/hubs' ? { data: [{ id: 'hub', attributes: { name: 'Account' } }] }
    : { data: [{ id: `b.${id}`, attributes: { name: 'Linked project' } }] });
  const page = await h.provider.listProjects(h.ctx, { query: `https://acc.autodesk.com/docs/files/projects/${id}?folderUrn=urn%3Aadsk.wipprod%3Afs.folder%3Afolder` });
  const areas = await h.provider.listContainers(h.ctx, page.items[0].id);
  expect(areas.items[0].name).toBe('Linked Autodesk folder');
  expect(decodeURIComponent(areas.items[0].id)).toContain('urn:adsk.wipprod:fs.folder:folder');
  expect(h.calls.every((call) => call.path.startsWith('/project/v1/'))).toBe(true);
});

it('detects current proposal changes without depending on revision-history sort order', async () => {
  const site = address({ kind: 'site', project: 'pro_123', id: 'site', region: 'EMEA' });
  const h = harness(() => ({ results: [{ urn: 'urn:adsk-forma-elements:proposal:pro_123:design:new', properties: { name: 'Design' } }] }));
  const updates = await h.provider.watchRevisions(h.ctx, [{ projectId: site, containerId: 'container',
    fileId: 'urn:adsk-forma-elements:proposal:pro_123:design', revisionId: 'urn:adsk-forma-elements:proposal:pro_123:design:old' }]);
  expect(updates.events[0].latestRevisionId).toBe('urn:adsk-forma-elements:proposal:pro_123:design:new');
  expect(h.calls[0].path).not.toContain('/revisions');
});
