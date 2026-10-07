/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactLink, parseDeepLink, withoutDeepLink } from './artifact-link';

test('#6927 artifact links resolve to their owning panel and exclude room invitation credentials', () => {
  const url = artifactLink('https://viewer.example/?model=house.ifc&room=private&t=secret&panel=clash#old', { kind: 'conversation', id: 'conversation-1' });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('model'), 'house.ifc');
  assert.equal(parsed.searchParams.has('room'), false);
  assert.equal(parsed.searchParams.has('t'), false);
  assert.equal(parsed.hash, '');
  assert.deepEqual(parseDeepLink(parsed.search), { ok: true, panel: 'assistant', artifact: { kind: 'conversation', id: 'conversation-1' } });
  assert.equal(withoutDeepLink(parsed.search), '?model=house.ifc');
});

test('#6927 an artifact-only link implies its owner and retired panel names migrate', () => {
  assert.deepEqual(parseDeepLink('?bcfDraft=batch-1'), { ok: true, panel: 'bcf', artifact: { kind: 'bcfDraft', id: 'batch-1' } });
  assert.deepEqual(parseDeepLink('?panel=ids'), { ok: true, panel: 'validation', artifact: null });
  assert.equal(parseDeepLink('?model=house.ifc'), null);
});

test('#6927 malformed and ambiguous links refuse a destination instead of picking one', () => {
  for (const query of ['?panel=clash&conversation=c1', '?conversation=c1&receipt=r1', '?conversation=c1&conversation=c2', '?receipt=../private', '?panel=unknown', '?panel=assistant&panel=clash', '?panel=clash&panel=assistant']) {
    assert.equal(parseDeepLink(query)?.ok, false, query);
  }
});
