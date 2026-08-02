/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What `ifc-lite diff --by-content` does with the paths it is handed, before it
 * compares anything (issue #1891).
 *
 * The sidecar is JSON and the two arguments in front of it are IFC files, so
 * the worst outcome this command has available is writing the map over one of
 * the models it was asked to compare.
 */

import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentDiffCommand } from './diff-content.js';
import { BASE_MODEL, HEAD_MODEL } from './diff-test-helpers.js';

describe('ifc-lite diff --by-content — input paths', () => {
  let dir: string;
  let basePath: string;
  let headPath: string;
  let mapPath: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ifclite-identity-inputs-'));
    basePath = join(dir, 'v1.ifc');
    headPath = join(dir, 'v2.ifc');
    mapPath = join(dir, 'renames.json');
    await writeFile(basePath, BASE_MODEL, 'utf-8');
    await writeFile(headPath, HEAD_MODEL, 'utf-8');
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => {
      throw new Error('process.exit called');
    }) as unknown) as (code?: number) => never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  function stderr(): string {
    return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  describe('--identity-out cannot destroy an input model', () => {
    async function expectRefused(identityOut: string): Promise<void> {
      await expect(
        contentDiffCommand({ basePath, headPath, identityOut, json: true }),
      ).rejects.toThrow('process.exit called');
      expect(stderr()).toContain('would overwrite the input file');
      // The point of the guard: both models are still models.
      expect(await readFile(basePath, 'utf-8')).toBe(BASE_MODEL);
      expect(await readFile(headPath, 'utf-8')).toBe(HEAD_MODEL);
    }

    it('refuses the base model', async () => {
      await expectRefused(basePath);
    });

    it('refuses the head model', async () => {
      await expectRefused(headPath);
    });

    it('refuses a path that only normalizes to an input', async () => {
      // `./v1.ifc` and `v1.ifc` are the same file; comparing the raw strings
      // would wave this through. `sub` does not exist, so no `stat` can resolve
      // this path either — only the lexical comparison catches it.
      await expectRefused(`${dir}/./sub/../v1.ifc`);
    });

    it('refuses a symlink to an input', async () => {
      // Nothing about the two path strings is alike, and neither is their
      // normalized form — only the file they land on.
      const link = join(dir, 'link.json');
      await symlink(basePath, link);
      await expectRefused(link);
    });

    it('still allows reading and writing the same sidecar', async () => {
      // The carry-forward workflow: `--identity-in x --identity-out x`. The
      // guard is about the models, not about the map.
      await contentDiffCommand({ basePath, headPath, identityOut: mapPath, json: true });
      await contentDiffCommand({
        basePath,
        headPath,
        identityIn: mapPath,
        identityOut: mapPath,
        json: true,
      });
      expect(exitSpy).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(mapPath, 'utf-8')).entries).toHaveLength(2);
    }, 30_000);
  });

  it('reports an unreadable model instead of throwing a raw error', async () => {
    const missing = join(dir, 'not-here.ifc');
    await expect(contentDiffCommand({ basePath: missing, headPath, json: true })).rejects.toThrow(
      'process.exit called',
    );
    expect(stderr()).toContain(`Cannot read ${missing}`);
    expect(stderr()).toContain('ENOENT');

    stderrSpy.mockClear();
    await expect(contentDiffCommand({ basePath, headPath: missing, json: true })).rejects.toThrow(
      'process.exit called',
    );
    expect(stderr()).toContain(`Cannot read ${missing}`);
  }, 30_000);
});
