/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { isCommitSourceError } from '@ifc-lite/plugin-api';
import type { FileSourceProvider, PluginContext } from '@ifc-lite/plugin-api';

import type { CommitConformanceFixtures } from './commit-types.js';

function uploadBytes(marker: string): ArrayBuffer {
  return new TextEncoder().encode(`ISO-10303-21;\n/* ${marker} */\nEND-ISO-10303-21;\n`).buffer as ArrayBuffer;
}

export function describeCommitWriteConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: CommitConformanceFixtures,
): void {
  const projectId = fixtures.writableProjectId!;
  const modelId = fixtures.writableModelId!;
  const ref = { projectId, modelId };

  describe('createCommit', () => {
    it('refuses a stale expectedParentId with conflict, naming the real head', async () => {
      const ctx = createContext();
      const model = await provider.getModel!(ctx, ref);
      try {
        await provider.createCommit!(ctx, {
          projectId,
          modelId,
          expectedParentId: 'a-commit-that-was-never-the-head',
          fileName: 'stale.ifc',
          bytes: uploadBytes('stale'),
          idempotencyKey: crypto.randomUUID(),
        });
        expect.fail('createCommit accepted a stale expectedParentId instead of throwing conflict');
      } catch (error) {
        expect(isCommitSourceError(error), `createCommit threw a non-conforming error: ${String(error)}`).toBe(true);
        if (!isCommitSourceError(error)) return;
        expect(error.code).toBe('conflict');
        // Without the current head in `details`, the host's only recovery is
        // to re-list and guess — which is exactly the race the check exists
        // to close.
        expect(error.details?.headCommitId).toBe(model.headCommitId);
      }
    });

    it('replaying an idempotency key returns the original commit, not a second one', async () => {
      const ctx = createContext();
      const before = await provider.getModel!(ctx, ref);
      const idempotencyKey = crypto.randomUUID();
      const input = {
        projectId,
        modelId,
        expectedParentId: before.headCommitId === '' ? null : before.headCommitId,
        fileName: 'upload.ifc',
        bytes: uploadBytes('upload'),
        message: 'conformance upload',
        idempotencyKey,
      };

      const first = await provider.createCommit!(ctx, input);
      const replay = await provider.createCommit!(ctx, { ...input, bytes: uploadBytes('upload') });
      expect(replay.id).toBe(first.id);
      expect(replay.artifact.digest).toBe(first.artifact.digest);

      const after = await provider.getModel!(ctx, ref);
      expect(after.headCommitId).toBe(first.id);
      expect(first.parents[0]).toBe(before.headCommitId === '' ? undefined : before.headCommitId);
    });
  });

  describe('createModel', () => {
    it('creates an empty model whose first commit has no parent', async () => {
      const ctx = createContext();
      const model = await provider.createModel!(ctx, { projectId, name: 'Conformance model' });
      expect(model.projectId).toBe(projectId);
      expect(model.headCommitId).toBe('');

      const first = await provider.createCommit!(ctx, {
        projectId,
        modelId: model.id,
        expectedParentId: null,
        fileName: 'first.ifc',
        bytes: uploadBytes('first'),
        idempotencyKey: crypto.randomUUID(),
      });
      expect(first.parents).toEqual([]);
      expect((await provider.getModel!(ctx, { projectId, modelId: model.id })).headCommitId).toBe(first.id);
    });
  });

  describe('recordIdentity', () => {
    it('is idempotent for the same pair', async () => {
      const ctx = createContext();
      const commits = await provider.listCommits!(ctx, ref, { limit: 2 });
      if (commits.items.length < 2) return;
      const head = { ...ref, commitId: commits.items[0].id };
      const base = { ...ref, commitId: commits.items[1].id };
      const entries = [{ base: 'base-key-1', here: 'head-key-1', reason: 'content-match:renamed' }];

      const first = await provider.recordIdentity!(ctx, base, head, entries);
      const second = await provider.recordIdentity!(ctx, base, head, entries);
      expect(second.entries.length).toBe(first.entries.length);
    });
  });
}

/** Every commit method must reject with something `isCommitSourceError` accepts. */
export function describeCommitErrorConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: CommitConformanceFixtures,
): void {
  describe('commit errors', () => {
    it('reports an unknown model with a conforming error', async () => {
      const ctx = createContext();
      try {
        await provider.getModel!(ctx, { projectId: fixtures.projectId, modelId: 'no-such-model' });
        expect.fail('getModel resolved for a model that does not exist');
      } catch (error) {
        expect(
          isCommitSourceError(error),
          `getModel rejected with an error carrying no usable code: ${String(error)}`,
        ).toBe(true);
        if (isCommitSourceError(error)) expect(error.code).toBe('not-found');
      }
    });

    it('reports an unknown commit with a conforming error', async () => {
      const ctx = createContext();
      try {
        await provider.getCommit!(ctx, {
          projectId: fixtures.projectId,
          modelId: fixtures.modelId,
          commitId: 'no-such-commit',
        });
        expect.fail('getCommit resolved for a commit that does not exist');
      } catch (error) {
        expect(isCommitSourceError(error), `getCommit rejected with an error carrying no usable code: ${String(error)}`).toBe(true);
        if (isCommitSourceError(error)) expect(error.code).toBe('not-found');
      }
    });
  });
}
