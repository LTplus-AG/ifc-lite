/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The fast path meshes only STEP sources: a ZIP archive (or anything else)
 * named `.ifc` is refused in the worker, so the load meshes the bytes the
 * loader actually parses.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Loaded at runtime: the changed-test oracle removes new production files, and
// a missing module must fail an assertion rather than the whole file's import.
const modulePath = './stepSource.js';
const mod: typeof import('./stepSource.js') | null = await import(modulePath).catch(() => null);
const looksLikeStepSource = (b: Uint8Array) => { assert.ok(mod, 'the STEP check exists (hooks/ingest/stepSource.ts)'); return mod.looksLikeStepSource(b); };
const bytes = (s: string) => new TextEncoder().encode(s);

describe('looksLikeStepSource', () => {
  it('accepts a STEP header, with an optional BOM and leading whitespace', () => {
    assert.equal(looksLikeStepSource(bytes('ISO-10303-21;\nHEADER;')), true);
    assert.equal(looksLikeStepSource(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('ISO-10303-21;')])), true);
    assert.equal(looksLikeStepSource(bytes('\r\n  ISO-10303-21;')), true);
  });

  it('refuses a ZIP archive, IFCX JSON, an empty or truncated file', () => {
    assert.equal(looksLikeStepSource(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0])), false);
    assert.equal(looksLikeStepSource(bytes('{"header":{"ifcxVersion":"2.0"}}')), false);
    assert.equal(looksLikeStepSource(new Uint8Array()), false);
    assert.equal(looksLikeStepSource(bytes('ISO-10303')), false);
  });
});
