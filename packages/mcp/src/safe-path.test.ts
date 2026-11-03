/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { chmod, unlink, mkdir, mkdtemp, link, readFile, realpath, symlink, writeFile, rm } from 'node:fs/promises';
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
    // realpath() so the root is canonical: on macOS tmpdir() lives under
    // /var, a symlink to /private/var. resolveSafePath always returns
    // realpath-canonicalized paths, so the test's expected values must be
    // canonical too — otherwise every `toBe(resolve(...))` assertion fails.
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'mcp-safe-path-')));
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

    it('accepts the allowed root itself, not just paths beneath it', async () => {
      // `ensureWithinRoots` is `absolute === root || absolute.startsWith(root + sep)`.
      // Every other test in this file passes a path strictly *inside* a root, so
      // the equality arm was never exercised and could be deleted: an operator
      // who passed `--allow <dir>` and then named that same directory as a tool
      // argument would be told their own allowed root is outside allowed roots.
      await expect(resolveSafePath(scratch, makeCtx([scratch]), 'read')).resolves.toBe(scratch);

      // Counter-example, so the assertion above is about the boundary rule and
      // not about the guard being off: the root's *parent* is still refused.
      await expect(
        resolveSafePath(resolve(scratch, '..'), makeCtx([scratch]), 'read'),
      ).rejects.toThrow(/outside allowed roots/i);
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
      const realWorkspace = await realpath(await mkdtemp(join(tmpdir(), 'mcp-realws-')));
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

    it('refuses ~/.zshrc (shell startup / write-to-execute)', async () => {
      const home = homedir();
      await expect(
        resolveSafePath(join(home, '.zshrc'), makeCtx([home]), 'write'),
      ).rejects.toThrow(/sensitive home entry/i);
    });

    it('refuses other shell startup files and ~/.config', async () => {
      const home = homedir();
      for (const entry of ['.bashrc', '.profile', '.bash_profile', '.zprofile', '.zshenv', '.gitconfig']) {
        await expect(
          resolveSafePath(join(home, entry), makeCtx([home]), 'write'),
        ).rejects.toThrow(/sensitive home entry/i);
      }
      // `.config` is a directory: entries beneath it are refused too.
      await expect(
        resolveSafePath(join(home, '.config', 'app', 'secrets.json'), makeCtx([home]), 'write'),
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
      const modelDir = await realpath(await mkdtemp(join(tmpdir(), 'mcp-model-')));
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

  describe('loaded source protection (GHSA-xf2f-wgcc-928h)', () => {
    it.each([undefined, 'explicit'])('rejects source aliases with %s roots', async (mode) => {
      const source = join(scratch, 'model.ifc');
      const symbolic = join(scratch, 'alias.csv');
      const hard = join(scratch, 'alias.json');
      await writeFile(source, 'original model bytes');
      await symlink(source, symbolic);
      await link(source, hard);
      await writeFile(join(scratch, 'other.ifc'), 'other model');
      const ctx = makeCtx(mode ? [scratch] : undefined, [join(scratch, 'other.ifc'), symbolic]);
      for (const target of [source, symbolic, hard]) {
        await expect(resolveSafePath(target, ctx, 'write')).rejects.toThrow(/overwrite loaded model/);
        expect(await readFile(source, 'utf8')).toBe('original model bytes');
      }
      await expect(resolveSafePath(source, ctx, 'read')).resolves.toBe(source);
      const output = join(scratch, 'output.ifc');
      await expect(resolveSafePath(output, ctx, 'write')).resolves.toBe(output);
      await writeFile(output, 'previous export');
      await expect(resolveSafePath(output, ctx, 'write')).resolves.toBe(output);
    });

    it('refuses surviving hard links when the loaded source path disappears (#8705)', async () => {
      const source = join(scratch, 'source.ifc');
      const alias = join(scratch, 'surviving.csv');
      await writeFile(source, 'original model');
      await link(source, alias);
      const ctx = makeCtx([scratch], [source]);
      await unlink(source);
      await expect(resolveSafePath(alias, ctx, 'write')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(await readFile(alias, 'utf8')).toBe('original model');
      const fresh = join(scratch, 'fresh.csv');
      await expect(resolveSafePath(fresh, ctx, 'write')).resolves.toBe(fresh);
      // An unavailable source identity also makes unrelated existing targets
      // unverifiable. Removing the model from the registry restores writes.
      const previous = join(scratch, 'previous.csv');
      await writeFile(previous, 'previous export');
      await expect(resolveSafePath(previous, ctx, 'write')).rejects.toThrow(/Cannot verify loaded model/);
      await expect(resolveSafePath(previous, makeCtx([scratch]), 'write')).resolves.toBe(previous);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'returns PERMISSION_DENIED for filesystem access errors (#8705)', async () => {
        const locked = join(scratch, 'locked');
        await mkdir(locked);
        const source = join(locked, 'source.ifc');
        await writeFile(source, 'original model');
        await chmod(locked, 0);
        try {
          await expect(resolveSafePath(source, makeCtx([scratch]), 'write'))
            .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        } finally {
          await chmod(locked, 0o700);
        }
        expect(await readFile(source, 'utf8')).toBe('original model');
      },
    );

    it('protects a loaded source path even if the source was removed', async () => {
      const source = join(scratch, 'removed.ifc');
      await expect(resolveSafePath(source, makeCtx([scratch], [source]), 'write'))
        .rejects.toThrow(/overwrite loaded model/);
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
