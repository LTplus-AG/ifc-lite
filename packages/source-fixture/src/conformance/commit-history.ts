/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { isCommitSourceError } from '@ifc-lite/plugin-api';
import type { FileSourceProvider, PluginContext, SourceCommit, StoredCommitDiff } from '@ifc-lite/plugin-api';

import { collectAllPages } from './collect.js';
import type { CommitConformanceFixtures } from './commit-types.js';

/**
 * `getCommitDiff` may legitimately answer `not-ready` while a service computes
 * one. A conformance run must wait for that rather than fail it — but only
 * for a bounded number of rounds, because a provider that answers `not-ready`
 * forever has a defect, not a queue.
 */
async function awaitDiff(
  provider: FileSourceProvider,
  ctx: PluginContext,
  base: { projectId: string; modelId: string; commitId: string },
  head: { projectId: string; modelId: string; commitId: string },
): Promise<StoredCommitDiff> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await provider.getCommitDiff!(ctx, base, head);
    } catch (error) {
      if (!isCommitSourceError(error) || error.code !== 'not-ready') throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(error.retryAfterMs ?? 50, 500)));
    }
  }
  throw new Error('getCommitDiff kept answering not-ready across 5 attempts');
}

export function describeFingerprintConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: CommitConformanceFixtures,
): void {
  const ref = { projectId: fixtures.projectId, modelId: fixtures.modelId };

  describe('loadCommitFingerprints', () => {
    it('keys are unique within a set, and the engine is named', async () => {
      const ctx = createContext();
      const page = await provider.listCommits!(ctx, ref, { limit: 1 });
      const set = await provider.loadCommitFingerprints!(ctx, { ...ref, commitId: page.items[0].id });

      expect(set.format).toBe('ifc-lite/fingerprints');
      expect(set.version).toBe(1);
      // Without this a host cannot tell whether the hashes are comparable
      // with its own engine's, and would report a whole model as changed.
      expect(set.engine.length).toBeGreaterThan(0);
      expect(set.artifactDigest).toBe(page.items[0].artifact.digest);

      const keys = new Set<string>();
      for (const entry of set.entries) {
        expect(keys.has(entry.key), `duplicate fingerprint key ${entry.key}`).toBe(false);
        keys.add(entry.key);
        expect(entry.ifcType.length).toBeGreaterThan(0);
        expect(typeof entry.dataHash).toBe('string');
      }
    });

    it('reports sampling only when maxEntries was set and exceeded', async () => {
      const ctx = createContext();
      const page = await provider.listCommits!(ctx, ref, { limit: 1 });
      const commitRef = { ...ref, commitId: page.items[0].id };

      const full = await provider.loadCommitFingerprints!(ctx, commitRef);
      expect(full.sample, 'an unbounded request must never be reported as a sample').toBeUndefined();

      if (full.entries.length < 2) return;
      const limit = full.entries.length - 1;
      const sampled = await provider.loadCommitFingerprints!(ctx, commitRef, { maxEntries: limit });
      expect(sampled.entries.length).toBeLessThanOrEqual(limit);
      expect(sampled.sample?.total).toBe(full.entries.length);
      expect(sampled.sample?.strategy).toBe('stratified-by-type');
    });
  });
}

export function describeStoredDiffConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: CommitConformanceFixtures,
): void {
  const ref = { projectId: fixtures.projectId, modelId: fixtures.modelId };

  describe('getCommitDiff', () => {
    async function twoCommits(ctx: PluginContext): Promise<[SourceCommit, SourceCommit]> {
      const commits = await collectAllPages((request) => provider.listCommits!(ctx, ref, request), 100);
      return [commits[commits.length - 1], commits[0]];
    }

    it('counts agree with entries, and unchanged elements are omitted', async () => {
      const ctx = createContext();
      const [oldest, newest] = await twoCommits(ctx);
      const diff = await awaitDiff(provider, ctx, { ...ref, commitId: oldest.id }, { ...ref, commitId: newest.id });

      expect(diff.format).toBe('ifc-lite/commit-diff');
      expect(diff.base.commitId).toBe(oldest.id);
      expect(diff.head.commitId).toBe(newest.id);

      const tally = { added: 0, modified: 0, deleted: 0 };
      for (const entry of diff.entries) {
        expect(entry.state, 'unchanged elements must not be listed').not.toBe('unchanged');
        tally[entry.state] += 1;
      }
      expect(tally.added).toBe(diff.counts.added);
      expect(tally.modified).toBe(diff.counts.modified);
      expect(tally.deleted).toBe(diff.counts.deleted);
      for (const entry of diff.entries) {
        if (entry.state === 'modified') {
          expect(entry.changeKinds.length, `modified ${entry.key} names no change kind`).toBeGreaterThan(0);
        }
      }
    });

    it('a commit diffed with itself reports no changes', async () => {
      const ctx = createContext();
      const page = await provider.listCommits!(ctx, ref, { limit: 1 });
      const self = { ...ref, commitId: page.items[0].id };
      const diff = await awaitDiff(provider, ctx, self, self);
      expect(diff.entries).toEqual([]);
      expect(diff.counts.added + diff.counts.modified + diff.counts.deleted).toBe(0);
    });
  });
}

export function describeElementHistoryConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: CommitConformanceFixtures,
): void {
  const ref = { projectId: fixtures.projectId, modelId: fixtures.modelId };

  describe('listElementHistory', () => {
    it('runs newest first and ends where the element was added', async () => {
      const ctx = createContext();
      const entries = await collectAllPages(
        (request) => provider.listElementHistory!(ctx, { ...ref, key: fixtures.elementKey! }, request),
        100,
      );
      expect(entries.length, 'fixtures.elementKey must have history in fixtures.modelId').toBeGreaterThan(0);

      const times = entries.map((entry) => Date.parse(entry.createdAt));
      for (let i = 1; i < times.length; i++) {
        expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
      }
      // The point of following identity records: an element re-GUIDed
      // mid-life still has ONE history, so the walk terminates at its birth
      // rather than at the rename that looks like one.
      expect(entries[entries.length - 1].state).toBe('added');
      expect(entries[0].key).toBe(fixtures.elementKey);
    });

    it('answers for a specific commit without loading the model', async () => {
      const ctx = createContext();
      const page = await provider.listCommits!(ctx, ref, { limit: 1 });
      const history = await provider.listElementHistory!(ctx, {
        ...ref,
        key: fixtures.elementKey!,
        atCommitId: page.items[0].id,
      });
      for (const entry of history.items) {
        expect(entry.commitId.length).toBeGreaterThan(0);
        expect(entry.key.length).toBeGreaterThan(0);
      }
    });
  });
}

export function describeIdentityRecordConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: CommitConformanceFixtures,
): void {
  const ref = { projectId: fixtures.projectId, modelId: fixtures.modelId };

  describe('listIdentityRecords', () => {
    it('pins both sides to their artifact digests, so it converts to a sidecar', async () => {
      const ctx = createContext();
      const commits = await collectAllPages((request) => provider.listCommits!(ctx, ref, request), 100);
      const oldest = commits[commits.length - 1];
      const newest = commits[0];
      const records = await provider.listIdentityRecords!(
        ctx,
        { ...ref, commitId: oldest.id },
        { ...ref, commitId: newest.id },
      );

      // `IdentityMapSidecar` pins `base.hash` / `head.hash`; without the
      // digests here the conversion would have to re-fetch both commits, and
      // a host reading a stale copy could pin a sidecar to the wrong file.
      expect(records.base.artifactDigest).toBe(oldest.artifact.digest);
      expect(records.head.artifactDigest).toBe(newest.artifact.digest);
      for (const entry of records.entries) {
        expect(entry.base.length).toBeGreaterThan(0);
        expect(entry.here.length).toBeGreaterThan(0);
        expect(entry.reason.length).toBeGreaterThan(0);
      }
    });
  });
}
