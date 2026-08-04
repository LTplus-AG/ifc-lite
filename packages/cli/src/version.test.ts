/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCliVersion, UNKNOWN_VERSION } from './version.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function captureStderr(): string[] {
  const err: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  return err;
}

describe('readCliVersion', () => {
  it('returns the declared version and stays quiet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ifc-lite-version-'));
    const pkgPath = join(dir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ name: '@ifc-lite/cli', version: '9.9.9' }));
    const err = captureStderr();

    expect(readCliVersion(pkgPath)).toBe('9.9.9');
    expect(err.join('')).toBe('');
  });

  it('reports an unreadable manifest on stderr instead of inventing a version', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'ifc-lite-version-')), 'package.json');
    const err = captureStderr();

    expect(readCliVersion(missing)).toBe(UNKNOWN_VERSION);
    const warning = err.join('');
    expect(warning, 'expected a stderr warning about the unreadable manifest').toContain('Warning');
    // The caught error must be named, not dropped.
    expect(warning).toContain('ENOENT');
  });

  it('reports a manifest with no version rather than reporting a wrong one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ifc-lite-version-'));
    const pkgPath = join(dir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ name: '@ifc-lite/cli' }));
    const err = captureStderr();

    expect(readCliVersion(pkgPath)).toBe(UNKNOWN_VERSION);
    expect(err.join('')).toContain('no "version"');
  });
});
