/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite clash --json` must emit exactly one JSON document on stdout.
 *
 * Regression test for PR #1872: the geometry/opening pipeline (including
 * wasm print bindings) used to write "[IFC-LITE] ..." diagnostic lines to
 * stdout via console.log/info, interleaving with the JSON payload and
 * forcing consumers to scrape the trailing JSON (see the world-gym
 * labeler's extractTrailingJson workaround). Diagnostics now go to stderr.
 *
 * Runs the real built CLI as a subprocess on a synthetic wall+door model.
 * The hosted door guarantees the opening pipeline emits its "[IFC-LITE]"
 * classifier/rect_fast diagnostics, so the test proves they land on stderr
 * rather than proving nothing on a silent model.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IfcCreator } from '@ifc-lite/create';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { clashCommand } from './clash.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '../../dist/index.js');
const WASM_RUNTIME = join(__dirname, '../../../wasm/pkg/ifc-lite_bg.wasm');

// Meshing needs the built CLI plus the wasm runtime (gitignored, rebuilt per
// host). Skip cleanly when either is absent: build with
// `pnpm turbo run build --filter=@ifc-lite/cli` and `scripts/build-wasm.sh`.
const canRun = existsSync(CLI_ENTRY) && existsSync(WASM_RUNTIME);

function buildClashModel(): string {
  const creator = new IfcCreator({ Name: 'ClashJsonTest' });
  const storey = creator.addIfcBuildingStorey({ Name: 'L1', Elevation: 0 });
  // Wall with a hosted door: triggers the opening/void pipeline and its
  // "[IFC-LITE]" console diagnostics during meshing.
  const wall = creator.addIfcWall(storey, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  creator.addIfcWallDoor(wall, { Width: 0.9, Height: 2.1, Position: [1.5, 0, 0] });
  // Second wall crossing the first so the run reports at least one clash.
  creator.addIfcWall(storey, { Start: [2, -2, 0], End: [2, 2, 0], Height: 3, Thickness: 0.2 });
  return creator.toIfc().content;
}

/**
 * Three wall-crossing pairs, spaced 10m apart along X — each pair produces
 * exactly one self-clash, and every pair is well outside the 1.5m default
 * cluster epsilon from every other pair. Models the MEP distribution-run
 * shape (contact points metres apart) with plain walls, so `--group cluster`
 * cannot consolidate any of the three clashes: 3 clashes in, 3 groups out.
 */
function buildScatteredClashModel(): string {
  const creator = new IfcCreator({ Name: 'ScatteredClashTest' });
  const storey = creator.addIfcBuildingStorey({ Name: 'L1', Elevation: 0 });
  for (const offset of [0, 10, 20]) {
    creator.addIfcWall(storey, { Start: [offset - 2, 0, 0], End: [offset + 2, 0, 0], Height: 3, Thickness: 0.2 });
    creator.addIfcWall(storey, { Start: [offset, -2, 0], End: [offset, 2, 0], Height: 3, Thickness: 0.2 });
  }
  return creator.toIfc().content;
}

/**
 * Same shape as `buildScatteredClashModel`, but the three crossing pairs sit
 * 0.5m apart along X — well within the 1.5m default cluster epsilon of each
 * other, and all same rule/type-pair (self-clash on `IfcWall`) — so cluster
 * grouping DOES consolidate: fewer groups than clashes come out.
 */
function buildClusteredClashModel(): string {
  const creator = new IfcCreator({ Name: 'ClusteredClashTest' });
  const storey = creator.addIfcBuildingStorey({ Name: 'L1', Elevation: 0 });
  for (const offset of [0, 0.5, 1.0]) {
    creator.addIfcWall(storey, { Start: [offset - 2, 0, 0], End: [offset + 2, 0, 0], Height: 3, Thickness: 0.2 });
    creator.addIfcWall(storey, { Start: [offset, -2, 0], End: [offset, 2, 0], Height: 3, Thickness: 0.2 });
  }
  return creator.toIfc().content;
}

describe('clash --group cluster ineffectiveness note', () => {
  it.skipIf(!canRun)(
    'warns on stderr when cluster grouping consolidates nothing',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-clash-cluster-noop-'));
      const modelPath = join(dir, 'model.ifc');
      const bcfPath = join(dir, 'out.bcfzip');
      try {
        await writeFile(modelPath, buildScatteredClashModel());

        const { stderr } = await execFileAsync(
          process.execPath,
          [CLI_ENTRY, 'clash', modelPath, '--a', 'IfcWall', '--group', 'cluster', '--bcf', bcfPath],
          { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
        );

        expect(stderr).toContain('did not consolidate any clashes');
        expect(stderr).toContain('3 groups from 3 clashes');
        expect(stderr).toContain('--group rule');
        expect(stderr).toContain('--group typePair');
        expect(stderr).toContain('--group element');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it.skipIf(!canRun)(
    'stays silent when cluster grouping actually consolidates',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-clash-cluster-ok-'));
      const modelPath = join(dir, 'model.ifc');
      const bcfPath = join(dir, 'out.bcfzip');
      try {
        // Same fixture shape as the noop test above, but the crossings sit
        // within epsilon of each other, so clustering merges them: proves the
        // note is conditioned on actual (in)effectiveness, not just present
        // whenever --group cluster runs.
        await writeFile(modelPath, buildClusteredClashModel());

        const { stderr } = await execFileAsync(
          process.execPath,
          [CLI_ENTRY, 'clash', modelPath, '--a', 'IfcWall', '--group', 'cluster', '--bcf', bcfPath],
          { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
        );

        // Fewer groups than clashes proves clustering actually merged some of
        // them (the fixture's 3 wall-crossing pairs sit within epsilon).
        const match = stderr.match(/\((\d+) topic group\(s\)/);
        expect(match).not.toBeNull();
        const groupCount = Number(match?.[1]);
        expect(groupCount).toBeGreaterThan(0);
        expect(groupCount).toBeLessThan(12);
        expect(stderr).not.toContain('did not consolidate');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

describe('clash --json stdout hygiene', () => {
  it.skipIf(!canRun)(
    'stdout is exactly one parseable JSON document; diagnostics go to stderr',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-clash-json-'));
      const modelPath = join(dir, 'model.ifc');
      try {
        await writeFile(modelPath, buildClashModel());

        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [CLI_ENTRY, 'clash', modelPath, '--json'],
          { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
        );

        // The whole of stdout must parse directly - no extractTrailingJson
        // style scraping allowed.
        const payload = JSON.parse(stdout) as {
          summary: { total: number };
          clashes: unknown[];
        };
        expect(stdout.trimStart().startsWith('{')).toBe(true);
        expect(payload.summary.total).toBeGreaterThan(0);
        expect(Array.isArray(payload.clashes)).toBe(true);
        expect(stdout).not.toContain('[IFC-LITE]');

        // The diagnostics are not swallowed - they moved to stderr. This also
        // proves the model actually exercised the noisy opening pipeline.
        expect(stderr).toContain('[IFC-LITE]');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

describe('clashCommand GeometryProcessor disposal (#1959 P2 leak)', () => {
  // `sharedProcessor` (clash.ts) is module-scoped, so each test uses a
  // uniquely-named model file — `meshModel`'s cache key is `basename(filePath)`
  // only (not the full path), so two tests both writing to `model.ifc` in
  // different tmpdirs would collide and the second call would skip meshing
  // (and therefore skip `getProcessor()`) entirely, making the assertion
  // pass for the wrong reason.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function withTempModel(basename: string, fn: (path: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-clash-dispose-'));
    const modelPath = join(dir, basename);
    try {
      await writeFile(modelPath, buildClashModel());
      await fn(modelPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('disposes the GeometryProcessor WASM handle on the success path', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose');

    await withTempModel('dispose-success.ifc', async (modelPath) => {
      await clashCommand([modelPath, '--json']);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });
  }, 60_000);

  it('disposes the GeometryProcessor WASM handle even when clashing throws after meshing', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose');
    // Force the throw downstream of `getProcessor()`/meshing (mirrors how
    // `process()` genuinely fails), so this exercises the `finally` on the
    // error path rather than only the happy path.
    vi.spyOn(GeometryProcessor.prototype, 'process').mockRejectedValue(
      new Error('forced meshing failure for #1959 dispose test'),
    );

    await withTempModel('dispose-throw.ifc', async (modelPath) => {
      await expect(clashCommand([modelPath, '--json'])).rejects.toThrow(
        'forced meshing failure for #1959 dispose test',
      );
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });
  }, 60_000);

  it('clears the shared processor even when dispose() throws, so the next call gets a fresh handle', async () => {
    // Ordering guard (#2128 review). The reset used to sit AFTER `dispose()`,
    // so a throwing dispose skipped it and left `sharedProcessor` pointing at
    // a processor whose handle may be half-freed — the next `clashCommand` in
    // the same host would reuse it. That is the dangling reference the reset
    // exists to prevent, reintroduced on the failure path.
    //
    // Not hypothetical: #1922 is an OOM inside a drained job aborting the WASM
    // module at dispose time — precisely a throwing dispose().
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const disposeSpy = vi
      .spyOn(GeometryProcessor.prototype, 'dispose')
      .mockImplementation(() => {
        throw new Error('dispose boom');
      });
    // Assert on CONSTRUCTION, not disposal. Counting disposals cannot
    // discriminate the ordering: with the reset skipped, the second run reuses
    // the stale processor and disposes THAT a second time, so `dispose` is
    // called twice either way. `getProcessor()` only calls `init()` when it
    // builds a fresh instance (`if (!sharedProcessor)`), so init-count is the
    // observable that distinguishes "fresh handle" from "reused dead handle".
    // (maintainer mutation on #2128: moving the reset back inside the try left
    // the disposal-count assertion green.)
    const initSpy = vi.spyOn(GeometryProcessor.prototype, 'init');

    // Distinct filenames: `meshModel`'s cache key is basename-only, so reusing
    // one name would skip meshing on the second call and never reach dispose.
    await withTempModel('dispose-throws-a.ifc', async (modelPath) => {
      await clashCommand([modelPath, '--json']);
    });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(initSpy).toHaveBeenCalledTimes(1);

    // The binding was cleared despite the throw, so a second run CONSTRUCTS a
    // fresh processor rather than reusing the one whose dispose just failed.
    await withTempModel('dispose-throws-b.ifc', async (modelPath) => {
      await clashCommand([modelPath, '--json']);
    });
    expect(disposeSpy).toHaveBeenCalledTimes(2);
    // The discriminating assertion: a fresh construction happened.
    expect(initSpy).toHaveBeenCalledTimes(2);

    // Not silent — the cleanup failure is reported.
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('dispose failed'))).toBe(true);
  }, 90_000);

  it('does not let a failing dispose() mask the error the caller was reporting', async () => {
    // A cleanup exception replacing the real clash error would tell the user
    // the wrong thing entirely. (#2128 review)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(GeometryProcessor.prototype, 'dispose').mockImplementation(() => {
      throw new Error('dispose boom');
    });
    vi.spyOn(GeometryProcessor.prototype, 'process').mockRejectedValue(
      new Error('the real clash failure'),
    );

    await withTempModel('dispose-mask.ifc', async (modelPath) => {
      await expect(clashCommand([modelPath, '--json'])).rejects.toThrow('the real clash failure');
    });
  }, 60_000);

  it('never constructs a GeometryProcessor when argument parsing fails before meshing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('process.exit called');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose');
    try {
      await expect(clashCommand(['--mode', 'not-a-real-mode', 'some-file.ifc'])).rejects.toThrow(
        'process.exit called',
      );
      // getProcessor() is never reached — nothing to dispose. Pins that the
      // fix did not turn a lazy processor into an eager one.
      expect(disposeSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  }, 30_000);
});
