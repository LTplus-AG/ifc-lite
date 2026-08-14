/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Argument handling for `ifc-lite diff` (issue #1891).
 *
 * Kept apart from `diff-content.test.ts` because these tests replace
 * `contentDiffCommand` with a spy to see what the outer command decided to
 * forward, and that file exercises the real one end to end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const contentDiffCommand = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./diff-content.js', () => ({ contentDiffCommand }));

const { diffCommand } = await import('./diff.js');

describe('diffCommand', () => {
  let stderr: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = '';
    contentDiffCommand.mockClear();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe('positional arguments', () => {
    it('rejects fewer than two files', async () => {
      await expect(diffCommand(['a.ifc'])).rejects.toThrow('process.exit called');
      expect(stderr).toContain('Usage: ifc-lite diff');
    });

    it('rejects more than two files', async () => {
      // Silently diffing the first two would answer confidently about a pair
      // the user did not ask about.
      await expect(diffCommand(['a.ifc', 'b.ifc', 'c.ifc'])).rejects.toThrow('process.exit called');
      expect(stderr).toContain('Usage: ifc-lite diff');
      expect(contentDiffCommand).not.toHaveBeenCalled();
    });

    it('still counts exactly two when a value flag sits between them', async () => {
      await diffCommand(['a.ifc', '--identity-out', 'map.json', 'b.ifc']);
      expect(contentDiffCommand).toHaveBeenCalledWith(
        expect.objectContaining({ basePath: 'a.ifc', headPath: 'b.ifc' }),
      );
    });
  });

  describe('identity flag values', () => {
    it('rejects a missing value', async () => {
      await expect(diffCommand(['a.ifc', 'b.ifc', '--identity-out'])).rejects.toThrow(
        'process.exit called',
      );
      expect(stderr).toContain('--identity-out requires a file path');
    });

    it('rejects the next flag as a value, rather than writing a file called --json', async () => {
      await expect(diffCommand(['a.ifc', 'b.ifc', '--identity-out', '--json'])).rejects.toThrow(
        'process.exit called',
      );
      expect(stderr).toContain('--identity-out requires a file path');
      expect(contentDiffCommand).not.toHaveBeenCalled();
    });

    it('rejects a missing --identity-in value too', async () => {
      await expect(diffCommand(['a.ifc', 'b.ifc', '--identity-in'])).rejects.toThrow(
        'process.exit called',
      );
      expect(stderr).toContain('--identity-in requires a file path');
    });
  });

  describe('routing', () => {
    it('takes the engine path for --by-content, with no identity map either way', async () => {
      await diffCommand(['a.ifc', 'b.ifc', '--by-content']);
      expect(contentDiffCommand).toHaveBeenCalledWith({
        basePath: 'a.ifc',
        headPath: 'b.ifc',
        identityIn: undefined,
        identityOut: undefined,
        json: false,
      });
    });

    it('forwards both identity paths and --json', async () => {
      await diffCommand([
        'a.ifc',
        'b.ifc',
        '--by-content',
        '--identity-in',
        'in.json',
        '--identity-out',
        'out.json',
        '--json',
      ]);
      expect(contentDiffCommand).toHaveBeenCalledWith({
        basePath: 'a.ifc',
        headPath: 'b.ifc',
        identityIn: 'in.json',
        identityOut: 'out.json',
        json: true,
      });
    });

    it('implies the engine path from --identity-in alone', async () => {
      // The flags only mean anything on the engine path, so they imply it
      // rather than being silently ignored next to the type-count diff.
      await diffCommand(['a.ifc', 'b.ifc', '--identity-in', 'in.json']);
      expect(contentDiffCommand).toHaveBeenCalledWith(
        expect.objectContaining({ identityIn: 'in.json' }),
      );
    });

    it('implies the engine path from --identity-out alone', async () => {
      await diffCommand(['a.ifc', 'b.ifc', '--identity-out', 'out.json']);
      expect(contentDiffCommand).toHaveBeenCalledWith(
        expect.objectContaining({ identityOut: 'out.json' }),
      );
    });
  });
});
