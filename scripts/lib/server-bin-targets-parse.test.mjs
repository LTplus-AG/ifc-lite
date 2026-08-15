#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for stripYamlComments, the primitive the whole server-bin parity
 * gate rests on (scripts/check-server-bin-targets.mjs strips comments BEFORE
 * any matching, so a stripper defect reopens the four false greens of PR
 * #2642 one level down).
 *
 * The defect class pinned here: the original stripper entered quote state on
 * ANY apostrophe or double quote, so a lone apostrophe in unquoted prose
 * ("it's a tag") left the line stuck in quote state and every later `#` on
 * that line invisible - comment text leaked into parsed values, silently.
 * The rule now is that a quote only OPENS a scalar when a matching closing
 * quote exists later on the same line; a lone quote is literal text.
 *
 * These are direct input/output cases against the exported function - the
 * black-box mutation harness for the checker lives next to the checker in
 * scripts/check-server-bin-targets.test.mjs, and one apostrophe case runs
 * end-to-end there too.
 *
 * Run: node --test scripts/lib/server-bin-targets-parse.test.mjs
 * (wired into the same CI node-test step as the checker harness in
 * .github/workflows/test.yml).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripYamlComments } from './server-bin-targets-parse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- The defect class: a lone quote in unquoted text must stay literal.

test('a lone apostrophe in an unquoted scalar does not hide a trailing comment', () => {
  assert.equal(
    stripYamlComments("        description: it's a tag # trailing comment"),
    "        description: it's a tag",
  );
});

test('a lone apostrophe in embedded shell does not hide a trailing comment', () => {
  // The comment carries checker-relevant text on purpose: if it leaks, the
  // gate would see a gh release upload invocation that does not exist.
  assert.equal(
    stripYamlComments('          echo the tag can\'t clobber # gh release upload "$RELEASE_TAG" "stale-$asset"'),
    "          echo the tag can't clobber",
  );
});

test('quote state is per-line: a lone apostrophe never leaks into the next line', () => {
  assert.equal(
    stripYamlComments("first: it's open\nsecond: value # tail"),
    "first: it's open\nsecond: value",
  );
});

// ---- Behaviour that already worked and must keep working.

test('a full-line comment may contain apostrophes', () => {
  assert.equal(stripYamlComments("# PowerShell doesn't parse the bare --clobber"), '');
  assert.equal(stripYamlComments("        # don't accumulate against Actions storage."), '');
});

test('a trailing comment containing apostrophes and further hashes is stripped whole', () => {
  assert.equal(
    stripYamlComments("- target: win32-x64 # don't remove # this"),
    '- target: win32-x64',
  );
});

test('a hash inside a single-quoted scalar is not a comment', () => {
  assert.equal(stripYamlComments("key: 'a # b'"), "key: 'a # b'");
});

test('a hash inside a double-quoted scalar is not a comment, one after it is', () => {
  assert.equal(stripYamlComments('key: "a # b" # tail'), 'key: "a # b"');
});

test('an escaped quote inside a double-quoted scalar does not end it', () => {
  assert.equal(
    stripYamlComments('run: echo "a \\" # b" # tail'),
    'run: echo "a \\" # b"',
  );
});

test('an apostrophe inside a double-quoted scalar is literal', () => {
  assert.equal(stripYamlComments('run: echo "it\'s fine" # tail'), 'run: echo "it\'s fine"');
});

test('a hash not preceded by whitespace is not a comment', () => {
  assert.equal(stripYamlComments('url: https://host/path#frag'), 'url: https://host/path#frag');
  assert.equal(stripYamlComments('key: a#b # real comment'), 'key: a#b');
});

// ---- The matched-pair decision, made explicit.

test('two apostrophes before the hash read as a quoted span and the comment still strips', () => {
  // YAML would treat both apostrophes as literal characters; the naive pair
  // is harmless here because the span opens AND closes before the `#`, so
  // the comment is recognised either way.
  assert.equal(
    stripYamlComments("description: it's Bob's tag # c"),
    "description: it's Bob's tag",
  );
});

test('a false apostrophe pair spanning the hash keeps the comment (fails closed)', () => {
  // Accepted limitation of not being a YAML parser: the pair straddles the
  // `#`, so the stripper reads it as quoted and UNDER-strips. The leaked
  // text corrupts a parsed value that every consumer compares exactly, so
  // this direction fails red, never green - unlike the lone-apostrophe bug,
  // which hid live-vs-commented distinctions silently.
  assert.equal(
    stripYamlComments("key: it's a # x's tag"),
    "key: it's a # x's tag",
  );
});

// ---- The real input this parser exists for.

test('the real workflow description line survives stripping byte-identical', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/server-binaries.yml'), 'utf8');
  const line = workflow.split('\n').find((l) => /^\s*description:/.test(l));
  assert.ok(line, 'the workflow no longer has a description: line; update this test');
  assert.equal(stripYamlComments(line), line);
});
