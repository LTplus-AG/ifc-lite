/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pins what `pageBoundary` actually changes about the requests the paging
// checks issue (#2493).
//
// `ListOptions.limit` is "Hint only; providers clamp to whatever their API
// allows". A provider that never forwards it — `DaluxBuildProvider`, whose
// upstream pages by opaque bookmark and takes no page-size argument at all —
// is therefore conformant, and the suite must not fail it for that. Under
// `pageBoundary: 'backend'` the suite stops passing a limit entirely and
// measures the only thing that was ever portable: that following cursors
// takes more than one request.
//
// Both directions are asserted, because "we stopped passing a limit" is
// indistinguishable from "these checks stopped running" unless the opposite
// mode is shown to still pass one.

import { describe, expect, it } from 'vitest';
import type {
  FileFilter,
  FileSourceProvider,
  ListOptions,
  ListProjectsOptions,
  Page,
  PluginContext,
  SourceContainer,
  SourceFile,
  SourceFileRef,
  SourceRevision,
} from '@ifc-lite/plugin-api';

import { createFixtureContext, createFixtureSourceProvider } from '../src/index.js';
import type { ConformanceFixtures } from '../src/conformance/index.js';
import { describePagingConformance } from '../src/conformance/paging.js';
import { buildTestWorldSpec } from './world.js';

const fixtures: ConformanceFixtures = {
  projectId: 'proj-1',
  containerWithFilesId: 'sub1',
  fileWithRevisions: { containerId: 'sub1', fileId: 'structural-model' },
  searchQuery: 'structural',
  secondProjectId: 'proj-2',
};

/**
 * Wraps a provider to record the `limit` on every listing call, delegating
 * otherwise. `pageSize: 1` on the underlying fixture is what makes the
 * *backend* split pages, standing in for a real API's own page size.
 */
function recordingProvider(seen: Array<number | undefined>): FileSourceProvider {
  const base = createFixtureSourceProvider({ world: buildTestWorldSpec(), pageSize: 1 });
  const record = <T>(options: ListOptions | undefined, run: () => Promise<T>): Promise<T> => {
    seen.push(options?.limit);
    return run();
  };

  return {
    ...base,
    listProjects: (ctx: PluginContext, options?: ListProjectsOptions): Promise<Page<never>> =>
      record(options, () => base.listProjects(ctx, options)) as Promise<Page<never>>,
    listContainers: (
      ctx: PluginContext,
      projectId: string,
      parentId?: string,
      options?: ListOptions,
    ): Promise<Page<SourceContainer>> =>
      record(options, () => base.listContainers(ctx, projectId, parentId, options)),
    listFiles: (
      ctx: PluginContext,
      projectId: string,
      containerId: string,
      filter?: FileFilter,
      options?: ListOptions,
    ): Promise<Page<SourceFile>> =>
      record(options, () => base.listFiles(ctx, projectId, containerId, filter, options)),
    searchFiles: (
      ctx: PluginContext,
      projectId: string,
      query: string,
      filter?: FileFilter,
      options?: ListOptions,
    ): Promise<Page<SourceFile>> =>
      record(options, () => base.searchFiles!(ctx, projectId, query, filter, options)),
    listRevisions: (
      ctx: PluginContext,
      ref: SourceFileRef,
      options?: ListOptions,
    ): Promise<Page<SourceRevision>> => record(options, () => base.listRevisions!(ctx, ref, options)),
  } as FileSourceProvider;
}

describe("pageBoundary: 'backend'", () => {
  const seen: Array<number | undefined> = [];
  // Deliberately larger than any result set in the test world. Under
  // `'limit'` this alone would fail the checks ("smallPageLimit must be
  // smaller than the N items available"); under `'backend'` it is inert,
  // because page size is the backend's to choose and this number is never
  // sent. A `smallPageLimit` that still mattered here would mean the mode
  // never really stopped depending on the hint.
  describePagingConformance(recordingProvider(seen), () => createFixtureContext(), fixtures, 50, 'backend');

  // Declared after the suite above so it observes a completed run. A plain
  // `it` rather than an `afterAll` on purpose: a failing hook does not move
  // the leaf test count, and this assertion is the whole point of the file.
  // It also cannot pass vacuously if the ordering ever changed — an empty
  // `seen` fails the first expectation rather than satisfying the second.
  it('sends no `limit` at all', () => {
    expect(seen.length, 'the recording provider was never called — this run proves nothing').toBeGreaterThan(0);
    expect(
      seen.filter((limit) => limit !== undefined),
      "pageBoundary: 'backend' still sent a `limit`, so it is still requiring the provider to honor a hint",
    ).toEqual([]);
  });
});

describe("pageBoundary: 'limit' still passes one", () => {
  const seen: Array<number | undefined> = [];
  describePagingConformance(recordingProvider(seen), () => createFixtureContext(), fixtures, 1, 'limit');

  it('sends smallPageLimit', () => {
    expect(seen.length, 'the recording provider was never called — this run proves nothing').toBeGreaterThan(0);
    expect(
      seen.some((limit) => limit === 1),
      "pageBoundary: 'limit' never passed smallPageLimit, so the default mode is not doing what it claims",
    ).toBe(true);
  });
});
