/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { isExpressId, filterWorstHosts, diagnoseGeometryCommand } from './diagnose-geometry.js';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Committed viewer demo sample (not the network-fetched tests/models/ fixture
// set) — small, fast to parse, always present, so this suite never needs
// `pnpm fixtures`.
const SAMPLE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/hello-wall.ifc');

describe('isExpressId', () => {
  it('is true for a bare numeric string', () => {
    expect(isExpressId('42')).toBe(true);
    expect(isExpressId('0')).toBe(true);
  });

  it('is false for an IFC GlobalId (base64-like, never purely numeric)', () => {
    expect(isExpressId('2O2Fr$t4X7Zf8NOew3FKau')).toBe(false);
    expect(isExpressId('0YvCT2_$X3_xJG3rzD8L_8')).toBe(false);
  });

  it('is false for a mixed or empty string', () => {
    expect(isExpressId('42a')).toBe(false);
    expect(isExpressId('')).toBe(false);
  });
});

describe('filterWorstHosts', () => {
  const hosts = [
    { productId: 1, ifcType: 'IfcWall', openings: 1, csgFailures: 3 },
    { productId: 2, ifcType: 'IfcSlab', openings: 2, csgFailures: 1 },
    { productId: 3, ifcType: 'IfcWall', openings: 1, csgFailures: 2 },
  ];

  it('filters by productId', () => {
    expect(filterWorstHosts(hosts, { productId: 2 })).toEqual([hosts[1]]);
  });

  it('filters by ifcType', () => {
    expect(filterWorstHosts(hosts, { ifcType: 'IfcWall' })).toEqual([hosts[0], hosts[2]]);
  });

  it('filters by both productId and ifcType (AND semantics)', () => {
    expect(filterWorstHosts(hosts, { productId: 3, ifcType: 'IfcWall' })).toEqual([hosts[2]]);
    expect(filterWorstHosts(hosts, { productId: 3, ifcType: 'IfcSlab' })).toEqual([]);
  });

  it('returns everything when no filter is given', () => {
    expect(filterWorstHosts(hosts, {})).toEqual(hosts);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterWorstHosts(hosts, { productId: 999 })).toEqual([]);
  });
});

describe('diagnoseGeometryCommand', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    logger.configure({ level: 'info' });
  });

  function stdoutText(): string {
    return stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  it('--json prints a JSON payload (or `null` for a clean model) to stdout', async () => {
    await diagnoseGeometryCommand([SAMPLE_IFC, '--json']);
    const text = stdoutText().trim();
    expect(() => JSON.parse(text)).not.toThrow();
  }, 30_000);

  it('prints the human-readable report (or the no-diagnostics line) without --json', async () => {
    await diagnoseGeometryCommand([SAMPLE_IFC]);
    const text = stdoutText();
    expect(text.length).toBeGreaterThan(0);
    // Never valid JSON — always the prose report or the fixed sentinel line.
    expect(() => JSON.parse(text.trim())).toThrow();
  }, 30_000);

  it('--quiet suppresses the "Wrote diagnostics to..." status line but keeps the file payload intact', async () => {
    const outPath = join(__dirname, '..', '..', '__diag_test_out__.json');
    logger.configure({ level: 'error' });
    try {
      await diagnoseGeometryCommand([SAMPLE_IFC, '--out', outPath, '--quiet']);
      // Narrow: --quiet must swallow the "Wrote diagnostics to…" status line,
      // but WASM init / the parser may legitimately touch stderr, so assert on
      // the specific line rather than total silence (PR #1564 review).
      expect(
        stderrSpy.mock.calls.every((c) => !String(c[0]).includes('Wrote diagnostics to')),
      ).toBe(true);
      const written = await readFile(outPath, 'utf-8');
      expect(() => JSON.parse(written)).not.toThrow();
    } finally {
      await unlink(outPath).catch(() => undefined);
    }
  }, 30_000);

  it('--product with a numeric express ID that matches nothing prints a sensible message, not a crash', async () => {
    await diagnoseGeometryCommand([SAMPLE_IFC, '--product', '999999999']);
    const text = stdoutText();
    expect(text.length).toBeGreaterThan(0);
  }, 30_000);

  it('--type filtering does not crash on a clean model with no worstHosts', async () => {
    await diagnoseGeometryCommand([SAMPLE_IFC, '--type', 'IfcWall']);
    const text = stdoutText();
    expect(text.length).toBeGreaterThan(0);
  }, 30_000);

  it('a filter that matches no worst host still prints the full aggregate report, not just a "no match" line', async () => {
    // A type that is never a CSG-failing host on this clean sample: the filtered
    // worstHosts list is empty, but the file-wide aggregate report must survive
    // (PR #1564 review — do not hide totalCsgFailures / classification context).
    await diagnoseGeometryCommand([SAMPLE_IFC, '--type', 'IfcNonExistentType']);
    const text = stdoutText();
    // The aggregate report header + counts are present regardless of the filter.
    expect(text).toContain('Geometry diagnostics');
    expect(text).toContain('CSG failures:');
  }, 30_000);

  it('--product with an unresolvable GlobalId fails closed with a clear error (does not crash silently)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => {
      throw new Error('process.exit called');
    }) as unknown) as (code?: number) => never);
    try {
      await expect(
        diagnoseGeometryCommand([SAMPLE_IFC, '--product', 'not-a-real-guid-value']),
      ).rejects.toThrow('process.exit called');
      expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('no entity found with GlobalId'))).toBe(true);
    } finally {
      exitSpy.mockRestore();
    }
  }, 30_000);
});
