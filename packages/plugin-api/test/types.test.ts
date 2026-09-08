/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expectTypeOf } from 'vitest';
import type {
  FileSourceProvider,
  PluginContext,
  PluginManifest,
  SourceProject,
  SourceContainer,
  SourceFile,
  RevisionWatchResult,
  SourceFileRef,
  ListOptions,
  ConnectionTestResult,
  SourceTag,
} from '../src/index.js';

describe('plugin-api types', () => {
  it('FileSourceProvider has the expected method signatures', () => {
    expectTypeOf<FileSourceProvider['listProjects']>().toBeFunction();
    expectTypeOf<FileSourceProvider['listContainers']>().toBeFunction();
    expectTypeOf<FileSourceProvider['listFiles']>().toBeFunction();
    expectTypeOf<FileSourceProvider['download']>().toBeFunction();
  });

  it('watchRevisions is optional, and carries the v2 cursor + options', () => {
    // This assertion previously named `checkRevisions`, which the v2 contract
    // renamed to `watchRevisions`. It kept passing because `expectTypeOf` is
    // erased at runtime AND the package tsconfig only included `src/**/*`, so
    // nothing ever type-checked this file — the test asserted a property that
    // does not exist. `tsconfig.test.json` + `typecheck` in vitest.config.ts
    // now cover it, so a drift like that fails instead of passing silently.
    expectTypeOf<FileSourceProvider['watchRevisions']>().toEqualTypeOf<
      ((
        ctx: PluginContext,
        refs: readonly SourceFileRef[],
        cursor?: string,
        options?: ListOptions,
      ) => Promise<RevisionWatchResult>) | undefined
    >();
  });

  it('testConnection is optional', () => {
    expectTypeOf<FileSourceProvider['testConnection']>().toEqualTypeOf<
      ((ctx: PluginContext) => Promise<ConnectionTestResult>) | undefined
    >();
  });

  it('SourceTag carries the expected fields', () => {
    expectTypeOf<SourceTag>().toHaveProperty('provider');
    expectTypeOf<SourceTag>().toHaveProperty('fileId');
    expectTypeOf<SourceTag>().toHaveProperty('revisionId');
    expectTypeOf<SourceTag>().toHaveProperty('loadedAt');
  });

  it('the source hierarchy types carry their identifying fields', () => {
    // These three were imported and then never asserted on, which the unused-
    // locals ratchet surfaced once it started measuring test files. Deleting
    // the imports would have been the smaller change and the wrong one: the
    // listing types are the provider contract, so the intent was clearly to
    // cover them.
    expectTypeOf<SourceProject>().toHaveProperty('id');
    expectTypeOf<SourceProject>().toHaveProperty('name');
    expectTypeOf<SourceContainer>().toHaveProperty('id');
    expectTypeOf<SourceContainer>().toHaveProperty('name');
    expectTypeOf<SourceFile>().toHaveProperty('id');
    expectTypeOf<SourceFile>().toHaveProperty('name');
  });

  it('PluginManifest has required fields', () => {
    expectTypeOf<PluginManifest>().toHaveProperty('name');
    expectTypeOf<PluginManifest>().toHaveProperty('title');
    expectTypeOf<PluginManifest>().toHaveProperty('api');
    expectTypeOf<PluginManifest>().toHaveProperty('permissions');
    expectTypeOf<PluginManifest>().toHaveProperty('preferences');
    expectTypeOf<PluginManifest>().toHaveProperty('contributes');
  });
});
