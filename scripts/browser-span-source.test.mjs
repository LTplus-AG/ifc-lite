/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
// A whole-production revert removes this new module. Keep the behavior test
// collected so absence fails the admission assertion, not module discovery.
const featureUrl = new URL('./perf/browser-span-source.mjs', import.meta.url);
const { requireSpanSource } = await import(featureUrl.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === featureUrl.href) return { requireSpanSource: () => undefined };
  throw error;
});

test('#7005 source admission rejects a pre-migration or unrelated base before browser launch', () => {
  const repo = mkdtempSync(join(tmpdir(), 'span-ancestry-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = name => {
    writeFileSync(join(repo, 'fixture'), name);
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', name);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q');
    const old = commit('before-spans');
    const migration = commit('span-readiness');
    const newer = commit('follow-up-release');
    assert.equal(requireSpanSource(repo, newer, migration), newer);
    assert.equal(requireSpanSource(repo, migration, migration), migration);
    assert.throws(() => requireSpanSource(repo, old, migration), /must include #6979/);
    assert.throws(() => requireSpanSource(repo, newer, 'unavailable-history'), /fetch its history/);
    assert.throws(() => requireSpanSource(repo, undefined, migration), /source revision is required/);
    assert.throws(() => requireSpanSource(repo, '--help', migration), /source revision is required/);
    git('checkout', '-q', '--orphan', 'unrelated');
    const unrelated = commit('unrelated');
    assert.throws(() => requireSpanSource(repo, unrelated, migration), /must include #6979/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
