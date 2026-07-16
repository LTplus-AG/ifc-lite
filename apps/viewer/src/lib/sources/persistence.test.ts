/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import type { SourceFile, SourceTag } from '@ifc-lite/plugin-api';
import {
  getDownloadedSourceFileRecord,
  getDownloadedSourceFileStatus,
  loadDownloadedSourceFileRecords,
  loadSourceCatalogCache,
  makeDownloadedSourceFileKey,
  recordDownloadedSourceFile,
  saveSourceCatalogCache,
} from './persistence.js';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const localStorageMock = new MemoryStorage();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: localStorageMock,
});

describe('source persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a cached file-area catalog', () => {
    const saved = saveSourceCatalogCache(
      'dalux-build',
      'project-1',
      'file-area-1',
      [{ id: 'folder-1', name: 'Folder A', parentId: 'file-area-1' }],
      [{
        id: 'file-1',
        name: 'Model.ifc',
        containerId: 'folder-1',
        currentRevisionId: 'rev-2',
        revisions: [{ id: 'rev-2', version: 2, createdAt: '2026-07-16T12:00:00Z' }],
      }],
    );

    const loaded = loadSourceCatalogCache('dalux-build', 'project-1', 'file-area-1');
    assert.deepStrictEqual(loaded, saved);
  });

  it('stores downloaded source-file metadata keyed by provider, project, and file', () => {
    const sourceFile: SourceFile = {
      id: 'file-1',
      name: 'Model.ifc',
      containerId: 'folder-1',
      currentRevisionId: 'rev-3',
      sizeBytes: 512,
      revisions: [{ id: 'rev-3', version: 3, createdAt: '2026-07-16T12:00:00Z' }],
    };
    const tag: SourceTag = {
      provider: 'dalux-build',
      projectId: 'project-1',
      containerId: 'folder-1',
      fileId: 'file-1',
      revisionId: 'rev-3',
      loadedAt: 123,
    };

    const record = recordDownloadedSourceFile(tag, sourceFile);
    const records = loadDownloadedSourceFileRecords();

    assert.deepStrictEqual(
      records.get(makeDownloadedSourceFileKey('dalux-build', 'project-1', 'file-1')),
      record,
    );
    assert.deepStrictEqual(
      getDownloadedSourceFileRecord(records, 'dalux-build', 'project-1', 'file-1'),
      record,
    );
  });

  it('flags downloaded files orange when Dalux exposes a newer revision', () => {
    const sourceFile: SourceFile = {
      id: 'file-1',
      name: 'Model.ifc',
      containerId: 'folder-1',
      currentRevisionId: 'rev-4',
      revisions: [{ id: 'rev-4', version: 4, createdAt: '2026-07-16T12:00:00Z' }],
    };

    assert.strictEqual(getDownloadedSourceFileStatus(sourceFile), 'never-loaded');
    assert.strictEqual(
      getDownloadedSourceFileStatus(sourceFile, {
        providerId: 'dalux-build',
        projectId: 'project-1',
        containerId: 'folder-1',
        fileId: 'file-1',
        name: 'Model.ifc',
        loadedRevisionId: 'rev-4',
        loadedRevisionVersion: 4,
        loadedAt: 123,
      }),
      'loaded-current',
    );
    assert.strictEqual(
      getDownloadedSourceFileStatus(sourceFile, {
        providerId: 'dalux-build',
        projectId: 'project-1',
        containerId: 'folder-1',
        fileId: 'file-1',
        name: 'Model.ifc',
        loadedRevisionId: 'rev-3',
        loadedRevisionVersion: 3,
        loadedAt: 123,
      }),
      'update-available',
    );
  });
});
