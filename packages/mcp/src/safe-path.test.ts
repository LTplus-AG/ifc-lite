/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSafePath } from './safe-path.js';
import { ToolExecutionError } from './errors.js';

interface Stub {
  config: { allowedPaths?: string[] };
  registry: { list(): Array<{ filePath?: string }> };
}

function makeCtx(allowedPaths?: string[], modelFiles: string[] = []): Stub {
  return {
    config: { allowedPaths },
    registry: { list: () => modelFiles.map((f) => ({ filePath: f })) },
  };
}

describe('resolveSafePath', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'mcp-safe-path-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  describe('with explicit --allow roots', () => {
    it('accepts a path inside an allowed root for read', async () => {
      const file = join(scratch, 'model.ifc');
      await writeFile(file, 'ISO-10303-21;');
      const out = await resolveSafePath(file, makeCtx([scratch]), 'read');
      expect(out).toBe(resolve(file));
    });

    it('accepts a write path inside an allowed root even if the file does not exist', async () => {
      const file = join(scratch, 'new-file.ifc');
      const out = await resolveSafePath(file, makeCtx([scratch]), 'write');
      expect(out).toBe(resolve(file));
    });

    it('rejects a path outside every allowed root', async () => {
      const other = await mkdtemp(join(tmpdir(), 'mcp-other-'));
      try {
        await expect(
          resolveSafePath(join(other, 'evil.ifc'), makeCtx([scratch]), 'write'),
        ).rejects.toBeInstanceOf(ToolExecutionError);
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    });

    it('rejects a sibling whose prefix matches by string but not by path boundary', async () => {
      // /tmp/scratchAB vs allowed=/tmp/scratch
      const sibling = `${scratch}-sibling`;
      await mkdir(sibling, { recursive: true });
      try {
        await writeFile(join(sibling, 'a.ifc'), '');
        await expect(
          resolveSafePath(join(sibling, 'a.ifc'), makeCtx([scratch]), 'read'),
        ).rejects.toBeInstanceOf(ToolExecutionError);
      } finally {
        await rm(sibling, { recursive: true, force: true });
      }
    });
  });

  describe('symlink handling', () => {
    it('refuses a symlink that points outside the allowed root', async () => {
      const target = await mkdtemp(join(tmpdir(), 'mcp-target-'));
      const targetFile = join(target, 'secret.ifc');
      await writeFile(targetFile, 'secret');
      const link = join(scratch, 'link.ifc');
      try {
        await symlink(targetFile, link);
        await expect(
          resolveSafePath(link, makeCtx([scratch]), 'read'),
        ).rejects.toBeInstanceOf(ToolExecutionError);
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    });

    it('refuses a write whose parent symlinks out of the allowed root', async () => {
      const target = await mkdtemp(join(tmpdir(), 'mcp-target-'));
      const linkedDir = join(scratch, 'linked');
      try {
        await symlink(target, linkedDir);
        await expect(
          resolveSafePath(join(linkedDir, 'new.ifc'), makeCtx([scratch]), 'write'),
        ).rejects.toBeInstanceOf(ToolExecutionError);
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    });

    it('accepts a file inside an allowed root that is itself a symlink', async () => {
      // Operator passes --allow <link>; the link points at the real workspace
      // dir. Files inside should be accepted even though their realpath lives
      // under the link's target rather than the configured root.
      const realWorkspace = await mkdtemp(join(tmpdir(), 'mcp-realws-'));
      const linkedRoot = join(scratch, 'linked-root');
      try {
        await symlink(realWorkspace, linkedRoot);
        const file = join(realWorkspace, 'model.ifc');
        await writeFile(file, 'x');
        const out = await resolveSafePath(
          join(linkedRoot, 'model.ifc'),
          makeCtx([linkedRoot]),
          'read',
        );
        expect(out).toBe(resolve(file));
      } finally {
        await rm(realWorkspace, { recursive: true, force: true });
      }
    });

    it('accepts a symlink whose target stays inside the allowed root', async () => {
      const real = join(scratch, 'real.ifc');
      await writeFile(real, 'x');
      const link = join(scratch, 'link.ifc');
      await symlink(real, link);
      const out = await resolveSafePath(link, makeCtx([scratch]), 'read');
      expect(out).toBe(resolve(real));
    });
  });

  describe('sensitive home directories', () => {
    it('refuses paths under $HOME/.ssh even with the parent in --allow', async () => {
      const home = homedir();
      await expect(
        resolveSafePath(join(home, '.ssh', 'authorized_keys'), makeCtx([home]), 'write'),
      ).rejects.toThrow(/sensitive home entry/i);
    });

    it('refuses ~/.aws/credentials specifically', async () => {
      const home = homedir();
      await expect(
        resolveSafePath(join(home, '.aws', 'credentials'), makeCtx([home]), 'write'),
      ).rejects.toThrow(/sensitive home entry/i);
    });

    it('allows ordinary $HOME paths', async () => {
      const home = homedir();
      const file = join(home, 'a-non-sensitive-file.ifc');
      const out = await resolveSafePath(file, makeCtx([home]), 'write');
      expect(out).toBe(resolve(file));
    });
  });

  describe('without --allow (default workspace)', () => {
    it('falls back to cwd / tmpdir / model dirs', async () => {
      const file = join(scratch, 'unallowed-but-tmp.ifc');
      // scratch is inside tmpdir by construction, so the default should accept it.
      const out = await resolveSafePath(file, makeCtx(undefined), 'write');
      expect(out).toBe(resolve(file));
    });

    it('uses the loaded models directory as a default root', async () => {
      const modelDir = await mkdtemp(join(tmpdir(), 'mcp-model-'));
      const sibling = join(modelDir, 'export.csv');
      try {
        const out = await resolveSafePath(
          sibling,
          makeCtx(undefined, [join(modelDir, 'model.ifc')]),
          'write',
        );
        expect(out).toBe(resolve(sibling));
      } finally {
        await rm(modelDir, { recursive: true, force: true });
      }
    });
  });

  describe('input validation', () => {
    it('rejects an empty string', async () => {
      await expect(
        resolveSafePath('', makeCtx([scratch]), 'read'),
      ).rejects.toBeInstanceOf(ToolExecutionError);
    });

    it('rejects non-string input', async () => {
      await expect(
        resolveSafePath(undefined, makeCtx([scratch]), 'read'),
      ).rejects.toBeInstanceOf(ToolExecutionError);
    });

    it('rejects a read of a non-existent file', async () => {
      await expect(
        resolveSafePath(join(scratch, 'nope.ifc'), makeCtx([scratch]), 'read'),
      ).rejects.toThrow(/does not exist/i);
    });

    it('handles write paths whose immediate ancestor is the filesystem root', async () => {
      // Regression: segment slicing must use basename(), not length-based
      // arithmetic, so a parent of `/` does not silently drop a character.
      // We can't actually write to `/<random>` in tests, so check the
      // intermediate behaviour by asking for a path that resolves through
      // root-as-ancestor and confirming the rejection message names the
      // *complete* requested path rather than a chopped one.
      const requested = '/this-segment-must-stay-intact';
      await expect(
        resolveSafePath(requested, makeCtx([scratch]), 'write'),
      ).rejects.toThrow(/this-segment-must-stay-intact/);
    });
  });
});
