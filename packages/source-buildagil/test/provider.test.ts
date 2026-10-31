/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from 'vitest';
import { BuildagilProvider } from '../src/index.js';
import { MAX_SCANNED_DOCUMENTS } from '../src/scan.js';
import { ACCESS_TOKEN, createMockApi, manyDocuments, type MockWorld } from './buildagil-api-mock.js';

const doc = (guid: string, filename: string, folder_url: string, created: string, versions = 1) => ({
  guid, filename, folder_url, creation_date: created,
  versions: Array.from({ length: versions }, (_, i) => ({
    version_index: i + 1, version_number: `${i + 1}.0`, modified_date: `2026-03-0${i + 1}T00:00:00.000Z`, content: `${filename}@${i + 1}`,
  })),
});

const WORLD: MockWorld = {
  projects: [{ project_id: 'p1', name: 'Tower', number: 'T-01' }, { project_id: 'p2', name: 'Bridge' }],
  documents: {
    p1: [
      doc('a0000000-0000-4000-8000-000000000001', 'ARC.ifc', '/documents/models/architecture', '2026-01-01T00:00:00.000Z', 3),
      doc('a0000000-0000-4000-8000-000000000002', 'STR.ifczip', '/documents/models/structure/', '2026-01-02T00:00:00.000Z'),
      doc('a0000000-0000-4000-8000-000000000003', 'site.ifc', '/documents', '2026-01-03T00:00:00.000Z'),
      // Not a model: excluded by the type filter, its folder never appears.
      doc('a0000000-0000-4000-8000-000000000004', 'minutes.pdf', '/documents/protocols', '2026-01-04T00:00:00.000Z'),
      // Upper-case extension, as some uploads report it.
      { ...doc('a0000000-0000-4000-8000-000000000005', 'MEP.IFC', '/documents/models/mep', '2026-01-05T00:00:00.000Z'), file_type: 'IFC' },
    ],
    p2: [],
  },
};

function setup(world: MockWorld = WORLD) {
  const api = createMockApi(world);
  const provider = new BuildagilProvider({ clientId: 'client-1' });
  return { api, provider, ctx: api.createContext() };
}

describe('BuildagilProvider', () => {
  // Token managers are cached per client id for the page's lifetime (so a
  // sign-out reaches an in-flight refresh); each test starts signed out.
  beforeEach(async () => {
    const { provider, ctx } = setup();
    await provider.auth.signOut(ctx);
  });

  it('lists projects and filters them by name or number', async () => {
    const { api, provider, ctx } = setup();
    await api.signIn();
    expect((await provider.listProjects(ctx)).items.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect((await provider.listProjects(ctx, { query: 't-01' })).items.map((p) => p.name)).toEqual(['Tower']);
    expect(api.calls[0].url.toString()).toBe('https://openapi.buildagil.com/1.0/projects');
    expect(api.calls[0].headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('builds the folder tree from model documents only, in one scan', async () => {
    const { api, provider, ctx } = setup();
    await api.signIn();
    const tree = (await provider.listContainers(ctx, 'p1')).items;
    expect(tree.map((f) => [f.id, f.parentId, f.hasChildren])).toEqual([
      ['/documents', undefined, true],
      ['/documents/models', '/documents', true],
      ['/documents/models/architecture', '/documents/models', false],
      ['/documents/models/mep', '/documents/models', false],
      ['/documents/models/structure', '/documents/models', false],
    ]);
    expect(tree[0].name).toBe('Documents');
    const files = await provider.listFiles(ctx, 'p1', '/documents/models/structure');
    expect(files.items.map((f) => [f.name, f.currentRevisionId, f.containerId])).toEqual([['STR.ifczip', '1', '/documents/models/structure']]);
    expect((await provider.listFiles(ctx, 'p1', '/documents')).items.map((f) => f.name)).toEqual(['site.ifc']);
    // Folders and files came from one cached scan.
    expect(api.calls.filter((c) => c.url.pathname.endsWith('/documents'))).toHaveLength(1);
    const filter = api.calls[0].url.searchParams.get('$filter') ?? '';
    expect(filter).toContain("file_type eq 'ifc'");
    expect(filter).toContain("file_type eq 'IFCZIP'");
  });

  it('scans past the 100-document page by creation time without losing or repeating any', async () => {
    const world: MockWorld = { projects: [{ project_id: 'big', name: 'Big' }], documents: { big: manyDocuments(250) } };
    const { api, provider, ctx } = setup(world);
    await api.signIn();
    const files = await provider.listFiles(ctx, 'big', '/documents/bulk', undefined, { limit: 500 });
    expect(files.items).toHaveLength(250);
    expect(new Set(files.items.map((f) => f.id)).size).toBe(250);
    const pages = api.calls.filter((c) => c.url.pathname.endsWith('/documents'));
    expect(pages).toHaveLength(3);
    expect(pages[1].url.searchParams.get('$filter')).toContain('creation_date ge 2026-01-01T00:01:39.000Z');
  });

  it('refuses a project too large to list completely', async () => {
    const world: MockWorld = { projects: [{ project_id: 'huge', name: 'Huge' }], documents: { huge: manyDocuments(MAX_SCANNED_DOCUMENTS) } };
    const { api, provider, ctx } = setup(world);
    await api.signIn();
    await expect(provider.listContainers(ctx, 'huge')).rejects.toThrow(/more than 5000 IFC documents/);
  });

  it('stops instead of looping when a full page cannot advance the cursor', async () => {
    const tied = manyDocuments(150).map((d) => ({ ...d, creation_date: '2026-01-01T00:00:00.000Z' }));
    const { api, provider, ctx } = setup({ projects: [{ project_id: 't', name: 'T' }], documents: { t: tied } });
    await api.signIn();
    await expect(provider.listContainers(ctx, 't')).rejects.toThrow(/cannot continue/);
  });

  it('lists revisions newest first and downloads a named revision by its index', async () => {
    const { api, provider, ctx } = setup();
    await api.signIn();
    const ref = { projectId: 'p1', containerId: '/documents/models/architecture', fileId: 'a0000000-0000-4000-8000-000000000001' };
    const revisions = await provider.listRevisions(ctx, ref);
    expect(revisions.items.map((r) => [r.id, r.label])).toEqual([['3', 'Version 3.0'], ['2', 'Version 2.0'], ['1', 'Version 1.0']]);
    const progress: number[] = [];
    const old = await provider.download(ctx, { ...ref, revisionId: '1' }, { onProgress: (received) => progress.push(received) });
    expect(new TextDecoder().decode(old)).toBe('ARC.ifc@1');
    expect(progress.at(-1)).toBe('ARC.ifc@1'.length);
    expect(new TextDecoder().decode(await provider.download(ctx, ref))).toBe('ARC.ifc@3');
    expect(api.calls.at(-1)?.url.pathname).toBe('/1.0/projects/p1/documents/a0000000-0000-4000-8000-000000000001');
    await expect(provider.download(ctx, { ...ref, revisionId: '../x' })).rejects.toThrow(/Invalid buildagil revision/);
  });

  it('searches through POST /1.0/search, keeps model files, and pages by offset', async () => {
    const { api, provider, ctx } = setup();
    await api.signIn();
    const first = await provider.searchFiles(ctx, 'p1', 'i', undefined, { limit: 2 });
    const call = api.calls.at(-1)!;
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({ targets: ['Document'], search_text: 'i', project_ids: ['p1'], limit: 2, offset: 0 });
    expect(first.cursor).toBe('2');
    const second = await provider.searchFiles(ctx, 'p1', 'i', undefined, { cursor: first.cursor, limit: 2 });
    const names = [...first.items, ...second.items].map((f) => f.name);
    expect(names).not.toContain('minutes.pdf');
    expect(names).toContain('site.ifc');
  });

  it('reports a rejected session as needing a new sign-in', async () => {
    const { provider, ctx, api } = setup();
    await expect(provider.listProjects(ctx)).rejects.toThrow(/Not signed in|sign in/i);
    await api.storage.set('buildagil:tokens', JSON.stringify({ accessToken: 'stale', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }));
    await expect(provider.listProjects(ctx)).rejects.toMatchObject({ status: 401, reauthenticationRequired: true });
  });

  it('forgets cached scans on sign-out', async () => {
    const { api, provider, ctx } = setup();
    await api.signIn();
    await provider.listContainers(ctx, 'p1');
    await provider.auth.signOut(ctx);
    expect(await provider.auth.getIdentity(ctx)).toBeNull();
    await expect(provider.listContainers(ctx, 'p1')).rejects.toThrow();
  });
});
