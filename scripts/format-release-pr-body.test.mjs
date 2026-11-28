// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

const formatterUrl = new URL('./format-release-pr-body.mjs', import.meta.url);
const formatter = existsSync(formatterUrl) ? await import(formatterUrl.href) : null;

test('labels private version bumps in generated release descriptions (#11789)', () => {
  const generated = [
    'Merge this and the packages will be published to npm automatically.',
    '',
    '# Releases',
    '## @ifc-lite/parser@5.0.0',
    '',
    'Parser changelog.',
    '## @ifc-lite/viewer-embed@1.15.32',
    '',
    'Embed changelog.',
    '',
  ].join('\n');
  const manifests = [
    { name: '@ifc-lite/parser', version: '5.0.0' },
    { name: '@ifc-lite/viewer-embed', version: '1.15.32', private: true },
  ];

  // Before the release workflow had a formatter, the generated body reached GitHub verbatim.
  const body = formatter ? formatter.formatReleasePrBody(generated, manifests) : generated;
  assert.equal(body, [
    'Merge this and public packages will be published to npm automatically. Entries marked as private version bumps stay in the workspace.',
    '',
    '# Releases',
    '## @ifc-lite/parser@5.0.0',
    '',
    'Parser changelog.',
    '## @ifc-lite/viewer-embed@1.15.32 (private version bump)',
    '',
    'Embed changelog.',
    '',
  ].join('\n'));
  assert.equal(formatter.formatReleasePrBody(body, manifests), body);
});
