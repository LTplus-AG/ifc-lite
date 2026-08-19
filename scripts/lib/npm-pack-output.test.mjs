#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for fetch-prebuilt-wasm.mjs reading `npm pack`'s human
 * output as a filename.
 *
 * The defect: the script ran `npm pack <spec>` and used the trimmed stdout as
 * the tarball path. That held while npm printed its "npm notice" block on
 * stderr. npm 11 prints it on STDOUT, so the trim returned the whole block —
 * about twenty lines listing tarball contents, sizes and the shasum — and the
 * `tar -xzf` two lines down was handed that as a path. tar exited 2 and the
 * script rethrew a bare `status: 2` with no stdout and no stderr, which reads
 * like a corrupt download. On a Windows box without a Rust toolchain this is
 * the ONLY way to get the WASM bundle, so the failure blocks the whole
 * viewer build with a message pointing nowhere near the cause.
 *
 * The first case is the actual npm 11.16.0 output, pasted verbatim. The second
 * is what a notice-on-stdout npm gives WITHOUT `--json`: the parser must
 * refuse it loudly rather than return a plausible-looking line, because the
 * silent version of this bug is what cost the afternoon.
 *
 * Run: node --test scripts/lib/npm-pack-output.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tarballNameFromPackOutput } from './npm-pack-output.mjs';

const NPM_11_JSON = `[
  {
    "id": "@ifc-lite/wasm@4.7.0",
    "name": "@ifc-lite/wasm",
    "version": "4.7.0",
    "size": 1540116,
    "unpackedSize": 4617738,
    "shasum": "efe7ad75c4ce966daa0507f4c7e33d4b4f2083a3",
    "filename": "ifc-lite-wasm-4.7.0.tgz",
    "entryCount": 6,
    "bundled": []
  }
]`;

const NPM_11_NOTICE_ON_STDOUT = `npm notice
npm notice package: @ifc-lite/wasm@4.7.0
npm notice Tarball Contents
npm notice 16.7kB LICENSE
npm notice 4.3MB pkg/ifc-lite_bg.wasm
npm notice Tarball Details
npm notice name: @ifc-lite/wasm
npm notice version: 4.7.0
npm notice filename: ifc-lite-wasm-4.7.0.tgz
npm notice total files: 6
npm notice
ifc-lite-wasm-4.7.0.tgz`;

test('reads the filename from npm 11 --json output', () => {
  assert.equal(tarballNameFromPackOutput(NPM_11_JSON), 'ifc-lite-wasm-4.7.0.tgz');
});

test('refuses the human notice block instead of guessing a path from it', () => {
  // The point of the whole change: this input must not silently produce
  // something tar will choke on later.
  assert.throws(
    () => tarballNameFromPackOutput(NPM_11_NOTICE_ON_STDOUT),
    /did not return JSON/,
  );
});

test('refuses a well-formed response that carries no filename', () => {
  assert.throws(() => tarballNameFromPackOutput('[{"name":"@ifc-lite/wasm"}]'), /no filename/);
  assert.throws(() => tarballNameFromPackOutput('[]'), /no filename/);
});

test('names the offending output in the error, truncated', () => {
  // A parse failure here surfaces on a dev machine that cannot build WASM at
  // all, so the message has to say what npm actually said.
  assert.throws(() => tarballNameFromPackOutput('not json at all'), (err) => {
    assert.match(err.message, /not json at all/);
    return true;
  });
});
