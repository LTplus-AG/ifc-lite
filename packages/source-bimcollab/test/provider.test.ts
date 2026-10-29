/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import type { PluginContext } from '@ifc-lite/plugin-api';
import { BimcollabProvider, RelayBimcollabTransport, DirectBimcollabTransport, BimcollabHttpError,
  spaceIdFromAccessToken, spaceLabelFromServerUrl } from '../src/index.js';

const guid = '12345678-1234-1234-1234-123456789abc';
const session = { spaceGuid: guid, spaceLabel: 'demo', getAccessToken: async () => 'secret-token' };
const structure = { locations: [{ locationId: 'loc', name: 'Location', projects: [
  { projectId: 'p', name: 'Project', projectPhases: [] },
  { projectId: 'phased', name: 'Phased', projectPhases: [{ projectPhaseId: 'phase', name: 'Design' }] },
] }] };
const version = { documentVersionId: 'v', documentId: 'd', versionNumber: '1', versionDate: '2026-01-01', fileName: 'model.ifczip' };
const document = { documentId: 'd', documentNumber: 'D1', latestVersion: version };
const record = { documentId: 1, documentNumber: 'D1', versionNumber: '1', versionId: 42, fileName: 'model.ifczip',
  allowDownload: true, locationId: 2, locationName: 'Location', projectId: 1, projectName: 'Project', projectPhaseName: null };
const ref = { projectId: 'p', containerId: 'root', fileId: 'd' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function setup(options: { fallback?: boolean; records?: unknown[]; legacy?: boolean } = {}) {
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret-token');
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('error');
    if (url.endsWith('project-structure')) return json(structure);
    if (url.includes('/document-versions') && !url.endsWith('/download')) return json([version]);
    if (url.includes('/index?')) return json({ records: url.endsWith('=1') ? [] : options.records ?? [record] });
    if (url.includes('/space/') && url.endsWith('/download/42')) return new Response('IFC');
    if (url.endsWith('/download')) return options.legacy === false ? json({ downloadUrl: 'https://storage.blob.core.windows.net/model?sas=private' })
      : json('No download URL available for this document', 404);
    if (url.includes('/documents?')) return json([document]);
    throw new Error(`Unexpected fake route: ${url}`);
  });
  const fetchPublic = vi.fn<PluginContext['fetchPublic']>(async (_url, init) => {
    expect(init).not.toHaveProperty('headers');
    return new Response('IFC');
  });
  const ctx: PluginContext = { fetch: fetchFn, fetchPublic, getPreference: async () => undefined,
    storage: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  const provider = new BimcollabProvider({ session, transport: new RelayBimcollabTransport('/api/bimcollab', fetchFn), legacyDownloadFallback: options.fallback });
  return { ctx, provider, fetchFn, fetchPublic };
}

describe('BIMcollab source provider (fake transport only)', () => {
  it('maps locations and projects and retains location identity', async () => {
    const { provider, ctx } = setup();
    expect((await provider.listProjects(ctx)).items[0]).toEqual({ id: 'p', name: 'Project', meta: { locationId: 'loc', locationName: 'Location' } });
    expect((await provider.listProjects(ctx, { query: 'phased' })).items).toHaveLength(1);
  });
  it('lists phases or a root leaf when there are no phases', async () => {
    const { provider, ctx } = setup();
    expect((await provider.listContainers(ctx, 'p')).items).toEqual([{ id: 'root', name: 'Project', hasChildren: false }]);
    expect((await provider.listContainers(ctx, 'phased')).items[0]?.id).toBe('phase');
    expect((await provider.listContainers(ctx, 'phased', 'phase')).items).toEqual([]);
  });
  it('pages raw documents before filtering, clamps page sizes, routes phase listings and search', async () => {
    const { provider, ctx, fetchFn } = setup();
    const docs = [document, ...['x.ifc', 'x.IFCXML', 'x.ifcx', 'x.pdf'].map((name, i) => ({ ...document, documentId: String(i), latestVersion: { ...version, fileName: name } })),
      { ...document, archived: true }, { ...document, confidential: true }];
    fetchFn.mockResolvedValueOnce(json(docs));
    const page = await provider.listFiles(ctx, 'p', 'phase', undefined, { limit: 7 });
    expect(page.items.map(f => f.name)).toEqual(['model.ifczip', 'x.ifc', 'x.IFCXML', 'x.ifcx']);
    expect(page.cursor).toBe('7');
    await provider.listFiles(ctx, 'p', 'phase', undefined, { cursor: page.cursor, limit: 1000 });
    expect(String(fetchFn.mock.calls.at(-1)?.[0])).toContain('project-phases/phase/documents?limit=100&offset=7');
    await provider.searchFiles(ctx, 'p', 'A & B');
    expect(String(fetchFn.mock.calls.at(-1)?.[0])).toContain('searchText=A+%26+B');
    await expect(provider.listFiles(ctx, 'p', 'root', undefined, { cursor: '-1' })).rejects.toThrow('paging');
  });
  it('applies filename filters and lists versions', async () => {
    const { provider, ctx } = setup();
    expect((await provider.listFiles(ctx, 'p', 'root', { namePatterns: ['*.ifc'] })).items).toHaveLength(0);
    expect((await provider.listRevisions(ctx, ref)).items).toEqual([{ id: 'v', label: '1', createdAt: '2026-01-01' }]);
  });
  it('uses credential-free presigned fetch and reports actual bytes', async () => {
    const { provider, ctx, fetchPublic } = setup({ legacy: false });
    const onProgress = vi.fn();
    const signal = new AbortController().signal;
    expect(new TextDecoder().decode(await provider.download(ctx, ref, { signal, onProgress }))).toBe('IFC');
    expect(fetchPublic).toHaveBeenCalledWith(expect.stringContaining('https://storage.blob.core.windows.net/'), { signal });
    expect(onProgress).toHaveBeenLastCalledWith(3, 3);
  });
  it('never attaches bearer credentials to a SAS URL in the concrete fetchPublic adapter', async () => {
    const { provider, ctx } = setup({ legacy: false });
    const publicFetch = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      expect(init?.credentials).toBe('omit');
      return new Response('IFC');
    });
    await provider.download({ ...ctx, fetchPublic: (url, init) => publicFetch(url, { signal: init?.signal, credentials: 'omit' }) }, ref);
    expect(publicFetch).toHaveBeenCalledTimes(1);
  });
  it('falls back on the specific 404, probes locations sequentially, caches the index and downloads numeric version', async () => {
    const { provider, ctx, fetchFn } = setup();
    expect(new TextDecoder().decode(await provider.download(ctx, ref))).toBe('IFC');
    await provider.download(ctx, ref);
    const indexes = fetchFn.mock.calls.map(call => String(call[0])).filter(url => url.includes('/index?'));
    expect(indexes).toEqual(['/api/bimcollab/space/demo/index?locationId=1', '/api/bimcollab/space/demo/index?locationId=2']);
    expect(fetchFn.mock.calls.filter(call => String(call[0]).endsWith('/space/demo/download/42'))).toHaveLength(2);
  });
  it('expires cached indexes after a short TTL', async () => {
    const { provider, ctx, fetchFn } = setup();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      await provider.download(ctx, ref);
      now.mockReturnValue(62_000);
      await provider.download(ctx, ref);
      expect(fetchFn.mock.calls.filter(call => String(call[0]).includes('/index?'))).toHaveLength(4);
    } finally { now.mockRestore(); }
  });
  it('accepts a project-name match when the location name is unavailable', async () => {
    const { provider, ctx } = setup({ records: [{ ...record, locationName: 'Other' }] });
    expect(new TextDecoder().decode(await provider.download(ctx, ref))).toBe('IFC');
  });
  it('honors download permission and rejects ambiguous or missing matches', async () => {
    for (const [records, message] of [ [[{ ...record, allowDownload: false }], 'does not allow'],
      [[record, record], 'found 2'], [[{ ...record, versionNumber: 'other' }], 'found 0'] ] as const) {
      const { provider, ctx } = setup({ records: [...records] });
      await expect(provider.download(ctx, ref)).rejects.toThrow(message);
    }
  });
  it('bounds location probing and refuses historical-version substitution', async () => {
    const empty = setup({ records: [] });
    await expect(empty.provider.download(empty.ctx, ref)).rejects.toThrow('1–10');
    expect(empty.fetchFn.mock.calls.filter(call => String(call[0]).includes('/index?'))).toHaveLength(10);
    const old = setup();
    await expect(old.provider.download(old.ctx, { ...ref, revisionId: 'unknown-old' })).rejects.toThrow('version number');
  });
  it('can disable the legacy fallback and does not fallback on unrelated 404', async () => {
    const disabled = setup({ fallback: false });
    await expect(disabled.provider.download(disabled.ctx, ref)).rejects.toThrow(BimcollabHttpError);
    expect(disabled.fetchFn.mock.calls).toHaveLength(1);
    const unrelated = setup();
    unrelated.fetchFn.mockResolvedValueOnce(json('Not found', 404));
    await expect(unrelated.provider.download(unrelated.ctx, ref)).rejects.toThrow(BimcollabHttpError);
    expect(unrelated.fetchFn.mock.calls).toHaveLength(1);
  });
  it.each([401, 403])('maps status %i without reflecting tokens or upstream bodies', async status => {
    const { provider, ctx, fetchFn } = setup();
    fetchFn.mockResolvedValueOnce(json('secret-token', status));
    const error = await provider.listProjects(ctx).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(BimcollabHttpError);
    expect(String(error)).toContain(status === 401 ? 'sign in again' : 'no document access in this space');
    expect(String(error)).not.toContain('secret-token');
    expect((error as BimcollabHttpError).reauthenticationRequired).toBe(status === 401);
  });
  it('aborts before requesting credentials and forwards the signal at every hop', async () => {
    const { provider, ctx, fetchFn } = setup();
    const controller = new AbortController(); controller.abort();
    await expect(provider.download(ctx, ref, { signal: controller.signal })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    await provider.download(ctx, ref, { signal });
    expect(fetchFn.mock.calls.every(call => call[1]?.signal === signal)).toBe(true);
  });
  it('supports Node public API access using an injected direct transport', async () => {
    const { ctx } = setup();
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(`https://api.eu.bimcollab.com/spaces/${guid}/documents/v1/project-structure`);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret-token');
      return json(structure);
    });
    const provider = new BimcollabProvider({ session, transport: new DirectBimcollabTransport(fetchFn) });
    expect((await provider.listProjects(ctx)).items).toHaveLength(2);
  });
  it('extracts space claims and validates space host labels', () => {
    const jwt = (value: unknown) => `header.${btoa(JSON.stringify(value)).replace(/=/g, '')}.signature`;
    expect(spaceIdFromAccessToken(jwt({ spaceGuid: guid.toUpperCase() }))).toBe(guid);
    expect(spaceIdFromAccessToken(jwt({ otherSpace: [guid] }))).toBe(guid);
    expect(spaceIdFromAccessToken('malformed')).toBe('');
    expect(spaceIdFromAccessToken('header.%%%.sig')).toBe('');
    expect(spaceIdFromAccessToken(jwt({ spaceGuid: 'not-a-guid' }))).toBe('');
    expect(spaceLabelFromServerUrl('https://demo.bimcollab.com/bcf')).toBe('demo');
    for (const url of ['https://bimcollab.com/bcf', 'https://demo.bimcollab.com.evil/bcf', 'http://demo.bimcollab.com', 'invalid']) {
      expect(spaceLabelFromServerUrl(url)).toBe('');
    }
  });
});
