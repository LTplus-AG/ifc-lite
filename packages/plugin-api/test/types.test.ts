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
  RevisionEvent,
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

  it('checkRevisions is optional', () => {
    expectTypeOf<FileSourceProvider['checkRevisions']>().toEqualTypeOf<
      ((ctx: PluginContext, fileIds: string[]) => Promise<RevisionEvent[]>) | undefined
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

  it('PluginManifest has required fields', () => {
    expectTypeOf<PluginManifest>().toHaveProperty('name');
    expectTypeOf<PluginManifest>().toHaveProperty('title');
    expectTypeOf<PluginManifest>().toHaveProperty('api');
    expectTypeOf<PluginManifest>().toHaveProperty('permissions');
    expectTypeOf<PluginManifest>().toHaveProperty('preferences');
    expectTypeOf<PluginManifest>().toHaveProperty('contributes');
  });
});
