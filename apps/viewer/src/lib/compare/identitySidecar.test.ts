/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Compare panel's sidecar round-trip under an authored key scheme (issue
 * #4989): an export pinned to `keyProperty: 'Tag'` writes format version 2
 * (`@ifc-lite/diff`'s `IDENTITY_MAP_SIDECAR_KEYED_VERSION`), and an import is
 * refused unless the panel's current scheme matches the one the map was
 * written under exactly — GlobalId included, since a GlobalId-keyed map
 * replayed under `Tag` would otherwise apply nothing, silently.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelDiff, ModelIdentity } from '@ifc-lite/diff';
import type { CompareResult } from '../../store/slices/compareSlice.js';
import type { CompareRef } from './buildFingerprints.js';
import { downloadIdentityMapSidecar, readIdentityMapSidecar } from './identitySidecar.js';

const identities = {
  base: { hash: 'sha256:aaa', path: 'A.ifc' } as ModelIdentity,
  head: { hash: 'sha256:bbb', path: 'B.ifc' } as ModelIdentity,
};

function result(keyProperty: string | undefined): CompareResult {
  const diff: ModelDiff<CompareRef> = {
    entries: [],
    byKey: new Map(),
    counts: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
    scope: 'both',
    excludedTypes: [],
  };
  return {
    baseModelId: 'A',
    headModelId: 'B',
    baseName: 'A.ifc',
    headName: 'B.ifc',
    scope: 'both',
    geometryUnavailable: false,
    excludedHiddenIds: new Set(),
    keyProperty,
    diff,
  };
}

let capturedBlob: Blob | null = null;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  capturedBlob = null;
  URL.createObjectURL = ((blob: Blob) => {
    capturedBlob = blob;
    return 'blob:mock';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe('downloadIdentityMapSidecar carries the key scheme (#4989)', () => {
  it('writes version 2 with keyProperty for an authored-key run', async () => {
    downloadIdentityMapSidecar(
      result('Tag'),
      identities,
      [{ base: 'A-1', here: 'A-1b', reason: 'successor:footprint' }],
    );
    assert.ok(capturedBlob, 'a blob must have been downloaded');
    const text = await capturedBlob!.text();
    const parsed = JSON.parse(text);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.keyProperty, 'Tag');
  });

  it('writes version 1 with no keyProperty for a GlobalId run', async () => {
    downloadIdentityMapSidecar(result(undefined), identities, []);
    const text = await capturedBlob!.text();
    const parsed = JSON.parse(text);
    assert.equal(parsed.version, 1);
    assert.equal('keyProperty' in parsed, false);
  });
});

describe('readIdentityMapSidecar refuses a scheme mismatch (#4989)', () => {
  async function exportedTagMapText(): Promise<string> {
    downloadIdentityMapSidecar(
      result('Tag'),
      identities,
      [{ base: 'A-1', here: 'A-1b', reason: 'successor:footprint' }],
    );
    return capturedBlob!.text();
  }

  it('imports a v2 map under the same scheme', async () => {
    const text = await exportedTagMapText();
    const read = readIdentityMapSidecar(text, identities, 'Tag');
    assert.ok('entries' in read, (read as { error?: string }).error ?? 'expected entries');
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].base, 'A-1');
  });

  it('refuses the same map under a DIFFERENT authored scheme', async () => {
    const text = await exportedTagMapText();
    const read = readIdentityMapSidecar(text, identities, 'Pset_Asset.AssetId');
    assert.ok('error' in read);
    assert.match(read.error, /key scheme/i);
  });

  it('refuses a Tag-keyed map when the panel is on GlobalId', async () => {
    const text = await exportedTagMapText();
    const read = readIdentityMapSidecar(text, identities, undefined);
    assert.ok('error' in read);
    assert.match(read.error, /key scheme/i);
  });

  it('refuses a GlobalId-keyed (v1) map when the panel is on an authored scheme', async () => {
    downloadIdentityMapSidecar(result(undefined), identities, []);
    const text = await capturedBlob!.text();
    const read = readIdentityMapSidecar(text, identities, 'Tag');
    assert.ok('error' in read);
    assert.match(read.error, /key scheme/i);
  });
});
