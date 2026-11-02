/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { DaluxDecodeError } from '../src/dalux-types.js';
import {
  commitDigest,
  commitTimestamp,
  decodeVersionSet,
  isModelFileName,
} from '../src/version-sets.js';

describe('isModelFileName', () => {
  it('accepts every model extension this viewer can open', () => {
    for (const name of ['a.ifc', 'a.IFCZIP', 'a.ifcxml', 'a.ifcx', 'a.ifc5']) {
      expect(isModelFileName(name)).toBe(true);
    }
  });

  it('rejects the documents a version set also pins', () => {
    for (const name of ['readme.txt', 'plan.pdf', 'sheet.xlsx', 'model.ifc.bak']) {
      expect(isModelFileName(name)).toBe(false);
    }
  });
});

describe('decodeVersionSet', () => {
  it('decodes a well-formed row', () => {
    const set = decodeVersionSet({
      versionSetId: 'vs-1',
      name: 'Coordination round 14',
      status: 'locked',
      fileAreaId: 'fa-models',
    });
    expect(set).toEqual({
      versionSetId: 'vs-1',
      name: 'Coordination round 14',
      status: 'locked',
      fileAreaId: 'fa-models',
    });
  });

  it('omits description/status when Dalux sends none', () => {
    const set = decodeVersionSet({ versionSetId: 'vs-1', name: 'Set', fileAreaId: 'fa-1' });
    expect(set).not.toHaveProperty('description');
    expect(set).not.toHaveProperty('status');
  });

  it('throws on a missing required field', () => {
    expect(() => decodeVersionSet({ name: 'Set', fileAreaId: 'fa-1' })).toThrow(DaluxDecodeError);
  });

  it('throws on a non-object payload', () => {
    expect(() => decodeVersionSet('not-an-object')).toThrow(DaluxDecodeError);
  });
});

describe('commitDigest', () => {
  it('prefers contentHash, namespaced as dalux-content — never sha256', () => {
    const digest = commitDigest({ contentHash: 'abc123', fileRevisionId: 'rev-1' });
    expect(digest).toBe('dalux-content:abc123');
    expect(digest.startsWith('sha256:')).toBe(false);
  });

  it('falls back to the revision id when Dalux gave no content hash', () => {
    expect(commitDigest({ contentHash: undefined, fileRevisionId: 'rev-1' })).toBe('dalux-revision:rev-1');
  });

  it('treats a blank contentHash the same as an absent one', () => {
    expect(commitDigest({ contentHash: '   ', fileRevisionId: 'rev-1' })).toBe('dalux-revision:rev-1');
  });
});

describe('commitTimestamp', () => {
  it('prefers lastModified over uploaded', () => {
    expect(commitTimestamp({ lastModified: '2026-03-03', uploaded: '2026-01-01' })).toBe('2026-03-03');
  });

  it('falls back to uploaded when lastModified is absent', () => {
    expect(commitTimestamp({ lastModified: undefined, uploaded: '2026-01-01' })).toBe('2026-01-01');
  });

  it('is undefined when Dalux supplied neither', () => {
    expect(commitTimestamp({ lastModified: undefined, uploaded: undefined })).toBeUndefined();
  });
});
