/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { SourceFileRef, UploadResult } from '@ifc-lite/plugin-api';

import { DaluxBuildProvider } from '../src/provider.js';
import { DALUX_MANIFEST } from '../src/manifest.js';
import { fileAreaContainerId, folderContainerId } from '../src/mapping.js';
import {
  contentDisposition,
  daluxFileTypeFor,
  uploadToDalux,
  DaluxUploadError,
  DALUX_DEFAULT_PART_BYTES,
} from '../src/upload.js';
import {
  createDaluxApiMock,
  createDaluxMockContext,
  DALUX_MOCK_BASE_URL,
  type DaluxMockWorld,
} from './dalux-api-mock.js';

const WORLD: DaluxMockWorld = {
  projects: [
    {
      projectId: 'p1',
      projectName: 'Project',
      fileAreas: [
        {
          fileAreaId: 'fa-files',
          fileAreaName: 'Files',
          fileAreaType: 'files',
          folders: [
            { folderId: 'fld-ifc', folderName: 'IFC' },
            { folderId: 'fld-strict', folderName: 'Strict', requiredProperties: ['Discipline'] },
          ],
          files: [
            {
              fileId: 'file-a',
              fileName: 'a.ifc',
              folderId: 'fld-ifc',
              fileRevisionId: 'rev-1',
              fileType: 'model',
              content: 'A-ONE',
              properties: [{ key: 'discipline', name: 'Discipline', values: [{ text: 'ARC' }] }],
            },
            { fileId: 'file-root', fileName: 'root.txt', fileRevisionId: 'rev-r', fileType: 'document', content: 'R' },
            { fileId: 'file-gone', fileName: 'gone.ifc', folderId: 'fld-ifc', deleted: true, content: 'X' },
          ],
        },
        {
          fileAreaId: 'fa-pub',
          fileAreaName: 'Published',
          fileAreaType: 'published',
          folders: [{ folderId: 'fld-pub', folderName: 'Pub' }],
          files: [{ fileId: 'file-pub', fileName: 'p.ifc', fileRevisionId: 'rev-p', fileType: 'model', content: 'P' }],
        },
      ],
    },
  ],
};

interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function setup(fetchWorld: DaluxMockWorld = WORLD) {
  const inner = createDaluxApiMock(fetchWorld, { pageSize: 100 });
  const calls: Call[] = [];
  const recording = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      path: new URL(input.toString()).pathname.replace('/service/api', ''),
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    return inner(input, init);
  }) as typeof fetch;
  const ctx = createDaluxMockContext(recording);
  const provider = new DaluxBuildProvider();
  const posts = () => calls.filter((call) => call.method === 'POST');
  return { calls, ctx, provider, posts, fetchImpl: inner };
}

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const textOf = async (provider: DaluxBuildProvider, ctx: ReturnType<typeof setup>['ctx'], ref: SourceFileRef) =>
  new TextDecoder().decode(await provider.download(ctx, ref));

function ok(result: UploadResult) {
  if (!result.ok) throw new Error(`expected success, got conflict ${JSON.stringify(result.conflict)}`);
  return result;
}

const FILE_A: SourceFileRef = {
  projectId: 'p1',
  containerId: folderContainerId('fa-files', 'fld-ifc'),
  fileId: 'file-a',
};

describe('Dalux write-back', () => {
  it('declares all three modes and implements uploadFile', () => {
    expect(DALUX_MANIFEST.capabilities?.writeBack).toEqual(['new-version', 'new-file', 'new-location']);
    expect(typeof new DaluxBuildProvider().uploadFile).toBe('function');
  });

  it('new-version: slot, one part, finalize with fileId, and the file now serves the new bytes', async () => {
    const { ctx, provider, posts } = setup();
    const result = ok(
      await provider.uploadFile(ctx, { mode: 'new-version', ref: FILE_A, baseRevisionId: 'rev-1' }, bytesOf('A-TWO')),
    );

    expect(result.file.id).toBe('file-a');
    expect(result.file.name).toBe('a.ifc');
    expect(result.revision.id).not.toBe('rev-1');
    expect(result.file.currentRevisionId).toBe(result.revision.id);

    const [slot, part, finalize] = posts();
    expect(slot.path).toBe('/1.0/projects/p1/file_areas/fa-files/upload');
    expect(part.path).toMatch(/^\/1\.0\/projects\/p1\/file_areas\/fa-files\/upload\/upload-\d+$/);
    expect(part.headers.get('content-range')).toBe('bytes 0-4/5');
    expect(part.headers.get('content-type')).toBe('application/octet-stream');
    expect(part.headers.get('x-api-key')).toBe('conformance-key');
    expect(finalize.path).toMatch(/^\/2\.0\/projects\/p1\/file_areas\/fa-files\/upload\/upload-\d+\/finalize$/);
    const meta = JSON.parse(String(finalize.body));
    expect(meta).toMatchObject({ fileName: 'a.ifc', fileType: 'model', fileId: 'file-a' });
    expect(meta.folderId).toBeUndefined();
    // The existing properties ride along so required-property folders accept the revision.
    expect(meta.properties).toEqual([{ key: 'discipline', name: 'Discipline', values: [{ text: 'ARC' }] }]);

    expect(await textOf(provider, ctx, { ...FILE_A, revisionId: result.revision.id })).toBe('A-TWO');
  });

  it('new-version without a base revision skips the stale check', async () => {
    const { ctx, provider } = setup();
    ok(await provider.uploadFile(ctx, { mode: 'new-version', ref: FILE_A }, bytesOf('X')));
  });

  it('new-version: a stale base is a conflict and nothing is posted', async () => {
    const { ctx, provider, posts } = setup();
    const result = await provider.uploadFile(
      ctx,
      { mode: 'new-version', ref: FILE_A, baseRevisionId: 'rev-OLD' },
      bytesOf('X'),
    );
    expect(result).toEqual({ ok: false, conflict: { kind: 'stale-base', currentRevisionId: 'rev-1' } });
    expect(posts()).toHaveLength(0);
  });

  it('new-version: a deleted file is refused with guidance, not a conflict', async () => {
    const { ctx, provider } = setup();
    await expect(
      provider.uploadFile(
        ctx,
        { mode: 'new-version', ref: { ...FILE_A, fileId: 'file-gone' } },
        bytesOf('X'),
      ),
    ).rejects.toThrow(/deleted/);
  });

  it('new-file: creates the file in the folder via folderId, with fileType from the extension', async () => {
    const { ctx, provider, posts } = setup();
    const container = folderContainerId('fa-files', 'fld-ifc');
    const result = ok(
      await provider.uploadFile(
        ctx,
        { mode: 'new-file', projectId: 'p1', containerId: container, fileName: 'a-edited.ifc' },
        bytesOf('NEW-BYTES'),
      ),
    );

    expect(result.file.name).toBe('a-edited.ifc');
    expect(result.file.containerId).toBe(container);
    const meta = JSON.parse(String(posts().at(-1)?.body));
    expect(meta).toEqual({ fileName: 'a-edited.ifc', fileType: 'model', folderId: 'fld-ifc' });
    expect(
      await textOf(provider, ctx, {
        projectId: 'p1',
        containerId: container,
        fileId: result.file.id,
        revisionId: result.revision.id,
      }),
    ).toBe('NEW-BYTES');
  });

  it('new-location: the file area root uses the area id as the folder id', async () => {
    const { ctx, provider, posts } = setup();
    const result = ok(
      await provider.uploadFile(
        ctx,
        {
          mode: 'new-location',
          projectId: 'p1',
          containerId: fileAreaContainerId('fa-files'),
          fileName: 'moved.ifc',
        },
        bytesOf('M'),
      ),
    );
    expect(JSON.parse(String(posts().at(-1)?.body)).folderId).toBe('fa-files');
    expect(result.file.containerId).toBe(fileAreaContainerId('fa-files'));
  });

  it('name-exists: same name in the same folder (case-insensitive) conflicts and posts nothing', async () => {
    const { ctx, provider, posts } = setup();
    const result = await provider.uploadFile(
      ctx,
      {
        mode: 'new-file',
        projectId: 'p1',
        containerId: folderContainerId('fa-files', 'fld-ifc'),
        fileName: 'A.IFC',
      },
      bytesOf('X'),
    );
    expect(result).toEqual({ ok: false, conflict: { kind: 'name-exists', existingFileId: 'file-a' } });
    expect(posts()).toHaveLength(0);
  });

  it('the same name in another folder, or matching a deleted file, is not a conflict', async () => {
    const { ctx, provider } = setup();
    ok(
      await provider.uploadFile(
        ctx,
        { mode: 'new-location', projectId: 'p1', containerId: fileAreaContainerId('fa-files'), fileName: 'a.ifc' },
        bytesOf('X'),
      ),
    );
    ok(
      await provider.uploadFile(
        ctx,
        {
          mode: 'new-file',
          projectId: 'p1',
          containerId: folderContainerId('fa-files', 'fld-ifc'),
          fileName: 'gone.ifc',
        },
        bytesOf('X'),
      ),
    );
  });

  it('refuses published and shared file areas with a clear error, before posting', async () => {
    const { ctx, provider, posts } = setup();
    await expect(
      provider.uploadFile(
        ctx,
        { mode: 'new-file', projectId: 'p1', containerId: fileAreaContainerId('fa-pub'), fileName: 'x.ifc' },
        bytesOf('X'),
      ),
    ).rejects.toThrow(/published file area/);
    await expect(
      provider.uploadFile(
        ctx,
        {
          mode: 'new-version',
          ref: { projectId: 'p1', containerId: fileAreaContainerId('fa-pub'), fileId: 'file-pub' },
        },
        bytesOf('X'),
      ),
    ).rejects.toThrow(/published file area/);
    expect(posts()).toHaveLength(0);
  });

  it('refuses a folder with required properties instead of failing at finalize', async () => {
    const { ctx, provider, posts } = setup();
    await expect(
      provider.uploadFile(
        ctx,
        {
          mode: 'new-file',
          projectId: 'p1',
          containerId: folderContainerId('fa-files', 'fld-strict'),
          fileName: 'x.ifc',
        },
        bytesOf('X'),
      ),
    ).rejects.toThrow(/requires file properties \(Discipline\)/);
    expect(posts()).toHaveLength(0);
  });

  it('proceeds when the property mapping lookup itself fails', async () => {
    const { ctx, provider } = setup();
    const real = ctx.fetch;
    const failingMappings = ((input: RequestInfo | URL, init?: RequestInit) =>
      input.toString().includes('/properties/1.0/mappings')
        ? Promise.resolve(new Response('nope', { status: 404 }))
        : real(input, init)) as typeof fetch;
    ok(
      await provider.uploadFile(
        { ...ctx, fetch: failingMappings },
        {
          mode: 'new-file',
          projectId: 'p1',
          containerId: folderContainerId('fa-files', 'fld-strict'),
          fileName: 'x.ifc',
        },
        bytesOf('X'),
      ),
    );
  });

  it('rejects a mode the manifest does not declare, an empty file and bad names', async () => {
    const { ctx, provider } = setup();
    const container = folderContainerId('fa-files', 'fld-ifc');
    await expect(
      provider.uploadFile(ctx, { mode: 'nope' as 'new-file', projectId: 'p1', containerId: container, fileName: 'x' }, bytesOf('X')),
    ).rejects.toThrow(/does not support write-back mode/);
    await expect(
      provider.uploadFile(ctx, { mode: 'new-file', projectId: 'p1', containerId: container, fileName: 'x.ifc' }, new ArrayBuffer(0)),
    ).rejects.toThrow(DaluxUploadError);
    for (const fileName of ['', '   ', 'a/b.ifc', 'a\\b.ifc', 'a\nb.ifc', 'x'.repeat(256)]) {
      await expect(
        provider.uploadFile(ctx, { mode: 'new-file', projectId: 'p1', containerId: container, fileName }, bytesOf('X')),
      ).rejects.toThrow(DaluxUploadError);
    }
  });

  describe('chunking', () => {
    const container = folderContainerId('fa-files', 'fld-ifc');
    const credentials = { baseUrl: DALUX_MOCK_BASE_URL, apiKey: 'k' };

    async function run(size: number, partSizeBytes: number) {
      const { ctx, posts, provider } = setup();
      const payload = 'abcdefghij'.repeat(Math.ceil(size / 10)).slice(0, size);
      const progress: Array<[number, number]> = [];
      const result = ok(
        await uploadToDalux(
          ctx,
          credentials,
          { mode: 'new-file', projectId: 'p1', containerId: container, fileName: `n${size}.ifc` },
          bytesOf(payload),
          { onProgress: (sent, total) => progress.push([sent, total]) },
          { partSizeBytes },
        ),
      );
      const ranges = posts()
        .filter((call) => call.headers.has('content-range'))
        .map((call) => call.headers.get('content-range'));
      const stored = await textOf(provider, ctx, {
        projectId: 'p1',
        containerId: container,
        fileId: result.file.id,
        revisionId: result.revision.id,
      });
      return { ranges, progress, stored, payload };
    }

    it('splits on exact multiples without an empty trailing part', async () => {
      const { ranges, progress, stored, payload } = await run(30, 10);
      expect(ranges).toEqual(['bytes 0-9/30', 'bytes 10-19/30', 'bytes 20-29/30']);
      expect(progress).toEqual([[10, 30], [20, 30], [30, 30]]);
      expect(stored).toBe(payload);
    });

    it('puts the remainder in a short final part', async () => {
      const { ranges, stored, payload } = await run(25, 10);
      expect(ranges).toEqual(['bytes 0-9/25', 'bytes 10-19/25', 'bytes 20-24/25']);
      expect(stored).toBe(payload);
    });

    it('sends a payload of exactly one part and one smaller than a part as a single request', async () => {
      expect((await run(10, 10)).ranges).toEqual(['bytes 0-9/10']);
      expect((await run(3, 10)).ranges).toEqual(['bytes 0-2/3']);
    });

    it('defaults to parts no larger than the relay accepts', async () => {
      // The same-origin relay refuses a body over 4 MiB, so the default part
      // size must never exceed it, whatever Dalux itself would accept.
      expect(DALUX_DEFAULT_PART_BYTES).toBe(4 * 1024 * 1024);
      const { ctx, posts } = setup();
      const size = DALUX_DEFAULT_PART_BYTES * 2 + 5;
      await uploadToDalux(
        ctx,
        credentials,
        { mode: 'new-file', projectId: 'p1', containerId: container, fileName: 'default-parts.ifc' },
        new Uint8Array(size).buffer,
      );
      const ranges = posts()
        .filter((call) => call.headers.has('content-range'))
        .map((call) => call.headers.get('content-range'));
      const last = DALUX_DEFAULT_PART_BYTES * 2;
      expect(ranges).toEqual([
        `bytes 0-${DALUX_DEFAULT_PART_BYTES - 1}/${size}`,
        `bytes ${DALUX_DEFAULT_PART_BYTES}-${last - 1}/${size}`,
        `bytes ${last}-${size - 1}/${size}`,
      ]);
    });

    it('never exceeds the 100 MiB ceiling', async () => {
      const { ctx } = setup();
      await expect(
        uploadToDalux(
          ctx,
          credentials,
          { mode: 'new-file', projectId: 'p1', containerId: container, fileName: 'big.ifc' },
          bytesOf('X'),
          undefined,
          { partSizeBytes: 104_857_601 },
        ),
      ).rejects.toThrow(RangeError);
    });

    it('does not alias the caller buffer into the parts', async () => {
      const { ctx, posts } = setup();
      const buffer = bytesOf('abcdef');
      await uploadToDalux(
        ctx,
        credentials,
        { mode: 'new-file', projectId: 'p1', containerId: container, fileName: 'alias.ifc' },
        buffer,
        undefined,
        { partSizeBytes: 3 },
      );
      const part = posts().find((call) => call.headers.has('content-range'))?.body as Uint8Array;
      new Uint8Array(buffer).fill(0);
      expect(new TextDecoder().decode(part)).toBe('abc');
    });
  });

  describe('abort', () => {
    it('aborting before the first request posts nothing', async () => {
      const { ctx, provider, posts } = setup();
      const controller = new AbortController();
      controller.abort();
      await expect(
        provider.uploadFile(
          ctx,
          { mode: 'new-version', ref: FILE_A },
          bytesOf('X'),
          { signal: controller.signal },
        ),
      ).rejects.toThrow();
      expect(posts()).toHaveLength(0);
    });

    it('aborting between parts stops before finalize, so no file or revision appears', async () => {
      const { ctx, provider, posts } = setup();
      const controller = new AbortController();
      const container = folderContainerId('fa-files', 'fld-ifc');
      const promise = uploadToDalux(
        ctx,
        { baseUrl: DALUX_MOCK_BASE_URL, apiKey: 'k' },
        { mode: 'new-file', projectId: 'p1', containerId: container, fileName: 'abort.ifc' },
        bytesOf('abcdefghij'),
        { signal: controller.signal, onProgress: (sent) => sent >= 4 && controller.abort() },
        { partSizeBytes: 4 },
      );
      await expect(promise).rejects.toThrow();
      expect(posts().some((call) => call.path.endsWith('/finalize'))).toBe(false);
      const files = await provider.listFiles(ctx, 'p1', container);
      expect(files.items.map((file) => file.name)).not.toContain('abort.ifc');
    });
  });

  it('surfaces a Dalux rejection at finalize with its status', async () => {
    const { ctx, provider } = setup();
    const real = ctx.fetch;
    const rejecting = ((input: RequestInfo | URL, init?: RequestInit) =>
      input.toString().includes('/finalize')
        ? Promise.resolve(new Response('Required property missing', { status: 400, statusText: 'Bad Request' }))
        : real(input, init)) as typeof fetch;
    await expect(
      provider.uploadFile(
        { ...ctx, fetch: rejecting },
        { mode: 'new-version', ref: FILE_A },
        bytesOf('X'),
      ),
    ).rejects.toThrow(/Dalux API 400.*Required property missing/);
  });

  it('forwards the node selector on every upload request when the user is on another node', async () => {
    const { ctx, provider, calls } = setup();
    const seen: string[] = [];
    const real = ctx.fetch;
    const spy = ((input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') seen.push(new URL(input.toString()).searchParams.get('daluxNode') ?? '');
      return real(input, init);
    }) as typeof fetch;
    const nodeCtx = {
      ...ctx,
      fetch: spy,
      getPreference: (name: string) =>
        Promise.resolve(name === 'apiKey' ? 'k' : name === 'baseUrl' ? 'https://node2.field.dalux.com/service/api' : undefined),
    };
    ok(await provider.uploadFile(nodeCtx, { mode: 'new-version', ref: FILE_A }, bytesOf('X')));
    expect(seen).toEqual(['node2', 'node2', 'node2']);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('upload helpers', () => {
  it('maps extensions to Dalux file types', () => {
    expect(daluxFileTypeFor('a.IFC')).toBe('model');
    expect(daluxFileTypeFor('a.ifczip')).toBe('model');
    expect(daluxFileTypeFor('plan.pdf')).toBe('drawing');
    expect(daluxFileTypeFor('notes.txt')).toBe('document');
    expect(daluxFileTypeFor('noextension')).toBe('document');
  });

  it('encodes Content-Disposition with an ASCII fallback and an RFC 5987 name', () => {
    expect(contentDisposition('file name.ifc')).toBe(
      `form-data; filename="file name.ifc"; filename*=UTF-8''file%20name.ifc`,
    );
    const value = contentDisposition(`Gebäude "A"'s (v2).ifc`);
    expect(value).toContain('filename="Geb_ude _A_\'s (v2).ifc"');
    expect(value).toContain(`filename*=UTF-8''Geb%C3%A4ude%20%22A%22%27s%20%28v2%29.ifc`);
  });
});
