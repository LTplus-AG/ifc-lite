/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Fixture-specific behavior the reusable conformance kit deliberately does
// NOT assert, because it is this fixture's own implementation choice rather
// than something every conformant provider must share: injected failures,
// hang/abort wiring, truncated pages, deterministic per-revision content,
// the interactive auth gate, and cursor scoping.

import { describe, expect, it } from 'vitest';

import { createFixtureContext, createFixtureSourceProvider, FixtureApiError } from '../src/index.js';
import { buildTestWorldSpec } from './world.js';

describe('injected failures', () => {
  it('"throw" rejects with the configured message and status', async () => {
    const provider = createFixtureSourceProvider({
      world: buildTestWorldSpec(),
      failures: { listProjects: { kind: 'throw', message: 'boom', status: 500 } },
    });
    const ctx = createFixtureContext();
    await expect(provider.listProjects(ctx)).rejects.toMatchObject({ message: 'boom' });
    try {
      await provider.listProjects(ctx);
      throw new Error('expected listProjects to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(FixtureApiError);
      expect((err as FixtureApiError).status).toBe(500);
    }
  });

  it('"rate-limit" rejects with a 429-shaped error', async () => {
    const provider = createFixtureSourceProvider({
      world: buildTestWorldSpec(),
      failures: { listContainers: { kind: 'rate-limit', retryAfterSeconds: 3 } },
    });
    const ctx = createFixtureContext();
    try {
      await provider.listContainers(ctx, 'proj-1');
      throw new Error('expected listContainers to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(FixtureApiError);
      expect((err as FixtureApiError).status).toBe(429);
      expect((err as FixtureApiError).retryAfterSeconds).toBe(3);
    }
  });

  it('"hang" never settles until the AbortSignal fires, then rejects', async () => {
    const provider = createFixtureSourceProvider({
      world: buildTestWorldSpec(),
      failures: { listFiles: { kind: 'hang' } },
    });
    const ctx = createFixtureContext();
    const controller = new AbortController();

    let settled = false;
    const pending = provider
      .listFiles(ctx, 'proj-1', 'sub1', undefined, { signal: controller.signal })
      .catch((err) => {
        settled = true;
        throw err;
      });

    // Give the microtask queue a few turns — it must still be pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    controller.abort();
    await expect(pending).rejects.toBeTruthy();
    expect(settled).toBe(true);
  });

  it('"truncate" shrinks the page below what its own cursor promises', async () => {
    const provider = createFixtureSourceProvider({
      world: buildTestWorldSpec(),
      pageSize: 10,
      failures: { listContainers: { kind: 'truncate', keep: 1 } },
    });
    const ctx = createFixtureContext();
    const page = await provider.listContainers(ctx, 'proj-1');
    // Natural top-level result is root1 + root2 (2 items) with no cursor
    // (fits in one page); truncate keeps only 1 but the (absent) cursor is
    // untouched — a host that trusts "no cursor -> complete" would wrongly
    // conclude it has everything.
    expect(page.items.length).toBe(1);
  });

  it('setFailure adjusts an already-constructed provider at runtime', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    const ctx = createFixtureContext();

    await expect(provider.listProjects(ctx)).resolves.toBeTruthy();

    provider.fixture.setFailure('listProjects', { kind: 'throw', message: 'now broken' });
    await expect(provider.listProjects(ctx)).rejects.toMatchObject({ message: 'now broken' });

    provider.fixture.setFailure('listProjects', undefined);
    await expect(provider.listProjects(ctx)).resolves.toBeTruthy();
  });
});

describe('deterministic per-revision content', () => {
  it('download() returns the exact bytes declared for each revision', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    const ctx = createFixtureContext();
    const ref = { projectId: 'proj-1', containerId: 'sub1', fileId: 'structural-model' };

    const rev1 = await provider.download(ctx, { ...ref, revisionId: 'rev1' });
    const rev2 = await provider.download(ctx, { ...ref, revisionId: 'rev2' });
    const latest = await provider.download(ctx, ref); // omitted revisionId -> current (newest) revision

    expect(new TextDecoder().decode(rev1)).toBe('REVISION-1::short');
    expect(new TextDecoder().decode(rev2)).toBe('REVISION-2::deterministic-content-longer-body');
    expect(new TextDecoder().decode(latest)).toBe(new TextDecoder().decode(rev2));
  });

  it('rejects an unknown revisionId', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    const ctx = createFixtureContext();
    await expect(
      provider.download(ctx, { projectId: 'proj-1', containerId: 'sub1', fileId: 'structural-model', revisionId: 'nope' }),
    ).rejects.toBeTruthy();
  });

  it('rejects a ref whose containerId does not match the file', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    const ctx = createFixtureContext();
    await expect(
      provider.download(ctx, { projectId: 'proj-1', containerId: 'root2', fileId: 'structural-model' }),
    ).rejects.toBeTruthy();
  });
});

describe('interactive auth gate', () => {
  it('rejects every data call until signIn, and re-gates after signOut', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec(), auth: 'interactive' });
    const ctx = createFixtureContext();

    await expect(provider.listProjects(ctx)).rejects.toBeTruthy();
    expect(await provider.auth!.restore(ctx)).toBeNull();

    const identity = await provider.auth!.signIn(ctx);
    expect(identity.id.length).toBeGreaterThan(0);
    await expect(provider.listProjects(ctx)).resolves.toBeTruthy();
    expect(await provider.auth!.getIdentity(ctx)).toEqual(identity);
    expect(await provider.auth!.restore(ctx)).toEqual(identity);

    await provider.auth!.signOut(ctx);
    await expect(provider.listProjects(ctx)).rejects.toBeTruthy();
    expect(await provider.auth!.getIdentity(ctx)).toBeNull();
  });

  it('preferences-mode providers have no provider.auth and no gate', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec(), auth: 'preferences' });
    expect(provider.auth).toBeUndefined();
    await expect(provider.listProjects(createFixtureContext())).resolves.toBeTruthy();
  });
});

describe('cursor scoping', () => {
  it('rejects a malformed cursor', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    const ctx = createFixtureContext();
    await expect(provider.listContainers(ctx, 'proj-1', undefined, { cursor: 'not-a-real-cursor' })).rejects.toBeTruthy();
  });

  it('rejects a cursor minted for a different query', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec(), pageSize: 1 });
    const ctx = createFixtureContext();
    const page = await provider.listContainers(ctx, 'proj-1', undefined, { limit: 1 });
    expect(page.cursor, 'top-level query with pageSize 1 should have a second page').toBeDefined();

    // Reuse the cursor against a structurally different query (a different
    // containerId scope) — must not be silently accepted.
    await expect(
      provider.listContainers(ctx, 'proj-1', 'root1', { cursor: page.cursor }),
    ).rejects.toBeTruthy();
  });
});

describe('watchRevisions', () => {
  it('reports a changed revision when the ref carries an older revisionId', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    const ctx = createFixtureContext();
    const result = await provider.watchRevisions!(
      ctx,
      [{ projectId: 'proj-1', containerId: 'sub1', fileId: 'structural-model', revisionId: 'rev1' }],
      undefined,
    );
    expect(result.events).toEqual([
      { fileId: 'structural-model', latestRevisionId: 'rev2', previousRevisionId: 'rev1' },
    ]);
    expect(result.cursor).toBeDefined();
  });

  it('reports no event when the ref is already current', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    const ctx = createFixtureContext();
    const result = await provider.watchRevisions!(
      ctx,
      [{ projectId: 'proj-1', containerId: 'sub1', fileId: 'structural-model', revisionId: 'rev2' }],
      undefined,
    );
    expect(result.events).toEqual([]);
  });

  it('reports deleted: true for a ref the world no longer has', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    const ctx = createFixtureContext();
    const result = await provider.watchRevisions!(
      ctx,
      [{ projectId: 'proj-1', containerId: 'sub1', fileId: 'never-existed', revisionId: 'rev1' }],
      undefined,
    );
    expect(result.events).toEqual([{ fileId: 'never-existed', latestRevisionId: 'rev1', deleted: true }]);
  });
});
