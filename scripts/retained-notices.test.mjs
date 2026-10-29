// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderNotices } from './retained-notices.mjs';

test('Refs #7955 notice bundle preserves attribution bytes and refuses corrupted inputs', () => {
  const text = 'Copyright Example Author\nPermission and disclaimer\n';
  const component = { name: 'fixture', version: '1', license: 'MIT', source: 'fixture archive', scope: 'inert packaging fixture',
    notices: [{ file: 'fixture.txt', origin: 'LICENSE', sha256: createHash('sha256').update(text).digest('hex') }] };
  assert.ok(renderNotices({ components: [component] }, () => text).includes(text));
  assert.throws(() => renderNotices({ components: [component] }, () => 'truncated'), /hash mismatch/);
  assert.match(renderNotices({ components: [{ ...component, notices: [] }] }, () => ''), /OPEN: upstream package contains no licence text/);
});
