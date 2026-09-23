/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The python-api region of generate-docs-sections.mjs (#4899, #4926).
 *
 * The generator derives its root from its own location and exports nothing,
 * so the reproduction is a copy of the real script into a synthetic tree,
 * next to copies of the real inputs of the OTHER regions (every region runs
 * on each invocation) plus a synthetic rust/python/README.md, run as a child
 * process. Inputs are copied with CRLF folded to LF so a Windows checkout
 * sees the same bytes as CI.
 *
 * The README deliberately carries every String.prototype.replace
 * replacement token: the first version of the region passed the README to
 * `replace` as a replacement STRING, so an inline `$` from the real README
 * expanded `$`` into the whole page header ("# Python API Reference") in the
 * middle of the generated body.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const PAGE_HEADER = '# Python API Reference';
const BEGIN = '<!-- BEGIN GENERATED: python-api -->';
const END = '<!-- END GENERATED: python-api -->';

function copyLf(rel, root) {
  const dest = join(root, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(join(REPO, rel), 'utf-8').replace(/\r\n/g, '\n'));
}

function makeTree(readme) {
  const root = mkdtempSync(join(tmpdir(), 'generate-docs-sections-'));
  copyLf('scripts/docs/generate-docs-sections.mjs', root);
  for (const dir of readdirSync(join(REPO, 'packages'))) {
    if (existsSync(join(REPO, 'packages', dir, 'package.json'))) {
      copyLf(`packages/${dir}/package.json`, root);
    }
  }
  for (const rel of [
    'packages/cli/src/index.ts',
    // The help text the CLI table is generated from lives here since #5138 PR 7b.
    'packages/cli/src/help.ts',
    'tests/benchmark/baseline.json',
    'apps/landing/bench-data.json',
    'apps/landing/app.jsx',
    'docs/api/typescript.md',
    'docs/guide/cli.md',
    'docs/guide/performance.md',
  ]) {
    copyLf(rel, root);
  }
  mkdirSync(join(root, 'rust', 'python'), { recursive: true });
  writeFileSync(join(root, 'rust', 'python', 'README.md'), readme);
  writeFileSync(
    join(root, 'docs', 'api', 'python.md'),
    `${PAGE_HEADER}\n\n${BEGIN}\nstale placeholder\n${END}\n`,
  );
  return root;
}

function generate(root) {
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'docs', 'generate-docs-sections.mjs')], {
    encoding: 'utf-8',
  });
  assert.equal(run.status, 0, `generator failed:\n${run.stdout}\n${run.stderr}`);
  return readFileSync(join(root, 'docs', 'api', 'python.md'), 'utf-8');
}

/** The whole python.md the generator must write around a given body. */
function expectedDoc(body) {
  return `${PAGE_HEADER}\n\n${BEGIN}\n${body}\n${END}\n`;
}

test('python-api stamps README text containing replacement tokens literally (#4926)', () => {
  const body = [
    '## Attributes',
    '',
    'An attribute left `$` is omitted.',
    "Every token: $` $' $& $1 $2 $$ $<name>.",
  ].join('\n');
  const root = makeTree(`# ifclite-geom\n\n${body}\n`);
  try {
    assert.equal(generate(root), expectedDoc(body));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('python-api drops the README title and points ./examples links at GitHub (#4899)', () => {
  const readme = [
    '# ifclite-geom',
    '',
    'See [the examples](./examples) and [triangles](./examples/triangles.py).',
    '',
  ].join('\n');
  const root = makeTree(readme);
  try {
    assert.equal(
      generate(root),
      expectedDoc(
        'See [the examples](https://github.com/LTplus-AG/ifc-lite/tree/main/rust/python/examples)' +
          ' and [triangles](https://github.com/LTplus-AG/ifc-lite/blob/main/rust/python/examples/triangles.py).',
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
