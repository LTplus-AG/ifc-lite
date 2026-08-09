/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The other half of the `ifc-lite schema` exit-code contract.
 *
 * `schema.test.ts` mocks `@ifc-lite/sandbox/schema` to throw at module level,
 * so every test in that file exercises the fallback branch and nothing there
 * can observe the success path. That leaves the signal pinned in one
 * direction only: adding `process.exitCode = 1` to the successful load keeps
 * that whole file green (maintainer negative control on #2100).
 *
 * The resulting regression would be worse than the bug it guards. A degraded
 * schema reported as success is wrong on the fallback path alone; an
 * always-non-zero exit breaks EVERY invocation, so any CI step running
 * `ifc-lite schema` fails outright — and the test written to protect the exit
 * code would not notice.
 *
 * Same shape as the `persisted` gap closed on #2089: a one-directional
 * assertion on a two-valued signal. This file supplies the other direction,
 * which needs its own module mock and therefore its own file.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

// A schema export that loads normally. Shape matches what the command reads:
// `NAMESPACE_SCHEMAS[].{name,doc,methods[]}`.
vi.mock('@ifc-lite/sandbox/schema', () => ({
  NAMESPACE_SCHEMAS: [
    {
      name: 'query',
      doc: 'Query entities',
      methods: [{ name: 'byType', doc: 'Filter by IFC type', params: [], returns: 'Entity[]' }],
    },
  ],
}));

const { schemaCommand } = await import('./schema.js');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('schemaCommand when the sandbox schema loads', () => {
  it('leaves the exit code at 0 and writes nothing to stderr', async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });

    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;

      await schemaCommand([]);

      // The success path must not borrow the failure signal.
      expect(process.exitCode).toBe(0);
      expect(err.join('')).toBe('');

      // And it is genuinely the real schema being emitted, not the fallback
      // reached without a warning — otherwise this would pass for the wrong
      // reason if the mock ever stopped taking effect.
      const parsed = JSON.parse(out.join(''));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({ namespace: 'query', description: 'Query entities' });
    } finally {
      // The test runner's own exit-status flag, not a per-test sandbox.
      process.exitCode = previousExitCode;
    }
  });
});
