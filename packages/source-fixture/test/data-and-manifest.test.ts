/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { createFixtureContext, createFixtureSourceProvider } from '../src/index.js';
import { buildTestWorldSpec } from './world.js';

describe('fixture world validation', () => {
  it('throws at construction for a file with an unknown containerId', () => {
    expect(() =>
      createFixtureSourceProvider({
        world: {
          projects: [
            {
              id: 'p',
              name: 'P',
              containers: [{ id: 'c1', name: 'C1' }],
              files: [{ id: 'f1', name: 'f.ifc', containerId: 'does-not-exist', revisions: [{ id: 'r1', content: 'x' }] }],
            },
          ],
        },
      }),
    ).toThrow(/containerId/);
  });

  it('throws at construction for a container with an unknown parentId', () => {
    expect(() =>
      createFixtureSourceProvider({
        world: {
          projects: [{ id: 'p', name: 'P', containers: [{ id: 'c1', name: 'C1', parentId: 'ghost' }], files: [] }],
        },
      }),
    ).toThrow(/unknown parentId/);
  });

  it('throws at construction for a duplicate container id', () => {
    expect(() =>
      createFixtureSourceProvider({
        world: {
          projects: [
            {
              id: 'p',
              name: 'P',
              containers: [
                { id: 'dup', name: 'A' },
                { id: 'dup', name: 'B' },
              ],
              files: [],
            },
          ],
        },
      }),
    ).toThrow(/Duplicate container id/);
  });

  it('throws at construction for a file with zero revisions', () => {
    expect(() =>
      createFixtureSourceProvider({
        world: {
          projects: [
            {
              id: 'p',
              name: 'P',
              containers: [{ id: 'c1', name: 'C1' }],
              files: [{ id: 'f1', name: 'f.ifc', containerId: 'c1', revisions: [] }],
            },
          ],
        },
      }),
    ).toThrow(/at least one revision/);
  });
});

describe('manifest defaults and overrides', () => {
  it('defaults to a reserved, never-resolvable network host', () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    expect(provider.manifest.permissions.network).toEqual(['fixture.invalid']);
  });

  it('declares an api range the reference host version satisfies by default', () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    expect(provider.manifest.api.startsWith('^')).toBe(true);
  });

  it('reflects capability overrides in both the manifest and method presence', () => {
    const provider = createFixtureSourceProvider({
      world: buildTestWorldSpec(),
      capabilities: { revisionHistory: false, changeDetection: false, search: false },
    });
    expect(provider.manifest.capabilities.revisionHistory).toBe(false);
    expect(provider.manifest.capabilities.changeDetection).toBe(false);
    expect(provider.manifest.capabilities.search).toBe(false);
    expect(provider.listRevisions).toBeUndefined();
    expect(provider.watchRevisions).toBeUndefined();
    expect(provider.searchFiles).toBeUndefined();
  });

  it('honors manifest name/title/relay overrides', () => {
    const provider = createFixtureSourceProvider({
      world: buildTestWorldSpec(),
      manifest: { name: 'my-fixture', title: 'My Fixture', relay: { upstream: 'https://api.example.invalid', path: '/api/fixture' } },
    });
    expect(provider.manifest.name).toBe('my-fixture');
    expect(provider.manifest.title).toBe('My Fixture');
    expect(provider.manifest.permissions.relay).toEqual({ upstream: 'https://api.example.invalid', path: '/api/fixture' });
  });
});

describe('container metadata', () => {
  it('hasChildren is true only for containers that actually have children', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    const ctx = createFixtureContext();
    const topLevel = await provider.listContainers(ctx, 'proj-1');
    const root1 = topLevel.items.find((c) => c.id === 'root1');
    const root2 = topLevel.items.find((c) => c.id === 'root2');
    expect(root1?.hasChildren).toBe(true);
    expect(root2?.hasChildren).toBe(false);
  });
});

describe('file filtering', () => {
  it('namePatterns glob-filters listFiles results', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    const ctx = createFixtureContext();
    const page = await provider.listFiles(ctx, 'proj-1', 'sub1', { namePatterns: ['*.ifc'] });
    expect(page.items.map((f) => f.name)).toEqual(['structural-model.ifc']);
  });

  it('mimeTypes filters listFiles results', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    const ctx = createFixtureContext();
    const page = await provider.listFiles(ctx, 'proj-1', 'sub1', { mimeTypes: ['text/plain'] });
    expect(page.items.map((f) => f.name)).toEqual(['structural-notes.txt']);
  });

  it('searchFiles matches by substring, case-insensitively, across the whole project', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    const ctx = createFixtureContext();
    const page = await provider.searchFiles!(ctx, 'proj-1', 'STRUCTURAL');
    expect(new Set(page.items.map((f) => f.name))).toEqual(new Set(['structural-model.ifc', 'structural-notes.txt']));
  });
});

describe('listProjects query filtering', () => {
  it('filters by name substring when projectsAreDiscoverableOnly-style query is given', async () => {
    const provider = createFixtureSourceProvider({ world: buildTestWorldSpec() });
    const ctx = createFixtureContext();
    const match = await provider.listProjects(ctx, { query: 'alpha' });
    const noMatch = await provider.listProjects(ctx, { query: 'zzz-nonexistent' });
    expect(match.items.map((p) => p.id)).toEqual(['proj-1']);
    expect(noMatch.items).toEqual([]);
  });
});
