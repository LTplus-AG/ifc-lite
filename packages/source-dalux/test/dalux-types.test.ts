/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  DaluxDecodeError,
  decodeFile,
  decodeFileArea,
  decodeFileResponse,
  decodeFolder,
  decodeProject,
} from '../src/dalux-types.js';

/**
 * These decoders replaced a third-party zod schema set. The point of the
 * tests below is that the replacement is a dependency change and not a
 * behaviour change, so they pin the semantics that were previously supplied
 * by zod: nullish handling, the `deleted` default, non-strict objects, and
 * rejection (rather than coercion) of wrong-typed fields.
 */

const validFile = {
  fileId: 'f1',
  fileName: 'model.ifc',
  fileAreaId: 'fa1',
  deleted: false,
};

describe('decodeProject', () => {
  it('decodes the required fields and ignores unknown ones', () => {
    expect(
      decodeProject({ projectId: 'p1', projectName: 'Tower', address: 'somewhere', modules: [] }),
    ).toEqual({ projectId: 'p1', projectName: 'Tower' });
  });

  it('rejects a missing required field', () => {
    expect(() => decodeProject({ projectId: 'p1' })).toThrow(DaluxDecodeError);
    expect(() => decodeProject({ projectId: 'p1' })).toThrow(/projectName/);
  });

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 42, 'x', ['a']]) {
      expect(() => decodeProject(value)).toThrow(DaluxDecodeError);
    }
  });
});

describe('decodeFileArea', () => {
  it('requires all three fields', () => {
    expect(decodeFileArea({ fileAreaId: 'a', fileAreaName: 'Docs', fileAreaType: 'standard' })).toEqual({
      fileAreaId: 'a',
      fileAreaName: 'Docs',
      fileAreaType: 'standard',
    });
    expect(() => decodeFileArea({ fileAreaId: 'a', fileAreaName: 'Docs' })).toThrow(/fileAreaType/);
  });
});

describe('decodeFolder', () => {
  it('treats an absent and an explicitly null parentFolderId identically', () => {
    const absent = decodeFolder({ folderId: 'd1', folderName: 'Level 1' });
    const explicitNull = decodeFolder({ folderId: 'd1', folderName: 'Level 1', parentFolderId: null });

    expect(absent.parentFolderId).toBeUndefined();
    expect(explicitNull.parentFolderId).toBeUndefined();
    expect(absent).toEqual(explicitNull);
  });

  it('keeps a real parentFolderId', () => {
    expect(decodeFolder({ folderId: 'd2', folderName: 'Sub', parentFolderId: 'd1' }).parentFolderId).toBe('d1');
  });
});

describe('decodeFile', () => {
  it('defaults deleted to false when absent or null', () => {
    expect(decodeFile({ fileId: 'f', fileName: 'a.ifc', fileAreaId: 'fa' }).deleted).toBe(false);
    expect(decodeFile({ ...validFile, deleted: null }).deleted).toBe(false);
  });

  it('preserves an explicit deleted: true', () => {
    expect(decodeFile({ ...validFile, deleted: true }).deleted).toBe(true);
  });

  it('rejects a non-boolean deleted rather than coercing it', () => {
    expect(() => decodeFile({ ...validFile, deleted: 'yes' })).toThrow(/deleted/);
    expect(() => decodeFile({ ...validFile, deleted: 1 })).toThrow(/deleted/);
  });

  it('rejects a wrong-typed optional rather than coercing it', () => {
    // Silently reinterpreting this would surface a nonsense size in the UI.
    expect(() => decodeFile({ ...validFile, fileSize: 'big' })).toThrow(/fileSize/);
    expect(() => decodeFile({ ...validFile, fileName: 123 })).toThrow(/fileName/);
  });

  it('coerces a non-finite fileSize to undefined instead of dropping the whole file', () => {
    // zod's z.number() accepted NaN/Infinity, so silently rejecting the
    // whole row here would be an undocumented behaviour change: a bad
    // fileSize shouldn't cost the user the rest of the row.
    expect(decodeFile({ ...validFile, fileSize: Number.NaN }).fileSize).toBeUndefined();
    expect(decodeFile({ ...validFile, fileSize: Number.POSITIVE_INFINITY }).fileSize).toBeUndefined();
    expect(decodeFile({ ...validFile, fileSize: Number.NEGATIVE_INFINITY }).fileSize).toBeUndefined();
    // The rest of the row still decodes normally.
    expect(decodeFile({ ...validFile, fileSize: Number.NaN }).fileId).toBe('f1');
  });

  it('normalises every nullish field to undefined', () => {
    const decoded = decodeFile({
      ...validFile,
      fileRevisionId: null,
      folderId: null,
      uploaded: null,
      lastModified: null,
      fileType: null,
      fileSize: null,
      downloadLink: null,
    });

    expect(decoded.fileRevisionId).toBeUndefined();
    expect(decoded.folderId).toBeUndefined();
    expect(decoded.fileSize).toBeUndefined();
    expect(decoded.downloadLink).toBeUndefined();
  });

  it('accepts an empty string id — that is the API’s business, not the decoder’s', () => {
    expect(decodeFile({ ...validFile, fileId: '' }).fileId).toBe('');
  });

  it('carries through the fields the provider actually maps', () => {
    const decoded = decodeFile({
      ...validFile,
      fileRevisionId: 'r7',
      folderId: 'd1',
      fileType: 'application/octet-stream',
      fileSize: 1024,
      lastModified: '2026-07-24T00:00:00Z',
      lastModifiedByUserId: 'u9',
      downloadLink: 'https://node1.field.dalux.com/service/api/x',
    });

    expect(decoded).toMatchObject({
      fileRevisionId: 'r7',
      folderId: 'd1',
      fileSize: 1024,
      lastModifiedByUserId: 'u9',
    });
  });
});

describe('decodeFileResponse', () => {
  it('unwraps the data envelope', () => {
    expect(decodeFileResponse({ data: validFile, links: [] }).data.fileId).toBe('f1');
  });

  it('throws loudly when data is missing or invalid', () => {
    expect(() => decodeFileResponse({ links: [] })).toThrow(/data/);
    expect(() => decodeFileResponse({ data: { fileId: 'f1' } })).toThrow(DaluxDecodeError);
  });
});
