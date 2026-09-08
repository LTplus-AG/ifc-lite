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

/**
 * `--storey` takes its own branch in `queryCommand`, post-filtering the
 * entity list by hand. Both sibling paths — the plain `QueryBuilder` path
 * and the `--where` path — apply `--limit`/`--offset` before printing, but
 * the storey branch handed its unsliced array straight to `outputEntities`,
 * so both flags parsed, validated, and then did nothing at all.
 */
describe('query --storey honours --limit and --offset', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const STOREY = '00 groundfloor';

  async function storeyCount(extra: string[]): Promise<number> {
    const stdout = captureStdout();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await queryCommand([SAMPLE_IFC, '--storey', STOREY, '--json', ...extra]);
    const n = countEntities(stdout.out);
    vi.restoreAllMocks();
    return n;
  }

  it('bounding control: the unrestricted storey listing has more than 2 rows', async () => {
    expect(await storeyCount([])).toBeGreaterThan(2);
  });

  it('--limit caps the rows returned', async () => {
    expect(await storeyCount(['--limit', '2'])).toBe(2);
  });

  it('--limit 0 is a deliberate empty result', async () => {
    expect(await storeyCount(['--limit', '0'])).toBe(0);
  });

  it('--offset skips rows from the front', async () => {
    const total = await storeyCount([]);
    expect(await storeyCount(['--offset', '2'])).toBe(total - 2);
  });

  it('--offset and --limit compose', async () => {
    expect(await storeyCount(['--offset', '1', '--limit', '2'])).toBe(2);
  });

  it('--limit still applies when --storey is combined with --where', async () => {
    const all = await storeyCount(['--where', 'Pset_WallCommon.IsExternal']);
    expect(all).toBeGreaterThan(1);
    expect(await storeyCount(['--where', 'Pset_WallCommon.IsExternal', '--limit', '1'])).toBe(1);
  });
});

/**
 * `--sum`/`--avg`/`--min`/`--max` must aggregate over the FULL filtered set,
 * never a `--limit`/`--offset`-sliced one — the `--where` path enforces this
 * deliberately ("Aggregations operate on the full filtered set (no
 * offset/limit)"). The plain (no `--where`, no `--storey`) path built its
 * `QueryBuilder` with `q.limit(rowLimit)` applied whenever `!groupBy` and
 * `q.offset(offset)` applied with no guard at all, then reused that SAME
 * limited `q` for `--sum`/`--avg`/`--min`/`--max`, which never should have
 * been sliced in
 * the first place: `--type IfcBeam --sum NetVolume --limit 2` silently sums
 * only the first two matched beams instead of every beam with the quantity,
 * with no warning that the total is partial.
 */
describe('query --sum ignores --limit/--offset (plain path, no --where)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const BRIDGE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/infra-bridge.ifc');

  async function sumJson(extra: string[]): Promise<{ total: number; matchedEntities: number }> {
    const stdout = captureStdout();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await queryCommand([BRIDGE_IFC, '--type', 'IfcBeam', '--sum', 'NetVolume', '--json', ...extra]);
    vi.restoreAllMocks();
    return JSON.parse(stdout.out);
  }

  it('bounding control: the unrestricted sum matches more than 2 beams', async () => {
    const full = await sumJson([]);
    expect(full.matchedEntities).toBeGreaterThan(2);
  });

  it('--limit does not shrink the summed set or the total', async () => {
    const full = await sumJson([]);
    const limited = await sumJson(['--limit', '2']);
    expect(limited.matchedEntities).toBe(full.matchedEntities);
    expect(limited.total).toBeCloseTo(full.total, 9);
  });

  // The other half of this block's own title. Only `--limit` was exercised,
  // so the `!aggQuantity` guard on `q.offset(...)` was unpinned: removing it
  // left every test here green while `--sum --offset 2` silently dropped the
  // first two beams from the total.
  it('--offset does not shrink the summed set or the total', async () => {
    const full = await sumJson([]);
    const offsetted = await sumJson(['--offset', '2']);
    expect(offsetted.matchedEntities).toBe(full.matchedEntities);
    expect(offsetted.total).toBeCloseTo(full.total, 9);
  });
});

/**
 * `--group-by` on the plain (no `--where`, no `--storey`) path re-used the
 * shared `QueryBuilder` after `.limit()`/`.offset()` were applied to it.
 * `.limit()` was guarded with `!groupBy` so it never truncated a group-by
 * query, but `.offset()` had no such guard, so `--group-by X --offset N`
 * silently skipped N rows out of the *underlying filtered set* before
 * grouping -- changing which rows land in which group -- while the
 * `--where` and `--storey` siblings both group the full filtered set and
 * ignore `--offset` entirely. One flag, three different answers for the
 * same combination, depending only on which branch handled the query.
 */
describe('query --group-by ignores --offset on the plain path (matches --where/--storey)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function groupJson(extra: string[]): Promise<string> {
    const stdout = captureStdout();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await queryCommand([SAMPLE_IFC, '--group-by', 'type', '--json', ...extra]);
    vi.restoreAllMocks();
    return stdout.out;
  }

  it('plain path: --offset does not change the group-by result', async () => {
    const full = await groupJson([]);
    const offsetResult = await groupJson(['--offset', '2']);
    expect(offsetResult).toBe(full);
  });

  it('--where path: --offset already ignored for group-by (control)', async () => {
    const full = await groupJson(['--where', 'Pset_WallCommon.IsExternal']);
    const offsetResult = await groupJson(['--where', 'Pset_WallCommon.IsExternal', '--offset', '1']);
    expect(offsetResult).toBe(full);
  });

  it('--storey path: --offset already ignored for group-by (control)', async () => {
    const full = await groupJson(['--storey', '00 groundfloor']);
    const offsetResult = await groupJson(['--storey', '00 groundfloor', '--offset', '2']);
    expect(offsetResult).toBe(full);
  });
});
