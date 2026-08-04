/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A length-unit extraction failure must not be silent.
 *
 * `extractWallSegmentsForStorey` scales every segment it emits by the
 * model's length-unit scale. When the extraction throws it falls back to
 * 1.0 (metres) — correct for a metre model, silently 1000x wrong for a
 * millimetre one, which collapses the panel's metre-based snap tolerance
 * and yields garbage segments with no indication anything went wrong.
 * The two write-side siblings (`resolve-anchor.ts`, `resolve-source.ts`)
 * already warn on exactly this failure; this pins the read side to match.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import type { IfcDataStore } from '@ifc-lite/parser';

vi.mock('@ifc-lite/parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ifc-lite/parser')>();
  return {
    ...actual,
    extractLengthUnitScale: () => {
      throw new Error('unit table unreadable');
    },
  };
});

const { extractWallSegmentsForStorey } = await import('./extract-walls.js');

/**
 * Minimal store that exercises the unit block and then finds no dividers.
 * `source` must be non-empty (the unit block is guarded on it) and the
 * index lookups the divider walk performs must all be present, or the
 * test would pass for the wrong reason (never reaching the catch).
 */
function makeStore(): IfcDataStore {
  return {
    source: new TextEncoder().encode("ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"),
    entityIndex: { byId: new Map(), byType: new Map() },
    entities: { getTypeName: () => undefined },
  } as unknown as IfcDataStore;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractWallSegmentsForStorey: length-unit extraction failure', () => {
  it('warns with the error bound instead of silently defaulting to metres', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = extractWallSegmentsForStorey(makeStore(), 1);

    // The fallback itself is unchanged — metres.
    expect(result.lengthUnitScale).toBe(1.0);

    const call = warn.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('length unit scale'),
    );
    expect(call, 'expected a console.warn naming the length-unit failure').toBeDefined();
    // The caught error must be bound, not dropped.
    expect(call?.[1]).toBeInstanceOf(Error);
    expect((call?.[1] as Error).message).toBe('unit table unreadable');
  });
});
