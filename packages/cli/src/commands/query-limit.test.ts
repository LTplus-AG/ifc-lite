/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `--limit` on `query` used to reach two different unguarded call sites:
 *
 *  - the plain (no `--where`) path built a `QueryBuilder` and called
 *    `.limit(parseInt(limit, 10))`, which lands in the headless backend's
 *    descriptor and is only honoured under a bare `descriptor.limit > 0`
 *    check — `NaN > 0` is `false`, so a garbage `--limit` was silently
 *    IGNORED and every matching entity came back instead.
 *  - the `--where` path did `entities.slice(0, parseInt(limit, 10))`
 *    directly, where `slice(0, NaN)` silently returns `[]` — a garbage
 *    `--limit` EMPTIED the result instead.
 *
 * Both are "exit 0, wrong answer" failures. `validateLimit()` now guards
 * both paths.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { queryCommand } from './query.js';
import { evalCommand } from './eval.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/building-architecture.ifc');

function captureStdout(): { out: string } {
  const state = { out: '' };
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    state.out += chunk;
    return true;
  }) as typeof process.stdout.write);
  return state;
}

function countEntities(jsonOut: string): number {
  const parsed = JSON.parse(jsonOut);
  return Array.isArray(parsed) ? parsed.length : parsed.count ?? parsed.length ?? 0;
}

describe('query --limit validation (no --where)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a non-numeric --limit instead of silently returning every match', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(
      queryCommand([SAMPLE_IFC, '--type', 'IfcWall', '--limit', 'abc']),
    ).rejects.toThrow();
  });

  it('rejects a negative --limit', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      queryCommand([SAMPLE_IFC, '--type', 'IfcWall', '--limit', '-1']),
    ).rejects.toThrow();
  });

  it('rejects a fractional --limit', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      queryCommand([SAMPLE_IFC, '--type', 'IfcWall', '--limit', '1.5']),
    ).rejects.toThrow();
  });

  it('rejects a whitespace-only --limit', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      queryCommand([SAMPLE_IFC, '--type', 'IfcWall', '--limit', '  ']),
    ).rejects.toThrow();
  });

  it('bounding control: a valid --limit still limits the rows returned', async () => {
    const stdout = captureStdout();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await queryCommand([SAMPLE_IFC, '--type', 'IfcWall', '--limit', '1', '--json']);

    expect(countEntities(stdout.out)).toBe(1);
  });

  it('bounding control: --limit 0 is a deliberate empty result, not an error', async () => {
    const stdout = captureStdout();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await queryCommand([SAMPLE_IFC, '--type', 'IfcWall', '--limit', '0', '--json']);

    expect(countEntities(stdout.out)).toBe(0);
  });
});

describe('query --limit validation (with --where)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a non-numeric --limit', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(
      queryCommand([SAMPLE_IFC, '--type', 'IfcWall', '--where', 'Pset_WallCommon.IsExternal', '--limit', 'abc']),
    ).rejects.toThrow();
  });

  it('bounding control: a valid --limit still limits the rows returned', async () => {
    const stdout = captureStdout();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await queryCommand([SAMPLE_IFC, '--type', 'IfcWall', '--where', 'Pset_WallCommon.IsExternal', '--limit', '1', '--json']);

    expect(countEntities(stdout.out)).toBe(1);
  });
});

describe('eval --type --limit validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a non-numeric --limit instead of silently evaluating nothing', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(
      evalCommand([SAMPLE_IFC, 'ref.name', '--type', 'IfcWall', '--limit', 'abc']),
    ).rejects.toThrow();
  });

  it('bounding control: a valid --limit still evaluates that many entities', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = captureStdout();

    await evalCommand([SAMPLE_IFC, 'ref.name', '--type', 'IfcWall', '--limit', '1']);

    expect(stdout.out.trim().split('\n')).toHaveLength(1);
  });

  it('bounding control: --limit 0 evaluates nothing without erroring', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = captureStdout();

    await evalCommand([SAMPLE_IFC, 'ref.name', '--type', 'IfcWall', '--limit', '0']);

    expect(stdout.out.trim()).toBe('');
  });
});
