/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import type { Logger, PluginContext } from '@ifc-lite/plugin-api';
import {
  LATEST_REVISION,
  convertListLenient,
  decodeContainerId,
  fileAreaContainerId,
  folderContainerId,
  toSourceFile,
} from '../src/mapping.js';
import type { DaluxFile } from 'dalux-build-api/src/models/files/index.js';

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockCtx(): PluginContext {
  return {
    fetch: vi.fn() as unknown as typeof fetch,
    fetchPublic: vi.fn() as unknown as PluginContext['fetchPublic'],
    getPreference: vi.fn(() => Promise.resolve(undefined)),
    storage: {
      get: vi.fn(() => Promise.resolve(undefined)),
      set: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve()),
      keys: vi.fn(() => Promise.resolve([])),
    },
    log: createMockLogger(),
  };
}

function daluxFile(overrides: Partial<DaluxFile> = {}): DaluxFile {
  return {
    fileId: 'f1',
    fileName: 'model.ifc',
    fileAreaId: 'fa1',
    deleted: false,
    ...overrides,
  };
}

describe('container id encoding', () => {
  it('round-trips a file-area-only container id', () => {
    const id = fileAreaContainerId('fa1');
    expect(decodeContainerId(id)).toEqual({ fileAreaId: 'fa1' });
  });

  it('round-trips a folder container id', () => {
    const id = folderContainerId('fa1', 'folder-a');
    expect(decodeContainerId(id)).toEqual({ fileAreaId: 'fa1', folderId: 'folder-a' });
  });
});

describe('toSourceFile', () => {
  it('uses the real fileRevisionId as currentRevisionId when present', () => {
    const file = toSourceFile('fa1', daluxFile({ fileRevisionId: 'rev-7' }));
    expect(file.currentRevisionId).toBe('rev-7');
  });

  it('falls back to the explicit LATEST_REVISION sentinel rather than faking one from fileId', () => {
    const file = toSourceFile('fa1', daluxFile({ fileRevisionId: null }));
    expect(file.currentRevisionId).toBe(LATEST_REVISION);
    expect(file.currentRevisionId).not.toBe(file.id);
  });

  it('places a folder-owned file under the composite folder container id', () => {
    const file = toSourceFile('fa1', daluxFile({ folderId: 'folder-a' }));
    expect(file.containerId).toBe(folderContainerId('fa1', 'folder-a'));
  });

  it('places a root file directly under the file area container id', () => {
    const file = toSourceFile('fa1', daluxFile({ folderId: null }));
    expect(file.containerId).toBe(fileAreaContainerId('fa1'));
  });
});

interface Thing {
  readonly id: string;
  readonly name: string;
}

/** Minimal stand-in for a zod schema — just enough surface
 * (`convertListLenient` only ever calls `.parse`) to exercise the
 * drop-invalid-records behavior without pulling in a real schema library. */
const thingSchema = {
  parse(value: unknown): Thing {
    const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
    if (!record || typeof record.id !== 'string' || typeof record.name !== 'string') {
      throw new Error('invalid Thing');
    }
    return { id: record.id, name: record.name };
  },
};

describe('convertListLenient', () => {
  const schema = thingSchema;

  it('keeps every record that validates', () => {
    const ctx = createMockCtx();
    const result = convertListLenient(ctx, [{ id: '1', name: 'a' }, { id: '2', name: 'b' }], schema, 'Thing');
    expect(result).toEqual([{ id: '1', name: 'a' }, { id: '2', name: 'b' }]);
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it('drops an invalid record with a logged warning instead of throwing and losing every record', () => {
    const ctx = createMockCtx();
    const result = convertListLenient(
      ctx,
      [{ id: '1', name: 'a' }, { id: '2' /* missing name */ }, { id: '3', name: 'c' }],
      schema,
      'Thing',
    );
    expect(result).toEqual([{ id: '1', name: 'a' }, { id: '3', name: 'c' }]);
    expect(ctx.log.warn).toHaveBeenCalledOnce();
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Thing'),
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it('unwraps a Dalux `{ data }` envelope before validating', () => {
    const ctx = createMockCtx();
    const result = convertListLenient(ctx, [{ data: { id: '1', name: 'a' } }], schema, 'Thing');
    expect(result).toEqual([{ id: '1', name: 'a' }]);
  });
});
