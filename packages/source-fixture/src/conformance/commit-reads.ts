/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { isCommitSourceError } from '@ifc-lite/plugin-api';
import type { CommitPayloadFormat, FileSourceProvider, PluginContext, SourceCommit } from '@ifc-lite/plugin-api';

import { collectAllPages } from './collect.js';
import { ALL_PAYLOAD_FORMATS, type CommitConformanceFixtures, type CommitConformanceOptions } from './commit-types.js';

/** Independent SHA-256 oracle — the platform's, never the provider's own. */
async function sha256Prefixed(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The algorithm half of an `<algorithm>:<value>` digest, lowercased.
 *
 * A digest whose algorithm is `sha256` is INDEPENDENTLY VERIFIABLE and the
 * suite hashes the bytes to prove it. Any other algorithm is one this suite
 * cannot compute — some stores expose only their own content hash — so what
 * is checkable there is the shape and the stability, not the value. That is
 * a weaker check and is meant to read as one: `@ifc-lite/plugin-api`'s
 * `CommitArtifact` says why a provider should declare `sha256:` when it can.
 */
function digestAlgorithm(digest: string): string {
  const separator = digest.indexOf(':');
  return separator === -1 ? '' : digest.slice(0, separator).toLowerCase();
}

/** `commits` present implies the five required reads; every flag matches its method. */
export function describeCommitCapabilityConformance(provider: FileSourceProvider): void {
  describe('commit capabilities match the commit methods', () => {
    const commits = provider.manifest.capabilities.commits;

    it('declares the five required reads whenever `commits` is present', () => {
      if (!commits) {
        // Not commit-aware. The inverse must also hold, or a host feature-
        // detecting by capability would never call methods that exist.
        expect(typeof provider.listCommits).toBe('undefined');
        expect(typeof provider.loadCommit).toBe('undefined');
        return;
      }
      expect(typeof provider.listModels).toBe('function');
      expect(typeof provider.getModel).toBe('function');
      expect(typeof provider.listCommits).toBe('function');
      expect(typeof provider.getCommit).toBe('function');
      expect(typeof provider.loadCommit).toBe('function');
    });

    it.runIf(commits !== undefined)('declares at least one payload format', () => {
      expect(commits!.payloadFormats.length).toBeGreaterThan(0);
      for (const format of commits!.payloadFormats) {
        expect(ALL_PAYLOAD_FORMATS, `unknown payload format: ${format}`).toContain(format);
      }
    });

    it.runIf(commits !== undefined)('presents each gated method exactly when its flag is true', () => {
      expect(typeof provider.loadCommitFingerprints === 'function').toBe(commits!.fingerprints);
      expect(typeof provider.getCommitDiff === 'function').toBe(commits!.storedDiffs);
      expect(typeof provider.listElementHistory === 'function').toBe(commits!.elementHistory);
      expect(typeof provider.listIdentityRecords === 'function').toBe(commits!.identityRecords);
      expect(typeof provider.createModel === 'function').toBe(commits!.write);
      expect(typeof provider.createCommit === 'function').toBe(commits!.write);
      expect(typeof provider.recordIdentity === 'function').toBe(commits!.write);
      expect(typeof provider.watchCommits === 'function').toBe(commits!.watch);
    });
  });
}

export function describeCommitListingConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: CommitConformanceFixtures,
  smallPageLimit: number,
): void {
  const ref = { projectId: fixtures.projectId, modelId: fixtures.modelId };

  describe('listCommits / getCommit', () => {
    it('lists the model and reports a head that is one of its commits', async () => {
      const ctx = createContext();
      const model = await provider.getModel!(ctx, ref);
      expect(model.id).toBe(fixtures.modelId);
      const commits = await collectAllPages((request) => provider.listCommits!(ctx, ref, request), 100);
      expect(commits.length, 'fixtures.modelId must have 2+ commits').toBeGreaterThanOrEqual(2);
      if (model.headCommitId !== '') {
        expect(commits.map((c) => c.id)).toContain(model.headCommitId);
      }
    });

    it('returns commits newest first, and keeps that order across pages', async () => {
      const ctx = createContext();
      const bulk = await collectAllPages((request) => provider.listCommits!(ctx, ref, request), 100);
      const paged = await collectAllPages((request) => provider.listCommits!(ctx, ref, request), smallPageLimit);

      // Order is part of the contract, so unlike the file suites this cannot
      // settle for "same id SET" — a provider whose pager reshuffles pages
      // would still pass that and still render a scrambled timeline.
      expect(paged.map((c) => c.id)).toEqual(bulk.map((c) => c.id));

      const times = bulk.map((c) => Date.parse(c.createdAt));
      for (let i = 1; i < times.length; i++) {
        expect(times[i - 1], `commit ${bulk[i - 1].id} is older than ${bulk[i].id}`).toBeGreaterThanOrEqual(times[i]);
      }
    });

    it('resolves every mainline parent with getCommit', async () => {
      const ctx = createContext();
      const commits = await collectAllPages((request) => provider.listCommits!(ctx, ref, request), 100);
      for (const commit of commits) {
        const parentId = commit.parents[0];
        if (parentId === undefined) continue;
        const parent = await provider.getCommit!(ctx, { ...ref, commitId: parentId });
        expect(parent.id).toBe(parentId);
        expect(Date.parse(parent.createdAt)).toBeLessThanOrEqual(Date.parse(commit.createdAt));
      }
    });

    it('never reports a non-published commit as the head', async () => {
      const ctx = createContext();
      const model = await provider.getModel!(ctx, ref);
      if (model.headCommitId === '') return;
      const head = await provider.getCommit!(ctx, { ...ref, commitId: model.headCommitId });
      expect(head.status).toBe('published');
    });

    it('is immutable: two reads of one commit are deep-equal', async () => {
      const ctx = createContext();
      const page = await provider.listCommits!(ctx, ref, { limit: 1 });
      const target = page.items[0];
      expect(target, 'fixtures.modelId must have at least one commit').toBeDefined();
      const [first, second] = await Promise.all([
        provider.getCommit!(ctx, { ...ref, commitId: target.id }),
        provider.getCommit!(ctx, { ...ref, commitId: target.id }),
      ]);
      expect(first).toEqual(second);
      // A commit whose stats/artifact drift between reads is not immutable
      // even if its id is stable; that is the failure worth naming.
      expect(first.artifact.digest).toBe(second.artifact.digest);
    });
  });
}

export function describeLoadCommitConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: CommitConformanceFixtures,
  unsupportedFormat: CommitConformanceOptions['unsupportedFormat'],
): void {
  const ref = { projectId: fixtures.projectId, modelId: fixtures.modelId };

  describe('loadCommit', () => {
    async function headCommit(ctx: PluginContext): Promise<SourceCommit> {
      const page = await provider.listCommits!(ctx, ref, { limit: 1 });
      return page.items[0];
    }

    it('returns a payload whose digest is the commit artifact digest', async () => {
      const ctx = createContext();
      const commit = await headCommit(ctx);
      const payload = await provider.loadCommit!(ctx, { ...ref, commitId: commit.id });

      // Every digest must be `<algorithm>:<value>`: a bare hash gives a host
      // no way to know whether it can verify it.
      expect(commit.artifact.digest, 'artifact.digest must be <algorithm>:<value>').toMatch(/^[a-z0-9-]+:.+$/i);
      expect(payload.artifactDigest).toBe(commit.artifact.digest);
      expect(payload.fileName.length).toBeGreaterThan(0);

      if (digestAlgorithm(commit.artifact.digest) !== 'sha256') return;
      // The digest the payload CLAIMS and the digest its bytes HAVE are two
      // different assertions; a provider that echoes the commit's digest
      // while serving another commit's bytes passes the first and fails here.
      expect(await sha256Prefixed(new Uint8Array(payload.bytes))).toBe(commit.artifact.digest);
    });

    it('gives two commits with DIFFERENT bytes different digests', async () => {
      const ctx = createContext();
      const commits = await collectAllPages((request) => provider.listCommits!(ctx, ref, request), 100);
      if (commits.length < 2) return;

      // The two newest only: this downloads payloads, and a conformance run
      // pointed at a real tenant should not pull a model's whole history.
      const [newer, older] = commits;
      const [a, b] = await Promise.all([
        provider.loadCommit!(ctx, { ...ref, commitId: newer.id }),
        provider.loadCommit!(ctx, { ...ref, commitId: older.id }),
      ]);

      // The contract's actual rule, and the only direction that holds: the
      // digest MUST change when the bytes change. The converse does NOT —
      // two commits with identical bytes may legitimately differ (a provider
      // deriving the digest from a revision id) or agree (a content hash,
      // which is what Dalux's `contentHash` is: re-uploading identical bytes
      // yields the same hash under a new revision). Asserting uniqueness
      // across commits, as this once did, fails an honest content-addressed
      // store on a re-upload.
      const sameBytes = a.bytes.byteLength === b.bytes.byteLength
        && new Uint8Array(a.bytes).every((byte, i) => byte === new Uint8Array(b.bytes)[i]);
      if (sameBytes) return;
      expect(
        newer.artifact.digest,
        `commits ${newer.id} and ${older.id} have different bytes but the same digest`,
      ).not.toBe(older.artifact.digest);
    });

    it('honours the order of `accept` among the formats it can serve', async () => {
      const ctx = createContext();
      const commit = await headCommit(ctx);
      const declared = provider.manifest.capabilities.commits!.payloadFormats;

      // `payloadFormats` is what the provider can serve ACROSS its store, not
      // what it can serve for THIS commit: a store that keeps the uploaded
      // bytes has exactly one format per commit and transcodes nothing. So
      // the servable set is discovered per commit rather than assumed —
      // asserting the host's first choice unconditionally would fail every
      // honest provider that does not transcode.
      const servable: CommitPayloadFormat[] = [];
      for (const format of declared) {
        try {
          const payload = await provider.loadCommit!(ctx, { ...ref, commitId: commit.id }, { accept: [format] });
          expect(payload.format, `asked for ${format} alone and got ${payload.format}`).toBe(format);
          servable.push(format);
        } catch (error) {
          expect(
            isCommitSourceError(error) && error.code === 'unsupported-format',
            `loadCommit({ accept: ['${format}'] }) must serve it or throw unsupported-format, got ${String(error)}`,
          ).toBe(true);
        }
      }
      expect(servable.length, 'loadCommit can serve none of the declared payloadFormats').toBeGreaterThan(0);

      // The ordering rule itself, and it only has content when the provider
      // really does have a choice to make.
      if (servable.length < 2) return;
      const forward = await provider.loadCommit!(ctx, { ...ref, commitId: commit.id }, { accept: servable });
      expect(forward.format).toBe(servable[0]);
      const reversed = [...servable].reverse();
      const backward = await provider.loadCommit!(ctx, { ...ref, commitId: commit.id }, { accept: reversed });
      expect(backward.format, 'the HOST order decides, not the provider preference').toBe(reversed[0]);
    });

    it('returns a format the host accepted', async () => {
      const ctx = createContext();
      const commit = await headCommit(ctx);
      const declared = provider.manifest.capabilities.commits!.payloadFormats;
      const payload = await provider.loadCommit!(ctx, { ...ref, commitId: commit.id }, { accept: declared });
      expect(declared, `served ${payload.format}, which is not in payloadFormats`).toContain(payload.format);
    });

    it.runIf(unsupportedFormat !== undefined)('throws unsupported-format when it can serve none of `accept`', async () => {
      const ctx = createContext();
      const commit = await headCommit(ctx);
      await expect(
        provider.loadCommit!(ctx, { ...ref, commitId: commit.id }, { accept: [unsupportedFormat!] }),
      ).rejects.toMatchObject({ code: 'unsupported-format' });
    });
  });
}
