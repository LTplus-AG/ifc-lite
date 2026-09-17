/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isExcluded, navPages, notInNavPatterns, omittedPages } from './check-mkdocs-nav.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the REAL docs tree has no page mkdocs --strict would reject as omitted from nav (#4912)', () => {
  // #4875 added docs/guide/cost-panel.md without a nav entry; the strict site
  // build in the ifclite.dev deploy then failed and froze the nightly
  // production advance. This is that failure, caught in Node tests.
  assert.deepEqual(omittedPages(REPO_ROOT), []);
});

test('reads nav page paths, including titled and untitled entries', () => {
  const pages = navPages(`site_name: x
nav:
  - Home: index.md
  - Guide:
    - Cost Panel: guide/cost-panel.md
    - guide/untitled.md
  - External: https://example.com/page.md
theme:
  name: material
`);
  assert.deepEqual([...pages].sort(), ['guide/cost-panel.md', 'guide/untitled.md', 'index.md']);
});

test('reads not_in_nav patterns and applies directory and exact shapes', () => {
  const patterns = notInNavPatterns(`not_in_nav: |
  architecture/evidence/**
  research/note.md

theme:
  name: material
`);
  assert.deepEqual(patterns, ['architecture/evidence/**', 'research/note.md']);
  assert.equal(isExcluded('architecture/evidence/a/README.md', patterns), true);
  assert.equal(isExcluded('architecture/evidence.md', patterns), false);
  assert.equal(isExcluded('research/note.md', patterns), true);
  assert.equal(isExcluded('guide/cost-panel.md', patterns), false);
});

test('refuses a not_in_nav pattern shape it cannot evaluate, rather than passing', () => {
  assert.throws(() => isExcluded('guide/x.md', ['guide/*.md']), /does not understand/);
});

test('refuses a mkdocs.yml without a nav block', () => {
  assert.throws(() => navPages('site_name: x\n'), /no top-level `nav:` block/);
});
