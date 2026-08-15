/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `HeadlessBackend.query.entities()` guarded `descriptor.limit`/
 * `descriptor.offset` with a bare `> 0` check. Every comparison with `NaN`
 * is `false`, so a non-numeric value that reached the descriptor (e.g. from
 * `@ifc-lite/mcp`, or any other direct SDK caller that does not go through
 * the CLI's own `validateLimit()`) was silently IGNORED rather than
 * rejected or applied -- the opposite failure mode from the CLI's
 * `slice(0, NaN)` bug, but the same "exit 0, wrong answer" shape. The same
 * `> 0` check also silently ignored a deliberate `limit: 0` / `offset: 0`,
 * which both the CLI and this backend otherwise treat as a valid,
 * zero-result / no-skip request. Non-finite/negative values now throw
 * instead of being swallowed.
 *
 * This backend is shared with `@ifc-lite/mcp`, so it is exercised here
 * directly via `bim.query()`, not through the `query`/`eval`/`export` CLI
 * commands, which now validate `--limit`/`--offset` before ever building a
 * descriptor.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHeadlessContext } from './loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IFC = join(__dirname, '../../../apps/viewer/public/samples/building-architecture.ifc');

describe('HeadlessBackend query.entities() limit/offset guard', () => {
  it('a NaN limit throws instead of silently returning every match', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const all = bim.query().byType('IfcWall').toArray();
    expect(all.length).toBeGreaterThan(1); // sanity: more than one match exists

    expect(() => bim.query().byType('IfcWall').limit(NaN).toArray()).toThrow();
  });

  it('a NaN offset throws instead of silently returning the unskipped full set', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    expect(() => bim.query().byType('IfcWall').offset(NaN).toArray()).toThrow();
  });

  it('a negative limit throws', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    expect(() => bim.query().byType('IfcWall').limit(-1).toArray()).toThrow();
  });

  it('limit: 0 is a deliberate empty result, not a no-op', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const zeroLimited = bim.query().byType('IfcWall').limit(0).toArray();
    expect(zeroLimited).toHaveLength(0);
  });

  it('bounding control: a valid positive limit still limits the rows returned', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const limited = bim.query().byType('IfcWall').limit(1).toArray();
    expect(limited).toHaveLength(1);
  });

  it('bounding control: a valid positive offset still skips rows', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const all = bim.query().byType('IfcWall').toArray();
    const offsetResult = bim.query().byType('IfcWall').offset(1).toArray();
    expect(offsetResult).toHaveLength(all.length - 1);
  });
});
