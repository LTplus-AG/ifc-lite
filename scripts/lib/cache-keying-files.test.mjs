/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheKeyingFiles, isListed, parseKeyingList } from './cache-keying-files.mjs';
import { KEYING_LIST_PATH } from './cache-keying-list.mjs';

const ROOT = '.github/workflows/test.yml';

/** cacheKeyingFiles over an in-memory tree; `githubFiles` defaults to every fixture path under .github/. */
function check(fixture, { extra = [], symlinks = [] } = {}) {
  const githubFiles = [...Object.keys(fixture), ...extra].filter((p) => /^\.github\/(?:workflows|actions)\//.test(p));
  return cacheKeyingFiles({ root: ROOT, githubFiles, symlinks, readText: (p) => fixture[p] ?? null });
}

const action = (body = '[]') => `runs:\n  using: composite\n  steps: ${body}\n`;

// The repository's own list against its own workflow and actions, parsed with a
// real YAML parser. This runs in the Node guards lane of every PR and batch run
// that touches a workflow or action file, so the green run a replay needs has
// checked the list for that exact tree.
test('scripts/ci-cache-keying-files.txt lists every file that can key a Test cache', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const githubFiles = git('ls-files', '-z', '.github/workflows', '.github/actions').split('\0').filter(Boolean);
  const symlinks = git('ls-files', '-z', '-s').split('\0').filter((e) => e.startsWith('120000 '))
    .map((e) => e.slice(e.indexOf('\t') + 1)).map((path) => ({ path, target: readlinkSync(join(repoRoot, path)) }));
  const readText = (p) => {
    try {
      return readFileSync(join(repoRoot, p), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };
  const list = parseKeyingList(readText(KEYING_LIST_PATH) ?? '');
  const { required, errors } = cacheKeyingFiles({ root: ROOT, githubFiles, symlinks, readText });
  assert.deepEqual(errors, [], 'a cache key input the check cannot judge');
  assert.deepEqual(required.filter((p) => !isListed(p, list)), [], `add these to ${KEYING_LIST_PATH}`);
  // A stale entry costs replays for nothing; keep the list to what exists.
  assert.deepEqual(list.filter((e) => !githubFiles.some((f) => (e.endsWith('/') ? f.startsWith(e) : f === e))), [], 'entries naming no file');
});

test('follows reusable workflows and composite actions, and lists what they hash', () => {
  const r = check({
    [ROOT]: [
      'jobs:',
      '  a:',
      '    uses: ./.github/workflows/reusable.yml',
      '  b:',
      '    steps:',
      '      - uses: ./.github/actions/setup',
      '      - uses: actions/setup-python@v5',
      '        with:',
      '          cache-dependency-path: |',
      '            requirements.txt',
      '            .github/workflows/deps.yml',
      "      - run: echo ${{ hashFiles('.github/workflows/in-run.yml') }}",
    ].join('\n'),
    '.github/workflows/reusable.yml': "jobs:\n  c:\n    steps:\n      - with: { key: \"${{ hashFiles('.github/workflows/hashed.yml') }}\" }",
    '.github/actions/setup/action.yml': action(`
    - id: k
      run: echo "key=$(sha256sum .github/workflows/by-step.yml)" >> "$GITHUB_OUTPUT"
    - uses: actions/cache@v4
      with: { key: '\${{ steps.k.outputs.key }}', path: x }`),
    '.github/workflows/deps.yml': '', '.github/workflows/in-run.yml': '', '.github/workflows/hashed.yml': '', '.github/workflows/by-step.yml': '',
    '.github/workflows/unrelated.yml': '',
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.required, [
    '.github/actions/setup/',
    '.github/workflows/by-step.yml',
    '.github/workflows/deps.yml',
    '.github/workflows/hashed.yml',
    '.github/workflows/in-run.yml',
    '.github/workflows/reusable.yml',
    ROOT,
  ]);
});

// The forms a line-based scanner misread: the parser reads them as GitHub does.
test('YAML aliases, tags, escapes and multi-line scalars are read as a parser reads them', () => {
  for (const text of [
    "env:\n  K: &k uses\njobs:\n  a:\n    *k : ./.github/workflows/x.yml",
    "jobs:\n  a:\n    steps:\n      - run: !!str |\n          # ${{ hashFiles('.github/workflows/x.yml') }}",
    "env:\n  K: \"a\n    #${{ hashFiles('.github/workflows/x.yml') }}\"",
    "env:\n  K: \"${{ hash\\x46iles('.github/workflows/x.yml') }}\"",
    "env:\n  K:\n    |\n    #${{ hashFiles('.github/workflows/x.yml') }}",
    "jobs: { t: { name: \"x\n    #\", uses: ./.github/workflows/x.yml } }",
  ]) {
    const r = check({ [ROOT]: text, '.github/workflows/x.yml': 'jobs: {}' });
    assert.deepEqual(r.errors, [], text);
    assert.ok(r.required.includes('.github/workflows/x.yml'), text);
  }
});

test('a pattern is matched against the real files, a directory counting for all below it', () => {
  const files = ['.github/workflows/a.yml', '.github/workflows/mergify-junit.xml', '.github/actions/x/action.yml'];
  const hashing = (...patterns) => check({ [ROOT]: `env: { K: "\${{ hashFiles(${patterns.map((p) => `'${p}'`).join(', ')}) }}" }` }, { extra: files }).required.filter((p) => p !== ROOT);
  assert.deepEqual(hashing('**/*.yml'), ['.github/actions/x/action.yml', '.github/workflows/a.yml']);
  assert.deepEqual(hashing('.github'), files.slice().sort());
  assert.deepEqual(hashing('.'), files.slice().sort());
  assert.deepEqual(hashing('*/*/mergify-junit.xml'), ['.github/workflows/mergify-junit.xml']);
  assert.deepEqual(hashing('tests/models/manifest.json', '*/*/junit.xml', '!.github/**'), []);
  assert.deepEqual(hashing('.GitHub/Workflows/A.yml'), ['.github/workflows/a.yml'], 'case-insensitive, like macOS and Windows runners');
});

test('what cannot be judged is an error, not a pass', () => {
  for (const [label, fixture, symlinks] of [
    ['non-literal hashFiles', { [ROOT]: 'env: { K: "${{ hashFiles(env.P) }}" }' }],
    ['climbing pattern', { [ROOT]: "env: { K: \"${{ hashFiles('../repo/.github/workflows/x.yml') }}\" }" }],
    ['absolute pattern', { [ROOT]: "env: { K: \"${{ hashFiles('/home/runner/work') }}\" }" }],
    ['glob class', { [ROOT]: "env: { K: \"${{ hashFiles('.github/[wa]*/**') }}\" }" }],
    ['checkout path', { [ROOT]: 'jobs: { a: { steps: [ { uses: actions/checkout@v4, with: { path: repo } } ] } }' }],
    ['remote reusable workflow', { [ROOT]: 'jobs: { a: { uses: o/r/.github/workflows/w.yml@main } }' }],
    ['remote at .github/workflows', { [ROOT]: 'jobs: { a: { steps: [ { uses: o/r/.github/workflows@main } ] } }' }],
    ['climbing local uses', { [ROOT]: 'jobs: { a: { steps: [ { uses: ./.github/actions/../../ci } ] } }' }],
    ['action without action.yml', { [ROOT]: 'jobs: { a: { steps: [ { uses: ./.github/actions/gone } ] } }' }],
    ['non-composite action', { [ROOT]: 'jobs: { a: { steps: [ { uses: ./.github/actions/js } ] } }', '.github/actions/js/action.yml': "runs: { using: node20, main: index.js }" }],
    ['key from a step elsewhere', { [ROOT]: 'jobs: { a: { steps: [ { with: { key: "${{ steps.gone.outputs.k }}" } } ] } }' }],
    ['unparsable YAML', { [ROOT]: 'jobs: [' }],
    ['missing test.yml', {}],
    ['symlink into .github', { [ROOT]: 'jobs: {}' }, [{ path: 'ci/wf', target: '../.github/workflows' }]],
    ['symlink to the root', { [ROOT]: 'jobs: {}' }, [{ path: 'ci/root', target: '../' }]],
  ]) {
    assert.notDeepEqual(check(fixture, { symlinks }).errors, [], label);
  }
});

test('the list format: comments, blank lines and directory entries', () => {
  const list = parseKeyingList('# note\n\n.github/workflows/test.yml  # inline\n.github/actions/a/\n');
  assert.deepEqual(list, ['.github/workflows/test.yml', '.github/actions/a/']);
  assert.ok(isListed('.github/actions/a/action.yml', list));
  assert.ok(isListed('.github/actions/a/', list));
  assert.ok(!isListed('.github/actions/ab/action.yml', list));
  assert.ok(!isListed('.github/workflows/test.yml.bak', list));
});
