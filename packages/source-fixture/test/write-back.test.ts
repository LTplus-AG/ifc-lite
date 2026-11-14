/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { SourceFileRef } from '@ifc-lite/plugin-api';

import { createFixtureContext, createFixtureSourceProvider } from '../src/index.js';
import { describeOptionalMethodConformance } from '../src/conformance/optional-methods.js';
import { buildTestWorldSpec } from './world.js';

const ref: SourceFileRef = { projectId: 'proj-1', containerId: 'sub1', fileId: 'structural-model' };
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const allModes = ['new-version', 'new-file', 'new-location'] as const;

function writable() {
  return createFixtureSourceProvider({ world: buildTestWorldSpec(), capabilities: { writeBack: allModes } });
}

describe('write-back capability', () => {
  it('a default fixture is read-only', () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    expect(provider.uploadFile).toBeUndefined();
    expect(provider.manifest.capabilities.writeBack).toBeUndefined();
  });

  describe('optional-method conformance holds for read-only and writable providers', () => {
    describeOptionalMethodConformance(createFixtureSourceProvider({ world: buildTestWorldSpec() }));
    describeOptionalMethodConformance(writable());
  });

  it('refuses a mode it did not declare', async () => {
    const provider = createFixtureSourceProvider({
      world: buildTestWorldSpec(),
      capabilities: { writeBack: ['new-version'] },
    });
    await expect(
      provider.uploadFile!(createFixtureContext(), { mode: 'new-file', projectId: 'proj-1', containerId: 'sub1', fileName: 'x.ifc' }, bytes('x')),
    ).rejects.toThrow(/does not declare writeBack mode "new-file"/);
  });
});

describe('new-version', () => {
  it('appends a revision that becomes current and keeps the old bytes', async () => {
    const provider = writable();
    const ctx = createFixtureContext();
    const result = await provider.uploadFile!(ctx, { mode: 'new-version', ref, baseRevisionId: 'rev2' }, bytes('EDITED'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.currentRevisionId).toBe(result.revision.id);
    expect(result.revision.id).toBe('rev3');

    const revisions = await provider.listRevisions!(ctx, ref);
    expect(revisions.items.map((r) => r.id)).toEqual(['rev3', 'rev2', 'rev1']);
    expect(new TextDecoder().decode(await provider.download(ctx, ref))).toBe('EDITED');
    expect(new TextDecoder().decode(await provider.download(ctx, { ...ref, revisionId: 'rev2' }))).toContain('REVISION-2');
  });

  it('reports a stale-base conflict and writes nothing', async () => {
    const provider = writable();
    const ctx = createFixtureContext();
    const result = await provider.uploadFile!(ctx, { mode: 'new-version', ref, baseRevisionId: 'rev1' }, bytes('EDITED'));
    expect(result).toEqual({ ok: false, conflict: { kind: 'stale-base', currentRevisionId: 'rev2' } });
    expect((await provider.listRevisions!(ctx, ref)).items).toHaveLength(2);
  });

  it('skips the base check when baseRevisionId is omitted', async () => {
    const result = await writable().uploadFile!(createFixtureContext(), { mode: 'new-version', ref }, bytes('EDITED'));
    expect(result.ok).toBe(true);
  });
});

describe('new-file and new-location', () => {
  it('creates a file in the same container, listed and downloadable', async () => {
    const provider = writable();
    const ctx = createFixtureContext();
    const result = await provider.uploadFile!(
      ctx,
      { mode: 'new-file', projectId: 'proj-1', containerId: 'sub1', fileName: 'structural-model-v2.ifc' },
      bytes('NEW'),
      { mimeType: 'application/octet-stream' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.name).toBe('structural-model-v2.ifc');
    expect(result.file.containerId).toBe('sub1');

    const listed = await provider.listFiles(ctx, 'proj-1', 'sub1');
    expect(listed.items.map((f) => f.name)).toContain('structural-model-v2.ifc');
    const created: SourceFileRef = { projectId: 'proj-1', containerId: 'sub1', fileId: result.file.id };
    expect(new TextDecoder().decode(await provider.download(ctx, created))).toBe('NEW');
  });

  it('creates a file in a different container', async () => {
    const provider = writable();
    const ctx = createFixtureContext();
    const result = await provider.uploadFile!(
      ctx,
      { mode: 'new-location', projectId: 'proj-1', containerId: 'root2', fileName: 'copy.ifc' },
      bytes('COPY'),
    );
    expect(result.ok && result.file.containerId).toBe('root2');
    expect((await provider.listFiles(ctx, 'proj-1', 'root2')).items.map((f) => f.name)).toEqual(['copy.ifc']);
  });

  it('reports name-exists instead of overwriting', async () => {
    const provider = writable();
    const result = await provider.uploadFile!(
      createFixtureContext(),
      { mode: 'new-file', projectId: 'proj-1', containerId: 'sub1', fileName: 'structural-model.ifc' },
      bytes('NEW'),
    );
    expect(result).toEqual({ ok: false, conflict: { kind: 'name-exists', existingFileId: 'structural-model' } });
  });

  it('rejects an unknown container', async () => {
    await expect(
      writable().uploadFile!(
        createFixtureContext(),
        { mode: 'new-file', projectId: 'proj-1', containerId: 'nope', fileName: 'a.ifc' },
        bytes('x'),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('uploadFile plumbing', () => {
  it('honours injected failures and a pre-aborted signal', async () => {
    const provider = writable();
    provider.fixture.setFailure('uploadFile', { kind: 'throw', message: 'quota', status: 507 });
    await expect(provider.uploadFile!(createFixtureContext(), { mode: 'new-version', ref }, bytes('x'))).rejects.toMatchObject({ message: 'quota' });

    provider.fixture.setFailure('uploadFile', undefined);
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.uploadFile!(createFixtureContext(), { mode: 'new-version', ref }, bytes('x'), { signal: controller.signal }),
    ).rejects.toBeTruthy();
  });

  it('does not alias the caller\'s buffer', async () => {
    const provider = writable();
    const ctx = createFixtureContext();
    const buf = bytes('ORIGINAL');
    await provider.uploadFile!(ctx, { mode: 'new-version', ref }, buf);
    new Uint8Array(buf).fill(0);
    expect(new TextDecoder().decode(await provider.download(ctx, ref))).toBe('ORIGINAL');
  });
});


describe('write-back review regressions (#9526)', () => {
  it('keeps old revision bytes addressable when generated IDs have gaps', async () => {
    const world = buildTestWorldSpec();
    const projects = world.projects.map(project => ({ ...project, files: project.files.map(file => file.id === ref.fileId ? { ...file, revisions: [{ id: 'rev3', content: 'OLD-THREE' }, { id: 'rev1', content: 'OLD-ONE' }] } : file) }));
    const provider = createFixtureSourceProvider({ world: { projects }, capabilities: { writeBack: allModes } });
    const ctx = createFixtureContext();
    const result = await provider.uploadFile!(ctx, { mode: 'new-version', ref, baseRevisionId: 'rev3' }, bytes('NEW'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision.id).not.toBe('rev3');
    expect(new TextDecoder().decode(await provider.download(ctx, { ...ref, revisionId: 'rev3' }))).toBe('OLD-THREE');
    const watch = await provider.watchRevisions!(ctx, [{ ...ref, revisionId: 'rev3' }]);
    expect(watch.events[0]?.latestRevisionId).toBe(result.revision.id);
  });

  it('reports no byte progress for stale-base or existing-name conflicts', async () => {
    const provider = writable(), ctx = createFixtureContext(), progress: number[] = [];
    const options = { onProgress: (sent: number) => progress.push(sent) };
    const stale = await provider.uploadFile!(ctx, { mode: 'new-version', ref, baseRevisionId: 'old' }, bytes('X'), options);
    const existing = await provider.uploadFile!(ctx, { mode: 'new-file', projectId: ref.projectId, containerId: ref.containerId, fileName: 'structural-model.ifc' }, bytes('X'), options);
    expect(stale.ok).toBe(false);
    expect(existing.ok).toBe(false);
    expect(progress).toEqual([]);
  });
});
