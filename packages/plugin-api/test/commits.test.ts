/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Contract 2.1.0 (commit-aware sources). Two halves, both load-bearing:
 *
 *  - the TYPE assertions pin every new member's signature onto
 *    `FileSourceProvider`, and — the point of the exercise — pin each one as
 *    OPTIONAL. An additive contract that accidentally makes one method
 *    required breaks every `^2.0.0` provider at registration, which is
 *    exactly the failure this version bump exists to avoid. These run because
 *    `vitest.config.ts` turns `typecheck` on; see `types.test.ts` for the
 *    history of what happens when it is off.
 *  - `isCommitSourceError` is a RUNTIME export, so it gets runtime tests.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  isCommitSourceError,
  PLUGIN_API_VERSION,
  satisfiesCaretRange,
  type CommitCapabilities,
  type CommitPayload,
  type CommitRef,
  type CommitSourceErrorLike,
  type CommitWatchResult,
  type ElementHistoryEntry,
  type FileSourceProvider,
  type IdentityRecordSet,
  type ListCommitsOptions,
  type ModelRef,
  type Page,
  type PluginContext,
  type ProviderCapabilities,
  type SourceCommit,
  type SourceModel,
  type StoredCommitDiff,
} from '../src/index.js';

describe('plugin-api 2.1.0 version gate', () => {
  it('implements 2.1.0 and still satisfies every shipped ^2.0.0 provider', () => {
    expect(PLUGIN_API_VERSION).toBe('2.1.0');
    // The whole additive-only claim in one assertion: source-dalux,
    // source-dropbox and source-msgraph all declare `^2.0.0` and none of them
    // was touched by this change.
    expect(satisfiesCaretRange(PLUGIN_API_VERSION, '^2.0.0')).toBe(true);
    expect(satisfiesCaretRange(PLUGIN_API_VERSION, '^2.1.0')).toBe(true);
    // A provider needing a member that does not exist yet is still refused.
    expect(satisfiesCaretRange(PLUGIN_API_VERSION, '^2.2.0')).toBe(false);
  });
});

describe('commit capability declaration', () => {
  it('`commits` is optional on ProviderCapabilities', () => {
    expectTypeOf<ProviderCapabilities['commits']>().toEqualTypeOf<CommitCapabilities | undefined>();
  });

  it('every capability flag is a required boolean once `commits` is declared', () => {
    expectTypeOf<CommitCapabilities['fingerprints']>().toEqualTypeOf<boolean>();
    expectTypeOf<CommitCapabilities['storedDiffs']>().toEqualTypeOf<boolean>();
    expectTypeOf<CommitCapabilities['elementHistory']>().toEqualTypeOf<boolean>();
    expectTypeOf<CommitCapabilities['identityRecords']>().toEqualTypeOf<boolean>();
    expectTypeOf<CommitCapabilities['write']>().toEqualTypeOf<boolean>();
    expectTypeOf<CommitCapabilities['watch']>().toEqualTypeOf<boolean>();
    expectTypeOf<CommitCapabilities['modelIdsAreFileIds']>().toEqualTypeOf<boolean>();
  });
});

describe('commit methods on FileSourceProvider', () => {
  it('the five required-when-declared reads are still OPTIONAL members', () => {
    // Optional at the TYPE level, required by the CAPABILITY contract: a
    // `^2.0.0` provider has none of them and must keep type-checking.
    expectTypeOf<FileSourceProvider['listModels']>().toEqualTypeOf<
      | ((
          ctx: PluginContext,
          projectId: string,
          options?: ListOptionsWithQuery,
        ) => Promise<Page<SourceModel>>)
      | undefined
    >();
    expectTypeOf<FileSourceProvider['getModel']>().toEqualTypeOf<
      ((ctx: PluginContext, ref: ModelRef) => Promise<SourceModel>) | undefined
    >();
    expectTypeOf<FileSourceProvider['listCommits']>().toEqualTypeOf<
      ((ctx: PluginContext, ref: ModelRef, options?: ListCommitsOptions) => Promise<Page<SourceCommit>>) | undefined
    >();
    expectTypeOf<FileSourceProvider['getCommit']>().toEqualTypeOf<
      ((ctx: PluginContext, ref: CommitRef) => Promise<SourceCommit>) | undefined
    >();
  });

  it('loadCommit returns a typed payload, not a bare ArrayBuffer', () => {
    type Load = NonNullable<FileSourceProvider['loadCommit']>;
    expectTypeOf<Awaited<ReturnType<Load>>>().toEqualTypeOf<CommitPayload>();
    expectTypeOf<CommitPayload['bytes']>().toEqualTypeOf<ArrayBuffer>();
    expectTypeOf<CommitPayload['artifactDigest']>().toEqualTypeOf<string>();
  });

  it('the flag-gated members are optional and typed', () => {
    expectTypeOf<FileSourceProvider['getCommitDiff']>().toBeNullable();
    expectTypeOf<FileSourceProvider['listElementHistory']>().toBeNullable();
    expectTypeOf<FileSourceProvider['listIdentityRecords']>().toBeNullable();
    expectTypeOf<FileSourceProvider['createModel']>().toBeNullable();
    expectTypeOf<FileSourceProvider['createCommit']>().toBeNullable();
    expectTypeOf<FileSourceProvider['recordIdentity']>().toBeNullable();
    expectTypeOf<FileSourceProvider['watchCommits']>().toBeNullable();

    type Diff = NonNullable<FileSourceProvider['getCommitDiff']>;
    expectTypeOf<Awaited<ReturnType<Diff>>>().toEqualTypeOf<StoredCommitDiff>();
    type History = NonNullable<FileSourceProvider['listElementHistory']>;
    expectTypeOf<Awaited<ReturnType<History>>>().toEqualTypeOf<Page<ElementHistoryEntry>>();
    type Identity = NonNullable<FileSourceProvider['listIdentityRecords']>;
    expectTypeOf<Awaited<ReturnType<Identity>>>().toEqualTypeOf<IdentityRecordSet>();
    type Watch = NonNullable<FileSourceProvider['watchCommits']>;
    expectTypeOf<Awaited<ReturnType<Watch>>>().toEqualTypeOf<CommitWatchResult>();
  });

  it('a CommitRef is a ModelRef plus a commit id', () => {
    expectTypeOf<CommitRef>().toExtend<ModelRef>();
    expectTypeOf<CommitRef['commitId']>().toEqualTypeOf<string>();
  });
});

/** Local alias so the assertion above reads without importing the options type. */
type ListOptionsWithQuery = Parameters<NonNullable<FileSourceProvider['listModels']>>[2];

describe('isCommitSourceError', () => {
  it('accepts every code in the union', () => {
    const codes: CommitSourceErrorLike['code'][] = [
      'not-found', 'forbidden', 'conflict', 'not-ready', 'unsupported-format', 'invalid', 'unavailable',
    ];
    for (const code of codes) {
      expect(isCommitSourceError({ code, message: 'x' })).toBe(true);
    }
  });

  it('accepts a real Error subclass carrying a code', () => {
    class ProviderError extends Error {
      readonly code = 'conflict' as const;
      readonly details = { headCommitId: 'c9' };
    }
    const err: unknown = new ProviderError('head moved');
    expect(isCommitSourceError(err)).toBe(true);
    if (isCommitSourceError(err)) {
      // The narrowing is the point — a host branches on this without knowing
      // which provider threw.
      expect(err.code).toBe('conflict');
      expect(err.details?.headCommitId).toBe('c9');
    }
  });

  it('accepts a prototype-less object, because a worker boundary strips prototypes', () => {
    const plain = Object.assign(Object.create(null), { code: 'not-ready', message: 'computing', retryAfterMs: 500 });
    expect(isCommitSourceError(plain)).toBe(true);
  });

  it('rejects anything that would not tell a host what to do', () => {
    expect(isCommitSourceError(new Error('plain'))).toBe(false);
    expect(isCommitSourceError({ code: 'teapot', message: 'x' })).toBe(false);
    expect(isCommitSourceError({ code: 'conflict' })).toBe(false);
    expect(isCommitSourceError({ code: 'conflict', message: 42 })).toBe(false);
    expect(isCommitSourceError(null)).toBe(false);
    expect(isCommitSourceError(undefined)).toBe(false);
    expect(isCommitSourceError('conflict')).toBe(false);
  });
});
