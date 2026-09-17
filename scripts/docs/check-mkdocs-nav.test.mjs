/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isExcluded, navPages, notInNavPatterns } from './check-mkdocs-nav.mjs';

test('reads nav page paths, including titled and untitled entries', () => {
  const pages = navPages(`site_name: x
nav:
  - Home: index.md
  - Guide:
    - Cost Panel: guide/cost-panel.md
    - guide/untitled.md
# a column-zero comment between entries does not end the nav
    - "IFC 5D: cost schedules": guide/cost-schedules.md
    - Parsing: Advanced: guide/parsing-advanced.md
  - External: https://example.com/page.md
theme:
  name: material
`);
  assert.deepEqual([...pages].sort(), [
    'guide/cost-panel.md', 'guide/cost-schedules.md', 'guide/parsing-advanced.md', 'guide/untitled.md', 'index.md',
  ]);
});

test('reads not_in_nav patterns and applies directory and exact shapes', () => {
  const patterns = notInNavPatterns(`not_in_nav: |
  architecture/evidence/**
  # comments are not patterns
  /research/note.md

theme:
  name: material
`);
  assert.deepEqual(patterns, ['architecture/evidence/**', '/research/note.md']);
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
