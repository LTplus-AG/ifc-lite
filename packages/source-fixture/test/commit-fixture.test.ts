/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The fixture's own commit behaviour — the parts the reusable suite cannot
 * assert because they are claims about THIS world's data (which element was
 * renamed, what the derived counts come to) rather than about every
 * conformant provider.
 */

import { describe, expect, it } from 'vitest';
import { isCommitSourceError } from '@ifc-lite/plugin-api';

import { createFixtureContext, createFixtureSourceProvider } from '../src/index.js';
import { buildCommitWorldSpec } from './commit-world.js';

function makeProvider(overrides?: Parameters<typeof createFixtureSourceProvider>[0]['capabilities']) {
  return createFixtureSourceProvider({
    world: buildCommitWorldSpec(),
    capabilities: overrides ?? { commits: { payloadFormats: ['ifc-step', 'ifcx'] } },
  });
}

const REF = { projectId: 'proj-1', modelId: 'model-structural' };

describe('world validation', () => {
  it('rejects a commit naming a parent the model does not declare', () => {
    expect(() =>
      createFixtureSourceProvider({
        world: {
          projects: [
            {
              id: 'p',
              name: 'P',
              containers: [],
              files: [],
              models: [
                {
                  id: 'm',
                  name: 'M',
                  commits: [{ id: 'c1', parents: ['ghost'], fileName: 'a.ifc', content: 'x' }],
                },
              ],
            },
          ],
        },
      }),
    ).toThrow(/unknown parent ghost/);
  });

  it('rejects a model with no commits', () => {
    expect(() =>
      createFixtureSourceProvider({
        world: {
          projects: [{ id: 'p', name: 'P', containers: [], files: [], models: [{ id: 'm', name: 'M', commits: [] }] }],
        },
      }),
    ).toThrow(/at least one commit/);
  });
});

describe('commit listing', () => {
  it('hides unpublished commits by default and never heads on one', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();

    const published = await provider.listCommits!(ctx, REF, { limit: 50 });
    expect(published.items.map((c) => c.id)).toEqual(['c3', 'c2', 'c1']);

    const all = await provider.listCommits!(ctx, REF, { limit: 50, includeUnpublished: true });
    expect(all.items.map((c) => c.id)).toEqual(['c4', 'c3', 'c2', 'c1']);
    expect(all.items[0].status).toBe('pending');

    // c4 is newer than c3 and still not the head — the whole point of the
    // status field.
    expect((await provider.getModel!(ctx, REF)).headCommitId).toBe('c3');
  });

  it('filters by before / after', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    const recent = await provider.listCommits!(ctx, REF, { limit: 50, after: '2026-06-01T00:00:00.000Z' });
    expect(recent.items.map((c) => c.id)).toEqual(['c3', 'c2']);
  });

  it('derives per-commit stats that agree with the stored diff', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    const commits = await provider.listCommits!(ctx, REF, { limit: 50 });
    const c3 = commits.items.find((c) => c.id === 'c3')!;

    // c3 vs c2: slab-a data edited, wall-b deleted, door-a added, wall-a2 untouched.
    expect(c3.stats).toEqual({ added: 1, modified: 1, deleted: 1, unchanged: 1 });

    const diff = await provider.getCommitDiff!(ctx, { ...REF, commitId: 'c2' }, { ...REF, commitId: 'c3' });
    expect(diff.counts).toEqual(c3.stats);
  });
});

describe('artifact digests', () => {
  it('are computed from the declared bytes and echoed by loadCommit', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    const commit = await provider.getCommit!(ctx, { ...REF, commitId: 'c1' });
    const payload = await provider.loadCommit!(ctx, { ...REF, commitId: 'c1' });

    expect(commit.artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload.artifactDigest).toBe(commit.artifact.digest);
    expect(new TextDecoder().decode(payload.bytes)).toBe('COMMIT-1::initial-delivery');
    expect(commit.artifact.sizeBytes).toBe(payload.bytes.byteLength);
  });

  it('differ between commits, so a host can tell two versions apart', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    const [c1, c2] = await Promise.all([
      provider.getCommit!(ctx, { ...REF, commitId: 'c1' }),
      provider.getCommit!(ctx, { ...REF, commitId: 'c2' }),
    ]);
    expect(c1.artifact.digest).not.toBe(c2.artifact.digest);
  });
});

describe('stored diff across a re-GUID', () => {
  it('pairs the renamed element instead of reporting a delete plus an add', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    const diff = await provider.getCommitDiff!(ctx, { ...REF, commitId: 'c1' }, { ...REF, commitId: 'c3' });

    const keys = diff.entries.map((entry) => `${entry.state}:${entry.key}`);
    // wall-a became wall-a2 in c2 and is unchanged otherwise, so across c1→c3
    // it is not in the list at all — neither deleted nor added.
    expect(keys).not.toContain('deleted:wall-a');
    expect(keys).not.toContain('added:wall-a2');
    expect(keys).toContain('deleted:wall-b');
    expect(keys).toContain('added:door-a');
    expect(diff.appliedIdentity).toEqual([{ base: 'wall-a', here: 'wall-a2', reason: 'content-match:renamed' }]);
  });

  it('names the changed components of a modified element', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    const diff = await provider.getCommitDiff!(ctx, { ...REF, commitId: 'c2' }, { ...REF, commitId: 'c3' });
    const slab = diff.entries.find((entry) => entry.key === 'slab-a')!;
    expect(slab.state).toBe('modified');
    expect(slab.changeKinds).toEqual(['data']);
    expect(slab.changedComponents).toEqual(['attr:core']);
  });

  it('refuses a base that is not an ancestor on the mainline', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    await expect(
      provider.getCommitDiff!(ctx, { ...REF, commitId: 'c3' }, { ...REF, commitId: 'c1' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('element history', () => {
  it('follows a re-GUID back to the element birth', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    const history = await provider.listElementHistory!(ctx, { ...REF, key: 'wall-a2' }, { limit: 50 });

    expect(history.items.map((entry) => `${entry.commitId}:${entry.state}:${entry.key}`)).toEqual([
      // c3 left it untouched, so c3 contributes nothing.
      'c2:renamed:wall-a2',
      'c1:added:wall-a',
    ]);
    expect(history.items[0].relatedKeys).toEqual(['wall-a']);
    expect(history.items[0].reason).toBe('content-match:renamed');
  });

  it('reports a deletion and still shows the life before it', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    const history = await provider.listElementHistory!(ctx, { ...REF, key: 'wall-b' }, { limit: 50 });
    expect(history.items.map((entry) => `${entry.commitId}:${entry.state}`)).toEqual(['c3:deleted', 'c1:added']);
  });

  it('answers at a historical commit, not only at the head', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    const history = await provider.listElementHistory!(ctx, { ...REF, key: 'wall-a', atCommitId: 'c1' }, { limit: 50 });
    expect(history.items.map((entry) => entry.state)).toEqual(['added']);
  });
});

describe('writes', () => {
  it('rejects a stale parent with the live head in details', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    try {
      await provider.createCommit!(ctx, {
        projectId: 'proj-1',
        modelId: 'model-uploads',
        expectedParentId: 'not-the-head',
        fileName: 'x.ifc',
        bytes: new TextEncoder().encode('x').buffer as ArrayBuffer,
        idempotencyKey: 'k1',
      });
      expect.fail('createCommit accepted a stale parent');
    } catch (error) {
      expect(isCommitSourceError(error)).toBe(true);
      if (isCommitSourceError(error)) expect(error.details?.headCommitId).toBe('u1');
    }
  });

  it('moves the head and records the new commit as a child of the old one', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    const created = await provider.createCommit!(ctx, {
      projectId: 'proj-1',
      modelId: 'model-uploads',
      expectedParentId: 'u1',
      fileName: 'u2.ifc',
      bytes: new TextEncoder().encode('UPLOAD-2').buffer as ArrayBuffer,
      message: 'Second upload',
      idempotencyKey: 'k2',
    });
    expect(created.parents).toEqual(['u1']);
    const model = await provider.getModel!(ctx, { projectId: 'proj-1', modelId: 'model-uploads' });
    expect(model.headCommitId).toBe(created.id);
  });
});

describe('watchCommits', () => {
  it('reports nothing on the first poll, then the head that moved', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    const models = [{ projectId: 'proj-1', modelId: 'model-uploads' }];

    const first = await provider.watchCommits!(ctx, models);
    // A first poll that announced every model as changed would light up "new
    // version available" on everything the user already has open.
    expect(first.events).toEqual([]);

    await provider.createCommit!(ctx, {
      projectId: 'proj-1',
      modelId: 'model-uploads',
      expectedParentId: 'u1',
      fileName: 'u2.ifc',
      bytes: new TextEncoder().encode('UPLOAD-2').buffer as ArrayBuffer,
      idempotencyKey: 'k3',
    });

    const second = await provider.watchCommits!(ctx, models, first.cursor);
    expect(second.events).toHaveLength(1);
    expect(second.events[0].previousHeadCommitId).toBe('u1');
    expect(second.events[0].modelId).toBe('model-uploads');
  });
});

describe('capability gating', () => {
  it('declaring models is the opt-in; `commits: false` is the way back', () => {
    expect(makeProvider().manifest.capabilities.commits).toBeDefined();
    expect(makeProvider({ commits: false }).manifest.capabilities.commits).toBeUndefined();
  });

  it('leaves a world with no models on the 2.0.0 surface', () => {
    const provider = createFixtureSourceProvider({
      world: { projects: [{ id: 'p', name: 'P', containers: [], files: [] }] },
    });
    expect(provider.manifest.capabilities.commits).toBeUndefined();
    expect(provider.listCommits).toBeUndefined();
  });

  it('injects failures into commit methods like any other', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    provider.fixture.setFailure('listCommits', { kind: 'throw', message: 'commit service down', status: 503 });
    await expect(provider.listCommits!(ctx, REF)).rejects.toMatchObject({ message: 'commit service down' });
  });
});

describe('injected commit failures', () => {
  it('can carry a contract code, so a host can branch on it', async () => {
    const provider = makeProvider();
    const ctx = createFixtureContext();
    provider.fixture.setFailure('listCommits', { kind: 'throw', code: 'forbidden', message: 'no access', status: 403 });
    try {
      await provider.listCommits!(ctx, REF);
      expect.fail('listCommits resolved under an injected failure');
    } catch (error) {
      // Without the code a host cannot tell "you may not see this" (nothing to
      // retry) from a transient outage (offer Retry) — which is exactly the
      // branch the History panel takes.
      expect(isCommitSourceError(error)).toBe(true);
      if (isCommitSourceError(error)) expect(error.code).toBe('forbidden');
    }
  });
});
